/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Automated Tests for Customer-Facing Booking UI Backend Contracts:
 * - GET /api/services (Service Catalog & Eligibility)
 * - GET /api/availability (D3 Grouped Employee Availability & D4 Packed Slot Calculation)
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

  mockDb.store.get(COLLECTIONS.SERVICES)!.set('srv_manicure', {
    id: 'srv_manicure',
    categoryId: 'cat_nails',
    nameKa: 'მანიკიური',
    nameEn: 'Manicure',
    descriptionKa: 'კლასიკური მანიკიური',
    descriptionEn: 'Classic manicure',
    displayOrder: 3,
    durationMin: 45,
    durationMax: 45,
    priceMin: 40,
    priceMax: 40,
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
    displayOrder: 4,
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
    displayOrder: 5,
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

  mockDb.store.get(COLLECTIONS.EMPLOYEE_SERVICES)!.set('es_elene_manicure', {
    id: 'es_elene_manicure',
    employeeId: 'emp_elene',
    serviceId: 'srv_manicure',
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
    expect(res.body.services).toHaveLength(3);

    expect(res.body.services[0].id).toBe('srv_coloring');
    expect(res.body.services[1].id).toBe('srv_haircut');
    expect(res.body.services[2].id).toBe('srv_manicure');
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

    expect(haircut.eligibleEmployeeIds).toEqual(['emp_elene', 'emp_giorgi']);
    expect(haircut.eligibleEmployeeIds).not.toContain('emp_internal');
    expect(haircut.eligibleEmployeeIds).not.toContain('emp_inactive');

    expect(coloring.eligibleEmployeeIds).toEqual(['emp_elene']);
  });
});

