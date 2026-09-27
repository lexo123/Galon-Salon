/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Customer-Facing Availability Endpoint
 * Implements:
 * - GET /api/availability (public, read-only)
 * - Authoritative validation of date, booking window, service (D45), employee (D10), and eligibility (D46)
 * - Feasible slot generation using weeklySchedules, scheduleBreaks, scheduleExceptions,
 *   same-day minimum lead time (D14), business hours (D15), and Employee-Day Interval Ledger
 * - Strictly read-only: never mutates Booking, BookingItem, or AvailabilityLedger state
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getAdminDb } from '../config/firebaseAdmin.ts';
import {
  COLLECTIONS,
  Service,
  Employee,
  EmployeeService,
  WeeklySchedule,
  ScheduleBreak,
  ScheduleException,
  AvailabilityLedger,
} from '../../src/types/index.ts';
import {
  calculateAuthoritativeServiceValues,
  getDayOfWeekFromDate,
} from '../services/bookingEngine.ts';
import {
  BUSINESS_OPEN_TIME,
  BUSINESS_CLOSE_TIME,
  MAX_BOOKING_WINDOW_DAYS,
  MIN_LEAD_TIME_MINUTES,
  timeStringToMinutes,
  minutesToTimeString,
  addMinutesToTimeString,
  doIntervalsOverlap,
  getTbilisiCurrentDateTime,
  getDayDifference,
} from '../utils/dateTime.ts';
import { assertId, assertDateString } from '../utils/validation.ts';
import { BadRequestError, NotFoundError } from '../utils/errors.ts';

export const SLOT_STEP_MINUTES = 30;

export interface AvailableSlot {
  startTime: string;
  endTime: string;
}

export interface AvailabilityQueryInput {
  serviceId: unknown;
  employeeId: unknown;
  date: unknown;
}

export interface AvailabilityResult {
  date: string;
  serviceId: string;
  employeeId: string;
  durationMinutes: number;
  slots: AvailableSlot[];
}

/**
 * Validates calendar YYYY-MM-DD date string to prevent impossible dates (e.g. 2026-02-31).
 */
function validateCalendarDate(dateStr: string): void {
  const [y, m, d] = dateStr.split('-').map(Number);
  const parsedUtc = new Date(Date.UTC(y, m - 1, d));
  if (
    parsedUtc.getUTCFullYear() !== y ||
    parsedUtc.getUTCMonth() + 1 !== m ||
    parsedUtc.getUTCDate() !== d
  ) {
    throw new BadRequestError(
      `Invalid calendar date for 'date': ${dateStr}`,
      'INVALID_DATE_FORMAT',
      { fieldName: 'date' }
    );
  }
}

/**
 * Computes feasible booking slots for a given (serviceId, employeeId, date).
 * Reuses authoritative Booking Engine utilities and domain rules without mutating state.
 */
