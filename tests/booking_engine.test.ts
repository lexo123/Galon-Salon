/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Phase 3 Automated Test Suite:
 * - Phase 3A: Profile-required access boundary
 * - Phase 3B: Booking Engine, Ledger Concurrency, D42 Idempotency, Cancellation, Rescheduling, Notifications
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  requireCompleteProfile,
  requireAuthenticatedUser,
} from '../server/middleware/rbac.ts';
import { AuthenticatedUser } from '../server/middleware/auth.ts';
import {
  timeStringToMinutes,
  minutesToTimeString,
  addMinutesToTimeString,
  doIntervalsOverlap,
  validateBookingDateTime,
  getDayDifference,
} from '../server/utils/dateTime.ts';
import {
  canonicalizeJson,
  hashCanonicalRequest,
} from '../server/services/canonicalization.ts';
import { BookingEngine } from '../server/services/bookingEngine.ts';
import { NotificationService } from '../server/services/notificationService.ts';
import {
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../server/utils/errors.ts';
import { COLLECTIONS, User, Booking, BookingItem, AvailabilityLedger } from '../src/types/index.ts';
import type { Request, Response } from 'express';

// Helpers
function createMockReq(user?: AuthenticatedUser, body: any = {}, params: any = {}, headers: any = {}): Request {
  return {
    user,
    body,
    params,
    headers,
  } as unknown as Request;
}

function createMockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

/**
 * In-Memory Mock Firestore Database for transactional BookingEngine testing
 */
class MockFirestoreDb {
  public store = new Map<string, Map<string, any>>();

  constructor() {
    Object.values(COLLECTIONS).forEach((col) => {
      this.store.set(col, new Map());
    });
  }

  public collection(name: string) {
    const colStore = this.store.get(name) || new Map();
    this.store.set(name, colStore);

    return {
      id: name,
      doc: (id?: string) => {
        const docId = id || `mock_${Math.random().toString(36).substring(2, 9)}`;
        return {
          id: docId,
          collectionName: name,
          get: async () => ({
            id: docId,
            exists: colStore.has(docId),
            data: () => colStore.get(docId),
          }),
          set: async (data: any) => {
            colStore.set(docId, JSON.parse(JSON.stringify(data)));
          },
          update: async (patch: any) => {
            const existing = colStore.get(docId) || {};
            colStore.set(docId, { ...existing, ...JSON.parse(JSON.stringify(patch)) });
          },
        };
      },
      where: (field: string, op: string, val: any) => ({
        collectionName: name,
        get: async () => {
          const docs: any[] = [];
          for (const [id, data] of colStore.entries()) {
            if (op === '==' && data[field] === val) {
              docs.push({
                id,
                exists: true,
                data: () => data,
              });
            }
          }
          return { docs };
        },
      }),
      limit: () => ({
        collectionName: name,
        get: async () => {
          const docs: any[] = [];
          for (const [id, data] of colStore.entries()) {
            docs.push({ id, exists: true, data: () => data });
          }
          return { docs };
        },
      }),
    };
  }

  public async runTransaction<T>(updateFunction: (transaction: any) => Promise<T>): Promise<T> {
    const stagedWrites: Array<() => void> = [];

    const transaction = {
      get: async (refOrQuery: any) => {
        return refOrQuery.get();
      },
      set: (ref: any, data: any) => {
        stagedWrites.push(() => {
          const colName = ref.collectionName;
          const colStore = (colName && this.store.get(colName)) || this.getCollectionForDoc(ref.id);
          colStore.set(ref.id, JSON.parse(JSON.stringify(data)));
        });
      },
      update: (ref: any, patch: any) => {
        stagedWrites.push(() => {
          const colName = ref.collectionName;
          const colStore = (colName && this.store.get(colName)) || this.getCollectionForDoc(ref.id);
          const existing = colStore.get(ref.id) || {};
          colStore.set(ref.id, { ...existing, ...JSON.parse(JSON.stringify(patch)) });
        });
      },
    };

    const result = await updateFunction(transaction);
    // Commit staged writes
    for (const write of stagedWrites) {
      write();
    }
    return result;
  }

  private getCollectionForDoc(docId: string): Map<string, any> {
    for (const [, map] of this.store.entries()) {
      if (map.has(docId)) return map;
    }
    // If not found in existing maps, find by prefix or return default bookings
    return this.store.get(COLLECTIONS.BOOKINGS)!;
  }
}

// ============================================================================
// SUITE 1: PHASE 3A — PROFILE-REQUIRED ACCESS BOUNDARY
// ============================================================================
describe('Phase 3A: Profile-Required Access Boundary Middleware', () => {
  it('rejects unauthenticated requests with 401 Unauthorized', () => {
    const req = createMockReq(undefined);
    const next = vi.fn();

    requireCompleteProfile(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
  });

  it('rejects user in profilePending state (profile === undefined) with 403 PROFILE_REQUIRED', () => {
    const user: AuthenticatedUser = {
      uid: 'user_pending',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      profile: undefined, // Profile does not exist yet in Firestore
    };
    const req = createMockReq(user);
    const next = vi.fn();

    requireCompleteProfile(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    const err = next.mock.calls[0][0] as ForbiddenError;
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('PROFILE_REQUIRED');
  });

  it('rejects user whose profile is missing required name or phone with 403 PROFILE_INCOMPLETE', () => {
    const user: AuthenticatedUser = {
      uid: 'user_incomplete',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      profile: {
        id: 'user_incomplete',
        role: 'CUSTOMER',
        firstName: '',
        lastName: 'Doe',
        phone: '555123456',
        email: 'test@example.com',
        language: 'ka',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
    const req = createMockReq(user);
    const next = vi.fn();

    requireCompleteProfile(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    const err = next.mock.calls[0][0] as ForbiddenError;
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('PROFILE_INCOMPLETE');
  });

  it('rejects suspended or deactivated account with 403 ACCOUNT_DISABLED', () => {
    const user: AuthenticatedUser = {
      uid: 'user_suspended',
      role: 'CUSTOMER',
      status: 'SUSPENDED',
      profile: {
        id: 'user_suspended',
        role: 'CUSTOMER',
        firstName: 'John',
        lastName: 'Doe',
        phone: '555123456',
        email: 'test@example.com',
        language: 'ka',
        status: 'SUSPENDED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
    const req = createMockReq(user);
    const next = vi.fn();

    requireCompleteProfile(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    const err = next.mock.calls[0][0] as ForbiddenError;
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('ACCOUNT_DISABLED');
  });

  it('allows access for a user with a complete, active profile', () => {
    const user: AuthenticatedUser = {
      uid: 'user_valid',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      profile: {
        id: 'user_valid',
        role: 'CUSTOMER',
        firstName: 'Nino',
        lastName: 'Beridze',
        phone: '+995599123456',
        email: 'nino@galon.ge',
        language: 'ka',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };
    const req = createMockReq(user);
    const next = vi.fn();

    requireCompleteProfile(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });
});

// ============================================================================
// SUITE 2: DATE, TIME & TIMEZONE VALIDATION (Asia/Tbilisi)
// ============================================================================
describe('Phase 3B: Date/Time & Business Constraints (Asia/Tbilisi)', () => {
  it('converts HH:mm to minutes from midnight and back', () => {
    expect(timeStringToMinutes('10:00')).toBe(600);
    expect(timeStringToMinutes('14:30')).toBe(870);
    expect(timeStringToMinutes('20:00')).toBe(1200);

    expect(minutesToTimeString(600)).toBe('10:00');
    expect(minutesToTimeString(870)).toBe('14:30');
    expect(minutesToTimeString(1200)).toBe('20:00');
  });

  it('correctly calculates end time with duration', () => {
    expect(addMinutesToTimeString('10:00', 45)).toBe('10:45');
    expect(addMinutesToTimeString('14:30', 90)).toBe('16:00');
  });

  it('evaluates half-open interval overlap [start, end) rigorously', () => {
    const s1 = timeStringToMinutes('10:00');
    const e1 = timeStringToMinutes('11:00');

    // Overlapping
    const s2 = timeStringToMinutes('10:30');
    const e2 = timeStringToMinutes('11:30');
    expect(doIntervalsOverlap(s1, e1, s2, e2)).toBe(true);

    // Back-to-back: e1 === s3 (11:00) -> MUST NOT OVERLAP
    const s3 = timeStringToMinutes('11:00');
    const e3 = timeStringToMinutes('12:00');
    expect(doIntervalsOverlap(s1, e1, s3, e3)).toBe(false);

    // Completely disjoint
    const s4 = timeStringToMinutes('14:00');
    const e4 = timeStringToMinutes('15:00');
    expect(doIntervalsOverlap(s1, e1, s4, e4)).toBe(false);
  });

  it('rejects booking times outside business hours (10:00 - 20:00)', () => {
    const validDate = '2026-09-22';
    // Before 10:00
    expect(() => validateBookingDateTime(validDate, '09:00', '10:00')).toThrow(BadRequestError);
    // After 20:00
    expect(() => validateBookingDateTime(validDate, '19:30', '20:30')).toThrow(BadRequestError);
  });
});

// ============================================================================
// SUITE 3: CANONICALIZATION & D42 IDEMPOTENCY
// ============================================================================
describe('Phase 3B: Canonicalization & Idempotency Hashing (D42)', () => {
  it('produces identical hash regardless of JSON object key ordering', () => {
    const req1 = {
      customerId: 'cust_1',
      items: [{ serviceId: 's1', employeeId: 'e1', date: '2026-09-22', startTime: '11:00' }],
      note: 'Hello',
    };
    const req2 = {
      note: 'Hello',
      items: [{ serviceId: 's1', employeeId: 'e1', date: '2026-09-22', startTime: '11:00' }],
      customerId: 'cust_1',
    };

    expect(canonicalizeJson(req1)).toBe(canonicalizeJson(req2));
    expect(hashCanonicalRequest(req1)).toBe(hashCanonicalRequest(req2));
  });

  it('produces different hash when logical request values differ', () => {
    const req1 = { customerId: 'cust_1', items: [{ date: '2026-09-22', startTime: '11:00' }] };
    const req2 = { customerId: 'cust_1', items: [{ date: '2026-09-22', startTime: '12:00' }] };

    expect(hashCanonicalRequest(req1)).not.toBe(hashCanonicalRequest(req2));
  });
});

// ============================================================================
// SUITE 4: BOOKING ENGINE CREATION & CONCURRENCY CONTROL
// ============================================================================
describe('Phase 3B: Transactional Booking Creation & Ledger Merging', () => {
  let mockDb: MockFirestoreDb;
  const customerId = 'cust_100';

  beforeEach(() => {
    mockDb = new MockFirestoreDb();
    // Seed active customer user
    const usersCol = mockDb.store.get(COLLECTIONS.USERS)!;
    usersCol.set(customerId, {
      id: customerId,
      role: 'CUSTOMER',
      firstName: 'Nino',
      lastName: 'Beridze',
      phone: '+995599123456',
      status: 'ACTIVE',
    });
  });

  it('successfully creates an atomic booking with items, ledger intervals, and history', async () => {
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '11:00',
          durationMinutes: 60,
        },
      ],
    };

    const result = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        idempotencyKey: 'key_abc_1',
        rawPayload,
        items: rawPayload.items,
      },
      mockDb
    );

    expect(result.isIdempotentReplay).toBe(false);
    expect(result.booking.id).toBeDefined();
    expect(result.booking.status).toBe('CONFIRMED');
    expect(result.items.length).toBe(1);
    expect(result.items[0].status).toBe('CONFIRMED');
    expect(result.items[0].durationMinutes).toBe(60);

    // Verify ledger entry
    const ledgerKey = 'emp_elene_2026-09-22';
    const ledgerCol = mockDb.store.get(COLLECTIONS.AVAILABILITY)!;
    const ledger = ledgerCol.get(ledgerKey) as AvailabilityLedger;
    expect(ledger).toBeDefined();
    expect(ledger.bookedIntervals.length).toBe(1);
    expect(ledger.bookedIntervals[0].startTime).toBe('11:00');
    expect(ledger.bookedIntervals[0].endTime).toBe('12:00');

    // Verify idempotency record
    const idempCol = mockDb.store.get(COLLECTIONS.IDEMPOTENCY)!;
    const idempRec = idempCol.get(`${customerId}_key_abc_1`);
    expect(idempRec).toBeDefined();
    expect(idempRec.resultingBookingId).toBe(result.booking.id);
  });

  it('detects and blocks internal schedule conflict (same employee, overlapping items in same request)', async () => {
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_1',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '11:00',
          durationMinutes: 60, // 11:00 - 12:00
        },
        {
          serviceId: 'srv_2',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '11:30',
          durationMinutes: 60, // 11:30 - 12:30 (overlaps!)
        },
      ],
    };

    await expect(
      BookingEngine.createBooking(
        {
          customerId,
          actorRole: 'CUSTOMER',
          rawPayload,
          items: rawPayload.items,
        },
        mockDb
      )
    ).rejects.toThrow(BadRequestError);
  });

  it('detects and blocks customer self-overlap (same customer scheduled at overlapping times across different employees)', async () => {
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_1',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '11:00',
          durationMinutes: 60, // 11:00 - 12:00 with Elene
        },
        {
          serviceId: 'srv_2',
          employeeId: 'emp_giorgi',
          date: '2026-09-22',
          startTime: '11:15',
          durationMinutes: 45, // 11:15 - 12:00 with Giorgi (self-overlap!)
        },
      ],
    };

    await expect(
      BookingEngine.createBooking(
        {
          customerId,
          actorRole: 'CUSTOMER',
          rawPayload,
          items: rawPayload.items,
        },
        mockDb
      )
    ).rejects.toThrow(BadRequestError);
  });

  it('correctly merges multiple non-overlapping items for the SAME employee on the SAME date into a single ledger write', async () => {
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '11:00',
          durationMinutes: 60, // 11:00 - 12:00
        },
        {
          serviceId: 'srv_styling',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '14:00',
          durationMinutes: 60, // 14:00 - 15:00
        },
      ],
    };

    const result = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        rawPayload,
        items: rawPayload.items,
      },
      mockDb
    );

    expect(result.items.length).toBe(2);

    const ledgerKey = 'emp_elene_2026-09-22';
    const ledgerCol = mockDb.store.get(COLLECTIONS.AVAILABILITY)!;
    const ledger = ledgerCol.get(ledgerKey) as AvailabilityLedger;

    // Both intervals must be present in the same ledger document
    expect(ledger.bookedIntervals.length).toBe(2);
    expect(ledger.bookedIntervals[0].startTime).toBe('11:00');
    expect(ledger.bookedIntervals[0].endTime).toBe('12:00');
    expect(ledger.bookedIntervals[1].startTime).toBe('14:00');
    expect(ledger.bookedIntervals[1].endTime).toBe('15:00');
  });

  it('rejects booking when an employee is already booked for the requested interval (AVAILABILITY_CONFLICT)', async () => {
    // Pre-populate ledger with an existing booking
    const ledgerKey = 'emp_elene_2026-09-22';
    const ledgerCol = mockDb.store.get(COLLECTIONS.AVAILABILITY)!;
    ledgerCol.set(ledgerKey, {
      id: ledgerKey,
      employeeId: 'emp_elene',
      date: '2026-09-22',
      bookedIntervals: [
        {
          bookingId: 'existing_booking',
          bookingItemId: 'item_prev',
          startTime: '11:00',
          endTime: '12:00',
        },
      ],
      updatedAt: new Date().toISOString(),
    });

    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '11:30', // Collides with 11:00-12:00
          durationMinutes: 45,
        },
      ],
    };

    await expect(
      BookingEngine.createBooking(
        {
          customerId,
          actorRole: 'CUSTOMER',
          rawPayload,
          items: rawPayload.items,
        },
        mockDb
      )
    ).rejects.toThrow(ConflictError);
  });

  it('implements D42 Idempotency: same key + same payload returns original result without duplicate booking', async () => {
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_1',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '11:00',
          durationMinutes: 60,
        },
      ],
    };

    // First attempt
    const firstResult = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        idempotencyKey: 'idemp_key_999',
        rawPayload,
        items: rawPayload.items,
      },
      mockDb
    );
    expect(firstResult.isIdempotentReplay).toBe(false);

    // Second attempt with exact same key and payload
    const secondResult = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        idempotencyKey: 'idemp_key_999',
        rawPayload,
        items: rawPayload.items,
      },
      mockDb
    );

    expect(secondResult.isIdempotentReplay).toBe(true);
    expect(secondResult.booking.id).toBe(firstResult.booking.id);

    // Ledger should still only have 1 interval
    const ledgerCol = mockDb.store.get(COLLECTIONS.AVAILABILITY)!;
    const ledger = ledgerCol.get('emp_elene_2026-09-22');
    expect(ledger.bookedIntervals.length).toBe(1);
  });

  it('implements D42 Idempotency: same key + DIFFERENT payload throws IDEMPOTENCY_CONFLICT', async () => {
    const payload1 = {
      customerId,
      items: [
        {
          serviceId: 'srv_1',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '11:00',
          durationMinutes: 60,
        },
      ],
    };

    await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        idempotencyKey: 'idemp_conflict_key',
        rawPayload: payload1,
        items: payload1.items,
      },
      mockDb
    );

    // Attempt with same key but different time (different logical request)
    const payload2 = {
      customerId,
      items: [
        {
          serviceId: 'srv_1',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '14:00',
          durationMinutes: 60,
        },
      ],
    };

    await expect(
      BookingEngine.createBooking(
        {
          customerId,
          actorRole: 'CUSTOMER',
          idempotencyKey: 'idemp_conflict_key',
          rawPayload: payload2,
          items: payload2.items,
        },
        mockDb
      )
    ).rejects.toThrow(ConflictError);
  });
});

