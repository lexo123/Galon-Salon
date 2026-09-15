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

function parseFirestoreValue(val: any): any {
  if (!val || typeof val !== 'object') return val;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('timestampValue' in val) return val.timestampValue;
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) {
    return (val.arrayValue.values || []).map((v: any) => parseFirestoreValue(v));
  }
  if ('mapValue' in val) {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      res[k] = parseFirestoreValue(v);
    }
    return res;
  }
  return undefined;
}

function parseFirestoreDocument(docJson: any): Record<string, any> {
  const fields = docJson.fields || {};
  const res: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    res[key] = parseFirestoreValue(value);
  }
  return res;
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

    let userDoc: { exists: boolean; id: string; data: () => any } | undefined;

    try {
      userDoc = (await adminDb.collection(COLLECTIONS.USERS).doc(decodedToken.uid).get()) as any;
    } catch (dbErr: any) {
      // In serverless environments where server service account keys are unset,
      // the Admin SDK lacks direct IAM datastore permissions (code 7 / PERMISSION_DENIED).
      // Fall back to reading the user's own profile via the authoritative Firestore REST API using their validated Bearer token.
      const isPermissionDenied =
        dbErr?.code === 7 ||
        String(dbErr?.message).includes('PERMISSION_DENIED') ||
        String(dbErr?.message).includes('insufficient permissions');

      if (isPermissionDenied && token) {
        const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID;
        if (projectId) {
          try {
            const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${COLLECTIONS.USERS}/${decodedToken.uid}`;
            const restRes = await fetch(url, {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            });

            if (restRes.status === 404 || restRes.status === 403) {
              // Document does not exist yet or rules restrict uninitialized profiles (legitimate registration race).
              // Treat as non-existent profile so low-privilege CUSTOMER / ACTIVE defaults are safely assigned.
              userDoc = { exists: false, id: decodedToken.uid, data: () => undefined };
            } else if (restRes.ok) {
              const json = await restRes.json();
              const parsed = parseFirestoreDocument(json);
              userDoc = { exists: true, id: decodedToken.uid, data: () => parsed };
            } else {
              return next(new UnauthorizedError('Unable to verify account status'));
            }
          } catch {
            return next(new UnauthorizedError('Unable to verify account status'));
          }
        } else {
          return next(new UnauthorizedError('Unable to verify account status'));
        }
      } else {
        // Any other database error (connection timeout, network drop, etc.) MUST fail closed.
        return next(new UnauthorizedError('Unable to verify account status'));
      }
    }

    if (userDoc && userDoc.exists) {
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
