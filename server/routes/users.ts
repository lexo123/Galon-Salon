/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * User and Account Management Routes
 * Enforces ownership and RBAC permissions.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken } from '../middleware/auth.ts';
import { requireAuthenticatedUser, requireAdmin, requireSelfOrAdmin } from '../middleware/rbac.ts';
import { getAdminDb } from '../config/firebaseAdmin.ts';
import { COLLECTIONS, User, UserStatus } from '../../src/types/index.ts';
import { NotFoundError, BadRequestError } from '../utils/errors.ts';
import { assertEnum, assertId } from '../utils/validation.ts';

const router = Router();

/**
 * GET /api/users/:userId
 * Retrieves user profile data.
 * Enforces OWNERSHIP: Accessible ONLY by the user themselves or by an ADMIN/OWNER.
 */
router.get(
  '/:userId',
  authenticateToken,
  requireAuthenticatedUser,
  requireSelfOrAdmin((req) => req.params.userId),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = assertId(req.params.userId, 'userId');
      const adminDb = getAdminDb();

      if (!adminDb) {
        return res.status(200).json({
          status: 'ok',
          user: req.user?.profile || { id: userId, role: req.user?.role, status: req.user?.status },
        });
      }

      const doc = await adminDb.collection(COLLECTIONS.USERS).doc(userId).get();
      if (!doc.exists) {
        return next(new NotFoundError('User not found', 'USER_NOT_FOUND'));
      }

      const data = doc.data() as User;
      res.status(200).json({
        status: 'ok',
        user: {
          id: doc.id,
          role: data.role,
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          email: data.email,
          language: data.language,
          status: data.status,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/admin/users
 * Lists user accounts.
 * Accessible ONLY to ADMIN and OWNER. Denies CUSTOMER and EMPLOYEE.
 */
router.get(
  '/',
  authenticateToken,
  requireAuthenticatedUser,
  requireAdmin,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const adminDb = getAdminDb();
      if (!adminDb) {
        return res.status(200).json({ status: 'ok', users: [] });
      }

      const snapshot = await adminDb.collection(COLLECTIONS.USERS).limit(100).get();
      const users = snapshot.docs.map((doc) => {
        const data = doc.data() as User;
        return {
          id: doc.id,
          role: data.role,
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          email: data.email,
          language: data.language,
          status: data.status,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        };
      });

      res.status(200).json({
        status: 'ok',
        users,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/admin/users/:userId/status
 * Administrative endpoint to update a user's account status (ACTIVE, SUSPENDED, DELETED).
 * Accessible ONLY to ADMIN and OWNER.
 */
router.patch(
  '/:userId/status',
  authenticateToken,
  requireAuthenticatedUser,
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = assertId(req.params.userId, 'userId');
      const newStatus = assertEnum(req.body?.status, 'status', ['ACTIVE', 'SUSPENDED', 'DELETED'] as const);

      const adminDb = getAdminDb();
      if (adminDb) {
        const userRef = adminDb.collection(COLLECTIONS.USERS).doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
          return next(new NotFoundError('User not found', 'USER_NOT_FOUND'));
        }

        await userRef.update({
          status: newStatus,
          updatedAt: new Date().toISOString(),
        });
      }

      res.status(200).json({
        status: 'ok',
        message: `User status updated to ${newStatus}`,
        userId,
        accountStatus: newStatus,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
