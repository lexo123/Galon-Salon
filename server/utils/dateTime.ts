/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Centralized Timezone & Date/Time Utilities
 * Authoritative for Asia/Tbilisi (UTC+04:00, no DST)
 */

import { BUSINESS_TIMEZONE } from '../../src/types/index.ts';
import { BadRequestError } from './errors.ts';

export const BUSINESS_OPEN_TIME = '10:00';
export const BUSINESS_CLOSE_TIME = '20:00';
export const MAX_BOOKING_WINDOW_DAYS = 7;
export const MIN_LEAD_TIME_MINUTES = 30;

/**
 * Converts "HH:mm" time string to minutes from midnight (0..1439).
 */
export function timeStringToMinutes(timeStr: string): number {
  const parts = timeStr.split(':');
  if (parts.length !== 2) {
    throw new BadRequestError(`Invalid time format: ${timeStr}`, 'INVALID_TIME_FORMAT');
  }
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new BadRequestError(`Invalid time values: ${timeStr}`, 'INVALID_TIME_FORMAT');
  }
  return hours * 60 + minutes;
}

/**
 * Converts minutes from midnight (0..1439) back to "HH:mm".
 */
export function minutesToTimeString(minutes: number): string {
  const normalized = Math.max(0, Math.min(1439, minutes));
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/**
 * Adds duration in minutes to "HH:mm" time string.
 */
export function addMinutesToTimeString(timeStr: string, durationMinutes: number): string {
  const startM = timeStringToMinutes(timeStr);
  const endM = startM + durationMinutes;
  return minutesToTimeString(endM);
}

/**
 * Evaluates whether two half-open intervals [startA, endA) and [startB, endB) overlap.
 * Back-to-back intervals (e.g. 10:00-11:00 and 11:00-12:00) DO NOT overlap.
 */
export function doIntervalsOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number
): boolean {
  return startA < endB && startB < endA;
}

/**
 * Gets the current authoritative date, time, and representation in Asia/Tbilisi.
 */
export function getTbilisiCurrentDateTime(): {
  dateStr: string;
  timeStr: string;
  minutesFromMidnight: number;
  nowEpochMs: number;
} {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const getPart = (t: string) => parts.find((p) => p.type === t)?.value || '00';
  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const hour = getPart('hour');
  const minute = getPart('minute');

  const dateStr = `${year}-${month}-${day}`;
  const timeStr = `${hour}:${minute}`;
  const minutesFromMidnight = parseInt(hour, 10) * 60 + parseInt(minute, 10);

  return {
    dateStr,
    timeStr,
    minutesFromMidnight,
    nowEpochMs: now.getTime(),
  };
}

/**
 * Computes calendar day difference between two YYYY-MM-DD date strings.
 */
export function getDayDifference(targetDate: string, baseDate: string): number {
  const [ty, tm, td] = targetDate.split('-').map(Number);
  const [by, bm, bd] = baseDate.split('-').map(Number);
  const targetUtc = Date.UTC(ty, tm - 1, td);
  const baseUtc = Date.UTC(by, bm - 1, bd);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((targetUtc - baseUtc) / msPerDay);
}

/**
 * Validates booking window, lead time, and operating business hours in Asia/Tbilisi.
 */
export function validateBookingDateTime(
  date: string,
  startTime: string,
  endTime: string
): void {
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

  const startMin = timeStringToMinutes(startTime);
  const endMin = timeStringToMinutes(endTime);

  if (endMin <= startMin) {
    throw new BadRequestError('End time must be after start time', 'INVALID_TIME_INTERVAL');
  }

  const openMin = timeStringToMinutes(BUSINESS_OPEN_TIME);
  const closeMin = timeStringToMinutes(BUSINESS_CLOSE_TIME);

  if (startMin < openMin || endMin > closeMin) {
    throw new BadRequestError(
      `Booking must fall within business hours (${BUSINESS_OPEN_TIME} - ${BUSINESS_CLOSE_TIME})`,
      'OUTSIDE_BUSINESS_HOURS'
    );
  }

  // Lead time check if booking is on current day
  if (daysDiff === 0) {
    const leadTime = startMin - current.minutesFromMidnight;
    if (leadTime < MIN_LEAD_TIME_MINUTES) {
      throw new BadRequestError(
        `Booking requires at least ${MIN_LEAD_TIME_MINUTES} minutes advance lead time`,
        'INSUFFICIENT_LEAD_TIME'
      );
    }
  }
}