// ============================================================================
// SUITE 2: GET /api/availability — AVAILABILITY CONTRACT (D3 & D4)
// ============================================================================
describe('Booking UI Backend Contract: GET /api/availability', () => {
  let mockDb: MockFirestoreDb;

  beforeEach(() => {
    mockDb = new MockFirestoreDb();
    seedContractTestData(mockDb);
    vi.spyOn(firebaseAdminModule, 'getAdminDb').mockReturnValue(mockDb as any);

    // Seed weekly schedules for emp_elene and emp_giorgi:
    // Tuesday (day 2, 2026-09-22):
    // - emp_elene: working 10:00 - 18:00
    // - emp_giorgi: working 11:00 - 15:00
    // Sunday (day 0, 2026-09-27): not working (isWorking: false)
    mockDb.store.get(COLLECTIONS.WEEKLY_SCHEDULES)!.set('emp_elene_tue', {
      id: 'emp_elene_tue',
      employeeId: 'emp_elene',
      dayOfWeek: 2,
      isWorking: true,
      startTime: '10:00',
      endTime: '18:00',
    });

    mockDb.store.get(COLLECTIONS.WEEKLY_SCHEDULES)!.set('emp_giorgi_tue', {
      id: 'emp_giorgi_tue',
      employeeId: 'emp_giorgi',
      dayOfWeek: 2,
      isWorking: true,
      startTime: '11:00',
      endTime: '15:00',
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

  it('rejects missing or malformed query parameters with 400 VALIDATION_FAILED', async () => {
    const missingService = await invokeRouterGet(availabilityRoutes, {
      date: '2026-09-22',
    });
    expect(missingService.statusCode).toBe(400);
    expect(missingService.body.code).toBe('VALIDATION_FAILED');

    const missingDate = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
    });
    expect(missingDate.statusCode).toBe(400);
    expect(missingDate.body.code).toBe('VALIDATION_FAILED');

    const badDate = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '22-09-2026',
    });
    expect(badDate.statusCode).toBe(400);
    expect(badDate.body.code).toBe('VALIDATION_FAILED');

    const impossibleCalendarDate = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-02-31',
    });
    expect(impossibleCalendarDate.statusCode).toBe(400);
    expect(impossibleCalendarDate.body.code).toBe('VALIDATION_FAILED');
  });

  it('rejects past dates and dates exceeding the 7-day booking window', async () => {
    const pastRes = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-21', // yesterday
    });
    expect(pastRes.statusCode).toBe(400);
    expect(pastRes.body.code).toBe('PAST_DATE_NOT_ALLOWED');

    const tooFarRes = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-30', // 8 days ahead (> 7)
    });
    expect(tooFarRes.statusCode).toBe(400);
    expect(tooFarRes.body.code).toBe('BOOKING_WINDOW_EXCEEDED');
  });

  it('validates service existence, active status, and configuration (D45)', async () => {
    await expect(
      getAvailableSlots({ serviceId: 'srv_missing', date: '2026-09-22' }, mockDb)
    ).rejects.toThrow(NotFoundError);

    await expect(
      getAvailableSlots({ serviceId: 'srv_inactive', date: '2026-09-22' }, mockDb)
    ).rejects.toThrow(BadRequestError);

    await expect(
      getAvailableSlots({ serviceId: 'srv_invalid_range', date: '2026-09-22' }, mockDb)
    ).rejects.toThrow(BadRequestError);
  });

  it('D3: returns availability grouped by eligible active CUSTOMER_FACING employees without requiring employeeId', async () => {
    const res = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-22',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.serviceId).toBe('srv_haircut');
    expect(res.body.date).toBe('2026-09-22');
    expect(res.body.durationMinutes).toBe(60);

    // Only emp_elene and emp_giorgi are eligible, active, customer-facing
    // emp_internal and emp_inactive are strictly excluded
    const employeeIds = res.body.employees.map((e: any) => e.employeeId);
    expect(employeeIds).toEqual(['emp_elene', 'emp_giorgi']);
    expect(employeeIds).not.toContain('emp_internal');
    expect(employeeIds).not.toContain('emp_inactive');

    // For srv_coloring, Giorgi's assignment is inactive, so only emp_elene is returned
    const coloringRes = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_coloring',
      date: '2026-09-22',
    });
    expect(coloringRes.body.employees.map((e: any) => e.employeeId)).toEqual(['emp_elene']);
  });

  it('D4: generates packed/service-specific feasible slots for 60-minute service respecting breaks and bookings', async () => {
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
      date: '2026-09-22',
    });

    expect(res.statusCode).toBe(200);
    const elene = res.body.employees.find((e: any) => e.employeeId === 'emp_elene')!;
    const giorgi = res.body.employees.find((e: any) => e.employeeId === 'emp_giorgi')!;

    // Elene available intervals: [10:00, 13:00], [14:00, 15:00], [16:00, 18:00]
    // Packed 60-minute slots:
    // [10:00, 13:00] -> 10:00-11:00, 11:00-12:00, 12:00-13:00
    // [14:00, 15:00] -> 14:00-15:00
    // [16:00, 18:00] -> 16:00-17:00, 17:00-18:00
    expect(elene.slots).toEqual([
      { startTime: '10:00', endTime: '11:00' },
      { startTime: '11:00', endTime: '12:00' },
      { startTime: '12:00', endTime: '13:00' },
      { startTime: '14:00', endTime: '15:00' },
      { startTime: '16:00', endTime: '17:00' },
      { startTime: '17:00', endTime: '18:00' },
    ]);

    // Giorgi available interval: [11:00, 15:00] -> packed 60-minute slots: 11:00, 12:00, 13:00, 14:00
    expect(giorgi.slots).toEqual([
      { startTime: '11:00', endTime: '12:00' },
      { startTime: '12:00', endTime: '13:00' },
      { startTime: '13:00', endTime: '14:00' },
      { startTime: '14:00', endTime: '15:00' },
    ]);
  });

  it('D4: generates packed slots for 45-minute service (10:00, 10:45, 11:30, 12:15...) without a fixed 30-min grid', async () => {
    // Lunch break 13:00 - 14:00 and booking 15:00 - 16:00
    mockDb.store.get(COLLECTIONS.SCHEDULE_BREAKS)!.set('brk_tue', {
      id: 'brk_tue',
      employeeId: 'emp_elene',
      scheduleId: 'emp_elene_tue',
      dayOfWeek: 2,
      startTime: '13:00',
      endTime: '14:00',
    });
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

    const result = await getAvailableSlots(
      {
        serviceId: 'srv_manicure', // 45 min
        date: '2026-09-22',
      },
      mockDb
    );

    expect(result.durationMinutes).toBe(45);
    const elene = result.employees.find((e) => e.employeeId === 'emp_elene')!;

    // [10:00, 13:00] -> 10:00-10:45, 10:45-11:30, 11:30-12:15, 12:15-13:00
    // [14:00, 15:00] -> 14:00-14:45 (14:45+45=15:30 > 15:00)
    // [16:00, 18:00] -> 16:00-16:45, 16:45-17:30 (17:30+45=18:15 > 18:00)
    expect(elene.slots).toEqual([
      { startTime: '10:00', endTime: '10:45' },
      { startTime: '10:45', endTime: '11:30' },
      { startTime: '11:30', endTime: '12:15' },
      { startTime: '12:15', endTime: '13:00' },
      { startTime: '14:00', endTime: '14:45' },
      { startTime: '16:00', endTime: '16:45' },
      { startTime: '16:45', endTime: '17:30' },
    ]);
  });

  it('D4 & D45: uses midpoint duration (90 min for 60-120 range) to pack 90-minute slots', async () => {
    const result = await getAvailableSlots(
      {
        serviceId: 'srv_coloring', // 60-120 -> 90 min
        date: '2026-09-22', // 10:00 - 18:00 (480 min)
      },
      mockDb
    );

    expect(result.durationMinutes).toBe(90);
    const elene = result.employees.find((e) => e.employeeId === 'emp_elene')!;

    // Packed 90-minute slots in [10:00, 18:00]:
    // 10:00-11:30, 11:30-13:00, 13:00-14:30, 14:30-16:00, 16:00-17:30
    expect(elene.slots).toEqual([
      { startTime: '10:00', endTime: '11:30' },
      { startTime: '11:30', endTime: '13:00' },
      { startTime: '13:00', endTime: '14:30' },
      { startTime: '14:30', endTime: '16:00' },
      { startTime: '16:00', endTime: '17:30' },
    ]);
  });

  it('returns empty slots array on weekly non-working day and on schedule exception OFF', async () => {
    // Sunday 2026-09-27 is non-working in weeklySchedules
    const sundayResult = await getAvailableSlots(
      {
        serviceId: 'srv_coloring',
        date: '2026-09-27',
      },
      mockDb
    );
    expect(sundayResult.employees[0].slots).toEqual([]);

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
        serviceId: 'srv_coloring',
        date: '2026-09-23',
      },
      mockDb
    );
    expect(offExceptionResult.employees[0].slots).toEqual([]);
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
        date: '2026-09-24',
      },
      mockDb
    );

    const elene = result.employees.find((e) => e.employeeId === 'emp_elene')!;
    // Packed 60-min slots in [12:00, 14:00]: 12:00-13:00, 13:00-14:00
    expect(elene.slots).toEqual([
      { startTime: '12:00', endTime: '13:00' },
      { startTime: '13:00', endTime: '14:00' },
    ]);
  });

  it('enforces same-day 30-minute minimum lead time in Asia/Tbilisi', async () => {
    // Advance system clock to 10:30 Asia/Tbilisi on 2026-09-22 (06:30 UTC)
    // Minimum allowed start time on 2026-09-22 is 10:30 + 30m = 11:00
    vi.setSystemTime(new Date('2026-09-22T06:30:00.000Z'));

    const todayResult = await getAvailableSlots(
      {
        serviceId: 'srv_haircut',
        date: '2026-09-22',
      },
      mockDb
    );

    const elene = todayResult.employees.find((e) => e.employeeId === 'emp_elene')!;
    expect(elene.slots[0]).toEqual({ startTime: '11:00', endTime: '12:00' });
    expect(elene.slots.map((s) => s.startTime)).not.toContain('10:00');
  });

  // ============================================================================
  // SUITE 3: excludeInterval AVAILABILITY CONTRACT
  // ============================================================================
  it('valid excludeInterval removes overlapping candidate slots', async () => {
    const res = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-22',
      excludeInterval: 'emp_elene,2026-09-22,11:00,12:00',
    });

    expect(res.statusCode).toBe(200);
    const elene = res.body.employees.find((e: any) => e.employeeId === 'emp_elene')!;
    const eleneStartTimes = elene.slots.map((s: any) => s.startTime);
    expect(eleneStartTimes).not.toContain('11:00');
    expect(eleneStartTimes).toContain('10:00');
    expect(eleneStartTimes).toContain('12:00');
  });

  it('non-matching exclusion date does not remove slots', async () => {
    const res = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-22',
      excludeInterval: 'emp_elene,2026-09-23,11:00,12:00',
    });

    expect(res.statusCode).toBe(200);
    const elene = res.body.employees.find((e: any) => e.employeeId === 'emp_elene')!;
    const eleneStartTimes = elene.slots.map((s: any) => s.startTime);
    expect(eleneStartTimes).toContain('11:00');
  });

  it('exclusion supplied for employee A also excludes the same candidate time for employee B', async () => {
    // Exclusion specified for emp_elene at 12:00-13:00 on 2026-09-22
    const res = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-22',
      excludeInterval: 'emp_elene,2026-09-22,12:00,13:00',
    });

    expect(res.statusCode).toBe(200);
    const giorgi = res.body.employees.find((e: any) => e.employeeId === 'emp_giorgi')!;
    const giorgiStartTimes = giorgi.slots.map((s: any) => s.startTime);

    // Giorgi works 11:00 - 15:00 (11:00, 12:00, 13:00, 14:00)
    // 12:00-13:00 must be excluded for Giorgi as well
    expect(giorgiStartTimes).not.toContain('12:00');
    expect(giorgiStartTimes).toEqual(['11:00', '13:00', '14:00']);

    const elene = res.body.employees.find((e: any) => e.employeeId === 'emp_elene')!;
    expect(elene.slots.map((s: any) => s.startTime)).not.toContain('12:00');
  });

  it('multiple exclusion intervals remove all matching candidate slots', async () => {
    const res = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-22',
      excludeInterval: [
        'emp_elene,2026-09-22,10:00,11:00',
        'emp_giorgi,2026-09-22,13:00,14:00',
      ],
    });

    expect(res.statusCode).toBe(200);
    const elene = res.body.employees.find((e: any) => e.employeeId === 'emp_elene')!;
    const eleneStartTimes = elene.slots.map((s: any) => s.startTime);
    expect(eleneStartTimes).not.toContain('10:00');
    expect(eleneStartTimes).not.toContain('13:00');

    const giorgi = res.body.employees.find((e: any) => e.employeeId === 'emp_giorgi')!;
    const giorgiStartTimes = giorgi.slots.map((s: any) => s.startTime);
    expect(giorgiStartTimes).not.toContain('13:00');
  });

  it('malformed exclusion interval returns VALIDATION_FAILED', async () => {
    // Missing parts
    const badParts = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-22',
      excludeInterval: 'emp_elene,2026-09-22,10:00',
    });
    expect(badParts.statusCode).toBe(400);
    expect(badParts.body.code).toBe('VALIDATION_FAILED');

    // Invalid employee ID
    const badEmp = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-22',
      excludeInterval: '@@invalid@@,2026-09-22,10:00,11:00',
    });
    expect(badEmp.statusCode).toBe(400);
    expect(badEmp.body.code).toBe('VALIDATION_FAILED');

    // Invalid date format
    const badDate = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-22',
      excludeInterval: 'emp_elene,22-09-2026,10:00,11:00',
    });
    expect(badDate.statusCode).toBe(400);
    expect(badDate.body.code).toBe('VALIDATION_FAILED');

    // Impossible calendar date
    const badCalendar = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-22',
      excludeInterval: 'emp_elene,2026-02-31,10:00,11:00',
    });
    expect(badCalendar.statusCode).toBe(400);
    expect(badCalendar.body.code).toBe('VALIDATION_FAILED');

    // End time before start time
    const invertedTime = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-22',
      excludeInterval: 'emp_elene,2026-09-22,11:00,10:00',
    });
    expect(invertedTime.statusCode).toBe(400);
    expect(invertedTime.body.code).toBe('VALIDATION_FAILED');

    // Invalid time string
    const badTime = await invokeRouterGet(availabilityRoutes, {
      serviceId: 'srv_haircut',
      date: '2026-09-22',
      excludeInterval: 'emp_elene,2026-09-22,25:00,26:00',
    });
    expect(badTime.statusCode).toBe(400);
    expect(badTime.body.code).toBe('VALIDATION_FAILED');
  });
});
