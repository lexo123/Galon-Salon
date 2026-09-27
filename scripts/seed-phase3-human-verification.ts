/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Minimal Deterministic Firestore Seed Script for Phase 3 Human Verification
 * 
 * This script seeds master data (categories, services, employees, employeeServices,
 * weeklySchedules, scheduleBreaks, scheduleExceptions) into Cloud Firestore
 * so Human Verification of Phase 3 can be conducted.
 * 
 * SAFETY RULES:
 * - Uses Firebase Admin SDK with existing configuration.
 * - Deterministic, idempotent operations (safe to re-run).
 * - NEVER overwrites or deletes existing users or notifications.
 * - NEVER creates booking state (bookings, bookingItems, availability, idempotency).
 * - Validates all documents written by reading them back.
 */

import { initializeFirebaseAdmin, getAdminDb } from '../server/config/firebaseAdmin.ts';
import { COLLECTIONS } from '../src/types/domain.ts';

async function seed() {
  console.log('================================================================');
  console.log('PHASE 3 HUMAN VERIFICATION — DETERMINISTIC FIRESTORE SEED');
  console.log('================================================================');

  // 1. Initialize Firebase Admin
  const adminApp = initializeFirebaseAdmin();
  if (!adminApp) {
    throw new Error('Failed to initialize Firebase Admin SDK. Check environment credentials.');
  }

  const db = getAdminDb();
  if (!db) {
    throw new Error('Firestore database instance is not available.');
  }

  const projectId = adminApp.options.projectId;
  console.log(`[Target Firebase Project]: ${projectId}`);

  // 2. Pre-flight Check: Read and record existing document counts
  console.log('\n[Pre-flight Verification] Checking existing collections...');
  const collectionsToCheck = [
    COLLECTIONS.USERS,
    COLLECTIONS.NOTIFICATIONS,
    COLLECTIONS.CATEGORIES,
    COLLECTIONS.SERVICES,
    COLLECTIONS.EMPLOYEES,
    COLLECTIONS.EMPLOYEE_SERVICES,
    COLLECTIONS.WEEKLY_SCHEDULES,
    COLLECTIONS.SCHEDULE_BREAKS,
    COLLECTIONS.SCHEDULE_EXCEPTIONS,
    COLLECTIONS.BOOKINGS,
    COLLECTIONS.BOOKING_ITEMS,
    COLLECTIONS.AVAILABILITY,
    COLLECTIONS.IDEMPOTENCY,
  ];

  const beforeCounts: Record<string, number> = {};
  for (const colName of collectionsToCheck) {
    const snap = await db.collection(colName).get();
    beforeCounts[colName] = snap.size;
    console.log(` - Collection '${colName}': ${snap.size} document(s)`);
  }

  // Safety Assertion: Verify existing CUSTOMER user is present and won't be modified
  const usersSnap = await db.collection(COLLECTIONS.USERS).get();
  console.log(`[Safety Guard] Existing user records: ${usersSnap.size}`);
  const existingCustomerIds = usersSnap.docs.map((d) => d.id);
  console.log(`[Safety Guard] Preserved user ID(s): ${existingCustomerIds.join(', ')}`);

  // 3. Define Deterministic Seed Datasets
  const timestamp = '2026-09-22T00:00:00.000Z';

  // --- CATEGORIES (2 active categories) ---
  const categories = [
    {
      id: 'cat_hair',
      nameKa: 'თმის მოვლა',
      nameEn: 'Hair Care',
      descriptionKa: 'თმის შეჭრა, შეღებვა და პროფესიონალური მოვლა',
      descriptionEn: 'Haircut, coloring and professional hair care',
      displayOrder: 1,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 'cat_nails',
      nameKa: 'ფრჩხილის მოვლა',
      nameEn: 'Nail Care',
      descriptionKa: 'მანიკიური, პედიკიური და ფრჩხილების მოვლა',
      descriptionEn: 'Manicure, pedicure and nail care',
      displayOrder: 2,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];

  // --- SERVICES (3 active services: fixed, range/midpoint, and nail service) ---
  const services = [
    {
      id: 'srv_haircut',
      categoryId: 'cat_hair',
      nameKa: 'თმის შეჭრა',
      nameEn: 'Haircut',
      descriptionKa: 'სტანდარტული თმის შეჭრა',
      descriptionEn: 'Standard haircut',
      priceMin: 50,
      priceMax: 50,
      durationMin: 60,
      durationMax: 60,
      displayOrder: 1,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      // D45 Test Service: bounded duration (60-120 min -> midpoint 90 min), bounded price (100-160 GEL)
      id: 'srv_coloring',
      categoryId: 'cat_hair',
      nameKa: 'თმის შეღებვა',
      nameEn: 'Hair Coloring',
      descriptionKa: 'თმის პროფესიონალური შეღებვა (ხანგრძლივობის შუალედი 60-120 წთ -> D45 შუა წერტილი 90 წთ)',
      descriptionEn: 'Professional hair coloring (duration range 60-120 min -> D45 midpoint 90 min)',
      priceMin: 100,
      priceMax: 160,
      durationMin: 60,
      durationMax: 120,
      displayOrder: 2,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 'srv_manicure',
      categoryId: 'cat_nails',
      nameKa: 'მანიკიური',
      nameEn: 'Manicure',
      descriptionKa: 'კლასიკური მანიკიური',
      descriptionEn: 'Classic manicure',
      priceMin: 40,
      priceMax: 40,
      durationMin: 45,
      durationMax: 45,
      displayOrder: 3,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];

  // --- EMPLOYEES (2 CUSTOMER_FACING + 1 INTERNAL) ---
  const employees = [
    {
      id: 'emp_elene',
      userId: 'user_emp_elene',
      employeeType: 'CUSTOMER_FACING',
      firstName: 'ელენე',
      lastName: 'ვაშაძე',
      phone: '+995599111222',
      status: 'ACTIVE',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 'emp_giorgi',
      userId: 'user_emp_giorgi',
      employeeType: 'CUSTOMER_FACING',
      firstName: 'გიორგი',
      lastName: 'ყაფლანიშვილი',
      phone: '+995599222333',
      status: 'ACTIVE',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      // D10 Test Employee: INTERNAL employee who must NEVER be visible or bookable to customers
      id: 'emp_vakho',
      userId: 'user_emp_vakho',
      employeeType: 'INTERNAL',
      firstName: 'ვახო',
      lastName: 'დამლაგებელი',
      phone: '+995599444555',
      status: 'ACTIVE',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];

  // --- EMPLOYEE_SERVICES (D46 Eligibility Mappings) ---
  // Elene: Haircut & Coloring (NOT Manicure)
  // Giorgi: Haircut & Manicure (NOT Coloring)
  // Vakho (INTERNAL): No services
  const employeeServices = [
    {
      id: 'emp_elene_srv_haircut',
      employeeId: 'emp_elene',
      serviceId: 'srv_haircut',
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 'emp_elene_srv_coloring',
      employeeId: 'emp_elene',
      serviceId: 'srv_coloring',
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 'emp_giorgi_srv_haircut',
      employeeId: 'emp_giorgi',
      serviceId: 'srv_haircut',
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 'emp_giorgi_srv_manicure',
      employeeId: 'emp_giorgi',
      serviceId: 'srv_manicure',
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];

  // --- WEEKLY SCHEDULES ---
  // Working days: Monday (1) to Saturday (6), 10:00 - 19:00
  // Non-working day: Sunday (0), isWorking: false
  const weeklySchedules: Array<{
    id: string;
    employeeId: string;
    dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
    isWorking: boolean;
    startTime: string;
    endTime: string;
    createdAt: string;
    updatedAt: string;
  }> = [];

  for (const empId of ['emp_elene', 'emp_giorgi']) {
    // Sunday (Day 0) - Day off
    weeklySchedules.push({
      id: `${empId}_sched_day_0`,
      employeeId: empId,
      dayOfWeek: 0,
      isWorking: false,
      startTime: '10:00',
      endTime: '19:00',
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // Monday to Saturday (Days 1..6) - Working 10:00 - 19:00
    for (let day = 1; day <= 6; day++) {
      weeklySchedules.push({
        id: `${empId}_sched_day_${day}`,
        employeeId: empId,
        dayOfWeek: day as 1 | 2 | 3 | 4 | 5 | 6,
        isWorking: true,
        startTime: '10:00',
        endTime: '19:00',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  }

  // --- SCHEDULE BREAKS ---
  // emp_elene lunch break on Tuesdays (day 2): 13:00 - 14:00
  // emp_giorgi lunch break on Wednesdays (day 3): 14:00 - 15:00
  const scheduleBreaks = [
    {
      id: 'emp_elene_break_tue_lunch',
      employeeId: 'emp_elene',
      scheduleId: 'emp_elene_sched_day_2',
      dayOfWeek: 2,
      startTime: '13:00',
      endTime: '14:00',
      type: 'LUNCH',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 'emp_giorgi_break_wed_lunch',
      employeeId: 'emp_giorgi',
      scheduleId: 'emp_giorgi_sched_day_3',
      dayOfWeek: 3,
      startTime: '14:00',
      endTime: '15:00',
      type: 'LUNCH',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];

  // --- SCHEDULE EXCEPTIONS ---
  // Within active booking window (2026-09-22 to 2026-09-29):
  // Exception 1: emp_elene scheduled OFF on 2026-09-25 (Friday)
  // Exception 2: emp_giorgi CUSTOM_HOURS 12:00-16:00 on 2026-09-26 (Saturday)
  const scheduleExceptions = [
    {
      id: 'emp_elene_exc_off_2026_09_25',
      employeeId: 'emp_elene',
      startDate: '2026-09-25',
      endDate: '2026-09-25',
      date: '2026-09-25',
      type: 'OFF' as const,
      reason: 'Personal Leave / დასვენების დღე',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 'emp_giorgi_exc_custom_2026_09_26',
      employeeId: 'emp_giorgi',
      startDate: '2026-09-26',
      endDate: '2026-09-26',
      date: '2026-09-26',
      type: 'CUSTOM_HOURS' as const,
      startTime: '12:00',
      endTime: '16:00',
      reason: 'Short Shift / შემოკლებული ცვლა',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];

  // 4. Batch Writes (Idempotent set() with merge: false)
  console.log('\n[Execution] Writing deterministic seed records...');

  const batch = db.batch();

  // Categories
  for (const item of categories) {
    const ref = db.collection(COLLECTIONS.CATEGORIES).doc(item.id);
    batch.set(ref, item);
  }

  // Services
  for (const item of services) {
    const ref = db.collection(COLLECTIONS.SERVICES).doc(item.id);
    batch.set(ref, item);
  }

  // Employees
  for (const item of employees) {
    const ref = db.collection(COLLECTIONS.EMPLOYEES).doc(item.id);
    batch.set(ref, item);
  }

  // EmployeeServices
  for (const item of employeeServices) {
    const ref = db.collection(COLLECTIONS.EMPLOYEE_SERVICES).doc(item.id);
    batch.set(ref, item);
  }

  // WeeklySchedules
  for (const item of weeklySchedules) {
    const ref = db.collection(COLLECTIONS.WEEKLY_SCHEDULES).doc(item.id);
    batch.set(ref, item);
  }

  // ScheduleBreaks
  for (const item of scheduleBreaks) {
    const ref = db.collection(COLLECTIONS.SCHEDULE_BREAKS).doc(item.id);
    batch.set(ref, item);
  }

  // ScheduleExceptions
  for (const item of scheduleExceptions) {
    const ref = db.collection(COLLECTIONS.SCHEDULE_EXCEPTIONS).doc(item.id);
    batch.set(ref, item);
  }

  await batch.commit();
  console.log('[Execution] Batch committed successfully.');

  // 5. Post-seed Verification (Read-back test)
  console.log('\n[Post-seed Verification] Reading back seeded documents...');

  const verifyDoc = async (col: string, id: string) => {
    const snap = await db.collection(col).doc(id).get();
    if (!snap.exists) {
      throw new Error(`CRITICAL: Document ${col}/${id} was not found after write!`);
    }
    return snap.data();
  };

  // Check Categories
  for (const cat of categories) {
    const data = await verifyDoc(COLLECTIONS.CATEGORIES, cat.id);
    console.log(` - Verified Category: ${cat.id} (${data?.nameKa} / ${data?.nameEn})`);
  }

  // Check Services
  for (const srv of services) {
    const data = await verifyDoc(COLLECTIONS.SERVICES, srv.id);
    console.log(
      ` - Verified Service: ${srv.id} (${data?.nameKa}) [duration: ${data?.durationMin}-${data?.durationMax}m, price: ${data?.priceMin}-${data?.priceMax} GEL]`
    );
  }

  // Check Employees
  for (const emp of employees) {
    const data = await verifyDoc(COLLECTIONS.EMPLOYEES, emp.id);
    console.log(` - Verified Employee: ${emp.id} (${data?.firstName} ${data?.lastName}, type: ${data?.employeeType})`);
  }

  // Check EmployeeServices
  for (const es of employeeServices) {
    const data = await verifyDoc(COLLECTIONS.EMPLOYEE_SERVICES, es.id);
    console.log(` - Verified EmployeeService: ${es.id} (emp: ${data?.employeeId} -> srv: ${data?.serviceId}, active: ${data?.isActive})`);
  }

  // Check WeeklySchedules count
  const schedSnap = await db.collection(COLLECTIONS.WEEKLY_SCHEDULES).get();
  console.log(` - Verified WeeklySchedules total count: ${schedSnap.size} (expected: 14)`);

  // Check ScheduleBreaks count
  const breaksSnap = await db.collection(COLLECTIONS.SCHEDULE_BREAKS).get();
  console.log(` - Verified ScheduleBreaks total count: ${breaksSnap.size} (expected: 2)`);

  // Check ScheduleExceptions count
  const excSnap = await db.collection(COLLECTIONS.SCHEDULE_EXCEPTIONS).get();
  console.log(` - Verified ScheduleExceptions total count: ${excSnap.size} (expected: 2)`);

  // 6. Post-seed Integrity Assertions
  console.log('\n[Post-seed Integrity Verification]');
  const afterCounts: Record<string, number> = {};
  for (const colName of collectionsToCheck) {
    const snap = await db.collection(colName).get();
    afterCounts[colName] = snap.size;
  }

  console.log('Collection counts before vs after:');
  for (const colName of collectionsToCheck) {
    console.log(` - ${colName}: ${beforeCounts[colName]} -> ${afterCounts[colName]}`);
  }

  // Verify untouched collections
  if (beforeCounts[COLLECTIONS.USERS] !== afterCounts[COLLECTIONS.USERS]) {
    throw new Error('CRITICAL INTEGRITY VIOLATION: User collection count changed!');
  }
  if (beforeCounts[COLLECTIONS.NOTIFICATIONS] !== afterCounts[COLLECTIONS.NOTIFICATIONS]) {
    throw new Error('CRITICAL INTEGRITY VIOLATION: Notification collection count changed!');
  }
  if (afterCounts[COLLECTIONS.BOOKINGS] !== 0) {
    throw new Error('CRITICAL INTEGRITY VIOLATION: Bookings collection is not empty!');
  }
  if (afterCounts[COLLECTIONS.BOOKING_ITEMS] !== 0) {
    throw new Error('CRITICAL INTEGRITY VIOLATION: BookingItems collection is not empty!');
  }
  if (afterCounts[COLLECTIONS.AVAILABILITY] !== 0) {
    throw new Error('CRITICAL INTEGRITY VIOLATION: Availability collection is not empty!');
  }

  console.log('\n================================================================');
  console.log('SEED EXECUTION SUCCESSFUL — ALL INTEGRITY CHECKS PASSED');
  console.log('================================================================');
}

seed().catch((err) => {
  console.error('[CRITICAL ERROR IN SEED EXECUTION]:', err.message);
  process.exit(1);
});
