/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Centralized Role-Based Access Control (RBAC) & Ownership Middleware
 */

import { Request, Response, NextFunction } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.ts';
import { UserRole, Permission, hasPermission, isAdminRole, isStaffRole } from '../../src/types/index.ts';

export function requireAuthenticatedUser(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    return next(new UnauthorizedError('Authentication required'));
  }
  next();
}

/**
 * Phase 3A: Profile-required access boundary.
 * Enforces that the authenticated user has an authoritative, complete, and active Firestore profile.
 * Users in profilePending state (e.g. Firebase Auth user without completed profile) are rejected.
 */
export function requireCompleteProfile(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    return next(new UnauthorizedError('Authentication required'));
  }
  if (!req.user.profile) {
    return next(
      new ForbiddenError(
        'User profile is incomplete or pending registration. Complete profile registration to perform this action.',
        'PROFILE_REQUIRED'
      )
    );
  }
  const { firstName, lastName, phone, status } = req.user.profile;
  if (!firstName || !firstName.trim() || !lastName || !lastName.trim() || !phone || !phone.trim()) {
    return next(
      new ForbiddenError(
        'Required profile details (name and phone) are missing. Please complete your profile.',
        'PROFILE_INCOMPLETE'
      )
    );
  }
  if (status !== 'ACTIVE' || req.user.status !== 'ACTIVE') {
    return next(
      new ForbiddenError(
        'Account is suspended or deactivated. Protected access denied.',
        'ACCOUNT_DISABLED'
      )
    );
  }
  next();
}

/**
 * Enforces that user account status is strictly ACTIVE.
 */
export function requireActiveAccount(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    return next(new UnauthorizedError('Authentication required'));
  }
  if (req.user.status !== 'ACTIVE') {
    return next(
      new ForbiddenError(
        'Account is suspended or deactivated. Protected access denied.',
        'ACCOUNT_DISABLED'
      )
    );
  }
  next();
}

export function requireRole(expectedRole: UserRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }
    if (req.user.role !== expectedRole) {
      return next(
        new ForbiddenError(
          `Action requires '${expectedRole}' role, current role is '${req.user.role}'`,
          'INSUFFICIENT_PERMISSIONS'
        )
      );
    }
    next();
  };
}

export function requireAnyRole(allowedRoles: readonly UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new ForbiddenError(
          `Action requires one of [${allowedRoles.join(', ')}], current role is '${req.user.role}'`,
          'INSUFFICIENT_PERMISSIONS'
        )
      );
    }
    next();
  };
}

/**
 * Enforces a granular capability permission using the centralized permission map.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }
    if (!hasPermission(req.user.role, permission)) {
      return next(
        new ForbiddenError(
          `Action requires '${permission}' permission`,
          'INSUFFICIENT_PERMISSIONS'
        )
      );
    }
    next();
  };
}

/**
 * Enforces resource ownership: the authenticated user must match targetUserId,
 * unless the caller has administrative privileges (ADMIN or OWNER).
 */
export function requireSelfOrAdmin(getTargetUserId: (req: Request) => string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }
    const targetUserId = getTargetUserId(req);
    if (!targetUserId) {
      return next(new ForbiddenError('Target user ID is missing', 'INVALID_TARGET_USER'));
    }
    if (req.user.uid !== targetUserId && !isAdminRole(req.user.role)) {
      return next(
        new ForbiddenError(
          'You do not have permission to access another user’s protected data',
          'OWNERSHIP_REQUIRED'
        )
      );
    }
    next();
  };
}

/**
 * Ensures user is an authorized staff member (Employee, Admin, or Owner).
 */
export const requireEmployee = requireAnyRole(['EMPLOYEE', 'ADMIN', 'OWNER'] as const);

/**
 * Ensures user has full administrative privileges (Admin or Owner).
 */
export const requireAdmin = requireAnyRole(['ADMIN', 'OWNER'] as const);

/**
 * Ensures user is an Owner.
 */
export const requireOwner = requireRole('OWNER');