export async function getAvailableSlots(
  input: AvailabilityQueryInput,
  customDb?: any
): Promise<AvailabilityResult> {
  // 1. Validate query parameter formats
  const serviceId = assertId(input?.serviceId, 'serviceId');
  const employeeId = assertId(input?.employeeId, 'employeeId');
  const date = assertDateString(input?.date, 'date');
  validateCalendarDate(date);

  // 2. Validate date against authoritative Asia/Tbilisi booking window (D13)
  const current = getTbilisiCurrentDateTime();
  const daysDiff = getDayDifference(date, current.dateStr);

  if (daysDiff < 0) {
    throw new BadRequestError('Cannot book in the past', 'PAST_DATE_NOT_ALLOWED');
  }

  if (daysDiff > MAX_BOOKING_WINDOW_DAYS) {
    throw new BadRequestError(
      `Date exceeds maximum booking window of ${MAX_BOOKING_WINDOW_DAYS} days`,
      'BOOKING_WINDOW_EXCEEDED'
    );
  }

  const adminDb = customDb || getAdminDb();
  if (!adminDb) {
    throw new BadRequestError('Database service is currently unavailable', 'DB_UNAVAILABLE');
  }

  // 3. Read & Validate Service (D45)
  const serviceDoc = await adminDb.collection(COLLECTIONS.SERVICES).doc(serviceId).get();
  if (!serviceDoc || !serviceDoc.exists) {
    throw new NotFoundError(`Service #${serviceId} not found`, 'SERVICE_NOT_FOUND');
  }
  const rawService = serviceDoc.data() as Service;
  const service: Service = {
    ...rawService,
    id: serviceDoc.id || rawService.id || serviceId,
  };
  if (!service.isActive) {
    throw new BadRequestError(`Service #${serviceId} is not active`, 'SERVICE_INACTIVE');
  }

  const { durationMinutes } = calculateAuthoritativeServiceValues(service);

  // 4. Read & Validate Employee (D10)
  const empDoc = await adminDb.collection(COLLECTIONS.EMPLOYEES).doc(employeeId).get();
  if (!empDoc || !empDoc.exists) {
    throw new NotFoundError(`Employee #${employeeId} not found`, 'EMPLOYEE_NOT_FOUND');
  }
  const employee = empDoc.data() as Employee;
  if (employee.status !== 'ACTIVE') {
    throw new BadRequestError(
      `Employee #${employeeId} is not active`,
      'EMPLOYEE_NOT_AVAILABLE'
    );
  }
  if (employee.employeeType !== 'CUSTOMER_FACING') {
    throw new BadRequestError(
      `Employee #${employeeId} is an internal employee and cannot be booked`,
      'EMPLOYEE_NOT_BOOKABLE'
    );
  }

  // 5. Read & Validate Employee ↔ Service Eligibility (D46)
  const esSnap = await adminDb
    .collection(COLLECTIONS.EMPLOYEE_SERVICES)
    .where('employeeId', '==', employeeId)
    .get();
  const empAssignedServices: EmployeeService[] = esSnap.docs
    ? esSnap.docs.map((d: any) => d.data() as EmployeeService)
    : [];
  const assignment = empAssignedServices.find((es) => es.serviceId === serviceId);
  if (!assignment) {
    throw new BadRequestError(
      `Employee #${employeeId} is not assigned to service #${serviceId}`,
      'EMPLOYEE_SERVICE_NOT_ASSIGNED'
    );
  }
  if (!assignment.isActive) {
    throw new BadRequestError(
      `Employee #${employeeId} assignment to service #${serviceId} is inactive`,
      'EMPLOYEE_SERVICE_INACTIVE'
    );
  }

  // 6. Read Schedules, Breaks, Exceptions, and Availability Ledger
  const ledgerKey = `${employeeId}_${date}`;
  const [schedSnap, breakSnap, exSnap, ledgerDoc] = await Promise.all([
    adminDb.collection(COLLECTIONS.WEEKLY_SCHEDULES).where('employeeId', '==', employeeId).get(),
    adminDb.collection(COLLECTIONS.SCHEDULE_BREAKS).where('employeeId', '==', employeeId).get(),
    adminDb.collection(COLLECTIONS.SCHEDULE_EXCEPTIONS).where('employeeId', '==', employeeId).get(),
    adminDb.collection(COLLECTIONS.AVAILABILITY).doc(ledgerKey).get(),
  ]);

  const empSchedules: WeeklySchedule[] = schedSnap.docs
    ? schedSnap.docs.map((d: any) => ({ id: d.id, ...(d.data() as WeeklySchedule) }))
    : [];
  const empBreaks: Array<ScheduleBreak & { employeeId?: string; dayOfWeek?: number }> =
    breakSnap.docs
      ? breakSnap.docs.map((d: any) => ({ id: d.id, ...(d.data() as ScheduleBreak) }))
      : [];
  const empExceptions: Array<ScheduleException & { date?: string }> = exSnap.docs
    ? exSnap.docs.map((d: any) => ({ id: d.id, ...(d.data() as ScheduleException) }))
    : [];

  // 7. Determine Effective Working Hours on target date
  const openMin = timeStringToMinutes(BUSINESS_OPEN_TIME);
  const closeMin = timeStringToMinutes(BUSINESS_CLOSE_TIME);
  const dayOfWeek = getDayOfWeekFromDate(date);
  const weeklySchedule = empSchedules.find((s) => s.dayOfWeek === dayOfWeek);

  // If scheduleBreaks are linked only by scheduleId without employeeId, also check by scheduleId
  if (weeklySchedule?.id && empBreaks.length === 0) {
    const breakBySchedSnap = await adminDb
      .collection(COLLECTIONS.SCHEDULE_BREAKS)
      .where('scheduleId', '==', weeklySchedule.id)
      .get();
    if (breakBySchedSnap.docs) {
      for (const d of breakBySchedSnap.docs) {
        empBreaks.push({ id: d.id, ...(d.data() as ScheduleBreak) });
      }
    }
  }

  const activeException = empExceptions.find(
    (ex) =>
      (ex.startDate && ex.endDate && ex.startDate <= date && date <= ex.endDate) ||
      ex.date === date
  );

  let effectiveStartMin = openMin;
  let effectiveEndMin = closeMin;

  if (activeException) {
    if (activeException.type === 'OFF') {
      return {
        date,
        serviceId,
        employeeId,
        durationMinutes,
        slots: [],
      };
    }
    if (activeException.type === 'CUSTOM_HOURS') {
      if (!activeException.startTime || !activeException.endTime) {
        return {
          date,
          serviceId,
          employeeId,
          durationMinutes,
          slots: [],
        };
      }
      const customStartMin = timeStringToMinutes(activeException.startTime);
      const customEndMin = timeStringToMinutes(activeException.endTime);
      effectiveStartMin = Math.max(openMin, customStartMin);
      effectiveEndMin = Math.min(closeMin, customEndMin);
    }
  } else if (weeklySchedule) {
    if (!weeklySchedule.isWorking) {
      return {
        date,
        serviceId,
        employeeId,
        durationMinutes,
        slots: [],
      };
    }
    if (weeklySchedule.startTime && weeklySchedule.endTime) {
      const schedStartMin = timeStringToMinutes(weeklySchedule.startTime);
      const schedEndMin = timeStringToMinutes(weeklySchedule.endTime);
      effectiveStartMin = Math.max(openMin, schedStartMin);
      effectiveEndMin = Math.min(closeMin, schedEndMin);
    }
  }

  if (effectiveEndMin <= effectiveStartMin || effectiveStartMin + durationMinutes > effectiveEndMin) {
    return {
      date,
      serviceId,
      employeeId,
      durationMinutes,
      slots: [],
    };
  }

  // 8. Collect applicable breaks and existing booked intervals
  const applicableBreaks: Array<{ startMin: number; endMin: number }> = [];
  for (const brk of empBreaks) {
    if (brk.dayOfWeek !== undefined && brk.dayOfWeek !== dayOfWeek) {
      continue;
    }
    if (
      weeklySchedule &&
      weeklySchedule.id &&
      brk.scheduleId &&
      brk.scheduleId !== weeklySchedule.id
    ) {
      continue;
    }
    if (brk.startTime && brk.endTime) {
      applicableBreaks.push({
        startMin: timeStringToMinutes(brk.startTime),
        endMin: timeStringToMinutes(brk.endTime),
      });
    }
  }

  const bookedIntervals: Array<{ startMin: number; endMin: number }> = [];
  if (ledgerDoc && ledgerDoc.exists) {
    const ledgerData = ledgerDoc.data() as AvailabilityLedger;
    for (const interval of ledgerData?.bookedIntervals || []) {
      if (interval.startTime && interval.endTime) {
        bookedIntervals.push({
          startMin: timeStringToMinutes(interval.startTime),
          endMin: timeStringToMinutes(interval.endTime),
        });
      }
    }
  }

  // 9. Generate feasible slots
  const slots: AvailableSlot[] = [];
  for (
    let slotStartMin = effectiveStartMin;
    slotStartMin + durationMinutes <= effectiveEndMin;
    slotStartMin += SLOT_STEP_MINUTES
  ) {
    const slotEndMin = slotStartMin + durationMinutes;

    // Enforce same-day minimum lead time (D14: 30 minutes in Asia/Tbilisi)
    if (daysDiff === 0) {
      const leadTime = slotStartMin - current.minutesFromMidnight;
      if (leadTime < MIN_LEAD_TIME_MINUTES) {
        continue;
      }
    }

    // Exclude slots overlapping schedule breaks
    const overlapsBreak = applicableBreaks.some((brk) =>
      doIntervalsOverlap(slotStartMin, slotEndMin, brk.startMin, brk.endMin)
    );
    if (overlapsBreak) {
      continue;
    }

    // Exclude slots overlapping existing ledger bookings
    const overlapsBooking = bookedIntervals.some((booked) =>
      doIntervalsOverlap(slotStartMin, slotEndMin, booked.startMin, booked.endMin)
    );
    if (overlapsBooking) {
      continue;
    }

    const startTime = minutesToTimeString(slotStartMin);
    const endTime = addMinutesToTimeString(startTime, durationMinutes);
    slots.push({
      startTime,
      endTime,
    });
  }

  return {
    date,
    serviceId,
    employeeId,
    durationMinutes,
    slots,
  };
}

const router = Router();

/**
 * GET /api/availability?serviceId=...&employeeId=...&date=YYYY-MM-DD
 * Public, read-only endpoint returning feasible appointment slots.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await getAvailableSlots({
      serviceId: req.query.serviceId,
      employeeId: req.query.employeeId,
      date: req.query.date,
    });

    res.status(200).json({
      status: 'ok',
      date: result.date,
      serviceId: result.serviceId,
      employeeId: result.employeeId,
      durationMinutes: result.durationMinutes,
      slots: result.slots,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
