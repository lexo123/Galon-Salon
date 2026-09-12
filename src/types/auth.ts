/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Centralized Role-Based Access Control (RBAC) & Permissions Architecture
 */

import { UserRole, UserStatus } from './domain.ts';

// ============================================================================
// PERMISSIONS
// Granular permission identifiers for authorization checks across the system.
// ============================================================================

export type Permission =
  | 'profile:read:own'
  | 'profile:update:own'
  | 'users:read:any'
  | 'users:manage:any'
  | 'employees:read:customer_facing'
  | 'employees:read:all'
  | 'employees:manage'
  | 'bookings:create:own'
  | 'bookings:read:own'
  | 'bookings:cancel:own'
  | 'bookings:manage:all'
  | 'admin:access'
  | 'audit:read';

/**
 * Authoritative mapping of UserRole to granted Permissions.
 * Kept simple, explicit, and extensible.
 */
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  CUSTOMER: [
    'profile:read:own',
    'profile:update:own',
    'employees:read:customer_facing',
    'bookings:create:own',
    'bookings:read:own',
    'bookings:cancel:own',
  ],
  EMPLOYEE: [
    'profile:read:own',
    'profile:update:own',
    'employees:read:customer_facing',
    'bookings:read:own',
  ],
  ADMIN: [
    'profile:read:own',
    'profile:update:own',
    'users:read:any',
    'users:manage:any',
    'employees:read:customer_facing',
    'employees:read:all',
    'employees:manage',
    'bookings:manage:all',
    'admin:access',
    'audit:read',
  ],
  OWNER: [
    'profile:read:own',
    'profile:update:own',
    'users:read:any',
    'users:manage:any',
    'employees:read:customer_facing',
    'employees:read:all',
    'employees:manage',
    'bookings:manage:all',
    'admin:access',
    'audit:read',
  ],
};

/**
 * Checks whether a given role has a specific permission.
 */
export function hasPermission(role: UserRole, permission: Permission): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  return permissions ? permissions.includes(permission) : false;
}

/**
 * Helper to determine if a role has administrative authority (Admin or Owner).
 */
export function isAdminRole(role: UserRole): boolean {
  return role === 'ADMIN' || role === 'OWNER';
}

/**
 * Helper to determine if a role is a staff member (Employee, Admin, or Owner).
 */
export function isStaffRole(role: UserRole): boolean {
  return role === 'EMPLOYEE' || role === 'ADMIN' || role === 'OWNER';
}

/**
 * Checks whether an account status allows access to protected application functionality.
 */
export function isAccountActive(status: UserStatus): boolean {
  return status === 'ACTIVE';
}