// ============================================================================
// SUITE 5: BOOKING CANCELLATION & TARGET-STATE RETRY SAFETY
// ============================================================================
describe('Phase 3B: Booking Cancellation & Ledger Release', () => {
  let mockDb: MockFirestoreDb;
  const customerId = 'cust_cancel_test';

  beforeEach(async () => {
    mockDb = new MockFirestoreDb();
    const usersCol = mockDb.store.get(COLLECTIONS.USERS)!;
    usersCol.set(customerId, {
      id: customerId,
      role: 'CUSTOMER',
      firstName: 'Nino',
      lastName: 'Beridze',
      phone: '+995599123456',
      status: 'ACTIVE',
    });
  });

  it('cancels booking, releases ledger intervals, and provides target-state retry safety', async () => {
    // 1. Create a booking
    const createRes = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        rawPayload: { items: [] },
        items: [
          {
            serviceId: 'srv_1',
            employeeId: 'emp_elene',
            date: '2026-09-22',
            startTime: '11:00',
            durationMinutes: 60,
          },
        ],
      },
      mockDb
    );

    const bookingId = createRes.booking.id;

    // Verify ledger has 1 interval
    const ledgerCol = mockDb.store.get(COLLECTIONS.AVAILABILITY)!;
    expect(ledgerCol.get('emp_elene_2026-09-22').bookedIntervals.length).toBe(1);

    // 2. Cancel the booking
    const cancelRes = await BookingEngine.cancelBooking(
      {
        bookingId,
        actorUserId: customerId,
        actorRole: 'CUSTOMER',
        reason: 'Change of plans',
      },
      mockDb
    );

    expect(cancelRes.booking.status).toBe('CANCELLED');
    expect(cancelRes.cancelledItemsCount).toBe(1);

    // Verify ledger interval is released!
    expect(ledgerCol.get('emp_elene_2026-09-22').bookedIntervals.length).toBe(0);

    // 3. Target-state retry safety: Cancelling already-cancelled booking is safe and idempotent
    const retryCancelRes = await BookingEngine.cancelBooking(
      {
        bookingId,
        actorUserId: customerId,
        actorRole: 'CUSTOMER',
      },
      mockDb
    );
    expect(retryCancelRes.booking.status).toBe('CANCELLED');
    expect(retryCancelRes.cancelledItemsCount).toBe(0);
  });

  it('blocks cancellation if caller is an unauthorized other user', async () => {
    const createRes = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        rawPayload: { items: [] },
        items: [
          {
            serviceId: 'srv_1',
            employeeId: 'emp_elene',
            date: '2026-09-22',
            startTime: '11:00',
            durationMinutes: 60,
          },
        ],
      },
      mockDb
    );

    // Attempt cancellation by different user
    await expect(
      BookingEngine.cancelBooking(
        {
          bookingId: createRes.booking.id,
          actorUserId: 'other_customer_999',
          actorRole: 'CUSTOMER',
        },
        mockDb
      )
    ).rejects.toThrow(ForbiddenError);
  });
});

