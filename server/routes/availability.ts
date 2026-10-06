/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Customer-Facing Availability Endpoint
 * Implements:
 * - GET /api/availability?serviceId=<serviceId>&date=<YYYY-MM-DD>[&excludeInterval=...] (public, read-only)
 * - D3: Availability scope by serviceId + date, grouped by eligible active customer-facing employee
 * - D4: Packed/service-specific feasible start times based on authoritative duration and available intervals
 *   (strictly no fixed 15/30-minute candidate grid)
 * - excludeInterval support: repeated query param {employeeId},{date},{startTime},{endTime}
 *   filters overlapping candidate slots across all eligible employees when date matches requested date
 * - Authoritative validation of query input (VALIDATION_FAILED), booking window (D13),
 *   same-day minimum lead time (D14), business hours (D15), service (D45), employee (D10), and eligibility (D46)
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
  isCustomerFacingActive,
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
import { BadRequestError, NotFoundError } from '../utils/errors.ts';

export interface AvailableSlot {
  startTime: string;
  endTime: string;
}

export interface EmployeeAvailability {
  employeeId: string;
  firstName: string;
  lastName: string;
  slots: AvailableSlot[];
}

export interface ExclusionInterval {
  employeeId: string;
  date: string;
  startTime: string;
  endTime: string;
  startMin: number;
  endMin: number;
}

export interface AvailabilityQueryInput {
  serviceId: unknown;
  date: unknown;
  excludeInterval?: unknown;
}

export interface AvailabilityResult {
  serviceId: string;
  date: string;
  durationMinutes: number;
  employees: EmployeeAvailability[];
}

interface MinuteInterval {
  startMin: number;
  endMin: number;
}

/**
 * Validates serviceId query parameter using VALIDATION_FAILED on malformed or missing input.
 */
function validateServiceIdInput(val: unknown): string {
  if (typeof val !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(val.trim())) {
    throw new BadRequestError(
      "Invalid or missing query parameter 'serviceId'",
      'VALIDATION_FAILED',
      { fieldName: 'serviceId' }
    );
  }
  return val.trim();
}

/**
 * Validates date query parameter (YYYY-MM-DD format and real calendar date)
 * using VALIDATION_FAILED on malformed or missing input.
 */
function validateDateInput(val: unknown): string {
  if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val.trim())) {
    throw new BadRequestError(
      "Invalid or missing query parameter 'date': must match YYYY-MM-DD",
      'VALIDATION_FAILED',
      { fieldName: 'date' }
    );
  }
  const dateStr = val.trim();
  const [y, m, d] = dateStr.split('-').map(Number);
  const parsedUtc = new Date(Date.UTC(y, m - 1, d));
  if (
    parsedUtc.getUTCFullYear() !== y ||
    parsedUtc.getUTCMonth() + 1 !== m ||
    parsedUtc.getUTCDate() !== d
  ) {
    throw new BadRequestError(
      `Invalid calendar date for 'date': ${dateStr}`,
      'VALIDATION_FAILED',
      { fieldName: 'date' }
    );
  }
  return dateStr;
}

/**
 * Parses and validates repeated excludeInterval query parameter values.
 * Format: {employeeId},{date},{startTime},{endTime}
 * Throws VALIDATION_FAILED on any malformed or invalid interval.
 */
