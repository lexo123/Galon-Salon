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
 * - Mutual non-overlap & customer self-overlap prevention
 * - Idempotency D42 policy with deterministic request hash
 * - Booking cancellation with ledger release and target-state retry safety
 * - Booking rescheduling with old/new ledger updates and collision validation
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
  minutesToTimeString,
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
  durationMinutes?: number;
  serviceSnapshot?: Partial<ServiceSnapshot>;
  priceSnapshot?: Partial<PriceSnapshot>;
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

export class BookingEngine {
  /**
   * Creates a Booking with multi-item atomicity, ledger concurrency control,
   * and D42 idempotency enforcement.
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

    // 1. Validate & prepare items in memory
    const preparedItems = items.map((item, idx) => {
      if (!item.serviceId || !item.employeeId || !item.date || !item.startTime) {
        throw new BadRequestError(
          `Item at index ${idx} is missing required fields (serviceId, employeeId, date, startTime)`,
          'VALIDATION_FAILED'
        );
      }
      const durationMinutes = item.durationMinutes && item.durationMinutes > 0 ? item.durationMinutes : 60;
      const endTime = addMinutesToTimeString(item.startTime, durationMinutes);

      // Validate business hours, lead time, booking window
      validateBookingDateTime(item.date, item.startTime, endTime);

      const priceSnapshot: PriceSnapshot = {
        min: item.priceSnapshot?.min ?? 50,
        max: item.priceSnapshot?.max ?? 80,
        currency: DEFAULT_CURRENCY,
      };

      const serviceSnapshot: ServiceSnapshot = {
        nameKa: item.serviceSnapshot?.nameKa || 'მომსახურება',
        nameEn: item.serviceSnapshot?.nameEn || 'Service',
        categoryId: item.serviceSnapshot?.categoryId || 'cat_default',
      };

      return {
        ...item,
        durationMinutes,
        endTime,
        startMinutes: timeStringToMinutes(item.startTime),
        endMinutes: timeStringToMinutes(endTime),
        priceSnapshot,
        serviceSnapshot,
      };
    });

    // 2. Intra-request Mutual Non-Overlap Validation
    // A. Same Employee + Same Date cannot overlap
    for (let i = 0; i < preparedItems.length; i++) {
      for (let j = i + 1; j < preparedItems.length; j++) {
        const itemA = preparedItems[i];
        const itemB = preparedItems[j];
        if (itemA.employeeId === itemB.employeeId && itemA.date === itemB.date) {
          if (doIntervalsOverlap(itemA.startMinutes, itemA.endMinutes, itemB.startMinutes, itemB.endMinutes)) {
            throw new BadRequestError(
              `Requested items conflict: employee ${itemA.employeeId} has overlapping services scheduled (${itemA.startTime}-${itemA.endTime} and ${itemB.startTime}-${itemB.endTime})`,
              'INTERNAL_SCHEDULE_CONFLICT'
            );
          }
        }
      }
    }

    // B. Customer Self-Overlap Prevention: same customer cannot be booked in 2 places at once
    for (let i = 0; i < preparedItems.length; i++) {
      for (let j = i + 1; j < preparedItems.length; j++) {
        const itemA = preparedItems[i];
        const itemB = preparedItems[j];
        if (itemA.date === itemB.date) {
          if (doIntervalsOverlap(itemA.startMinutes, itemA.endMinutes, itemB.startMinutes, itemB.endMinutes)) {
            throw new BadRequestError(
              `Customer cannot be scheduled for overlapping time intervals (${itemA.startTime}-${itemA.endTime} and ${itemB.startTime}-${itemB.endTime})`,
              'CUSTOMER_SELF_OVERLAP'
            );
          }
        }
      }
    }

    // Compute deterministic request hash
    const requestHash = hashCanonicalRequest(rawPayload);
    const idempotencyDocId = idempotencyKey ? `${customerId}_${idempotencyKey}` : null;

    // Collect all unique availability ledger document IDs
    const uniqueLedgerKeys = Array.from(
      new Set(preparedItems.map((it) => `${it.employeeId}_${it.date}`))
    );

    const now = new Date().toISOString();

    // 3. Execute Firestore Transaction
    const result = await adminDb.runTransaction(async (transaction: any) => {
      // --- PHASE 1: ALL READS FIRST ---
      let idempotencyDoc: any = null;
      if (idempotencyDocId) {
        const idempRef = adminDb.collection(COLLECTIONS.IDEMPOTENCY).doc(idempotencyDocId);
        idempotencyDoc = await transaction.get(idempRef);
      }

      // If idempotency document exists:
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

      // Read customer doc
      const userRef = adminDb.collection(COLLECTIONS.USERS).doc(customerId);
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new NotFoundError('Customer user profile does not exist', 'USER_NOT_FOUND');
      }
      const userData = userDoc.data() as User;
      if (userData.status !== 'ACTIVE') {
        throw new ForbiddenError('Customer account is not active', 'ACCOUNT_DISABLED');
      }

      // Read affected ledgers
      const ledgerMap = new Map<string, { ref: any; data: AvailabilityLedger | null }>();
      for (const ledgerKey of uniqueLedgerKeys) {
        const ledgerRef = adminDb.collection(COLLECTIONS.AVAILABILITY).doc(ledgerKey);
        const docSnap = await transaction.get(ledgerRef);
        ledgerMap.set(ledgerKey, {
          ref: ledgerRef,
          data: docSnap.exists ? (docSnap.data() as AvailabilityLedger) : null,
        });
      }

      // --- PHASE 2: IN-MEMORY VALIDATION & TRANSFORMATION ---
      // Generate Booking and BookingItem IDs
      const bookingRef = adminDb.collection(COLLECTIONS.BOOKINGS).doc();
      const bookingId = bookingRef.id;

      const createdItems: BookingItem[] = [];
      const updatedLedgers: Array<{ ref: any; ledger: AvailabilityLedger }> = [];

      // For each ledger, check collisions and merge intervals in-memory
      for (const ledgerKey of uniqueLedgerKeys) {
        const lastUnderscoreIdx = ledgerKey.lastIndexOf('_');
        const empId = ledgerKey.substring(0, lastUnderscoreIdx);
        const dateStr = ledgerKey.substring(lastUnderscoreIdx + 1);
        const ledgerEntry = ledgerMap.get(ledgerKey)!;
        const existingIntervals: BookedInterval[] = ledgerEntry.data?.bookedIntervals
          ? [...ledgerEntry.data.bookedIntervals]
          : [];

        // Find items in this request belonging to this ledger
        const newItemsForLedger = preparedItems.filter(
          (it) => it.employeeId === empId && it.date === dateStr
        );

        const newIntervals: BookedInterval[] = [];

        for (const newItem of newItemsForLedger) {
          const itemRef = adminDb.collection(COLLECTIONS.BOOKING_ITEMS).doc();
          const bookingItemId = itemRef.id;

          // Check collision with all existing ledger intervals
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

        // Merge existing and new intervals, sort by startTime
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

      // --- PHASE 3: ALL WRITES ---
      // 1. Write Ledgers (full array write)
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

    // 4. Post-commit Notification Event (Strictly outside transaction)
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
      if (bookingData.customerId !== actorUserId && !isAdminRole(actorRole) && !isStaffRole(actorRole)) {
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
        throw new BadRequestError('A completed booking cannot be cancelled', 'CANNOT_CANCEL_COMPLETED');
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

      for (const [key, entry] of ledgerMap.entries()) {
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
   * and provides target-state retry safety.
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
      throw new BadRequestError('At least one item reschedule is required', 'RESCHEDULE_ITEMS_REQUIRED');
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
      if (booking.customerId !== actorUserId && !isAdminRole(actorRole) && !isStaffRole(actorRole)) {
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

      // Read items
      const itemsSnapshot = await transaction.get(
        adminDb.collection(COLLECTIONS.BOOKING_ITEMS).where('bookingId', '==', bookingId)
      );
      const items = itemsSnapshot.docs.map((d: any) => d.data() as BookingItem);
      const itemMap = new Map<string, BookingItem>(items.map((i: BookingItem) => [i.id, i]));

      // Target-state retry safety check:
      // If all requested changes are already currently set, return safely
      let allAlreadyAtTarget = true;
      for (const resch of reschedules) {
        const item = itemMap.get(resch.bookingItemId);
        if (!item) {
          throw new NotFoundError(`Booking item #${resch.bookingItemId} not found`, 'ITEM_NOT_FOUND');
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

      // Prepare target changes and validate
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
        const newEndTime = addMinutesToTimeString(resch.newStartTime, item.durationMinutes);

        // Validate business hours & window
        validateBookingDateTime(resch.newDate, resch.newStartTime, newEndTime);

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
          newStartMin: timeStringToMinutes(resch.newStartTime),
          newEndMin: timeStringToMinutes(newEndTime),
        });
      }

      // Check intra-request overlap among rescheduled items
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
        previousData: { items: preparedList.map((p) => ({ id: p.item.id, start: p.item.startTime })) },
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