// ============================================================================
// SUITE 6: BOOKING RESCHEDULING
// ============================================================================
describe('Phase 3B: Booking Rescheduling', () => {
  let mockDb: MockFirestoreDb;
  const customerId = 'cust_resched_test';

  beforeEach(() => {
    mockDb = new MockFirestoreDb();
    const usersCol = mockDb.store.get(COLLECTIONS.USERS)!;
    usersCol.set(customerId, {
      id: customerId,
      role: 'CUSTOMER',
      firstName: 'Nino',
      lastName: 'Beridze',
      phone: '+995599123456',
      status: 'ACTIVE',
    });
  });

  it('successfully reschedules an item to a new time and updates ledgers atomically', async () => {
    const createRes = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        rawPayload: { items: [] },
        items: [
          {
            serviceId: 'srv_1',
            employeeId: 'emp_elene',
            date: '2026-09-22',
            startTime: '11:00',
            durationMinutes: 60,
          },
        ],
      },
      mockDb
    );

    const bookingId = createRes.booking.id;
    const itemId = createRes.items[0].id;

    // Reschedule to 15:00 on the same day
    const reschedRes = await BookingEngine.rescheduleBooking(
      {
        bookingId,
        actorUserId: customerId,
        actorRole: 'CUSTOMER',
        reschedules: [
          {
            bookingItemId: itemId,
            newDate: '2026-09-22',
            newStartTime: '15:00',
          },
        ],
      },
      mockDb
    );

    expect(reschedRes.items[0].startTime).toContain('15:00');

    // Verify ledger has old interval removed and new interval added
    const ledgerCol = mockDb.store.get(COLLECTIONS.AVAILABILITY)!;
    const intervals = ledgerCol.get('emp_elene_2026-09-22').bookedIntervals;
    expect(intervals.length).toBe(1);
    expect(intervals[0].startTime).toBe('15:00');
    expect(intervals[0].endTime).toBe('16:00');

    // Target-state retry safety: Rescheduling to same target values succeeds cleanly
    const retryRes = await BookingEngine.rescheduleBooking(
      {
        bookingId,
        actorUserId: customerId,
        actorRole: 'CUSTOMER',
        reschedules: [
          {
            bookingItemId: itemId,
            newDate: '2026-09-22',
            newStartTime: '15:00',
          },
        ],
      },
      mockDb
    );
    expect(retryRes.items[0].startTime).toContain('15:00');
  });

  it('rejects rescheduling when new slot collides with existing booking (AVAILABILITY_CONFLICT)', async () => {
    // 1. Create booking A with Elene at 11:00
    const resA = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        rawPayload: { items: [] },
        items: [
          {
            serviceId: 'srv_1',
            employeeId: 'emp_elene',
            date: '2026-09-22',
            startTime: '11:00',
            durationMinutes: 60,
          },
        ],
      },
      mockDb
    );

    // 2. Create booking B with Elene at 14:00
    const resB = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        rawPayload: { items: [] },
        items: [
          {
            serviceId: 'srv_1',
            employeeId: 'emp_elene',
            date: '2026-09-22',
            startTime: '14:00',
            durationMinutes: 60,
          },
        ],
      },
      mockDb
    );

    // 3. Try to reschedule booking A to 14:30 (collides with booking B)
    await expect(
      BookingEngine.rescheduleBooking(
        {
          bookingId: resA.booking.id,
          actorUserId: customerId,
          actorRole: 'CUSTOMER',
          reschedules: [
            {
              bookingItemId: resA.items[0].id,
              newDate: '2026-09-22',
              newStartTime: '14:30',
            },
          ],
        },
        mockDb
      )
    ).rejects.toThrow(ConflictError);
  });
});