export function parseAndValidateExcludeIntervals(val: unknown): ExclusionInterval[] {
  if (val === undefined || val === null || val === '') {
    return [];
  }
  const rawList: unknown[] = Array.isArray(val) ? val : [val];
  const exclusions: ExclusionInterval[] = [];

  for (const raw of rawList) {
    if (typeof raw !== 'string') {
      throw new BadRequestError(
        "Invalid 'excludeInterval' format: must be string '{employeeId},{date},{startTime},{endTime}'",
        'VALIDATION_FAILED',
        { fieldName: 'excludeInterval' }
      );
    }
    const parts = raw.split(',').map((p) => p.trim());
    if (parts.length !== 4) {
      throw new BadRequestError(
        "Invalid 'excludeInterval' format: must be '{employeeId},{date},{startTime},{endTime}'",
        'VALIDATION_FAILED',
        { fieldName: 'excludeInterval', raw }
      );
    }
    const [employeeId, dateStr, startTime, endTime] = parts;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(employeeId)) {
      throw new BadRequestError(
        `Invalid employeeId in 'excludeInterval': ${employeeId}`,
        'VALIDATION_FAILED',
        { fieldName: 'excludeInterval', employeeId }
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new BadRequestError(
        `Invalid date format in 'excludeInterval': ${dateStr}`,
        'VALIDATION_FAILED',
        { fieldName: 'excludeInterval', date: dateStr }
      );
    }
    const [y, m, d] = dateStr.split('-').map(Number);
    const parsedUtc = new Date(Date.UTC(y, m - 1, d));
    if (
      parsedUtc.getUTCFullYear() !== y ||
      parsedUtc.getUTCMonth() + 1 !== m ||
      parsedUtc.getUTCDate() !== d
    ) {
      throw new BadRequestError(
        `Invalid calendar date in 'excludeInterval': ${dateStr}`,
        'VALIDATION_FAILED',
        { fieldName: 'excludeInterval', date: dateStr }
      );
    }

    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime)) {
      throw new BadRequestError(
        `Invalid time format in 'excludeInterval': ${startTime}-${endTime}`,
        'VALIDATION_FAILED',
        { fieldName: 'excludeInterval' }
      );
    }

    const startMin = timeStringToMinutes(startTime);
    const endMin = timeStringToMinutes(endTime);
    if (endMin <= startMin) {
      throw new BadRequestError(
        `Invalid time interval in 'excludeInterval': endTime (${endTime}) must be after startTime (${startTime})`,
        'VALIDATION_FAILED',
        { fieldName: 'excludeInterval' }
      );
    }

    exclusions.push({
      employeeId,
      date: dateStr,
      startTime,
      endTime,
      startMin,
      endMin,
    });
  }

  return exclusions;
}

/**
 * Subtracts a list of blocked intervals from an initial working interval,
 * returning sorted, disjoint available intervals.
 */
function subtractBlockedIntervals(
  initialWindow: MinuteInterval,
  blockers: MinuteInterval[]
): MinuteInterval[] {
  let available: MinuteInterval[] = [initialWindow];

  for (const blocker of blockers) {
    if (blocker.endMin <= blocker.startMin) {
      continue;
    }
    const nextAvailable: MinuteInterval[] = [];
    for (const current of available) {
      // No overlap between current available interval and blocker
      if (blocker.endMin <= current.startMin || blocker.startMin >= current.endMin) {
        nextAvailable.push(current);
        continue;
      }
      // Left remainder before blocker
      if (blocker.startMin > current.startMin) {
        nextAvailable.push({
          startMin: current.startMin,
          endMin: blocker.startMin,
        });
      }
      // Right remainder after blocker
      if (blocker.endMin < current.endMin) {
        nextAvailable.push({
          startMin: blocker.endMin,
          endMin: current.endMin,
        });
      }
    }
    available = nextAvailable;
    if (available.length === 0) {
      break;
    }
  }

  return available;
}

/**
 * Computes packed/service-specific feasible slots for a single eligible employee on the target date.
 */
