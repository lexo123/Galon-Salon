/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Authentication Verification & Self-Service Profile Routes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken } from '../middleware/auth.ts';
import { requireAuthenticatedUser } from '../middleware/rbac.ts';
import { getAdminDb } from '../config/firebaseAdmin.ts';
import { COLLECTIONS, User, UserRole, UserStatus } from '../../src/types/index.ts';
import { BadRequestError, NotFoundError, ForbiddenError } from '../utils/errors.ts';
import { assertString, assertEnum } from '../utils/validation.ts';
import { logger } from '../utils/logger.ts';

const router = Router();

/**
 * GET /api/auth/me
 * Returns authenticated user profile context.
 * Rejects disabled accounts (handled in authenticateToken).
 * Never returns secrets, tokens, or private credentials.
 */
router.get('/me', authenticateToken, requireAuthenticatedUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const adminDb = getAdminDb();

    let profile = user.profile;

    if (!profile && adminDb) {
      const doc = await adminDb.collection(COLLECTIONS.USERS).doc(user.uid).get();
      if (doc.exists) {
        profile = { id: doc.id, ...(doc.data() as Omit<User, 'id'>) };
      }
    }

    if (!profile) {
      // User is authenticated via Firebase Auth but Firestore user profile doc does not exist yet
      return res.status(200).json({
        status: 'ok',
        user: {
          id: user.uid,
          email: user.email || '',
          role: user.role,
          status: user.status,
          profilePending: true,
        },
      });
    }

    // Return safe user information only
    res.status(200).json({
      status: 'ok',
      user: {
        id: profile.id,
        role: profile.role,
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
        email: profile.email,
        language: profile.language,
        status: profile.status,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        lastLoginAt: profile.lastLoginAt ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/register-profile
 * Completes customer profile creation in Firestore after Firebase Auth signup.
 * Strictly forces role = 'CUSTOMER' and status = 'ACTIVE'.
 * Rejects any client-supplied privileged roles (ADMIN, OWNER, EMPLOYEE).
 */
router.post('/register-profile', authenticateToken, requireAuthenticatedUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const body = req.body || {};

    // Validate inputs
    const firstName = assertString(body.firstName, 'firstName', 1, 64);
    const lastName = assertString(body.lastName, 'lastName', 1, 64);
    const phone = assertString(body.phone, 'phone', 4, 32);
    const language = body.language === 'en' ? 'en' : 'ka';

    // Disallow role escalation: client cannot set role to anything other than CUSTOMER
    if (body.role && body.role !== 'CUSTOMER') {
      logger.warn('Role escalation attempt blocked during registration', {
        uid: user.uid,
        attemptedRole: body.role,
      });
      return next(
        new ForbiddenError(
          'Privilege escalation is forbidden. Only CUSTOMER role is allowed during self-registration.',
          'ROLE_ESCALATION_BLOCKED'
        )
      );
    }

    const now = new Date().toISOString();
    const newUser: User = {
      id: user.uid,
      role: 'CUSTOMER',
      firstName,
      lastName,
      phone,
      email: user.email || (typeof body.email === 'string' ? body.email.trim() : ''),
      language,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    };

    const adminDb = getAdminDb();
    if (adminDb) {
      await adminDb.collection(COLLECTIONS.USERS).doc(user.uid).set(newUser);
    }

    res.status(201).json({
      status: 'ok',
      message: 'User profile successfully created',
      user: {
        id: newUser.id,
        role: newUser.role,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        phone: newUser.phone,
        email: newUser.email,
        language: newUser.language,
        status: newUser.status,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/auth/me
 * Allows authenticated user to update their own contact/profile details.
 * Prevents modifying role, status, email, or id.
 */
router.patch('/me', authenticateToken, requireAuthenticatedUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const body = req.body || {};

    // Security check: Clients cannot change role or status
    if (body.role !== undefined && body.role !== user.role) {
      return next(
        new ForbiddenError(
          'Users cannot modify their own role',
          'PRIVILEGED_FIELD_UPDATE_BLOCKED'
        )
      );
    }
    if (body.status !== undefined && body.status !== user.status) {
      return next(
        new ForbiddenError(
          'Users cannot modify their own account status',
          'PRIVILEGED_FIELD_UPDATE_BLOCKED'
        )
      );
    }

    const updates: Partial<User> = {
      updatedAt: new Date().toISOString(),
    };

    if (body.firstName !== undefined) {
      updates.firstName = assertString(body.firstName, 'firstName', 1, 64);
    }
    if (body.lastName !== undefined) {
      updates.lastName = assertString(body.lastName, 'lastName', 1, 64);
    }
    if (body.phone !== undefined) {
      updates.phone = assertString(body.phone, 'phone', 4, 32);
    }
    if (body.language !== undefined) {
      updates.language = body.language === 'en' ? 'en' : 'ka';
    }

    const adminDb = getAdminDb();
    if (adminDb) {
      const userRef = adminDb.collection(COLLECTIONS.USERS).doc(user.uid);
      await userRef.update(updates);
    }

    res.status(200).json({
      status: 'ok',
      message: 'Profile updated successfully',
      updates,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
