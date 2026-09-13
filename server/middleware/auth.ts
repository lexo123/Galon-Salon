/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Authentication Middleware using Firebase Admin SDK
 * Enforces token validity and resolves authoritative role and account status from Firestore.
 */

import { Request, Response, NextFunction } from 'express';
import { getAdminAuth, getAdminDb } from '../config/firebaseAdmin.ts';
import { UnauthorizedError, ForbiddenError } from '../utils/errors.ts';
import { UserRole, UserStatus, COLLECTIONS, User } from '../../src/types/index.ts';

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  role: UserRole;
  status: UserStatus;
  profile?: User;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export async function authenticateToken(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing or malformed Authorization header with Bearer token'));
  }

  const token = authHeader.split('Bearer ')[1]?.trim();
  if (!token) {
    return next(new UnauthorizedError('Empty Bearer token'));
  }

  const adminAuth = getAdminAuth();
  if (!adminAuth) {
    return next(new UnauthorizedError('Firebase Admin Auth service is unavailable'));
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    
    // Authoritative resolution from Firestore users collection
    let role: UserRole = 'CUSTOMER';
    let status: UserStatus = 'ACTIVE';
    let userProfile: User | undefined;

    const adminDb = getAdminDb();
    if (!adminDb) {
      return next(new UnauthorizedError('Database service is unavailable'));
    }

    try {
      const userDoc = await adminDb.collection(COLLECTIONS.USERS).doc(decodedToken.uid).get();
      if (userDoc.exists) {
        const data = userDoc.data() as User;
        if (data.role) role = data.role;
        if (data.status) status = data.status;
        userProfile = {
          id: userDoc.id,
          role: data.role || 'CUSTOMER',
          firstName: data.firstName || '',
          lastName: data.lastName || '',
          phone: data.phone || '',
          email: data.email || decodedToken.email || '',
          language: data.language || 'ka',
          status: data.status || 'ACTIVE',
          createdAt: data.createdAt || new Date().toISOString(),
          updatedAt: data.updatedAt || new Date().toISOString(),
          lastLoginAt: data.lastLoginAt || null,
          deletedAt: data.deletedAt || null,
        };
      } else {
        // Legitimate registration race: user document does not exist yet.
        // Assign low-privilege defaults only; do NOT allow unrestricted access.
        role = 'CUSTOMER';
        status = 'ACTIVE';
      }
    } catch (dbErr) {
      // A database read error MUST fail closed.
      // MUST NOT leave status as ACTIVE or fall back to custom claims.
      return next(new UnauthorizedError('Unable to verify account status'));
    }

    // Account status enforcement: Disabled/deactivated users cannot access protected application functionality
    if (status !== 'ACTIVE') {
      return next(
        new ForbiddenError(
          'Account is suspended or deactivated. Protected access denied.',
          'ACCOUNT_DISABLED'
        )
      );
    }

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified,
      role,
      status,
      profile: userProfile,
    };

    next();
  } catch (error) {
    next(new UnauthorizedError('Invalid or expired Firebase ID token', 'INVALID_TOKEN'));
  }
}
