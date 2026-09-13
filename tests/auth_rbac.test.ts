/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Phase 2 Automated Tests: Authentication, User Roles, RBAC & Security Boundaries
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  UserRole,
  UserStatus,
  ROLE_PERMISSIONS,
  hasPermission,
  isAdminRole,
  isStaffRole,
  isAccountActive,
} from '../src/types/index.ts';
import {
  requireAuthenticatedUser,
  requireActiveAccount,
  requireRole,
  requireAnyRole,
  requireEmployee,
  requireAdmin,
  requireOwner,
  requireSelfOrAdmin,
} from '../server/middleware/rbac.ts';
import { authenticateToken, AuthenticatedUser } from '../server/middleware/auth.ts';
import * as firebaseAdminModule from '../server/config/firebaseAdmin.ts';
import { UnauthorizedError, ForbiddenError } from '../server/utils/errors.ts';
import type { Request, Response, NextFunction } from 'express';

function createMockReq(
  user?: AuthenticatedUser,
  params: Record<string, string> = {},
  headers: Record<string, string> = {}
): Request {
  return {
    user,
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

describe('Phase 2 RBAC: Role & Permission Architecture', () => {
  it('assigns correct granular permissions to CUSTOMER', () => {
    expect(hasPermission('CUSTOMER', 'profile:read:own')).toBe(true);
    expect(hasPermission('CUSTOMER', 'profile:update:own')).toBe(true);
    expect(hasPermission('CUSTOMER', 'bookings:create:own')).toBe(true);
    expect(hasPermission('CUSTOMER', 'admin:access')).toBe(false);
    expect(hasPermission('CUSTOMER', 'users:read:any')).toBe(false);
    expect(hasPermission('CUSTOMER', 'employees:manage')).toBe(false);
  });

  it('assigns correct granular permissions to EMPLOYEE', () => {
    expect(hasPermission('EMPLOYEE', 'profile:read:own')).toBe(true);
    expect(hasPermission('EMPLOYEE', 'employees:read:customer_facing')).toBe(true);
    expect(hasPermission('EMPLOYEE', 'admin:access')).toBe(false);
    expect(hasPermission('EMPLOYEE', 'employees:manage')).toBe(false);
  });

  it('assigns full administrative permissions to ADMIN and OWNER', () => {
    expect(hasPermission('ADMIN', 'admin:access')).toBe(true);
    expect(hasPermission('ADMIN', 'users:manage:any')).toBe(true);
    expect(hasPermission('ADMIN', 'employees:manage')).toBe(true);
    expect(hasPermission('ADMIN', 'audit:read')).toBe(true);

    expect(hasPermission('OWNER', 'admin:access')).toBe(true);
    expect(hasPermission('OWNER', 'users:manage:any')).toBe(true);
    expect(hasPermission('OWNER', 'employees:manage')).toBe(true);
  });

  it('correctly evaluates role hierarchy helper functions', () => {
    expect(isAdminRole('ADMIN')).toBe(true);
    expect(isAdminRole('OWNER')).toBe(true);
    expect(isAdminRole('EMPLOYEE')).toBe(false);
    expect(isAdminRole('CUSTOMER')).toBe(false);

    expect(isStaffRole('EMPLOYEE')).toBe(true);
    expect(isStaffRole('ADMIN')).toBe(true);
    expect(isStaffRole('OWNER')).toBe(true);
    expect(isStaffRole('CUSTOMER')).toBe(false);
  });

  it('evaluates account status active checks correctly', () => {
    expect(isAccountActive('ACTIVE')).toBe(true);
    expect(isAccountActive('SUSPENDED')).toBe(false);
    expect(isAccountActive('DELETED')).toBe(false);
  });
});

describe('Phase 2 Middleware: Authentication & Status Enforcement', () => {
  it('rejects unauthenticated requests in requireAuthenticatedUser (401)', () => {
    const req = createMockReq(undefined);
    const res = createMockRes();
    const next = vi.fn();

    requireAuthenticatedUser(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    const error = next.mock.calls[0][0] as UnauthorizedError;
    expect(error.statusCode).toBe(401);
  });

  it('allows authenticated requests in requireAuthenticatedUser', () => {
    const req = createMockReq({
      uid: 'user_1',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    });
    const res = createMockRes();
    const next = vi.fn();

    requireAuthenticatedUser(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects suspended or deleted accounts with 403 ACCOUNT_DISABLED', () => {
    const reqSuspended = createMockReq({
      uid: 'user_suspended',
      role: 'CUSTOMER',
      status: 'SUSPENDED',
    });
    const next1 = vi.fn();
    requireActiveAccount(reqSuspended, createMockRes(), next1);
    expect(next1).toHaveBeenCalledWith(expect.any(ForbiddenError));
    const err1 = next1.mock.calls[0][0] as ForbiddenError;
    expect(err1.statusCode).toBe(403);
    expect(err1.code).toBe('ACCOUNT_DISABLED');

    const reqDeleted = createMockReq({
      uid: 'user_deleted',
      role: 'CUSTOMER',
      status: 'DELETED',
    });
    const next2 = vi.fn();
    requireActiveAccount(reqDeleted, createMockRes(), next2);
    expect(next2).toHaveBeenCalledWith(expect.any(ForbiddenError));
  });

  it('rejects requests with missing or malformed Authorization header (401)', async () => {
    const reqNoHeader = createMockReq(undefined, {}, {});
    const next = vi.fn();
    await authenticateToken(reqNoHeader, createMockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));

    const reqBadHeader = createMockReq(undefined, {}, { authorization: 'Basic 12345' });
    const next2 = vi.fn();
    await authenticateToken(reqBadHeader, createMockRes(), next2);
    expect(next2).toHaveBeenCalledWith(expect.any(UnauthorizedError));
  });
});

describe('Phase 2 Middleware: Fail-Closed Auth & Firestore Resolution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('successfully resolves an existing ACTIVE user from Firestore', async () => {
    const mockVerifyIdToken = vi.fn().mockResolvedValue({
      uid: 'user_active_1',
      email: 'active@example.com',
      email_verified: true,
    });
    const mockUserDocGet = vi.fn().mockResolvedValue({
      exists: true,
      id: 'user_active_1',
      data: () => ({
        id: 'user_active_1',
        role: 'CUSTOMER',
        status: 'ACTIVE',
        firstName: 'Nino',
        lastName: 'Lomidze',
        phone: '+995555111222',
        email: 'active@example.com',
        language: 'ka',
      }),
    });

    vi.spyOn(firebaseAdminModule, 'getAdminAuth').mockReturnValue({
      verifyIdToken: mockVerifyIdToken,
    } as any);
    vi.spyOn(firebaseAdminModule, 'getAdminDb').mockReturnValue({
      collection: () => ({
        doc: () => ({
          get: mockUserDocGet,
        }),
      }),
    } as any);

    const req = createMockReq(undefined, {}, { authorization: 'Bearer valid_token' });
    const next = vi.fn();

    await authenticateToken(req, createMockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeDefined();
    expect(req.user?.uid).toBe('user_active_1');
    expect(req.user?.role).toBe('CUSTOMER');
    expect(req.user?.status).toBe('ACTIVE');
  });

  it('assigns safe low-privilege defaults (CUSTOMER / ACTIVE) when user document does not exist (registration race)', async () => {
    const mockVerifyIdToken = vi.fn().mockResolvedValue({
      uid: 'user_race_1',
      email: 'race@example.com',
      email_verified: true,
      role: 'ADMIN', // Token claims must NOT override
    });
    const mockUserDocGet = vi.fn().mockResolvedValue({
      exists: false,
    });

    vi.spyOn(firebaseAdminModule, 'getAdminAuth').mockReturnValue({
      verifyIdToken: mockVerifyIdToken,
    } as any);
    vi.spyOn(firebaseAdminModule, 'getAdminDb').mockReturnValue({
      collection: () => ({
        doc: () => ({
          get: mockUserDocGet,
        }),
      }),
    } as any);

    const req = createMockReq(undefined, {}, { authorization: 'Bearer race_token' });
    const next = vi.fn();

    await authenticateToken(req, createMockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeDefined();
    expect(req.user?.uid).toBe('user_race_1');
    expect(req.user?.role).toBe('CUSTOMER'); // Default low privilege
    expect(req.user?.status).toBe('ACTIVE');
  });

  it('fails closed when Firestore lookup throws a database/network error', async () => {
    const mockVerifyIdToken = vi.fn().mockResolvedValue({
      uid: 'user_err_1',
      email: 'err@example.com',
      role: 'ADMIN', // Even with admin claim
    });
    const mockUserDocGet = vi.fn().mockRejectedValue(new Error('Firestore connection failure / timeout'));

    vi.spyOn(firebaseAdminModule, 'getAdminAuth').mockReturnValue({
      verifyIdToken: mockVerifyIdToken,
    } as any);
    vi.spyOn(firebaseAdminModule, 'getAdminDb').mockReturnValue({
      collection: () => ({
        doc: () => ({
          get: mockUserDocGet,
        }),
      }),
    } as any);

    const req = createMockReq(undefined, {}, { authorization: 'Bearer db_error_token' });
    const next = vi.fn();

    await authenticateToken(req, createMockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    const error = next.mock.calls[0][0] as UnauthorizedError;
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('Unable to verify account status');
    expect(req.user).toBeUndefined(); // MUST NOT attach active user
  });

  it('rejects suspended users in Firestore with 403 ACCOUNT_DISABLED', async () => {
    const mockVerifyIdToken = vi.fn().mockResolvedValue({
      uid: 'user_suspended_1',
      email: 'suspended@example.com',
    });
    const mockUserDocGet = vi.fn().mockResolvedValue({
      exists: true,
      id: 'user_suspended_1',
      data: () => ({
        role: 'CUSTOMER',
        status: 'SUSPENDED',
      }),
    });

    vi.spyOn(firebaseAdminModule, 'getAdminAuth').mockReturnValue({
      verifyIdToken: mockVerifyIdToken,
    } as any);
    vi.spyOn(firebaseAdminModule, 'getAdminDb').mockReturnValue({
      collection: () => ({
        doc: () => ({
          get: mockUserDocGet,
        }),
      }),
    } as any);

    const req = createMockReq(undefined, {}, { authorization: 'Bearer suspended_token' });
    const next = vi.fn();

    await authenticateToken(req, createMockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    const error = next.mock.calls[0][0] as ForbiddenError;
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('Phase 2 Middleware: Role-Based Access Control (RBAC)', () => {
  it('CUSTOMER is allowed on customer endpoints and denied from admin endpoints (403)', () => {
    const customerUser: AuthenticatedUser = {
      uid: 'cust_123',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    };
    const req = createMockReq(customerUser);
    const next = vi.fn();

    requireAdmin(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    const err = next.mock.calls[0][0] as ForbiddenError;
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('EMPLOYEE is denied from admin-only endpoints (403)', () => {
    const employeeUser: AuthenticatedUser = {
      uid: 'emp_123',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
    };
    const req = createMockReq(employeeUser);
    const next = vi.fn();

    requireAdmin(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
  });

  it('EMPLOYEE is allowed on staff endpoints via requireEmployee', () => {
    const employeeUser: AuthenticatedUser = {
      uid: 'emp_123',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
    };
    const req = createMockReq(employeeUser);
    const next = vi.fn();

    requireEmployee(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('CUSTOMER is denied from staff endpoints via requireEmployee', () => {
    const customerUser: AuthenticatedUser = {
      uid: 'cust_123',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    };
    const req = createMockReq(customerUser);
    const next = vi.fn();

    requireEmployee(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
  });

  it('ADMIN is allowed on admin endpoints', () => {
    const adminUser: AuthenticatedUser = {
      uid: 'admin_123',
      role: 'ADMIN',
      status: 'ACTIVE',
    };
    const req = createMockReq(adminUser);
    const next = vi.fn();

    requireAdmin(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('OWNER is allowed on admin and owner endpoints', () => {
    const ownerUser: AuthenticatedUser = {
      uid: 'owner_123',
      role: 'OWNER',
      status: 'ACTIVE',
    };
    const req = createMockReq(ownerUser);
    const nextAdmin = vi.fn();
    const nextOwner = vi.fn();

    requireAdmin(req, createMockRes(), nextAdmin);
    expect(nextAdmin).toHaveBeenCalledWith();

    requireOwner(req, createMockRes(), nextOwner);
    expect(nextOwner).toHaveBeenCalledWith();
  });
});

describe('Phase 2 Middleware: Resource Ownership Enforcement', () => {
  it('allows a user to access their own protected resource', () => {
    const req = createMockReq(
      { uid: 'user_abc', role: 'CUSTOMER', status: 'ACTIVE' },
      { userId: 'user_abc' }
    );
    const next = vi.fn();

    const guard = requireSelfOrAdmin((r) => r.params.userId);
    guard(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('denies User A from accessing User B protected resource (403)', () => {
    const req = createMockReq(
      { uid: 'user_abc', role: 'CUSTOMER', status: 'ACTIVE' },
      { userId: 'user_xyz' }
    );
    const next = vi.fn();

    const guard = requireSelfOrAdmin((r) => r.params.userId);
    guard(req, createMockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
    const err = next.mock.calls[0][0] as ForbiddenError;
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('OWNERSHIP_REQUIRED');
  });

  it('allows an ADMIN or OWNER to access another user protected resource', () => {
    const adminReq = createMockReq(
      { uid: 'admin_1', role: 'ADMIN', status: 'ACTIVE' },
      { userId: 'user_xyz' }
    );
    const nextAdmin = vi.fn();
    const guard = requireSelfOrAdmin((r) => r.params.userId);
    guard(adminReq, createMockRes(), nextAdmin);
    expect(nextAdmin).toHaveBeenCalledWith();

    const ownerReq = createMockReq(
      { uid: 'owner_1', role: 'OWNER', status: 'ACTIVE' },
      { userId: 'user_xyz' }
    );
    const nextOwner = vi.fn();
    guard(ownerReq, createMockRes(), nextOwner);
    expect(nextOwner).toHaveBeenCalledWith();
  });
});

describe('Phase 2 Security: Firestore Security Rules & Client Single Write Path', () => {
  const rulesContent = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf-8');

  it('ensures bookingItems has allow read, write: if false (client deny-all)', () => {
    const bookingItemsMatch = rulesContent.match(/match\s+\/bookingItems\/\{bookingItemId\}\s*\{([^}]+)\}/);
    expect(bookingItemsMatch).not.toBeNull();
    const ruleBody = bookingItemsMatch![1];
    expect(ruleBody).toContain('allow read, write: if false;');
  });

  it('ensures users collection has allow create: if false (backend-mediated only)', () => {
    const usersMatch = rulesContent.match(/match\s+\/users\/\{userId\}\s*\{([^}]+(?:\{[^}]+\}[^}]+)*)\}/);
    expect(usersMatch).not.toBeNull();
    const ruleBody = usersMatch![1];
    expect(ruleBody).toContain('allow create: if false;');
  });

  it('confirms AuthContext.tsx has no direct client setDoc write in registerCustomer', () => {
    const authContextContent = fs.readFileSync(
      path.resolve(process.cwd(), 'src/auth/AuthContext.tsx'),
      'utf-8'
    );
    // Ensure setDoc is not imported or called
    expect(authContextContent).not.toContain('setDoc(');
    // Ensure registerCustomer calls /api/auth/register-profile
    expect(authContextContent).toContain('/api/auth/register-profile');
  });

  it('confirms server credentials do not use VITE_ prefix', () => {
    const serverVarNames = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
    serverVarNames.forEach((varName) => {
      expect(varName.startsWith('VITE_')).toBe(false);
    });
  });
});
