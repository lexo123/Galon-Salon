/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Customer-Facing Service Catalog Endpoint
 * Implements:
 * - GET /api/services (public, read-only)
 * - Active & valid service filtering
 * - D45 authoritative duration midpoint & price representation
 * - Raw persistence field prohibition (never exposes priceMin, priceMax, durationMin, durationMax)
 * - D10 & D46 eligibleEmployeeIds computation (active assignments to CUSTOMER_FACING + ACTIVE employees only)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getAdminDb } from '../config/firebaseAdmin.ts';
import {
  COLLECTIONS,
  Service,
  Employee,
  EmployeeService,
  PriceSnapshot,
  isCustomerFacingActive,
} from '../../src/types/index.ts';
import { calculateAuthoritativeServiceValues } from '../services/bookingEngine.ts';
import { logger } from '../utils/logger.ts';

export interface PublicCatalogServiceItem {
  id: string;
  categoryId: string;
  nameKa: string;
  nameEn: string;
  descriptionKa: string;
  descriptionEn: string;
  displayOrder: number;
  durationMinutes: number;
  price: PriceSnapshot;
  eligibleEmployeeIds: string[];
}

/**
 * Computes the public customer-facing service catalog from Firestore.
 * Pure read-only query & transformation; never mutates state.
 */
export async function getPublicServicesCatalog(
  customDb?: any
): Promise<PublicCatalogServiceItem[]> {
  const adminDb = customDb || getAdminDb();
  if (!adminDb) {
    return [];
  }

  // 1. Read active services, employees, and employeeServices in parallel
  const [servicesSnap, employeesSnap, employeeServicesSnap] = await Promise.all([
    adminDb.collection(COLLECTIONS.SERVICES).where('isActive', '==', true).get(),
    adminDb.collection(COLLECTIONS.EMPLOYEES).get(),
    adminDb.collection(COLLECTIONS.EMPLOYEE_SERVICES).where('isActive', '==', true).get(),
  ]);

  // 2. Identify active, customer-facing employee IDs (D10)
  const validCustomerFacingEmployeeIds = new Set<string>();
  for (const empDoc of employeesSnap.docs || []) {
    const empData = empDoc.data() as Employee;
    const empId = empDoc.id || empData.id;
    if (empId && isCustomerFacingActive(empData)) {
      validCustomerFacingEmployeeIds.add(empId);
    }
  }

  // 3. Group eligible employee IDs by serviceId (D46 + D10)
  const eligibleEmployeesByService = new Map<string, Set<string>>();
  for (const esDoc of employeeServicesSnap.docs || []) {
    const esData = esDoc.data() as EmployeeService;
    if (!esData || esData.isActive !== true) {
      continue;
    }
    if (!validCustomerFacingEmployeeIds.has(esData.employeeId)) {
      continue;
    }
    let set = eligibleEmployeesByService.get(esData.serviceId);
    if (!set) {
      set = new Set<string>();
      eligibleEmployeesByService.set(esData.serviceId, set);
    }
    set.add(esData.employeeId);
  }

  // 4. Transform active, valid services into the public contract shape (D45)
  const catalog: PublicCatalogServiceItem[] = [];

  for (const srvDoc of servicesSnap.docs || []) {
    const raw = srvDoc.data() as Service;
    const serviceId = srvDoc.id || raw.id;
    if (!raw || raw.isActive !== true) {
      continue;
    }

    const serviceWithId: Service = {
      ...raw,
      id: serviceId,
    };

    let durationMinutes: number;
    let priceSnapshot: PriceSnapshot;

    try {
      const authoritative = calculateAuthoritativeServiceValues(serviceWithId);
      durationMinutes = authoritative.durationMinutes;
      priceSnapshot = authoritative.priceSnapshot;
    } catch (err) {
      logger.warn(`Skipping service with invalid configuration in catalog: ${serviceId}`, {
        serviceId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const eligibleSet = eligibleEmployeesByService.get(serviceId);
    const eligibleEmployeeIds = eligibleSet
      ? Array.from(eligibleSet).sort((a, b) => a.localeCompare(b))
      : [];

    catalog.push({
      id: serviceId,
      categoryId: raw.categoryId || '',
      nameKa: raw.nameKa || '',
      nameEn: raw.nameEn || '',
      descriptionKa: raw.descriptionKa || '',
      descriptionEn: raw.descriptionEn || '',
      displayOrder: typeof raw.displayOrder === 'number' ? raw.displayOrder : 0,
      durationMinutes,
      price: {
        min: priceSnapshot.min,
        max: priceSnapshot.max,
        currency: priceSnapshot.currency,
      },
      eligibleEmployeeIds,
    });
  }

  // 5. Sort deterministically by displayOrder ascending, then id ascending
  catalog.sort((a, b) => {
    if (a.displayOrder !== b.displayOrder) {
      return a.displayOrder - b.displayOrder;
    }
    return a.id.localeCompare(b.id);
  });

  return catalog;
}

const router = Router();

/**
 * GET /api/services
 * Public, read-only endpoint returning customer-facing, active, valid services.
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const services = await getPublicServicesCatalog();
    res.status(200).json({
      status: 'ok',
      services,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
