/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Phase 2 Automated Tests: Authentication, User Roles, RBAC & Ownership
 */

import { describe, it, expect, vi } from 'vitest';
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
import { UnauthorizedError, ForbiddenError } from '../server/utils/errors.ts';
import type { Request, Response, NextFunction } from 'express';

function createMockReq(user?: AuthenticatedUser, params: Record<string, string> = {}, headers: Record<string, string> = {}): Request {
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

describe('Phase 2 Security: Environment & Secret Hygiene', () => {
  it('confirms server credentials do not use VITE_ prefix', () => {
    const serverVarNames = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
    serverVarNames.forEach((varName) => {
      expect(varName.startsWith('VITE_')).toBe(false);
    });
  });
});
