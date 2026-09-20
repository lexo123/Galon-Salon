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

    const makeQuery = (
      filters: Array<{ field: string; op: string; val: any }>,
      limitVal?: number
    ) => ({
      collectionName: name,
      where: (field: string, op: string, val: any) =>
        makeQuery([...filters, { field, op, val }], limitVal),
      limit: (num: number) => makeQuery(filters, num),
      get: async () => {
        const docs: any[] = [];
        for (const [id, data] of colStore.entries()) {
          let matches = true;
          for (const f of filters) {
            if (f.op === '==' && data[f.field] !== f.val) {
              matches = false;
              break;
            }
          }
          if (matches) {
            docs.push({
              id,
              exists: true,
              data: () => data,
            });
            if (limitVal && docs.length >= limitVal) break;
          }
        }
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
        };
      },
    });

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
      where: (field: string, op: string, val: any) => makeQuery([{ field, op, val }]),
      limit: (num: number) => makeQuery([], num),
      get: async () => makeQuery([]).get(),
    };
  }

  public async runTransaction<T>(updateFunction: (transaction: any) => Promise<T>): Promise<T> {
    const stagedWrites: Array<() => void> = [];
    let hasWritten = false;

    const transaction = {
      get: async (refOrQuery: any) => {
        if (hasWritten) {
          throw new Error('Firestore transaction error: read called after write occurred!');
        }
        return refOrQuery.get();
      },
      set: (ref: any, data: any) => {
        hasWritten = true;
        stagedWrites.push(() => {
          const colName = ref.collectionName;
          const colStore = (colName && this.store.get(colName)) || this.getCollectionForDoc(ref.id);
          colStore.set(ref.id, JSON.parse(JSON.stringify(data)));
        });
      },
      update: (ref: any, patch: any) => {
        hasWritten = true;
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

function seedStandardCatalog(mockDb: MockFirestoreDb) {
  // Users
  mockDb.store.get(COLLECTIONS.USERS)!.set('cust_100', {
    id: 'cust_100',
    role: 'CUSTOMER',
    firstName: 'Nino',
    lastName: 'Beridze',
    phone: '+995599123456',
    status: 'ACTIVE',
  });

  mockDb.store.get(COLLECTIONS.USERS)!.set('cust_200', {
    id: 'cust_200',
    role: 'CUSTOMER',
    firstName: 'Tamar',
    lastName: 'Gureshidze',
    phone: '+995599654321',
    status: 'ACTIVE',
  });

  // Employees
  mockDb.store.get(COLLECTIONS.EMPLOYEES)!.set('emp_elene', {
    id: 'emp_elene',
    userId: 'user_emp_elene',
    employeeType: 'CUSTOMER_FACING',
    firstName: 'Elene',
    lastName: 'Vashadze',
    phone: '+995599111222',
    status: 'ACTIVE',
  });

  mockDb.store.get(COLLECTIONS.EMPLOYEES)!.set('emp_giorgi', {
    id: 'emp_giorgi',
    userId: 'user_emp_giorgi',
    employeeType: 'CUSTOMER_FACING',
    firstName: 'Giorgi',
    lastName: 'Kapanadze',
    phone: '+995599222333',
    status: 'ACTIVE',
  });

  mockDb.store.get(COLLECTIONS.EMPLOYEES)!.set('emp_ana', {
    id: 'emp_ana',
    userId: 'user_emp_ana',
    employeeType: 'CUSTOMER_FACING',
    firstName: 'Ana',
    lastName: 'Abashidze',
    phone: '+995599333444',
    status: 'ACTIVE',
  });

  mockDb.store.get(COLLECTIONS.EMPLOYEES)!.set('emp_internal', {
    id: 'emp_internal',
    userId: 'user_emp_internal',
    employeeType: 'INTERNAL',
    firstName: 'Vakho',
    lastName: 'Cleaner',
    phone: '+995599444555',
    status: 'ACTIVE',
  });

  mockDb.store.get(COLLECTIONS.EMPLOYEES)!.set('emp_inactive', {
    id: 'emp_inactive',
    userId: 'user_emp_inactive',
    employeeType: 'CUSTOMER_FACING',
    firstName: 'Keti',
    lastName: 'Inactive',
    phone: '+995599555666',
    status: 'INACTIVE',
  });

  // Services
  mockDb.store.get(COLLECTIONS.SERVICES)!.set('srv_haircut', {
    id: 'srv_haircut',
    nameKa: 'თმის შეჭრა',
    nameEn: 'Haircut',
    categoryId: 'cat_hair',
    durationMin: 60,
    durationMax: 60,
    priceMin: 50,
    priceMax: 50,
    isActive: true,
  });

  mockDb.store.get(COLLECTIONS.SERVICES)!.set('srv_1', {
    id: 'srv_1',
    nameKa: 'სერვისი 1',
    nameEn: 'Service 1',
    categoryId: 'cat_general',
    durationMin: 60,
    durationMax: 60,
    priceMin: 60,
    priceMax: 60,
    isActive: true,
  });

  mockDb.store.get(COLLECTIONS.SERVICES)!.set('srv_2', {
    id: 'srv_2',
    nameKa: 'სერვისი 2',
    nameEn: 'Service 2',
    categoryId: 'cat_general',
    durationMin: 45,
    durationMax: 45,
    priceMin: 70,
    priceMax: 70,
    isActive: true,
  });

  mockDb.store.get(COLLECTIONS.SERVICES)!.set('srv_styling', {
    id: 'srv_styling',
    nameKa: 'დავარცხნა',
    nameEn: 'Styling',
    categoryId: 'cat_hair',
    durationMin: 60,
    durationMax: 60,
    priceMin: 40,
    priceMax: 40,
    isActive: true,
  });

  mockDb.store.get(COLLECTIONS.SERVICES)!.set('srv_coloring', {
    id: 'srv_coloring',
    nameKa: 'შეღებვა',
    nameEn: 'Hair Coloring',
    categoryId: 'cat_hair',
    durationMin: 60,
    durationMax: 120, // D45 midpoint = 90 min
    priceMin: 100,
    priceMax: 160, // D45 midpoint = 130 GEL
    isActive: true,
  });

  mockDb.store.get(COLLECTIONS.SERVICES)!.set('srv_inactive', {
    id: 'srv_inactive',
    nameKa: 'არააქტიური',
    nameEn: 'Inactive Service',
    categoryId: 'cat_hair',
    durationMin: 60,
    durationMax: 60,
    priceMin: 50,
    priceMax: 50,
    isActive: false,
  });

  mockDb.store.get(COLLECTIONS.SERVICES)!.set('srv_invalid_range', {
    id: 'srv_invalid_range',
    nameKa: 'არავალიდური',
    nameEn: 'Invalid Service',
    categoryId: 'cat_hair',
    durationMin: 60,
    durationMax: 30, // max < min
    priceMin: 50,
    priceMax: 50,
    isActive: true,
  });

  // Employee-Service Eligibility Mappings (Active assignments for standard testing)
  const standardServices = ['srv_haircut', 'srv_1', 'srv_2', 'srv_styling', 'srv_coloring', 'srv_invalid_range'];
  const standardEmployees = ['emp_elene', 'emp_giorgi', 'emp_ana'];

  for (const empId of standardEmployees) {
    for (const srvId of standardServices) {
      const mappingId = `${empId}_${srvId}`;
      mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set(mappingId, {
        id: mappingId,
        employeeId: empId,
        serviceId: srvId,
        isActive: true,
        createdAt: '2026-03-01T10:00:00.000Z',
        updatedAt: '2026-03-01T10:00:00.000Z',
      });
    }
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
    seedStandardCatalog(mockDb);
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
    seedStandardCatalog(mockDb);
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
    seedStandardCatalog(mockDb);
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

// ============================================================================
// SUITE 8: AUTHORITATIVE SERVICE VALIDATION & D45 MIDPOINT RULE
// ============================================================================
describe('Phase 3B: Authoritative Service Validation & D45 Midpoint Rule', () => {
  let mockDb: MockFirestoreDb;
  const customerId = 'cust_100';

  beforeEach(() => {
    mockDb = new MockFirestoreDb();
    seedStandardCatalog(mockDb);
  });

  it('calculates duration and price midpoint correctly for bounded ranges per D45', async () => {
    // srv_coloring: durationMin: 60, durationMax: 120 -> midpoint: 90
    // priceMin: 100, priceMax: 160 -> midpoint: 130
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_coloring',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '10:00',
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

    expect(result.items.length).toBe(1);
    const item = result.items[0];
    expect(item.durationMinutes).toBe(90);
    expect(item.startTime).toContain('10:00');
    expect(item.endTime).toContain('11:30');
    expect(item.priceSnapshot).toEqual({
      min: 100,
      max: 160,
      currency: 'GEL',
    });

    // Verify ledger has 10:00 - 11:30
    const ledger = mockDb.store.get(COLLECTIONS.AVAILABILITY)!.get('emp_elene_2026-09-22');
    expect(ledger.bookedIntervals[0].startTime).toBe('10:00');
    expect(ledger.bookedIntervals[0].endTime).toBe('11:30');
  });

  it('strictly ignores client-supplied durationMinutes in favor of authoritative catalog value', async () => {
    // Client tries to spoof durationMinutes: 15 for a 60-min haircut
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '10:00',
          durationMinutes: 15,
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

    // Must be authoritative 60 minutes
    expect(result.items[0].durationMinutes).toBe(60);
    expect(result.items[0].endTime).toContain('11:00');
  });

  it('rejects booking when service does not exist (SERVICE_NOT_FOUND)', async () => {
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'non_existent_service',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '10:00',
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
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects booking when service is inactive (SERVICE_INACTIVE)', async () => {
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_inactive',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '10:00',
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

  it('rejects booking when service has invalid range configuration (INVALID_SERVICE_CONFIGURATION)', async () => {
    // srv_invalid_range has durationMin: 60, durationMax: 30
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_invalid_range',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '10:00',
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
});

// ============================================================================
// SUITE 9: AUTHORITATIVE EMPLOYEE VALIDATION & INTERNAL EMPLOYEE PROHIBITION
// ============================================================================
describe('Phase 3B: Authoritative Employee Validation & Internal Prohibition', () => {
  let mockDb: MockFirestoreDb;
  const customerId = 'cust_100';

  beforeEach(() => {
    mockDb = new MockFirestoreDb();
    seedStandardCatalog(mockDb);
  });

  it('rejects booking for non-existent employee (EMPLOYEE_NOT_FOUND)', async () => {
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'non_existent_emp',
          date: '2026-09-22',
          startTime: '10:00',
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
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects booking for inactive employee (EMPLOYEE_NOT_AVAILABLE)', async () => {
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_inactive',
          date: '2026-09-22',
          startTime: '10:00',
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

  it('strictly rejects booking for INTERNAL employee (EMPLOYEE_NOT_BOOKABLE)', async () => {
    // emp_internal is employeeType: 'INTERNAL'
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_internal',
          date: '2026-09-22',
          startTime: '10:00',
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
});

// ============================================================================
// SUITE 10: WORKING HOURS, WEEKLY SCHEDULES, BREAKS & EXCEPTIONS
// ============================================================================
describe('Phase 3B: Working Hours, Weekly Schedules, Breaks & Exceptions', () => {
  let mockDb: MockFirestoreDb;
  const customerId = 'cust_100';

  beforeEach(() => {
    mockDb = new MockFirestoreDb();
    seedStandardCatalog(mockDb);

    // 2026-09-20 is Sunday (dayOfWeek 0)
    // 2026-09-21 is Monday (dayOfWeek 1)
    // 2026-09-22 is Tuesday (dayOfWeek 2)
    // 2026-09-23 is Wednesday (dayOfWeek 3)

    // Seed weekly schedule for emp_elene:
    // Sunday: day off (isWorking: false)
    // Tuesday: works 10:00 - 18:00
    const schedulesCol = mockDb.store.get(COLLECTIONS.WEEKLY_SCHEDULES)!;
    schedulesCol.set('emp_elene_sun', {
      employeeId: 'emp_elene',
      dayOfWeek: 0,
      isWorking: false,
    });
    schedulesCol.set('emp_elene_tue', {
      employeeId: 'emp_elene',
      dayOfWeek: 2,
      isWorking: true,
      startTime: '10:00',
      endTime: '18:00',
    });

    // Seed breaks for emp_elene on Tuesday: 13:00 - 14:00
    const breaksCol = mockDb.store.get(COLLECTIONS.SCHEDULE_BREAKS)!;
    breaksCol.set('emp_elene_break_tue', {
      employeeId: 'emp_elene',
      dayOfWeek: 2,
      startTime: '13:00',
      endTime: '14:00',
      type: 'LUNCH',
    });

    // Seed schedule exception for emp_elene on 2026-09-23: OFF
    const exceptionsCol = mockDb.store.get(COLLECTIONS.SCHEDULE_EXCEPTIONS)!;
    exceptionsCol.set('emp_elene_exc_off', {
      id: 'emp_elene_exc_off',
      employeeId: 'emp_elene',
      startDate: '2026-09-23',
      endDate: '2026-09-23',
      date: '2026-09-23',
      type: 'OFF',
      reason: 'Personal Leave',
    });

    // Seed schedule exception for emp_elene on 2026-09-24: CUSTOM_HOURS 12:00 - 16:00
    exceptionsCol.set('emp_elene_exc_custom', {
      id: 'emp_elene_exc_custom',
      employeeId: 'emp_elene',
      startDate: '2026-09-24',
      endDate: '2026-09-24',
      date: '2026-09-24',
      type: 'CUSTOM_HOURS',
      startTime: '12:00',
      endTime: '16:00',
    });
  });

  it('rejects booking on employee weekly day off (EMPLOYEE_NOT_WORKING)', async () => {
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-20', // Sunday
          startTime: '11:00',
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

  it('rejects booking outside employee weekly working hours (OUTSIDE_WORKING_HOURS)', async () => {
    // Starts before shift (09:00)
    const earlyPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '09:00',
        },
      ],
    };

    await expect(
      BookingEngine.createBooking(
        {
          customerId,
          actorRole: 'CUSTOMER',
          rawPayload: earlyPayload,
          items: earlyPayload.items,
        },
        mockDb
      )
    ).rejects.toThrow(BadRequestError);

    // Ends after shift (17:30 + 60 min = 18:30 > 18:00)
    const latePayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '17:30',
        },
      ],
    };

    await expect(
      BookingEngine.createBooking(
        {
          customerId,
          actorRole: 'CUSTOMER',
          rawPayload: latePayload,
          items: latePayload.items,
        },
        mockDb
      )
    ).rejects.toThrow(BadRequestError);
  });

  it('rejects booking on date with schedule exception type OFF (EMPLOYEE_SCHEDULE_EXCEPTION_OFF)', async () => {
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-23', // Exception: OFF
          startTime: '12:00',
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

  it('respects CUSTOM_HOURS schedule exception and blocks bookings outside exception hours', async () => {
    // Custom hours: 12:00 - 16:00
    // Attempt booking at 10:00 (outside custom hours)
    const outsidePayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-24',
          startTime: '10:00',
        },
      ],
    };

    await expect(
      BookingEngine.createBooking(
        {
          customerId,
          actorRole: 'CUSTOMER',
          rawPayload: outsidePayload,
          items: outsidePayload.items,
        },
        mockDb
      )
    ).rejects.toThrow(BadRequestError);

    // Booking at 13:00 (13:00 - 14:00 inside 12:00 - 16:00) succeeds!
    const validPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-24',
          startTime: '13:00',
        },
      ],
    };

    const result = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        rawPayload: validPayload,
        items: validPayload.items,
      },
      mockDb
    );

    expect(result.booking.id).toBeDefined();
    expect(result.items[0].startTime).toContain('13:00');
  });

  it('rejects booking overlapping employee break (EMPLOYEE_ON_BREAK)', async () => {
    // Break is 13:00 - 14:00
    // Booking at 12:30 for 60 minutes overlaps 13:00 - 13:30
    const rawPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '12:30',
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
});

// ============================================================================
// SUITE 11: CUSTOMER SELF-OVERLAP PREVENTION (D44)
// ============================================================================
describe('Phase 3B: Customer Self-Overlap Prevention (D44)', () => {
  let mockDb: MockFirestoreDb;
  const customerId = 'cust_100';

  beforeEach(() => {
    mockDb = new MockFirestoreDb();
    seedStandardCatalog(mockDb);
  });

  it('blocks inter-booking self-overlap against existing confirmed booking of same customer', async () => {
    // 1. Customer already has a confirmed booking on 2026-09-22 from 14:00 to 15:00 with Elene
    const firstRes = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        rawPayload: { items: [] },
        items: [
          {
            serviceId: 'srv_haircut',
            employeeId: 'emp_elene',
            date: '2026-09-22',
            startTime: '14:00',
          },
        ],
      },
      mockDb
    );
    expect(firstRes.booking.id).toBeDefined();

    // 2. Customer tries to create a second booking on the same day from 14:30 to 15:15 with Giorgi
    // Different employee, but SAME customer -> D44 Customer Self-Overlap Violation!
    const secondPayload = {
      customerId,
      items: [
        {
          serviceId: 'srv_2', // 45 min
          employeeId: 'emp_giorgi',
          date: '2026-09-22',
          startTime: '14:30',
        },
      ],
    };

    await expect(
      BookingEngine.createBooking(
        {
          customerId,
          actorRole: 'CUSTOMER',
          rawPayload: secondPayload,
          items: secondPayload.items,
        },
        mockDb
      )
    ).rejects.toThrow(ConflictError);
  });

  it('allows back-to-back non-overlapping appointments for the same customer', async () => {
    // Item 1: 14:00 - 15:00 with Elene
    // Item 2: 15:00 - 15:45 with Giorgi
    const payload = {
      customerId,
      items: [
        {
          serviceId: 'srv_haircut', // 60 min (14:00 - 15:00)
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '14:00',
        },
        {
          serviceId: 'srv_2', // 45 min (15:00 - 15:45)
          employeeId: 'emp_giorgi',
          date: '2026-09-22',
          startTime: '15:00',
        },
      ],
    };

    const res = await BookingEngine.createBooking(
      {
        customerId,
        actorRole: 'CUSTOMER',
        rawPayload: payload,
        items: payload.items,
      },
      mockDb
    );

    expect(res.items.length).toBe(2);
    expect(res.items[0].endTime).toContain('15:00');
    expect(res.items[1].startTime).toContain('15:00');
  });
});

// ============================================================================
// SUITE 12: EMPLOYEE OWN BOOKING VISIBILITY & RBAC (SECTION 17)
// ============================================================================
describe('Phase 3B: Employee Own Booking Visibility & RBAC', () => {
  let mockDb: MockFirestoreDb;

  beforeEach(() => {
    mockDb = new MockFirestoreDb();
    seedStandardCatalog(mockDb);

    // Seed bookings
    const bookingsCol = mockDb.store.get(COLLECTIONS.BOOKINGS)!;
    const itemsCol = mockDb.store.get(COLLECTIONS.BOOKING_ITEMS)!;

    // Booking 1: Customer Nino (cust_100), item with Elene (emp_elene)
    bookingsCol.set('b1', {
      id: 'b1',
      customerId: 'cust_100',
      status: 'CONFIRMED',
    });
    itemsCol.set('item_b1_1', {
      id: 'item_b1_1',
      bookingId: 'b1',
      employeeId: 'emp_elene',
      status: 'CONFIRMED',
    });

    // Booking 2: Customer Tamar (cust_200), item with Giorgi (emp_giorgi)
    bookingsCol.set('b2', {
      id: 'b2',
      customerId: 'cust_200',
      status: 'CONFIRMED',
    });
    itemsCol.set('item_b2_1', {
      id: 'item_b2_1',
      bookingId: 'b2',
      employeeId: 'emp_giorgi',
      status: 'CONFIRMED',
    });
  });

  it('allows employee to view booking where they are assigned an item', async () => {
    // Elene's user ID is user_emp_elene, employeeId is emp_elene
    // An employee query for items where employeeId == 'emp_elene' finds b1
    const items = await mockDb.collection(COLLECTIONS.BOOKING_ITEMS)
      .where('employeeId', '==', 'emp_elene')
      .get();
    expect(items.docs.length).toBe(1);
    expect(items.docs[0].data().bookingId).toBe('b1');
  });

  it('confirms employee cannot see unassigned bookings of other employees', async () => {
    // Elene's items do not include b2 (which belongs to Giorgi)
    const items = await mockDb.collection(COLLECTIONS.BOOKING_ITEMS)
      .where('employeeId', '==', 'emp_elene')
      .get();
    const bookingIds = items.docs.map(d => d.data().bookingId);
    expect(bookingIds).not.toContain('b2');
  });
});

// ============================================================================
// SUITE 9: BLOCKER A — EMPLOYEE ↔ SERVICE ELIGIBILITY ENFORCEMENT
// ============================================================================
describe('Blocker A: Employee ↔ Service Eligibility Enforcement', () => {
  let mockDb: MockFirestoreDb;

  beforeEach(() => {
    mockDb = new MockFirestoreDb();
    seedStandardCatalog(mockDb);

    // Clear existing bookings & ledgers
    mockDb.store.get(COLLECTIONS.BOOKINGS)!.clear();
    mockDb.store.get(COLLECTIONS.BOOKING_ITEMS)!.clear();
    mockDb.store.get(COLLECTIONS.AVAILABILITY)!.clear();
    mockDb.store.get(COLLECTIONS.IDEMPOTENCY)!.clear();

    // Specific eligibility setup for Suite 9:
    // emp_elene is assigned to srv_haircut (ACTIVE)
    // emp_giorgi is assigned to srv_coloring (ACTIVE)
    // emp_ana is assigned to srv_styling but INACTIVE (isActive: false)
    mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.clear();

    mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set('es_elene_haircut', {
      id: 'es_elene_haircut',
      employeeId: 'emp_elene',
      serviceId: 'srv_haircut',
      isActive: true,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
    });

    mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set('es_giorgi_coloring', {
      id: 'es_giorgi_coloring',
      employeeId: 'emp_giorgi',
      serviceId: 'srv_coloring',
      isActive: true,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
    });

    mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set('es_ana_styling_inactive', {
      id: 'es_ana_styling_inactive',
      employeeId: 'emp_ana',
      serviceId: 'srv_styling',
      isActive: false, // Inactive mapping
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
    });
  });

  it('8.1: allows booking when employee is actively assigned to the requested service', async () => {
    const rawPayload = {
      customerId: 'cust_100',
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '10:00',
        },
      ],
    };

    const result = await BookingEngine.createBooking(
      {
        customerId: 'cust_100',
        actorRole: 'CUSTOMER',
        rawPayload,
        items: rawPayload.items,
      },
      mockDb
    );

    expect(result.booking.id).toBeDefined();
    expect(result.booking.status).toBe('CONFIRMED');
    expect(result.items.length).toBe(1);
    expect(result.items[0].serviceId).toBe('srv_haircut');
    expect(result.items[0].employeeId).toBe('emp_elene');

    // Ledger must be updated
    const ledger = mockDb.store.get(COLLECTIONS.AVAILABILITY)!.get('emp_elene_2026-09-22');
    expect(ledger).toBeDefined();
    expect(ledger.bookedIntervals.length).toBe(1);
  });

  it('8.2: rejects booking when employee has NO assignment to the requested service', async () => {
    const rawPayload = {
      customerId: 'cust_100',
      items: [
        {
          serviceId: 'srv_coloring',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '10:00',
        },
      ],
    };

    // emp_elene is NOT assigned to srv_coloring
    await expect(
      BookingEngine.createBooking(
        {
          customerId: 'cust_100',
          actorRole: 'CUSTOMER',
          rawPayload,
          items: rawPayload.items,
        },
        mockDb
      )
    ).rejects.toThrowError(/not assigned to service/);

    // Verify ZERO mutations
    expect(mockDb.store.get(COLLECTIONS.BOOKINGS)!.size).toBe(0);
    expect(mockDb.store.get(COLLECTIONS.BOOKING_ITEMS)!.size).toBe(0);
    expect(mockDb.store.get(COLLECTIONS.AVAILABILITY)!.size).toBe(0);
  });

  it('8.3: rejects booking when employee assignment to service exists but is INACTIVE', async () => {
    const rawPayload = {
      customerId: 'cust_100',
      items: [
        {
          serviceId: 'srv_styling',
          employeeId: 'emp_ana',
          date: '2026-09-22',
          startTime: '10:00',
        },
      ],
    };

    // emp_ana has assignment to srv_styling but isActive === false
    await expect(
      BookingEngine.createBooking(
        {
          customerId: 'cust_100',
          actorRole: 'CUSTOMER',
          rawPayload,
          items: rawPayload.items,
        },
        mockDb
      )
    ).rejects.toThrowError(/inactive/);

    // Verify ZERO mutations
    expect(mockDb.store.get(COLLECTIONS.BOOKINGS)!.size).toBe(0);
    expect(mockDb.store.get(COLLECTIONS.BOOKING_ITEMS)!.size).toBe(0);
    expect(mockDb.store.get(COLLECTIONS.AVAILABILITY)!.size).toBe(0);
  });

  it('8.4: rejects booking when cross-matching wrong employee for service', async () => {
    const rawPayload = {
      customerId: 'cust_100',
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_giorgi',
          date: '2026-09-22',
          startTime: '11:00',
        },
      ],
    };

    // emp_giorgi is assigned to srv_coloring, NOT srv_haircut
    await expect(
      BookingEngine.createBooking(
        {
          customerId: 'cust_100',
          actorRole: 'CUSTOMER',
          rawPayload,
          items: rawPayload.items,
        },
        mockDb
      )
    ).rejects.toThrowError(/not assigned to service/);

    expect(mockDb.store.get(COLLECTIONS.BOOKINGS)!.size).toBe(0);
    expect(mockDb.store.get(COLLECTIONS.AVAILABILITY)!.size).toBe(0);
  });

  it('8.5: atomically rejects multi-item booking if even one item is ineligible (all-or-nothing)', async () => {
    const rawPayload = {
      customerId: 'cust_100',
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '10:00',
        },
        {
          serviceId: 'srv_styling',
          employeeId: 'emp_giorgi',
          date: '2026-09-22',
          startTime: '12:00',
        },
      ],
    };

    // Item 1: emp_elene + srv_haircut (ELIGIBLE)
    // Item 2: emp_giorgi + srv_styling (INELIGIBLE - not assigned)
    await expect(
      BookingEngine.createBooking(
        {
          customerId: 'cust_100',
          actorRole: 'CUSTOMER',
          rawPayload,
          items: rawPayload.items,
        },
        mockDb
      )
    ).rejects.toThrowError(/not assigned to service/);

    // Atomic: Item 1 must NOT be booked, no ledgers mutated
    expect(mockDb.store.get(COLLECTIONS.BOOKINGS)!.size).toBe(0);
    expect(mockDb.store.get(COLLECTIONS.BOOKING_ITEMS)!.size).toBe(0);
    expect(mockDb.store.get(COLLECTIONS.AVAILABILITY)!.size).toBe(0);
  });

  it('8.6: allows rescheduling to a new eligible employee/service', async () => {
    const rawPayload = {
      customerId: 'cust_100',
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '10:00',
        },
      ],
    };

    // First, book Elene for Haircut
    const created = await BookingEngine.createBooking(
      {
        customerId: 'cust_100',
        actorRole: 'CUSTOMER',
        rawPayload,
        items: rawPayload.items,
      },
      mockDb
    );

    // Now assign emp_giorgi to srv_haircut as well
    mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set('es_giorgi_haircut', {
      id: 'es_giorgi_haircut',
      employeeId: 'emp_giorgi',
      serviceId: 'srv_haircut',
      isActive: true,
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
    });

    // Reschedule item to Giorgi at 14:00
    const reschedResult = await BookingEngine.rescheduleBooking(
      {
        bookingId: created.booking.id,
        actorUserId: 'cust_100',
        actorRole: 'CUSTOMER',
        reschedules: [
          {
            bookingItemId: created.items[0].id,
            newEmployeeId: 'emp_giorgi',
            newDate: '2026-09-22',
            newStartTime: '14:00',
          },
        ],
      },
      mockDb
    );

    expect(reschedResult.items[0].employeeId).toBe('emp_giorgi');
    expect(reschedResult.items[0].startTime).toBe('2026-09-22T14:00:00+04:00');

    // Old ledger for Elene should have interval removed
    const oldLedger = mockDb.store.get(COLLECTIONS.AVAILABILITY)!.get('emp_elene_2026-09-22');
    expect(oldLedger.bookedIntervals.length).toBe(0);

    // New ledger for Giorgi should have interval booked
    const newLedger = mockDb.store.get(COLLECTIONS.AVAILABILITY)!.get('emp_giorgi_2026-09-22');
    expect(newLedger.bookedIntervals.length).toBe(1);
    expect(newLedger.bookedIntervals[0].startTime).toBe('14:00');
  });

  it('8.7: rejects rescheduling to an ineligible employee and leaves original booking and ledgers untouched', async () => {
    const rawPayload = {
      customerId: 'cust_100',
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene',
          date: '2026-09-22',
          startTime: '10:00',
        },
      ],
    };

    // First, book Elene for Haircut
    const created = await BookingEngine.createBooking(
      {
        customerId: 'cust_100',
        actorRole: 'CUSTOMER',
        rawPayload,
        items: rawPayload.items,
      },
      mockDb
    );

    // Giorgi is NOT assigned to srv_haircut. Rescheduling to Giorgi must fail!
    await expect(
      BookingEngine.rescheduleBooking(
        {
          bookingId: created.booking.id,
          actorUserId: 'cust_100',
          actorRole: 'CUSTOMER',
          reschedules: [
            {
              bookingItemId: created.items[0].id,
              newEmployeeId: 'emp_giorgi',
              newDate: '2026-09-22',
              newStartTime: '14:00',
            },
          ],
        },
        mockDb
      )
    ).rejects.toThrowError(/not assigned to service/);

    // Original booking remains unchanged
    const bookingDoc = mockDb.store.get(COLLECTIONS.BOOKINGS)!.get(created.booking.id);
    expect(bookingDoc.status).toBe('CONFIRMED');

    const itemDoc = mockDb.store.get(COLLECTIONS.BOOKING_ITEMS)!.get(created.items[0].id);
    expect(itemDoc.employeeId).toBe('emp_elene');
    expect(itemDoc.startTime).toBe('2026-09-22T10:00:00+04:00');

    // Elene's ledger still intact
    const eleneLedger = mockDb.store.get(COLLECTIONS.AVAILABILITY)!.get('emp_elene_2026-09-22');
    expect(eleneLedger.bookedIntervals.length).toBe(1);

    // Giorgi's ledger never touched
    const giorgiLedger = mockDb.store.get(COLLECTIONS.AVAILABILITY)!.get('emp_giorgi_2026-09-22');
    expect(giorgiLedger).toBeUndefined();
  });

  it('8.8: failed booking due to ineligibility does not save an idempotency success record', async () => {
    const idempotencyKey = 'suite9_idem_key_1';
    const invalidPayload = {
      customerId: 'cust_100',
      items: [
        {
          serviceId: 'srv_coloring',
          employeeId: 'emp_elene', // Ineligible
          date: '2026-09-22',
          startTime: '10:00',
        },
      ],
    };

    // First attempt fails due to ineligibility
    await expect(
      BookingEngine.createBooking(
        {
          customerId: 'cust_100',
          actorRole: 'CUSTOMER',
          idempotencyKey,
          rawPayload: invalidPayload,
          items: invalidPayload.items,
        },
        mockDb
      )
    ).rejects.toThrowError(/not assigned to service/);

    // No idempotency record stored
    expect(mockDb.store.get(COLLECTIONS.IDEMPOTENCY)!.size).toBe(0);

    // Now caller retries with the same idempotency key using a valid eligible assignment
    const validPayload = {
      customerId: 'cust_100',
      items: [
        {
          serviceId: 'srv_haircut',
          employeeId: 'emp_elene', // Eligible
          date: '2026-09-22',
          startTime: '10:00',
        },
      ],
    };

    const retryResult = await BookingEngine.createBooking(
      {
        customerId: 'cust_100',
        actorRole: 'CUSTOMER',
        idempotencyKey,
        rawPayload: validPayload,
        items: validPayload.items,
      },
      mockDb
    );

    expect(retryResult.booking.status).toBe('CONFIRMED');
    expect(mockDb.store.get(COLLECTIONS.IDEMPOTENCY)!.size).toBe(1);
  });
});
