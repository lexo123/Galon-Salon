import { describe, it, expect } from 'vitest';
import {
  BUSINESS_TIMEZONE,
  DEFAULT_CURRENCY,
  DEFAULT_LANGUAGE,
  COLLECTIONS,
  isBlockingBookingItemStatus,
  isTerminalBookingStatus,
  isCustomerFacingActive,
} from '../src/types/index.ts';
import {
  assertString,
  assertEnum,
  assertId,
  assertDateString,
  assertTimeString,
} from '../server/utils/validation.ts';
import {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
} from '../server/utils/errors.ts';

describe('Phase 1 Foundation: Timezone & Domain Constants', () => {
  it('enforces Asia/Tbilisi as the authoritative business timezone', () => {
    expect(BUSINESS_TIMEZONE).toBe('Asia/Tbilisi');
  });

  it('provides authoritative default currency and language', () => {
    expect(DEFAULT_CURRENCY).toBe('GEL');
    expect(DEFAULT_LANGUAGE).toBe('ka');
  });

  it('defines all required core collection names', () => {
    expect(COLLECTIONS.USERS).toBe('users');
    expect(COLLECTIONS.EMPLOYEES).toBe('employees');
    expect(COLLECTIONS.BOOKINGS).toBe('bookings');
    expect(COLLECTIONS.BOOKING_ITEMS).toBe('bookingItems');
    expect(COLLECTIONS.AVAILABILITY).toBe('availability');
    expect(COLLECTIONS.IDEMPOTENCY).toBe('idempotency');
    expect(COLLECTIONS.CUSTOMER_RATINGS).toBe('customerRatings');
    expect(COLLECTIONS.AUDIT_LOGS).toBe('auditLogs');
  });
});

describe('Phase 1 Foundation: Business Status Helpers', () => {
  it('correctly identifies booking item blocking status', () => {
    expect(isBlockingBookingItemStatus('CONFIRMED')).toBe(true);
    expect(isBlockingBookingItemStatus('CANCELLED')).toBe(false);
    expect(isBlockingBookingItemStatus('COMPLETED')).toBe(false);
  });

  it('correctly identifies terminal booking status', () => {
    expect(isTerminalBookingStatus('CANCELLED')).toBe(true);
    expect(isTerminalBookingStatus('COMPLETED')).toBe(true);
    expect(isTerminalBookingStatus('CONFIRMED')).toBe(false);
  });

  it('correctly validates customer-facing active staff', () => {
    expect(isCustomerFacingActive({ employeeType: 'CUSTOMER_FACING', status: 'ACTIVE' })).toBe(true);
    expect(isCustomerFacingActive({ employeeType: 'INTERNAL', status: 'ACTIVE' })).toBe(false);
    expect(isCustomerFacingActive({ employeeType: 'CUSTOMER_FACING', status: 'DEACTIVATED' })).toBe(false);
  });
});

describe('Phase 1 Foundation: Validation Infrastructure', () => {
  it('validates string constraints', () => {
    expect(assertString('Hello', 'greeting', 1, 10)).toBe('Hello');
    expect(() => assertString('', 'greeting', 1, 10)).toThrow(BadRequestError);
  });

  it('validates allowed enums', () => {
    const roles = ['CUSTOMER', 'EMPLOYEE', 'ADMIN', 'OWNER'] as const;
    expect(assertEnum('ADMIN', 'role', roles)).toBe('ADMIN');
    expect(() => assertEnum('SUPERADMIN', 'role', roles)).toThrow(BadRequestError);
  });

  it('validates sanitized ID strings', () => {
    expect(assertId('emp_123', 'id')).toBe('emp_123');
    expect(assertId('valid-id-01', 'id')).toBe('valid-id-01');
    expect(() => assertId('bad id with spaces!', 'id')).toThrow(BadRequestError);
  });

  it('validates date and time format', () => {
    expect(assertDateString('2026-09-09', 'date')).toBe('2026-09-09');
    expect(() => assertDateString('09-09-2026', 'date')).toThrow(BadRequestError);

    expect(assertTimeString('14:30', 'time')).toBe('14:30');
    expect(() => assertTimeString('25:99', 'time')).toThrow(BadRequestError);
  });
});

describe('Phase 1 Foundation: Backend Error Classes', () => {
  it('constructs correct HTTP status codes and machine-readable error codes', () => {
    const unauth = new UnauthorizedError('Auth needed');
    expect(unauth.statusCode).toBe(401);
    expect(unauth.code).toBe('UNAUTHORIZED');

    const forbidden = new ForbiddenError('No entry');
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.code).toBe('FORBIDDEN');

    const badReq = new BadRequestError('Bad input');
    expect(badReq.statusCode).toBe(400);
    expect(badReq.code).toBe('BAD_REQUEST');
  });
});
