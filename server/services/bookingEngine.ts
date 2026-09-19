/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Centralized Authoritative Booking Engine Service
 * Implements Phase 3 Booking Architecture:
 * - Multi-item atomic Booking & BookingItem creation
 * - Concurrency control via Employee-Day Interval Ledger (availability/{employeeId}_{YYYY-MM-DD})
 * - In-memory transform & full-array write (never arrayUnion/arrayRemove)
 * - Same-employee/date multi-item ledger merging
 * - Authoritative service duration & price derivation (D45 midpoint rule, superseding D16)
 * - Customer self-overlap prevention (D44: intra-request & inter-booking)
 * - Authoritative employee validation (INTERNAL employee booking prohibited)
 * - Employee schedule, break, and exception validation
 * - Idempotency D42 policy with deterministic request hash
 * - Booking cancellation with ledger release and target-state retry safety
 * - Booking rescheduling with old/new ledger updates and collision validation
 * - Strict read-before-write transaction ordering
 * - Comprehensive BookingHistory audit trail
 * - Post-commit Notification event generation
 */

import { getAdminDb } from '../config/firebaseAdmin.ts';
import {
  COLLECTIONS,
  Booking,
  BookingItem,
  BookingHistory,
  AvailabilityLedger,
  BookedInterval,
  UserRole,
  User,
  Employee,
  Service,
  WeeklySchedule,
  ScheduleBreak,
  ScheduleException,
  PriceSnapshot,
  ServiceSnapshot,
  DEFAULT_CURRENCY,
  isAdminRole,
  isStaffRole,
} from '../../src/types/index.ts';
import {
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../utils/errors.ts';
import {
  timeStringToMinutes,
  addMinutesToTimeString,
  doIntervalsOverlap,
  validateBookingDateTime,
} from '../utils/dateTime.ts';
import { hashCanonicalRequest } from './canonicalization.ts';
import { NotificationService } from './notificationService.ts';
import { logger } from '../utils/logger.ts';

export interface CreateBookingItemInput {
  serviceId: string;
  employeeId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  durationMinutes?: number; // Ignored in favor of authoritative Service midpoint (D45)
  serviceSnapshot?: Partial<ServiceSnapshot>; // Ignored in favor of authoritative Service snapshot
  priceSnapshot?: Partial<PriceSnapshot>; // Ignored in favor of authoritative Service snapshot
}

export interface CreateBookingInput {
  customerId: string;
  actorRole: UserRole;
  idempotencyKey?: string;
  rawPayload: unknown;
  items: CreateBookingItemInput[];
}

export interface RescheduleItemInput {
  bookingItemId: string;
  newDate: string; // YYYY-MM-DD
  newStartTime: string; // HH:mm
  newEmployeeId?: string;
}

export interface RescheduleBookingInput {
  bookingId: string;
  actorUserId: string;
  actorRole: UserRole;
  reschedules: RescheduleItemInput[];
}

/**
 * Calculates authoritative duration and price snapshots for a service.
 * Implements D45 (Service Price/Duration Authoritative Value Rule - CLOSED):
 * For bounded ranges, computes the exact midpoint.
 * Rejects open-ended or invalid ranges.
 */
export function calculateAuthoritativeServiceValues(service: Service): {
  durationMinutes: number;
  priceSnapshot: PriceSnapshot;
  serviceSnapshot: ServiceSnapshot;
} {
  if (
    typeof service.durationMin !== 'number' ||
    typeof service.durationMax !== 'number' ||
    service.durationMin <= 0 ||
    service.durationMax < service.durationMin
  ) {
    throw new BadRequestError(
      `Service #${service.id} has invalid or open-ended duration configuration`,
      'INVALID_SERVICE_CONFIGURATION'
    );
  }

  const durationMinutes = Math.round((service.durationMin + service.durationMax) / 2);

  if (
    typeof service.priceMin !== 'number' ||
    typeof service.priceMax !== 'number' ||
    service.priceMin < 0 ||
    service.priceMax < service.priceMin
  ) {
    throw new BadRequestError(
      `Service #${service.id} has invalid or open-ended price configuration`,
      'INVALID_SERVICE_CONFIGURATION'
    );
  }

  const priceSnapshot: PriceSnapshot = {
    min: service.priceMin,
    max: service.priceMax,
    currency: DEFAULT_CURRENCY,
  };

  const serviceSnapshot: ServiceSnapshot = {
    nameKa: service.nameKa || '',
    nameEn: service.nameEn || '',
    categoryId: service.categoryId || '',
  };

  return { durationMinutes, priceSnapshot, serviceSnapshot };
}

/**
 * Computes day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday) from a YYYY-MM-DD string.
 */
export function getDayOfWeekFromDate(dateStr: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export class BookingEngine {
  /**
   * Creates a Booking with multi-item atomicity, ledger concurrency control,
   * authoritative server-side validation, and D42 idempotency enforcement.
   * Strictly enforces read-before-write transaction ordering.
   */
  public static async createBooking(
    input: CreateBookingInput,
    customDb?: any
  ): Promise<{ booking: Booking; items: BookingItem[]; isIdempotentReplay?: boolean }> {
    const adminDb = customDb || getAdminDb();
    if (!adminDb) {
      throw new BadRequestError('Database service is currently unavailable', 'DB_UNAVAILABLE');
    }

    const { customerId, actorRole, idempotencyKey, rawPayload, items } = input;

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('At least one booking item is required', 'BOOKING_ITEMS_REQUIRED');
    }

    // Compute deterministic request hash & document ID
    const requestHash = hashCanonicalRequest(rawPayload);
    const idempotencyDocId = idempotencyKey ? `${customerId}_${idempotencyKey}` : null;
    const now = new Date().toISOString();

    // Collect all unique entity keys for transaction reads
    const uniqueServiceIds = Array.from(new Set(items.map((it) => it.serviceId)));
    const uniqueEmployeeIds = Array.from(new Set(items.map((it) => it.employeeId)));
    const uniqueLedgerKeys = Array.from(
      new Set(items.map((it) => `${it.employeeId}_${it.date}`))
    );

    // ========================================================================
    // EXECUTE FIRESTORE TRANSACTION
    // Strictly enforces: ALL READS -> IN-MEMORY VALIDATION -> ALL WRITES
    // ========================================================================
    const result = await adminDb.runTransaction(async (transaction: any) => {
      // ----------------------------------------------------------------------
      // PHASE 1: ALL TRANSACTIONAL READS
      // ----------------------------------------------------------------------

      // 1. Read Idempotency Record (if key provided)
      let idempotencyDoc: any = null;
      if (idempotencyDocId) {
        const idempRef = adminDb.collection(COLLECTIONS.IDEMPOTENCY).doc(idempotencyDocId);
        idempotencyDoc = await transaction.get(idempRef);
      }

      // Early return on idempotency replay (no state mutation needed)
      if (idempotencyDoc && idempotencyDoc.exists) {
        const record = idempotencyDoc.data();
        if (record.requestHash === requestHash) {
          logger.info(`Idempotency replay detected for key ${idempotencyKey}`);
          return {
            isIdempotentReplay: true,
            booking: record.responseBody?.booking,
            items: record.responseBody?.items || [],
          };
        } else {
          throw new ConflictError(
            `Idempotency key '${idempotencyKey}' was already used with a different request payload`,
            'IDEMPOTENCY_CONFLICT'
          );
        }
      }

      // 2. Read Customer User document
      const userRef = adminDb.collection(COLLECTIONS.USERS).doc(customerId);
      const userDoc = await transaction.get(userRef);

      // 3. Read Service documents
      const serviceDocsMap = new Map<string, any>();
      for (const sId of uniqueServiceIds) {
        const sRef = adminDb.collection(COLLECTIONS.SERVICES).doc(sId);
        const sDoc = await transaction.get(sRef);
        serviceDocsMap.set(sId, sDoc);
      }

      // 4. Read Employee documents
      const employeeDocsMap = new Map<string, any>();
      for (const eId of uniqueEmployeeIds) {
        const eRef = adminDb.collection(COLLECTIONS.EMPLOYEES).doc(eId);
        const eDoc = await transaction.get(eRef);
        employeeDocsMap.set(eId, eDoc);
      }

      // 5. Read Schedules, Breaks, and Exceptions for each employee
      const schedulesMap = new Map<string, WeeklySchedule[]>();
      const breaksMap = new Map<string, ScheduleBreak[]>();
      const exceptionsMap = new Map<string, ScheduleException[]>();

      for (const eId of uniqueEmployeeIds) {
        // Read weekly schedules
        const schedSnap = await transaction.get(
          adminDb.collection(COLLECTIONS.WEEKLY_SCHEDULES).where('employeeId', '==', eId)
        );
        const schedList = schedSnap.docs
          ? schedSnap.docs.map((d: any) => d.data() as WeeklySchedule)
          : [];
        schedulesMap.set(eId, schedList);

        // Read schedule breaks
        const breakSnap = await transaction.get(
          adminDb.collection(COLLECTIONS.SCHEDULE_BREAKS).where('employeeId', '==', eId)
        );
        const breakList = breakSnap.docs
          ? breakSnap.docs.map((d: any) => d.data() as ScheduleBreak)
          : [];
        breaksMap.set(eId, breakList);

        // Read schedule exceptions
        const exSnap = await transaction.get(
          adminDb.collection(COLLECTIONS.SCHEDULE_EXCEPTIONS).where('employeeId', '==', eId)
        );
        const exList = exSnap.docs
          ? exSnap.docs.map((d: any) => d.data() as ScheduleException)
          : [];
        exceptionsMap.set(eId, exList);
      }

      // 6. Read Customer's existing active bookings & items (to enforce D44 Customer Self-Overlap)
      const existingCustBookingsSnap = await transaction.get(
        adminDb
          .collection(COLLECTIONS.BOOKINGS)
          .where('customerId', '==', customerId)
          .where('status', '==', 'CONFIRMED')
      );

      const existingCustItems: BookingItem[] = [];
      if (existingCustBookingsSnap.docs && existingCustBookingsSnap.docs.length > 0) {
        for (const bDoc of existingCustBookingsSnap.docs) {
          const bItemsSnap = await transaction.get(
            adminDb.collection(COLLECTIONS.BOOKING_ITEMS).where('bookingId', '==', bDoc.id)
          );
          if (bItemsSnap.docs) {
            for (const itemDoc of bItemsSnap.docs) {
              const itemData = itemDoc.data() as BookingItem;
              if (itemData.status === 'CONFIRMED') {
                existingCustItems.push(itemData);
              }
            }
          }
        }
      }

      // 7. Read Availability Ledgers
      const ledgerMap = new Map<string, { ref: any; data: AvailabilityLedger | null }>();
      for (const ledgerKey of uniqueLedgerKeys) {
        const ledgerRef = adminDb.collection(COLLECTIONS.AVAILABILITY).doc(ledgerKey);
        const docSnap = await transaction.get(ledgerRef);
        ledgerMap.set(ledgerKey, {
          ref: ledgerRef,
          data: docSnap.exists ? (docSnap.data() as AvailabilityLedger) : null,
        });
      }

      // ----------------------------------------------------------------------
      // PHASE 2: IN-MEMORY VALIDATION & TRANSFORMATION
      // ----------------------------------------------------------------------

      // 1. Validate Customer Account
      if (!userDoc.exists) {
        throw new NotFoundError('Customer user profile does not exist', 'USER_NOT_FOUND');
      }
      const userData = userDoc.data() as User;
      if (userData.status !== 'ACTIVE') {
        throw new ForbiddenError('Customer account is not active', 'ACCOUNT_DISABLED');
      }

      // 2. Validate Items, Services, Employees, Schedules, and compute Authoritative Values
      const validatedItems: Array<{
        serviceId: string;
        employeeId: string;
        date: string;
        startTime: string;
        endTime: string;
        durationMinutes: number;
        startMinutes: number;
        endMinutes: number;
        priceSnapshot: PriceSnapshot;
        serviceSnapshot: ServiceSnapshot;
      }> = [];

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (!item.serviceId || !item.employeeId || !item.date || !item.startTime) {
          throw new BadRequestError(
            `Item at index ${idx} is missing required fields (serviceId, employeeId, date, startTime)`,
            'VALIDATION_FAILED'
          );
        }

        // Authoritative Service Validation
        const serviceDoc = serviceDocsMap.get(item.serviceId);
        if (!serviceDoc || !serviceDoc.exists) {
          throw new NotFoundError(`Service #${item.serviceId} not found`, 'SERVICE_NOT_FOUND');
        }
        const service = serviceDoc.data() as Service;
        if (!service.isActive) {
          throw new BadRequestError(`Service #${item.serviceId} is not active`, 'SERVICE_INACTIVE');
        }

        // D45 Authoritative Midpoint Computation for duration & price
        const { durationMinutes, priceSnapshot, serviceSnapshot } =
          calculateAuthoritativeServiceValues(service);

        const endTime = addMinutesToTimeString(item.startTime, durationMinutes);

        // Validate Business Hours, Lead Time, and Booking Window
        validateBookingDateTime(item.date, item.startTime, endTime);

        // Authoritative Employee Validation
        const empDoc = employeeDocsMap.get(item.employeeId);
        if (!empDoc || !empDoc.exists) {
          throw new NotFoundError(`Employee #${item.employeeId} not found`, 'EMPLOYEE_NOT_FOUND');
        }
        const employee = empDoc.data() as Employee;
        if (employee.status !== 'ACTIVE') {
          throw new BadRequestError(
            `Employee #${item.employeeId} is not active`,
            'EMPLOYEE_NOT_AVAILABLE'
          );
        }
        // Section 15: INTERNAL employees are strictly non-bookable
        if (employee.employeeType !== 'CUSTOMER_FACING') {
          throw new BadRequestError(
            `Employee #${item.employeeId} is an internal employee and cannot be booked`,
            'EMPLOYEE_NOT_BOOKABLE'
          );
        }

        const startMin = timeStringToMinutes(item.startTime);
        const endMin = timeStringToMinutes(endTime);
        const dayOfWeek = getDayOfWeekFromDate(item.date);
        const empSchedules = schedulesMap.get(item.employeeId) || [];
        const weeklySchedule = empSchedules.find((s) => s.dayOfWeek === dayOfWeek);

        // Validate Schedule Exceptions
        const empExceptions = exceptionsMap.get(item.employeeId) || [];
        const activeException = empExceptions.find(
          (ex: any) =>
            (ex.startDate && ex.endDate && ex.startDate <= item.date && item.date <= ex.endDate) ||
            ex.date === item.date
        );

        if (activeException) {
          if (activeException.type === 'OFF') {
            throw new ConflictError(
              `Employee #${item.employeeId} is scheduled OFF on ${item.date}`,
              'EMPLOYEE_SCHEDULE_EXCEPTION_OFF'
            );
          }
          if (
            activeException.type === 'CUSTOM_HOURS' &&
            activeException.startTime &&
            activeException.endTime
          ) {
            const customStartMin = timeStringToMinutes(activeException.startTime);
            const customEndMin = timeStringToMinutes(activeException.endTime);
            if (startMin < customStartMin || endMin > customEndMin) {
              throw new BadRequestError(
                `Requested time ${item.startTime}-${endTime} is outside employee's custom hours (${activeException.startTime}-${activeException.endTime}) on ${item.date}`,
                'OUTSIDE_WORKING_HOURS'
              );
            }
          }
        } else {
          // Check Weekly Schedules if present
          if (weeklySchedule) {
            if (!weeklySchedule.isWorking) {
              throw new BadRequestError(
                `Employee #${item.employeeId} does not work on this day`,
                'EMPLOYEE_NOT_WORKING'
              );
            }
            if (weeklySchedule.startTime && weeklySchedule.endTime) {
              const schedStartMin = timeStringToMinutes(weeklySchedule.startTime);
              const schedEndMin = timeStringToMinutes(weeklySchedule.endTime);
              if (startMin < schedStartMin || endMin > schedEndMin) {
                throw new BadRequestError(
                  `Requested time ${item.startTime}-${endTime} is outside employee's working hours (${weeklySchedule.startTime}-${weeklySchedule.endTime})`,
                  'OUTSIDE_WORKING_HOURS'
                );
              }
            }
          }
        }

        // Validate Schedule Breaks
        const empBreaks = breaksMap.get(item.employeeId) || [];
        for (const brk of (empBreaks as any[])) {
          if (brk.dayOfWeek !== undefined && brk.dayOfWeek !== dayOfWeek) {
            continue;
          }
          if (weeklySchedule && brk.scheduleId && brk.scheduleId !== weeklySchedule.id) {
            continue;
          }
          const brkStartMin = timeStringToMinutes(brk.startTime);
          const brkEndMin = timeStringToMinutes(brk.endTime);
          if (doIntervalsOverlap(startMin, endMin, brkStartMin, brkEndMin)) {
            throw new ConflictError(
              `Requested time overlaps with employee break (${brk.startTime}-${brk.endTime})`,
              'EMPLOYEE_ON_BREAK'
            );
          }
        }

        validatedItems.push({
          serviceId: item.serviceId,
          employeeId: item.employeeId,
          date: item.date,
          startTime: item.startTime,
          endTime,
          durationMinutes,
          startMinutes: startMin,
          endMinutes: endMin,
          priceSnapshot,
          serviceSnapshot,
        });
      }

      // 3. Intra-request Mutual Non-Overlap Validation (Same Employee + Same Date)
      for (let i = 0; i < validatedItems.length; i++) {
        for (let j = i + 1; j < validatedItems.length; j++) {
          const itemA = validatedItems[i];
          const itemB = validatedItems[j];
          if (itemA.employeeId === itemB.employeeId && itemA.date === itemB.date) {
            if (
              doIntervalsOverlap(
                itemA.startMinutes,
                itemA.endMinutes,
                itemB.startMinutes,
                itemB.endMinutes
              )
            ) {
              throw new BadRequestError(
                `Requested items conflict: employee ${itemA.employeeId} has overlapping services scheduled (${itemA.startTime}-${itemA.endTime} and ${itemB.startTime}-${itemB.endTime})`,
                'INTERNAL_SCHEDULE_CONFLICT'
              );
            }
          }
        }
      }

      // 4. Customer Self-Overlap Prevention (D44 - CLOSED)
      // A. Intra-request check: same customer cannot have overlapping items
      for (let i = 0; i < validatedItems.length; i++) {
        for (let j = i + 1; j < validatedItems.length; j++) {
          const itemA = validatedItems[i];
          const itemB = validatedItems[j];
          if (itemA.date === itemB.date) {
            if (
              doIntervalsOverlap(
                itemA.startMinutes,
                itemA.endMinutes,
                itemB.startMinutes,
                itemB.endMinutes
              )
            ) {
              throw new BadRequestError(
                `Customer cannot be scheduled for overlapping time intervals (${itemA.startTime}-${itemA.endTime} and ${itemB.startTime}-${itemB.endTime})`,
                'CUSTOMER_SELF_OVERLAP'
              );
            }
          }
        }
      }

      // B. Inter-booking check: compare new items with existing confirmed items for customer
      for (const newItem of validatedItems) {
        for (const exItem of existingCustItems) {
          const exDate = exItem.startTime.substring(0, 10);
          if (exDate === newItem.date) {
            const exStartTime = exItem.startTime.substring(11, 16);
            const exEndTime = exItem.endTime.substring(11, 16);
            const exStartMin = timeStringToMinutes(exStartTime);
            const exEndMin = timeStringToMinutes(exEndTime);
            if (doIntervalsOverlap(newItem.startMinutes, newItem.endMinutes, exStartMin, exEndMin)) {
              throw new ConflictError(
                `Customer already has a confirmed service between ${exStartTime} and ${exEndTime} on ${newItem.date}`,
                'CUSTOMER_SELF_OVERLAP'
              );
            }
          }
        }
      }

      // 5. Availability Ledger Collision Check & In-Memory Merging
      const bookingRef = adminDb.collection(COLLECTIONS.BOOKINGS).doc();
      const bookingId = bookingRef.id;

      const createdItems: BookingItem[] = [];
      const updatedLedgers: Array<{ ref: any; ledger: AvailabilityLedger }> = [];

      for (const ledgerKey of uniqueLedgerKeys) {
        const lastUnderscoreIdx = ledgerKey.lastIndexOf('_');
        const empId = ledgerKey.substring(0, lastUnderscoreIdx);
        const dateStr = ledgerKey.substring(lastUnderscoreIdx + 1);
        const ledgerEntry = ledgerMap.get(ledgerKey)!;
        const existingIntervals: BookedInterval[] = ledgerEntry.data?.bookedIntervals
          ? [...ledgerEntry.data.bookedIntervals]
          : [];

        const newItemsForLedger = validatedItems.filter(
          (it) => it.employeeId === empId && it.date === dateStr
        );

        const newIntervals: BookedInterval[] = [];

        for (const newItem of newItemsForLedger) {
          const itemRef = adminDb.collection(COLLECTIONS.BOOKING_ITEMS).doc();
          const bookingItemId = itemRef.id;

          // Check collision with existing ledger intervals
          for (const ex of existingIntervals) {
            const exStartM = timeStringToMinutes(ex.startTime);
            const exEndM = timeStringToMinutes(ex.endTime);
            if (doIntervalsOverlap(newItem.startMinutes, newItem.endMinutes, exStartM, exEndM)) {
              throw new ConflictError(
                `Employee ${empId} is already booked between ${ex.startTime} and ${ex.endTime} on ${dateStr}`,
                'AVAILABILITY_CONFLICT'
              );
            }
          }

          newIntervals.push({
            bookingId,
            bookingItemId,
            startTime: newItem.startTime,
            endTime: newItem.endTime,
          });

          createdItems.push({
            id: bookingItemId,
            bookingId,
            serviceId: newItem.serviceId,
            employeeId: newItem.employeeId,
            startTime: `${newItem.date}T${newItem.startTime}:00+04:00`,
            endTime: `${newItem.date}T${newItem.endTime}:00+04:00`,
            durationMinutes: newItem.durationMinutes,
            priceSnapshot: newItem.priceSnapshot,
            serviceSnapshot: newItem.serviceSnapshot,
            status: 'CONFIRMED',
            createdAt: now,
            updatedAt: now,
          });
        }

        const mergedIntervals = [...existingIntervals, ...newIntervals].sort((a, b) =>
          a.startTime.localeCompare(b.startTime)
        );

        updatedLedgers.push({
          ref: ledgerEntry.ref,
          ledger: {
            id: ledgerKey,
            employeeId: empId,
            date: dateStr,
            bookedIntervals: mergedIntervals,
            updatedAt: now,
          },
        });
      }

      const booking: Booking = {
        id: bookingId,
        customerId,
        status: 'CONFIRMED',
        createdAt: now,
        updatedAt: now,
      };

      // ----------------------------------------------------------------------
      // PHASE 3: ALL TRANSACTIONAL WRITES
      // ----------------------------------------------------------------------

      // 1. Write Updated Availability Ledgers (full array write)
      for (const { ref, ledger } of updatedLedgers) {
        transaction.set(ref, ledger);
      }

      // 2. Write Booking
      transaction.set(bookingRef, booking);

      // 3. Write BookingItems
      for (const item of createdItems) {
        const itemRef = adminDb.collection(COLLECTIONS.BOOKING_ITEMS).doc(item.id);
        transaction.set(itemRef, item);
      }

      // 4. Write BookingHistory
      const historyRef = adminDb.collection(COLLECTIONS.BOOKING_HISTORY).doc();
      const history: BookingHistory = {
        id: historyRef.id,
        bookingId,
        changedByUserId: customerId,
        changedByRole: actorRole,
        action: 'CREATED',
        previousData: null,
        newData: { booking, itemsCount: createdItems.length },
        createdAt: now,
      };
      transaction.set(historyRef, history);

      // 5. Write Idempotency Record (if key provided)
      if (idempotencyDocId) {
        const idempRef = adminDb.collection(COLLECTIONS.IDEMPOTENCY).doc(idempotencyDocId);
        transaction.set(idempRef, {
          id: idempotencyDocId,
          userId: customerId,
          idempotencyKey,
          requestHash,
          resultingBookingId: bookingId,
          responseStatus: 201,
          responseBody: { booking, items: createdItems },
          createdAt: now,
        });
      }

      return {
        isIdempotentReplay: false,
        booking,
        items: createdItems,
      };
    });

    // Post-commit Notification Event (Strictly outside transaction)
    if (!result.isIdempotentReplay && result.booking) {
      await NotificationService.dispatchBookingEvent({
        recipientUserId: customerId,
        bookingId: result.booking.id,
        title: 'ჯავშანი დადასტურებულია / Booking Confirmed',
        message: `თქვენი ჯავშანი #${result.booking.id} წარმატებით შეიქმნა. / Your booking has been confirmed.`,
        type: 'BOOKING_CREATED',
      });
    }

    return result;
  }

  /**
   * Cancels a booking, atomically releases intervals from all affected employee ledgers,
   * records booking history, and enforces target-state retry safety.
   */
  public static async cancelBooking(
    params: { bookingId: string; actorUserId: string; actorRole: UserRole; reason?: string },
    customDb?: any
  ): Promise<{ booking: Booking; cancelledItemsCount: number }> {
    const adminDb = customDb || getAdminDb();
    if (!adminDb) {
      throw new BadRequestError('Database service is unavailable', 'DB_UNAVAILABLE');
    }

    const { bookingId, actorUserId, actorRole, reason } = params;
    const now = new Date().toISOString();

    const result = await adminDb.runTransaction(async (transaction: any) => {
      // --- PHASE 1: READS ---
      const bookingRef = adminDb.collection(COLLECTIONS.BOOKINGS).doc(bookingId);
      const bookingDoc = await transaction.get(bookingRef);

      if (!bookingDoc.exists) {
        throw new NotFoundError(`Booking #${bookingId} not found`, 'BOOKING_NOT_FOUND');
      }

      const bookingData = bookingDoc.data() as Booking;

      // Ownership check: Customer owner OR staff
      if (
        bookingData.customerId !== actorUserId &&
        !isAdminRole(actorRole) &&
        !isStaffRole(actorRole)
      ) {
        throw new ForbiddenError(
          'You do not have permission to cancel this booking',
          'OWNERSHIP_REQUIRED'
        );
      }

      // Target-state retry safety: if already cancelled, return immediately
      if (bookingData.status === 'CANCELLED') {
        return {
          booking: bookingData,
          cancelledItemsCount: 0,
          alreadyCancelled: true,
        };
      }

      if (bookingData.status === 'COMPLETED') {
        throw new BadRequestError(
          'A completed booking cannot be cancelled',
          'CANNOT_CANCEL_COMPLETED'
        );
      }

      // Read items for this booking
      const itemsSnapshot = await transaction.get(
        adminDb.collection(COLLECTIONS.BOOKING_ITEMS).where('bookingId', '==', bookingId)
      );

      const items = itemsSnapshot.docs.map((d: any) => d.data() as BookingItem);
      const confirmedItems = items.filter((i: BookingItem) => i.status === 'CONFIRMED');

      // Identify affected ledgers
      const ledgerKeys = new Set<string>();
      for (const item of confirmedItems) {
        const dateStr = item.startTime.substring(0, 10);
        ledgerKeys.add(`${item.employeeId}_${dateStr}`);
      }

      // Read affected ledgers
      const ledgerMap = new Map<string, { ref: any; data: AvailabilityLedger | null }>();
      for (const key of ledgerKeys) {
        const lRef = adminDb.collection(COLLECTIONS.AVAILABILITY).doc(key);
        const lDoc = await transaction.get(lRef);
        ledgerMap.set(key, {
          ref: lRef,
          data: lDoc.exists ? (lDoc.data() as AvailabilityLedger) : null,
        });
      }

      // --- PHASE 2: IN-MEMORY TRANSFORMATION ---
      const itemIdsToCancel = new Set(confirmedItems.map((i: BookingItem) => i.id));
      const ledgersToWrite: Array<{ ref: any; data: AvailabilityLedger }> = [];

      for (const [, entry] of ledgerMap.entries()) {
        if (entry.data) {
          const filteredIntervals = entry.data.bookedIntervals.filter(
            (inv) => !itemIdsToCancel.has(inv.bookingItemId) && inv.bookingId !== bookingId
          );
          ledgersToWrite.push({
            ref: entry.ref,
            data: {
              ...entry.data,
              bookedIntervals: filteredIntervals,
              updatedAt: now,
            },
          });
        }
      }

      const updatedBooking: Booking = {
        ...bookingData,
        status: 'CANCELLED',
        updatedAt: now,
      };

      // --- PHASE 3: WRITES ---
      // 1. Release ledgers
      for (const { ref, data } of ledgersToWrite) {
        transaction.set(ref, data);
      }

      // 2. Update Booking
      transaction.update(bookingRef, { status: 'CANCELLED', updatedAt: now });

      // 3. Update BookingItems
      for (const item of confirmedItems) {
        const itemRef = adminDb.collection(COLLECTIONS.BOOKING_ITEMS).doc(item.id);
        transaction.update(itemRef, { status: 'CANCELLED', updatedAt: now });
      }

      // 4. Write BookingHistory
      const historyRef = adminDb.collection(COLLECTIONS.BOOKING_HISTORY).doc();
      const history: BookingHistory = {
        id: historyRef.id,
        bookingId,
        changedByUserId: actorUserId,
        changedByRole: actorRole,
        action: 'CANCELLED',
        previousData: { status: bookingData.status },
        newData: { status: 'CANCELLED', reason: reason || null },
        createdAt: now,
      };
      transaction.set(historyRef, history);

      return {
        booking: updatedBooking,
        cancelledItemsCount: confirmedItems.length,
        alreadyCancelled: false,
      };
    });

    // Post-commit notification
    if (!result.alreadyCancelled) {
      await NotificationService.dispatchBookingEvent({
        recipientUserId: result.booking.customerId,
        bookingId,
        title: 'ჯავშანი გაუქმებულია / Booking Cancelled',
        message: `თქვენი ჯავშანი #${bookingId} გაუქმებულია. / Your booking #${bookingId} has been cancelled.`,
        type: 'BOOKING_CANCELLED',
      });
    }

    return {
      booking: result.booking,
      cancelledItemsCount: result.cancelledItemsCount,
    };
  }

  /**
   * Reschedules one or more items in a booking.
   * Atomically mutates old and new availability ledgers, checks collisions,
   * validates employee schedule & Customer Self-Overlap (D44), and provides target-state retry safety.
   */
  public static async rescheduleBooking(
    input: RescheduleBookingInput,
    customDb?: any
  ): Promise<{ booking: Booking; items: BookingItem[]; alreadyRescheduled?: boolean }> {
    const adminDb = customDb || getAdminDb();
    if (!adminDb) {
      throw new BadRequestError('Database service is unavailable', 'DB_UNAVAILABLE');
    }

    const { bookingId, actorUserId, actorRole, reschedules } = input;
    if (!reschedules || !Array.isArray(reschedules) || reschedules.length === 0) {
      throw new BadRequestError(
        'At least one item reschedule is required',
        'RESCHEDULE_ITEMS_REQUIRED'
      );
    }

    const now = new Date().toISOString();

    const result = await adminDb.runTransaction(async (transaction: any) => {
      // --- PHASE 1: READS ---
      const bookingRef = adminDb.collection(COLLECTIONS.BOOKINGS).doc(bookingId);
      const bookingDoc = await transaction.get(bookingRef);

      if (!bookingDoc.exists) {
        throw new NotFoundError(`Booking #${bookingId} not found`, 'BOOKING_NOT_FOUND');
      }

      const booking = bookingDoc.data() as Booking;

      // Ownership check
      if (
        booking.customerId !== actorUserId &&
        !isAdminRole(actorRole) &&
        !isStaffRole(actorRole)
      ) {
        throw new ForbiddenError(
          'You do not have permission to reschedule this booking',
          'OWNERSHIP_REQUIRED'
        );
      }

      if (booking.status === 'CANCELLED' || booking.status === 'COMPLETED') {
        throw new BadRequestError(
          `Cannot reschedule a booking in '${booking.status}' status`,
          'CANNOT_RESCHEDULE_TERMINAL'
        );
      }

      // Read existing items of this booking
      const itemsSnapshot = await transaction.get(
        adminDb.collection(COLLECTIONS.BOOKING_ITEMS).where('bookingId', '==', bookingId)
      );
      const items = itemsSnapshot.docs.map((d: any) => d.data() as BookingItem);
      const itemMap = new Map<string, BookingItem>(items.map((i: BookingItem) => [i.id, i]));

      // Target-state retry safety check
      let allAlreadyAtTarget = true;
      for (const resch of reschedules) {
        const item = itemMap.get(resch.bookingItemId);
        if (!item) {
          throw new NotFoundError(
            `Booking item #${resch.bookingItemId} not found`,
            'ITEM_NOT_FOUND'
          );
        }
        const currentTargetEmp = resch.newEmployeeId || item.employeeId;
        const currentDate = item.startTime.substring(0, 10);
        const currentTime = item.startTime.substring(11, 16);

        if (
          item.employeeId !== currentTargetEmp ||
          currentDate !== resch.newDate ||
          currentTime !== resch.newStartTime
        ) {
          allAlreadyAtTarget = false;
          break;
        }
      }

      if (allAlreadyAtTarget) {
        return {
          booking,
          items,
          alreadyRescheduled: true,
        };
      }

      // Collect target employee IDs & dates
      const targetEmployeeIds = Array.from(
        new Set(reschedules.map((r) => r.newEmployeeId || itemMap.get(r.bookingItemId)!.employeeId))
      );

      // Read target employee docs
      const empDocsMap = new Map<string, any>();
      for (const eId of targetEmployeeIds) {
        const eRef = adminDb.collection(COLLECTIONS.EMPLOYEES).doc(eId);
        const eDoc = await transaction.get(eRef);
        empDocsMap.set(eId, eDoc);
      }

      // Read schedules, breaks, exceptions for target employees
      const schedulesMap = new Map<string, WeeklySchedule[]>();
      const breaksMap = new Map<string, ScheduleBreak[]>();
      const exceptionsMap = new Map<string, ScheduleException[]>();

      for (const eId of targetEmployeeIds) {
        const schedSnap = await transaction.get(
          adminDb.collection(COLLECTIONS.WEEKLY_SCHEDULES).where('employeeId', '==', eId)
        );
        schedulesMap.set(
          eId,
          schedSnap.docs ? schedSnap.docs.map((d: any) => d.data() as WeeklySchedule) : []
        );

        const breakSnap = await transaction.get(
          adminDb.collection(COLLECTIONS.SCHEDULE_BREAKS).where('employeeId', '==', eId)
        );
        breaksMap.set(
          eId,
          breakSnap.docs ? breakSnap.docs.map((d: any) => d.data() as ScheduleBreak) : []
        );

        const exSnap = await transaction.get(
          adminDb.collection(COLLECTIONS.SCHEDULE_EXCEPTIONS).where('employeeId', '==', eId)
        );
        exceptionsMap.set(
          eId,
          exSnap.docs ? exSnap.docs.map((d: any) => d.data() as ScheduleException) : []
        );
      }

      // Read other active bookings of this customer (excluding this bookingId) for D44 Customer Self-Overlap
      const otherCustBookingsSnap = await transaction.get(
        adminDb
          .collection(COLLECTIONS.BOOKINGS)
          .where('customerId', '==', booking.customerId)
          .where('status', '==', 'CONFIRMED')
      );

      const otherCustItems: BookingItem[] = [];
      if (otherCustBookingsSnap.docs) {
        for (const bDoc of otherCustBookingsSnap.docs) {
          if (bDoc.id === bookingId) continue;
          const bItemsSnap = await transaction.get(
            adminDb.collection(COLLECTIONS.BOOKING_ITEMS).where('bookingId', '==', bDoc.id)
          );
          if (bItemsSnap.docs) {
            for (const itDoc of bItemsSnap.docs) {
              const itData = itDoc.data() as BookingItem;
              if (itData.status === 'CONFIRMED') {
                otherCustItems.push(itData);
              }
            }
          }
        }
      }

      // Prepare target changes and identify all affected ledgers
      interface PreparedReschedule {
        item: BookingItem;
        oldLedgerKey: string;
        newLedgerKey: string;
        newEmployeeId: string;
        newDate: string;
        newStartTime: string;
        newEndTime: string;
        newStartMin: number;
        newEndMin: number;
      }

      const preparedList: PreparedReschedule[] = [];
      const affectedLedgerKeys = new Set<string>();

      for (const resch of reschedules) {
        const item = itemMap.get(resch.bookingItemId)!;
        const newEmpId = resch.newEmployeeId || item.employeeId;

        // Authoritative Employee Validation
        const empDoc = empDocsMap.get(newEmpId);
        if (!empDoc || !empDoc.exists) {
          throw new NotFoundError(`Employee #${newEmpId} not found`, 'EMPLOYEE_NOT_FOUND');
        }
        const employee = empDoc.data() as Employee;
        if (employee.status !== 'ACTIVE') {
          throw new BadRequestError(
            `Employee #${newEmpId} is not active`,
            'EMPLOYEE_NOT_AVAILABLE'
          );
        }
        if (employee.employeeType !== 'CUSTOMER_FACING') {
          throw new BadRequestError(
            `Employee #${newEmpId} is an internal employee and cannot be booked`,
            'EMPLOYEE_NOT_BOOKABLE'
          );
        }

        const newEndTime = addMinutesToTimeString(resch.newStartTime, item.durationMinutes);

        // Validate business hours & window
        validateBookingDateTime(resch.newDate, resch.newStartTime, newEndTime);

        const newStartMin = timeStringToMinutes(resch.newStartTime);
        const newEndMin = timeStringToMinutes(newEndTime);
        const newDayOfWeek = getDayOfWeekFromDate(resch.newDate);
        const empSchedules = schedulesMap.get(newEmpId) || [];
        const weeklySchedule = empSchedules.find((s) => s.dayOfWeek === newDayOfWeek);

        // Validate Schedule Exceptions
        const empExceptions = exceptionsMap.get(newEmpId) || [];
        const activeException = empExceptions.find(
          (ex: any) =>
            (ex.startDate && ex.endDate && ex.startDate <= resch.newDate && resch.newDate <= ex.endDate) ||
            ex.date === resch.newDate
        );

        if (activeException) {
          if (activeException.type === 'OFF') {
            throw new ConflictError(
              `Employee #${newEmpId} is scheduled OFF on ${resch.newDate}`,
              'EMPLOYEE_SCHEDULE_EXCEPTION_OFF'
            );
          }
          if (
            activeException.type === 'CUSTOM_HOURS' &&
            activeException.startTime &&
            activeException.endTime
          ) {
            const customStartMin = timeStringToMinutes(activeException.startTime);
            const customEndMin = timeStringToMinutes(activeException.endTime);
            if (newStartMin < customStartMin || newEndMin > customEndMin) {
              throw new BadRequestError(
                `Requested time ${resch.newStartTime}-${newEndTime} is outside employee's custom hours (${activeException.startTime}-${activeException.endTime}) on ${resch.newDate}`,
                'OUTSIDE_WORKING_HOURS'
              );
            }
          }
        } else {
          // Check Weekly Schedules
          if (weeklySchedule) {
            if (!weeklySchedule.isWorking) {
              throw new BadRequestError(
                `Employee #${newEmpId} does not work on this day`,
                'EMPLOYEE_NOT_WORKING'
              );
            }
            if (weeklySchedule.startTime && weeklySchedule.endTime) {
              const schedStartMin = timeStringToMinutes(weeklySchedule.startTime);
              const schedEndMin = timeStringToMinutes(weeklySchedule.endTime);
              if (newStartMin < schedStartMin || newEndMin > schedEndMin) {
                throw new BadRequestError(
                  `Requested time ${resch.newStartTime}-${newEndTime} is outside employee's working hours (${weeklySchedule.startTime}-${weeklySchedule.endTime})`,
                  'OUTSIDE_WORKING_HOURS'
                );
              }
            }
          }
        }

        // Validate Breaks
        const empBreaks = breaksMap.get(newEmpId) || [];
        for (const brk of (empBreaks as any[])) {
          if (brk.dayOfWeek !== undefined && brk.dayOfWeek !== newDayOfWeek) {
            continue;
          }
          if (weeklySchedule && brk.scheduleId && brk.scheduleId !== weeklySchedule.id) {
            continue;
          }
          const brkStartMin = timeStringToMinutes(brk.startTime);
          const brkEndMin = timeStringToMinutes(brk.endTime);
          if (doIntervalsOverlap(newStartMin, newEndMin, brkStartMin, brkEndMin)) {
            throw new ConflictError(
              `Requested time overlaps with employee break (${brk.startTime}-${brk.endTime})`,
              'EMPLOYEE_ON_BREAK'
            );
          }
        }

        const oldDate = item.startTime.substring(0, 10);
        const oldLedgerKey = `${item.employeeId}_${oldDate}`;
        const newLedgerKey = `${newEmpId}_${resch.newDate}`;

        affectedLedgerKeys.add(oldLedgerKey);
        affectedLedgerKeys.add(newLedgerKey);

        preparedList.push({
          item,
          oldLedgerKey,
          newLedgerKey,
          newEmployeeId: newEmpId,
          newDate: resch.newDate,
          newStartTime: resch.newStartTime,
          newEndTime,
          newStartMin,
          newEndMin,
        });
      }

      // Check intra-request overlap among rescheduled items for same employee
      for (let i = 0; i < preparedList.length; i++) {
        for (let j = i + 1; j < preparedList.length; j++) {
          const a = preparedList[i];
          const b = preparedList[j];
          if (a.newEmployeeId === b.newEmployeeId && a.newDate === b.newDate) {
            if (doIntervalsOverlap(a.newStartMin, a.newEndMin, b.newStartMin, b.newEndMin)) {
              throw new BadRequestError(
                'Rescheduled items conflict with each other for the same employee',
                'INTERNAL_SCHEDULE_CONFLICT'
              );
            }
          }
        }
      }

      // Check Customer Self-Overlap (D44) for rescheduled items
      // 1. Intra-request among rescheduled items
      for (let i = 0; i < preparedList.length; i++) {
        for (let j = i + 1; j < preparedList.length; j++) {
          const a = preparedList[i];
          const b = preparedList[j];
          if (a.newDate === b.newDate) {
            if (doIntervalsOverlap(a.newStartMin, a.newEndMin, b.newStartMin, b.newEndMin)) {
              throw new BadRequestError(
                'Customer cannot be scheduled for overlapping time intervals',
                'CUSTOMER_SELF_OVERLAP'
              );
            }
          }
        }
      }

      // 2. Inter-booking against customer's other active bookings
      for (const prep of preparedList) {
        for (const otherItem of otherCustItems) {
          const otherDate = otherItem.startTime.substring(0, 10);
          if (otherDate === prep.newDate) {
            const otherStartM = timeStringToMinutes(otherItem.startTime.substring(11, 16));
            const otherEndM = timeStringToMinutes(otherItem.endTime.substring(11, 16));
            if (doIntervalsOverlap(prep.newStartMin, prep.newEndMin, otherStartM, otherEndM)) {
              throw new ConflictError(
                `Customer already has a confirmed service between ${otherItem.startTime.substring(11, 16)} and ${otherItem.endTime.substring(11, 16)} on ${prep.newDate}`,
                'CUSTOMER_SELF_OVERLAP'
              );
            }
          }
        }
      }

      // Read all affected ledgers
      const ledgerMap = new Map<string, { ref: any; data: AvailabilityLedger | null }>();
      for (const key of affectedLedgerKeys) {
        const lRef = adminDb.collection(COLLECTIONS.AVAILABILITY).doc(key);
        const lDoc = await transaction.get(lRef);
        ledgerMap.set(key, {
          ref: lRef,
          data: lDoc.exists ? (lDoc.data() as AvailabilityLedger) : null,
        });
      }

      // --- PHASE 2: IN-MEMORY TRANSFORMATION ---
      const updatedLedgers: Array<{ ref: any; ledger: AvailabilityLedger }> = [];

      for (const key of affectedLedgerKeys) {
        const lastUnderscoreIdx = key.lastIndexOf('_');
        const empId = key.substring(0, lastUnderscoreIdx);
        const dateStr = key.substring(lastUnderscoreIdx + 1);
        const entry = ledgerMap.get(key)!;
        let intervals = entry.data?.bookedIntervals ? [...entry.data.bookedIntervals] : [];

        // 1. Remove intervals of items being rescheduled from this ledger
        const itemsLeaving = preparedList.filter((p) => p.oldLedgerKey === key);
        if (itemsLeaving.length > 0) {
          const leavingItemIds = new Set(itemsLeaving.map((p) => p.item.id));
          intervals = intervals.filter((inv) => !leavingItemIds.has(inv.bookingItemId));
        }

        // 2. Add newly incoming intervals
        const itemsEntering = preparedList.filter((p) => p.newLedgerKey === key);
        for (const entering of itemsEntering) {
          // Check collision with remaining intervals
          for (const rem of intervals) {
            const remStartM = timeStringToMinutes(rem.startTime);
            const remEndM = timeStringToMinutes(rem.endTime);
            if (doIntervalsOverlap(entering.newStartMin, entering.newEndMin, remStartM, remEndM)) {
              throw new ConflictError(
                `Employee ${empId} is already booked between ${rem.startTime} and ${rem.endTime} on ${dateStr}`,
                'AVAILABILITY_CONFLICT'
              );
            }
          }
          intervals.push({
            bookingId,
            bookingItemId: entering.item.id,
            startTime: entering.newStartTime,
            endTime: entering.newEndTime,
          });
        }

        intervals.sort((a, b) => a.startTime.localeCompare(b.startTime));

        updatedLedgers.push({
          ref: entry.ref,
          ledger: {
            id: key,
            employeeId: empId,
            date: dateStr,
            bookedIntervals: intervals,
            updatedAt: now,
          },
        });
      }

      const updatedItems: BookingItem[] = [];
      for (const prep of preparedList) {
        const item = prep.item;
        const updatedItem: BookingItem = {
          ...item,
          employeeId: prep.newEmployeeId,
          startTime: `${prep.newDate}T${prep.newStartTime}:00+04:00`,
          endTime: `${prep.newDate}T${prep.newEndTime}:00+04:00`,
          updatedAt: now,
        };
        updatedItems.push(updatedItem);
      }

      // --- PHASE 3: WRITES ---
      // 1. Write Ledgers
      for (const { ref, ledger } of updatedLedgers) {
        transaction.set(ref, ledger);
      }

      // 2. Update Booking
      transaction.update(bookingRef, { updatedAt: now });

      // 3. Update BookingItems
      for (const it of updatedItems) {
        const iRef = adminDb.collection(COLLECTIONS.BOOKING_ITEMS).doc(it.id);
        transaction.update(iRef, {
          employeeId: it.employeeId,
          startTime: it.startTime,
          endTime: it.endTime,
          updatedAt: now,
        });
      }

      // 4. Write BookingHistory
      const historyRef = adminDb.collection(COLLECTIONS.BOOKING_HISTORY).doc();
      const history: BookingHistory = {
        id: historyRef.id,
        bookingId,
        changedByUserId: actorUserId,
        changedByRole: actorRole,
        action: 'RESCHEDULED',
        previousData: {
          items: preparedList.map((p) => ({ id: p.item.id, start: p.item.startTime })),
        },
        newData: { items: updatedItems.map((u) => ({ id: u.id, start: u.startTime })) },
        createdAt: now,
      };
      transaction.set(historyRef, history);

      return {
        booking: { ...booking, updatedAt: now },
        items: updatedItems,
        alreadyRescheduled: false,
      };
    });

    // Post-commit notification
    if (!result.alreadyRescheduled) {
      await NotificationService.dispatchBookingEvent({
        recipientUserId: result.booking.customerId,
        bookingId,
        title: 'ჯავშანი გადატანილია / Booking Rescheduled',
        message: `თქვენი ჯავშანი #${bookingId} გადატანილია ახალ დროზე. / Your booking #${bookingId} has been rescheduled.`,
        type: 'BOOKING_RESCHEDULED',
      });
    }

    return {
      booking: result.booking,
      items: result.items,
    };
  }
}
