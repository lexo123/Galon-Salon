/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Automated Tests for Customer-Facing Booking UI Backend Contracts:
 * - GET /api/services (Service Catalog & Eligibility)
 * - GET /api/availability (Feasible Slot Calculation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import serviceRoutes, { getPublicServicesCatalog } from '../server/routes/services.ts';
import availabilityRoutes, { getAvailableSlots } from '../server/routes/availability.ts';
import * as firebaseAdminModule from '../server/config/firebaseAdmin.ts';
import { errorHandler, BadRequestError, NotFoundError } from '../server/utils/errors.ts';
import { COLLECTIONS } from '../src/types/index.ts';
import type { Request, Response } from 'express';

/**
 * In-Memory Mock Firestore Database for read-only contract testing
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
        };
      },
      where: (field: string, op: string, val: any) => makeQuery([{ field, op, val }]),
      limit: (num: number) => makeQuery([], num),
      get: async () => makeQuery([]).get(),
    };
  }
}

function invokeRouterGet(
  router: any,
  query: Record<string, any> = {}
): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve) => {
    const req = {
      method: 'GET',
      path: '/',
      url: '/',
      query,
      params: {},
      headers: {},
    } as unknown as Request;

    let statusCode = 200;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ statusCode, body: payload });
        return this;
      },
    } as unknown as Response;

    const layer = router.stack.find((l: any) => l.route && l.route.path === '/' && l.route.methods.get);
    const handler = layer.route.stack[0].handle;

    Promise.resolve(
      handler(req, res, (err?: any) => {
        if (err) {
          errorHandler(err, req, res, () => {});
        }
      })
    );
  });
}

function seedContractTestData(mockDb: MockFirestoreDb) {
  // Employees: 2 active customer-facing, 1 internal, 1 inactive
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

  mockDb.store.get(COLLECTIONS.EMPLOYEES)!.set('emp_internal', {
    id: 'emp_internal',
    userId: 'user_emp_internal',
    employeeType: 'INTERNAL',
    firstName: 'Vakho',
    lastName: 'Internal',
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
    categoryId: 'cat_hair',
    nameKa: 'თმის შეჭრა',
    nameEn: 'Haircut',
    descriptionKa: 'სტანდარტული თმის შეჭრა',
    descriptionEn: 'Standard haircut',
    displayOrder: 2,
    durationMin: 60,
    durationMax: 60,
    priceMin: 50,
    priceMax: 50,
    isActive: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });

  mockDb.store.get(COLLECTIONS.SERVICES)!.set('srv_coloring', {
    id: 'srv_coloring',
    categoryId: 'cat_hair',
    nameKa: 'თმის შეღებვა',
    nameEn: 'Hair Coloring',
    descriptionKa: 'პროფესიონალური შეღებვა',
    descriptionEn: 'Professional coloring',
    displayOrder: 1,
    durationMin: 60,
    durationMax: 120, // D45 midpoint = 90
    priceMin: 100,
    priceMax: 160,
    isActive: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  });

  mockDb.store.get(COLLECTIONS.SERVICES)!.set('srv_inactive', {
    id: 'srv_inactive',
    categoryId: 'cat_hair',
    nameKa: 'არააქტიური',
    nameEn: 'Inactive Service',
    descriptionKa: '',
    descriptionEn: '',
    displayOrder: 3,
    durationMin: 60,
    durationMax: 60,
    priceMin: 50,
    priceMax: 50,
    isActive: false,
  });

  mockDb.store.get(COLLECTIONS.SERVICES)!.set('srv_invalid_range', {
    id: 'srv_invalid_range',
    categoryId: 'cat_hair',
    nameKa: 'არავალიდური',
    nameEn: 'Invalid Service',
    descriptionKa: '',
    descriptionEn: '',
    displayOrder: 4,
    durationMin: 90,
    durationMax: 30, // invalid range: max < min
    priceMin: 50,
    priceMax: 50,
    isActive: true,
  });

  // EmployeeService eligibility mappings
  mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set('es_elene_haircut', {
    id: 'es_elene_haircut',
    employeeId: 'emp_elene',
    serviceId: 'srv_haircut',
    isActive: true,
  });

  mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set('es_giorgi_haircut', {
    id: 'es_giorgi_haircut',
    employeeId: 'emp_giorgi',
    serviceId: 'srv_haircut',
    isActive: true,
  });

  mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set('es_elene_coloring', {
    id: 'es_elene_coloring',
    employeeId: 'emp_elene',
    serviceId: 'srv_coloring',
    isActive: true,
  });

  // Inactive assignment for Giorgi on coloring
  mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set('es_giorgi_coloring_inactive', {
    id: 'es_giorgi_coloring_inactive',
    employeeId: 'emp_giorgi',
    serviceId: 'srv_coloring',
    isActive: false,
  });

  // Internal & inactive employees assigned in DB must still be excluded from public eligibility
  mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set('es_internal_haircut', {
    id: 'es_internal_haircut',
    employeeId: 'emp_internal',
    serviceId: 'srv_haircut',
    isActive: true,
  });

  mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set('es_inactive_haircut', {
    id: 'es_inactive_haircut',
    employeeId: 'emp_inactive',
    serviceId: 'srv_haircut',
    isActive: true,
  });
}

// Freeze time to 2026-09-22 09:00 Asia/Tbilisi (Tuesday, dayOfWeek = 2)
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-22T05:00:00.000Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ============================================================================
// SUITE 1: GET /api/services — SERVICE CATALOG CONTRACT
// ============================================================================
describe('Booking UI Backend Contract: GET /api/services', () => {
  let mockDb: MockFirestoreDb;

  beforeEach(() => {
    mockDb = new MockFirestoreDb();
    seedContractTestData(mockDb);
    vi.spyOn(firebaseAdminModule, 'getAdminDb').mockReturnValue(mockDb as any);
  });

  it('returns only active, valid services ordered by displayOrder and id', async () => {
    const res = await invokeRouterGet(serviceRoutes);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.services).toHaveLength(2);

    // srv_coloring has displayOrder: 1, srv_haircut has displayOrder: 2
    expect(res.body.services[0].id).toBe('srv_coloring');
    expect(res.body.services[1].id).toBe('srv_haircut');
  });

  it('computes authoritative D45 durationMinutes midpoint and price object without exposing raw fields', async () => {
    const services = await getPublicServicesCatalog(mockDb);
    const coloring = services.find((s) => s.id === 'srv_coloring')!;
    const haircut = services.find((s) => s.id === 'srv_haircut')!;

    // D45: 60..120 -> 90 minutes; price 100..160 GEL
    expect(coloring.durationMinutes).toBe(90);
    expect(coloring.price).toEqual({
      min: 100,
      max: 160,
      currency: 'GEL',
    });

    expect(haircut.durationMinutes).toBe(60);
    expect(haircut.price).toEqual({
      min: 50,
      max: 50,
      currency: 'GEL',
    });

    // Strictly prohibit raw persistence fields
    for (const srv of services) {
      expect(srv).not.toHaveProperty('priceMin');
      expect(srv).not.toHaveProperty('priceMax');
      expect(srv).not.toHaveProperty('durationMin');
      expect(srv).not.toHaveProperty('durationMax');
      expect(srv).not.toHaveProperty('isActive');
      expect(srv).not.toHaveProperty('createdAt');
      expect(srv).not.toHaveProperty('updatedAt');
    }
  });

  it('populates eligibleEmployeeIds with only CUSTOMER_FACING, ACTIVE employees having active assignments', async () => {
    const services = await getPublicServicesCatalog(mockDb);
    const haircut = services.find((s) => s.id === 'srv_haircut')!;
    const coloring = services.find((s) => s.id === 'srv_coloring')!;

    // Haircut has active assignments for emp_elene, emp_giorgi, emp_internal, emp_inactive
    // Only emp_elene and emp_giorgi are CUSTOMER_FACING + ACTIVE
    expect(haircut.eligibleEmployeeIds).toEqual(['emp_elene', 'emp_giorgi']);
    expect(haircut.eligibleEmployeeIds).not.toContain('emp_internal');
    expect(haircut.eligibleEmployeeIds).not.toContain('emp_inactive');

    // Coloring has active assignment for emp_elene and inactive assignment for emp_giorgi
    expect(coloring.eligibleEmployeeIds).toEqual(['emp_elene']);
  });
});

// ============================================================================
// SUITE 2: GET /api/availability — AVAILABILITY CONTRACT
// ============================================================================
describe('Booking UI Backend Contract: GET /api/availability', () => {
  let mockDb: MockFirestoreDb;

  beforeEach(() => {
    mockDb = new MockFirestoreDb();
    seedContractTestData(mockDb);
    vi.spyOn(firebaseAdminModule, 'getAdminDb').mockReturnValue(mockDb as any);

    // Seed weekly schedules for emp_elene:
    // Tuesday (day 2, 2026-09-22): working 10:00 - 18:00
    // Sunday (day 0, 2026-09-27): not working (isWorking: false)
    mockDb.store.get(COLLECTIONS.WEEKLY_SCHEDULES)!.set('emp_elene_tue', {
      id: 'emp_elene_tue',
      employeeId: 'emp_elene',
      dayOfWeek: 2,
      isWorking: true,
      startTime: '10:00',
      endTime: '18:00',
    });

    mockDb.store.get(COLLECTIONS.WEEKLY_SCHEDULES)!.set('emp_elene_sun', {
      id: 'emp_elene_sun',
      employeeId: 'emp_elene',
      dayOfWeek: 0,
      isWorking: false,
      startTime: '10:00',
      endTime: '18:00',
    });
  });

  it('rejects missing or invalid query parameters with 400 BadRequestError', async () => {
    const missingService = await invokeRouterGet(availabilityRoutes, {
      employeeId: 'emp_elene',
      date: '2026-09-22',
    });
    expect(missingService.statusCode).toBe(400);

    const badDate = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      employeeId: 'emp_elene',
      date: '22-09-2026',
    });
    expect(badDate.statusCode).toBe(400);
    expect(badDate.body.code).toBe('INVALID_DATE_FORMAT');

    const impossibleCalendarDate = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      employeeId: 'emp_elene',
      date: '2026-02-31',
    });
    expect(impossibleCalendarDate.statusCode).toBe(400);
    expect(impossibleCalendarDate.body.code).toBe('INVALID_DATE_FORMAT');
  });

  it('rejects past dates and dates exceeding the 7-day booking window', async () => {
    const pastRes = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      employeeId: 'emp_elene',
      date: '2026-09-21', // yesterday
    });
    expect(pastRes.statusCode).toBe(400);
    expect(pastRes.body.code).toBe('PAST_DATE_NOT_ALLOWED');

    const tooFarRes = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      employeeId: 'emp_elene',
      date: '2026-09-30', // 8 days ahead (> 7)
    });
    expect(tooFarRes.statusCode).toBe(400);
    expect(tooFarRes.body.code).toBe('BOOKING_WINDOW_EXCEEDED');
  });

  it('validates service existence, active status, and configuration (D45)', async () => {
    await expect(
      getAvailableSlots(
        { serviceId: 'srv_missing', employeeId: 'emp_elene', date: '2026-09-22' },
        mockDb
      )
    ).rejects.toThrow(NotFoundError);

    await expect(
      getAvailableSlots(
        { serviceId: 'srv_inactive', employeeId: 'emp_elene', date: '2026-09-22' },
        mockDb
      )
    ).rejects.toThrow(BadRequestError);

    await expect(
      getAvailableSlots(
        { serviceId: 'srv_invalid_range', employeeId: 'emp_elene', date: '2026-09-22' },
        mockDb
      )
    ).rejects.toThrow(BadRequestError);
  });

  it('validates employee existence, active status, customer-facing type (D10), and service eligibility (D46)', async () => {
    // Non-existent employee -> 404
    await expect(
      getAvailableSlots(
        { serviceId: 'srv_haircut', employeeId: 'emp_missing', date: '2026-09-22' },
        mockDb
      )
    ).rejects.toThrow(NotFoundError);

    // Inactive employee -> 400 EMPLOYEE_NOT_AVAILABLE
    await expect(
      getAvailableSlots(
        { serviceId: 'srv_haircut', employeeId: 'emp_inactive', date: '2026-09-22' },
        mockDb
      )
    ).rejects.toThrow(/not active/);

    // Internal employee -> 400 EMPLOYEE_NOT_BOOKABLE
    await expect(
      getAvailableSlots(
        { serviceId: 'srv_haircut', employeeId: 'emp_internal', date: '2026-09-22' },
        mockDb
      )
    ).rejects.toThrow(/internal employee/);

    // Ineligible employee-service assignment (Giorgi has inactive assignment for srv_coloring) -> 400
    await expect(
      getAvailableSlots(
        { serviceId: 'srv_coloring', employeeId: 'emp_giorgi', date: '2026-09-22' },
        mockDb
      )
    ).rejects.toThrow(/inactive/);
  });

  it('generates feasible slots respecting weekly working hours, breaks, and existing ledger bookings', async () => {
    // Add a lunch break 13:00 - 14:00 on Tuesday for emp_elene
    mockDb.store.get(COLLECTIONS.SCHEDULE_BREAKS)!.set('brk_tue', {
      id: 'brk_tue',
      employeeId: 'emp_elene',
      scheduleId: 'emp_elene_tue',
      dayOfWeek: 2,
      startTime: '13:00',
      endTime: '14:00',
    });

    // Add an existing booked interval 15:00 - 16:00 in availability ledger
    mockDb.store.get(COLLECTIONS.AVAILABILITY)!.set('emp_elene_2026-09-22', {
      id: 'emp_elene_2026-09-22',
      employeeId: 'emp_elene',
      date: '2026-09-22',
      bookedIntervals: [
        {
          bookingId: 'b_1',
          bookingItemId: 'bi_1',
          startTime: '15:00',
          endTime: '16:00',
        },
      ],
      updatedAt: '2026-09-22T00:00:00.000Z',
    });

    const res = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut', // 60 min
      employeeId: 'emp_elene',
      date: '2026-09-22',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.durationMinutes).toBe(60);

    const startTimes = res.body.slots.map((s: any) => s.startTime);

    // Shift is 10:00 - 18:00 (60 min service):
    // Before break (13:00-14:00): 10:00, 10:30, 11:00, 11:30, 12:00 (12:00-13:00 is back-to-back allowed!)
    // 12:30 (12:30-13:30), 13:00 (13:00-14:00), 13:30 (13:30-14:30) overlap break -> excluded!
    // Between break and booking (15:00-16:00): 14:00 (14:00-15:00 back-to-back allowed!)
    // 14:30 (14:30-15:30), 15:00 (15:00-16:00), 15:30 (15:30-16:30) overlap booking -> excluded!
    // After booking until 18:00: 16:00 (16:00-17:00), 16:30 (16:30-17:30), 17:00 (17:00-18:00)
    // 17:30 (17:30-18:30 > 18:00) -> excluded!
    expect(startTimes).toEqual([
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '12:00',
      '14:00',
      '16:00',
      '16:30',
      '17:00',
    ]);
  });

  it('uses D45 midpoint duration (90 min for 60-120 range) when calculating slot end times and fit', async () => {
    const result = await getAvailableSlots(
      {
        serviceId: 'srv_coloring', // 60-120 -> 90 min
        employeeId: 'emp_elene',
        date: '2026-09-22', // 10:00 - 18:00
      },
      mockDb
    );

    expect(result.durationMinutes).toBe(90);
    expect(result.slots[0]).toEqual({ startTime: '10:00', endTime: '11:30' });
    // Last slot for 90-min service ending by 18:00 is 16:30 - 18:00
    expect(result.slots[result.slots.length - 1]).toEqual({
      startTime: '16:30',
      endTime: '18:00',
    });
  });

  it('returns empty slots array on weekly non-working day and on schedule exception OFF', async () => {
    // Sunday 2026-09-27 is non-working in weeklySchedules
    const sundayResult = await getAvailableSlots(
      {
        serviceId: 'srv_haircut',
        employeeId: 'emp_elene',
        date: '2026-09-27',
      },
      mockDb
    );
    expect(sundayResult.slots).toEqual([]);

    // Add OFF exception on Wednesday 2026-09-23
    mockDb.store.get(COLLECTIONS.SCHEDULE_EXCEPTIONS)!.set('exc_off_wed', {
      id: 'exc_off_wed',
      employeeId: 'emp_elene',
      startDate: '2026-09-23',
      endDate: '2026-09-23',
      type: 'OFF',
    });

    const offExceptionResult = await getAvailableSlots(
      {
        serviceId: 'srv_haircut',
        employeeId: 'emp_elene',
        date: '2026-09-23',
      },
      mockDb
    );
    expect(offExceptionResult.slots).toEqual([]);
  });

  it('respects CUSTOM_HOURS schedule exception overriding standard weekly hours', async () => {
    mockDb.store.get(COLLECTIONS.SCHEDULE_EXCEPTIONS)!.set('exc_custom_thu', {
      id: 'exc_custom_thu',
      employeeId: 'emp_elene',
      startDate: '2026-09-24',
      endDate: '2026-09-24',
      type: 'CUSTOM_HOURS',
      startTime: '12:00',
      endTime: '14:00',
    });

    const result = await getAvailableSlots(
      {
        serviceId: 'srv_haircut', // 60 min
        employeeId: 'emp_elene',
        date: '2026-09-24',
      },
      mockDb
    );

    expect(result.slots).toEqual([
      { startTime: '12:00', endTime: '13:00' },
      { startTime: '12:30', endTime: '13:30' },
      { startTime: '13:00', endTime: '14:00' },
    ]);
  });

  it('enforces same-day 30-minute minimum lead time in Asia/Tbilisi', async () => {
    // Advance system clock to 10:45 Asia/Tbilisi on 2026-09-22 (06:45 UTC)
    // Minimum allowed start time on 2026-09-22 is 10:45 + 30m = 11:15 -> first 30m slot is 11:30
    vi.setSystemTime(new Date('2026-09-22T06:45:00.000Z'));

    const todayResult = await getAvailableSlots(
      {
        serviceId: 'srv_haircut',
        employeeId: 'emp_elene',
        date: '2026-09-22',
      },
      mockDb
    );

    expect(todayResult.slots[0].startTime).toBe('11:30');
    expect(todayResult.slots.map((s) => s.startTime)).not.toContain('10:00');
    expect(todayResult.slots.map((s) => s.startTime)).not.toContain('10:30');
    expect(todayResult.slots.map((s) => s.startTime)).not.toContain('11:00');
  });
});