async function computeEmployeeSlotsForDate(params: {
  adminDb: any;
  employeeId: string;
  date: string;
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  durationMinutes: number;
  daysDiff: number;
  currentMinutesFromMidnight: number;
  participatingExclusions: ExclusionInterval[];
}): Promise<AvailableSlot[]> {
  const {
    adminDb,
    employeeId,
    date,
    dayOfWeek,
    durationMinutes,
    daysDiff,
    currentMinutesFromMidnight,
    participatingExclusions,
  } = params;

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
  const empBreaksMap = new Map<string, ScheduleBreak & { employeeId?: string; dayOfWeek?: number }>();
  if (breakSnap.docs) {
    for (const d of breakSnap.docs) {
      empBreaksMap.set(d.id, { id: d.id, ...(d.data() as ScheduleBreak) });
    }
  }

  const empExceptions: Array<ScheduleException & { date?: string }> = exSnap.docs
    ? exSnap.docs.map((d: any) => ({ id: d.id, ...(d.data() as ScheduleException) }))
    : [];

  const openMin = timeStringToMinutes(BUSINESS_OPEN_TIME);
  const closeMin = timeStringToMinutes(BUSINESS_CLOSE_TIME);
  const weeklySchedule = empSchedules.find((s) => s.dayOfWeek === dayOfWeek);

  // Also query scheduleBreaks by scheduleId in case break docs only store scheduleId
  if (weeklySchedule?.id) {
    const breakBySchedSnap = await adminDb
      .collection(COLLECTIONS.SCHEDULE_BREAKS)
      .where('scheduleId', '==', weeklySchedule.id)
      .get();
    if (breakBySchedSnap.docs) {
      for (const d of breakBySchedSnap.docs) {
        empBreaksMap.set(d.id, { id: d.id, ...(d.data() as ScheduleBreak) });
      }
    }
  }

  const activeException = empExceptions.find(
    (ex) =>
      (ex.startDate && ex.endDate && ex.startDate <= date && date <= ex.endDate) ||
      ex.date === date
  );

  let effectiveStartMin: number;
  let effectiveEndMin: number;

  if (activeException) {
    if (activeException.type === 'OFF') {
      return [];
    }
    if (activeException.type === 'CUSTOM_HOURS') {
      if (!activeException.startTime || !activeException.endTime) {
        return [];
      }
      const customStartMin = timeStringToMinutes(activeException.startTime);
      const customEndMin = timeStringToMinutes(activeException.endTime);
      effectiveStartMin = Math.max(openMin, customStartMin);
      effectiveEndMin = Math.min(closeMin, customEndMin);
    } else {
      return [];
    }
  } else {
    if (!weeklySchedule || !weeklySchedule.isWorking || !weeklySchedule.startTime || !weeklySchedule.endTime) {
      return [];
    }
    const schedStartMin = timeStringToMinutes(weeklySchedule.startTime);
    const schedEndMin = timeStringToMinutes(weeklySchedule.endTime);
    effectiveStartMin = Math.max(openMin, schedStartMin);
    effectiveEndMin = Math.min(closeMin, schedEndMin);
  }

  // Enforce same-day minimum lead time (D14: 30 minutes in Asia/Tbilisi)
  if (daysDiff === 0) {
    const minAllowedStartMin = currentMinutesFromMidnight + MIN_LEAD_TIME_MINUTES;
    effectiveStartMin = Math.max(effectiveStartMin, minAllowedStartMin);
  }

  if (effectiveEndMin <= effectiveStartMin || effectiveStartMin + durationMinutes > effectiveEndMin) {
    return [];
  }

  // Collect blocked intervals (applicable breaks + booked ledger intervals)
  const blockers: MinuteInterval[] = [];

  for (const brk of empBreaksMap.values()) {
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
      blockers.push({
        startMin: timeStringToMinutes(brk.startTime),
        endMin: timeStringToMinutes(brk.endTime),
      });
    }
  }

  if (ledgerDoc && ledgerDoc.exists) {
    const ledgerData = ledgerDoc.data() as AvailabilityLedger;
    for (const interval of ledgerData?.bookedIntervals || []) {
      if (interval.startTime && interval.endTime) {
        blockers.push({
          startMin: timeStringToMinutes(interval.startTime),
          endMin: timeStringToMinutes(interval.endTime),
        });
      }
    }
  }

  // Compute disjoint available intervals and generate packed slots of length durationMinutes
  const availableIntervals = subtractBlockedIntervals(
    { startMin: effectiveStartMin, endMin: effectiveEndMin },
    blockers
  );

  const candidateSlots: AvailableSlot[] = [];
  for (const interval of availableIntervals) {
    for (
      let slotStartMin = interval.startMin;
      slotStartMin + durationMinutes <= interval.endMin;
      slotStartMin += durationMinutes
    ) {
      const startTime = minutesToTimeString(slotStartMin);
      const endTime = addMinutesToTimeString(startTime, durationMinutes);
      candidateSlots.push({
        startTime,
        endTime,
      });
    }
  }

  // Apply excludeInterval filtering to candidate slots:
  // Candidate slot [start, end) overlaps exclusion [start, end) iff:
  // candidateStart < exclusionEnd && candidateEnd > exclusionStart
  if (participatingExclusions.length === 0) {
    return candidateSlots;
  }

  return candidateSlots.filter((slot) => {
    const slotStartMin = timeStringToMinutes(slot.startTime);
    const slotEndMin = timeStringToMinutes(slot.endTime);
    return !participatingExclusions.some((ex) =>
      doIntervalsOverlap(slotStartMin, slotEndMin, ex.startMin, ex.endMin)
    );
  });
}

