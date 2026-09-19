/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Employee Catalog Endpoints
 * Enforces Section 15: Internal Employee Visibility Prohibition
 * Internal employees are strictly concealed from customer-facing queries.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getAdminDb } from '../config/firebaseAdmin.ts';
import { COLLECTIONS, Employee } from '../../src/types/index.ts';
import { NotFoundError } from '../utils/errors.ts';
import { assertId } from '../utils/validation.ts';

const router = Router();

/**
 * GET /api/employees
 * Returns public, customer-facing, active employees.
 * Internal employees are NEVER returned to customers.
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const adminDb = getAdminDb();
    if (!adminDb) {
      return res.status(200).json({ status: 'ok', employees: [] });
    }

    const snapshot = await adminDb
      .collection(COLLECTIONS.EMPLOYEES)
      .where('employeeType', '==', 'CUSTOMER_FACING')
      .where('status', '==', 'ACTIVE')
      .get();

    const employees = snapshot.docs.map((doc: any) => {
      const data = doc.data() as Employee;
      return {
        id: doc.id,
        employeeType: data.employeeType,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        status: data.status,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    });

    res.status(200).json({
      status: 'ok',
      employees,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/employees/:id
 * Retrieves a single customer-facing, active employee.
 * Returns 404 if not found, inactive, or internal.
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const employeeId = assertId(req.params.id, 'id');
    const adminDb = getAdminDb();
    if (!adminDb) {
      throw new NotFoundError('Employee not found', 'EMPLOYEE_NOT_FOUND');
    }

    const doc = await adminDb.collection(COLLECTIONS.EMPLOYEES).doc(employeeId).get();
    if (!doc.exists) {
      return next(new NotFoundError('Employee not found', 'EMPLOYEE_NOT_FOUND'));
    }

    const data = doc.data() as Employee;
    if (data.employeeType !== 'CUSTOMER_FACING' || data.status !== 'ACTIVE') {
      return next(new NotFoundError('Employee not found or unavailable', 'EMPLOYEE_NOT_FOUND'));
    }

    res.status(200).json({
      status: 'ok',
      employee: {
        id: doc.id,
        employeeType: data.employeeType,
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        status: data.status,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