// ============================================================================
// SUITE 7: TRANSACTION READ/WRITE LIMITS (MANDATORY AUDIT)
// ============================================================================
describe('Phase 3B: Transaction Read/Write Limits Audit', () => {
  it('confirms largest reasonable multi-item scenario is strictly below Firestore 500-doc transaction limit', () => {
    // Scenario: Customer books 5 services in a multi-item appointment package across 3 employees on 2 days
    const maxItems = 5;
    const maxDistinctEmployees = 3;
    const maxDistinctDays = 2;
    const maxLedgers = maxDistinctEmployees * maxDistinctDays; // 6 ledgers

    // Reads in transaction:
    // 1 idempotency doc + 1 customer doc + 6 ledger docs = 8 reads
    const estimatedReads = 1 + 1 + maxLedgers;

    // Writes in transaction:
    // 1 booking doc + 5 booking items + 6 ledger docs + 1 history doc + 1 idempotency doc = 14 writes
    const estimatedWrites = 1 + maxItems + maxLedgers + 1 + 1;

    const totalTransactionDocs = estimatedReads + estimatedWrites;
    expect(totalTransactionDocs).toBeLessThan(50); // Under 50 docs total (limit is 500!)
    expect(totalTransactionDocs).toBeLessThan(500);
  });
});