/**
 * Computes feasible booking slots for a given (serviceId, date), grouped by eligible employee (D3 & D4),
 * with excludeInterval filtering applied.
 * Reuses authoritative Booking Engine utilities and domain rules without mutating state.
 */
export async function getAvailableSlots(
  input: AvailabilityQueryInput,
  customDb?: any
): Promise<AvailabilityResult> {
  // 1. Validate query parameter formats (VALIDATION_FAILED)
  const serviceId = validateServiceIdInput(input?.serviceId);
  const date = validateDateInput(input?.date);
  const excludeIntervals = parseAndValidateExcludeIntervals(input?.excludeInterval);
  const participatingExclusions = excludeIntervals.filter((ex) => ex.date === date);

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

  // 4. Resolve Eligible Active Customer-Facing Employees for this Service (D10 & D46)
  const [esSnap, employeesSnap] = await Promise.all([
    adminDb
      .collection(COLLECTIONS.EMPLOYEE_SERVICES)
      .where('serviceId', '==', serviceId)
      .where('isActive', '==', true)
      .get(),
    adminDb.collection(COLLECTIONS.EMPLOYEES).get(),
  ]);

  const activeEligibleEmployeeIds = new Set<string>();
  for (const doc of esSnap.docs || []) {
    const es = doc.data() as EmployeeService;
    if (es && es.serviceId === serviceId && es.isActive === true && es.employeeId) {
      activeEligibleEmployeeIds.add(es.employeeId);
    }
  }

  const eligibleEmployees: Employee[] = [];
  for (const empDoc of employeesSnap.docs || []) {
    const empData = empDoc.data() as Employee;
    const empId = empDoc.id || empData.id;
    if (!empId || !activeEligibleEmployeeIds.has(empId)) {
      continue;
    }
    if (!isCustomerFacingActive(empData)) {
      continue;
    }
    eligibleEmployees.push({
      ...empData,
      id: empId,
    });
  }

  // Sort deterministically by employeeId ascending
  eligibleEmployees.sort((a, b) => a.id.localeCompare(b.id));

  const dayOfWeek = getDayOfWeekFromDate(date);

  // 5. Compute packed feasible slots for each eligible employee
  const employeesAvailability: EmployeeAvailability[] = await Promise.all(
    eligibleEmployees.map(async (emp) => {
      const slots = await computeEmployeeSlotsForDate({
        adminDb,
        employeeId: emp.id,
        date,
        dayOfWeek,
        durationMinutes,
        daysDiff,
        currentMinutesFromMidnight: current.minutesFromMidnight,
        participatingExclusions,
      });

      return {
        employeeId: emp.id,
        firstName: emp.firstName || '',
        lastName: emp.lastName || '',
        slots,
      };
    })
  );

  return {
    serviceId,
    date,
    durationMinutes,
    employees: employeesAvailability,
  };
}

const router = Router();

/**
 * GET /api/availability?serviceId=<serviceId>&date=<YYYY-MM-DD>[&excludeInterval=...]
 * Public, read-only endpoint returning feasible appointment slots grouped by eligible employee.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await getAvailableSlots({
      serviceId: req.query.serviceId,
      date: req.query.date,
      excludeInterval: req.query.excludeInterval,
    });

    res.status(200).json({
      status: 'ok',
      serviceId: result.serviceId,
      date: result.date,
      durationMinutes: result.durationMinutes,
      employees: result.employees,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
