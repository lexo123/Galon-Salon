/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * GALON SALON — DOMAIN TYPE DEFINITIONS
 * Authoritative TypeScript domain models for the Galon Salon architecture.
 */

// ============================================================================
// 1. CONSTANTS & TIMEZONE
// ============================================================================

export const BUSINESS_TIMEZONE = 'Asia/Tbilisi' as const;
export const DEFAULT_CURRENCY = 'GEL' as const;
export const DEFAULT_LANGUAGE = 'ka' as const;

export const COLLECTIONS = {
  USERS: 'users',
  EMPLOYEES: 'employees',
  CATEGORIES: 'categories',
  SERVICES: 'services',
  EMPLOYEE_SERVICES: 'employeeServices',
  EMPLOYEE_PROFILES: 'employeeProfiles',
  EMPLOYEE_PORTFOLIO: 'employeePortfolio',
  MEDIA: 'media',
  WEEKLY_SCHEDULES: 'weeklySchedules',
  SCHEDULE_BREAKS: 'scheduleBreaks',
  SCHEDULE_EXCEPTIONS: 'scheduleExceptions',
  BOOKINGS: 'bookings',
  BOOKING_ITEMS: 'bookingItems',
  BOOKING_HISTORY: 'bookingHistory',
  EMPLOYEE_REVIEWS: 'employeeReviews',
  CUSTOMER_RATINGS: 'customerRatings',
  REVIEW_HISTORY: 'reviewHistory',
  NOTIFICATIONS: 'notifications',
  PAYMENTS: 'payments',
  AUDIT_LOGS: 'auditLogs',
  IDEMPOTENCY: 'idempotency',
  AVAILABILITY: 'availability',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

// ============================================================================
// 2. USER & ROLES
// ============================================================================

export type UserRole = 'CUSTOMER' | 'EMPLOYEE' | 'ADMIN' | 'OWNER';

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

export type SupportedLanguage = 'ka' | 'en';

export interface User {
  id: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  language: SupportedLanguage;
  status: UserStatus;
  createdAt: string; // ISO 8601 or Firestore Timestamp representation
  updatedAt: string;
  lastLoginAt?: string | null;
  deletedAt?: string | null;
}

// ============================================================================
// 3. EMPLOYEE
// ============================================================================

export type EmployeeType = 'CUSTOMER_FACING' | 'INTERNAL';

export type EmployeeStatus = 'ACTIVE' | 'INACTIVE' | 'DEACTIVATED';

export interface Employee {
  id: string;
  userId: string;
  employeeType: EmployeeType;
  firstName: string;
  lastName: string;
  phone: string;
  status: EmployeeStatus;
  createdAt: string;
  updatedAt: string;
  deactivatedAt?: string | null;
}

export interface EmployeeProfile {
  id: string;
  employeeId: string;
  photoId?: string | null;
  bioKa: string;
  bioEn: string;
  displayOrder: number;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeePortfolio {
  id: string;
  employeeId: string;
  mediaId: string;
  titleKa: string;
  titleEn: string;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeService {
  id: string;
  employeeId: string;
  serviceId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// 4. CATEGORY & SERVICE
// ============================================================================

export interface Category {
  id: string;
  nameKa: string;
  nameEn: string;
  descriptionKa: string;
  descriptionEn: string;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Service {
  id: string;
  categoryId: string;
  nameKa: string;
  nameEn: string;
  descriptionKa: string;
  descriptionEn: string;
  priceMin: number;
  priceMax: number;
  durationMin: number; // in minutes
  durationMax: number; // in minutes
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// 5. SCHEDULES & AVAILABILITY
// ============================================================================

export interface WeeklySchedule {
  id: string;
  employeeId: string;
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday, 1 = Monday, ...
  isWorking: boolean;
  startTime: string; // "HH:mm" in Asia/Tbilisi
  endTime: string; // "HH:mm" in Asia/Tbilisi
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleBreak {
  id: string;
  scheduleId: string;
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
}

export type ScheduleExceptionType = 'OFF' | 'CUSTOM_HOURS';

export interface ScheduleException {
  id: string;
  employeeId: string;
  startDate: string; // "YYYY-MM-DD"
  endDate: string; // "YYYY-MM-DD"
  type: ScheduleExceptionType;
  startTime?: string | null; // "HH:mm" if CUSTOM_HOURS
  endTime?: string | null; // "HH:mm" if CUSTOM_HOURS
  reason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookedInterval {
  bookingId: string;
  bookingItemId: string;
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
}

export interface AvailabilityLedger {
  id: string; // Format: `${employeeId}_${YYYY-MM-DD}`
  employeeId: string;
  date: string; // "YYYY-MM-DD"
  bookedIntervals: BookedInterval[];
  updatedAt: string;
}

// ============================================================================
// 6. BOOKINGS
// ============================================================================

export type BookingStatus = 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';

export type BookingItemStatus = 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';

export interface Booking {
  id: string;
  customerId: string;
  status: BookingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PriceSnapshot {
  min: number;
  max: number;
  currency: typeof DEFAULT_CURRENCY;
}

export interface ServiceSnapshot {
  nameKa: string;
  nameEn: string;
  categoryId: string;
}

export interface BookingItem {
  id: string;
  bookingId: string;
  serviceId: string;
  employeeId: string;
  startTime: string; // Stored as ISO string in domain representations / Firestore Timestamp
  endTime: string;
  durationMinutes: number;
  priceSnapshot: PriceSnapshot;
  serviceSnapshot: ServiceSnapshot;
  status: BookingItemStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BookingHistory {
  id: string;
  bookingId: string;
  changedByUserId: string;
  changedByRole: UserRole;
  action: string;
  previousData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  createdAt: string;
}

// ============================================================================
// 7. REVIEWS & RATINGS
// ============================================================================

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'DELETED';

export interface EmployeeReview {
  id: string;
  employeeId: string;
  customerId: string;
  bookingId: string;
  rating: number; // 1 to 5
  comment?: string | null;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface CustomerRating {
  id: string;
  customerId: string;
  employeeId: string;
  bookingId: string;
  rating: number; // 1 to 5
  comment?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface ReviewHistory {
  id: string;
  reviewId: string;
  changedByUserId: string;
  action: string;
  previousData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  createdAt: string;
}

// ============================================================================
// 8. NOTIFICATIONS
// ============================================================================

export type NotificationChannel = 'IN_APP' | 'SMS';
export type NotificationStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface Notification {
  id: string;
  recipientUserId: string;
  type: string;
  title: string;
  message: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  relatedBookingId?: string | null;
  createdAt: string;
  sentAt?: string | null;
  readAt?: string | null;
  failedAt?: string | null;
}

// ============================================================================
// 9. PAYMENTS (FUTURE ENTITY FOUNDATION)
// ============================================================================

export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';

export interface Payment {
  id: string;
  bookingId: string;
  customerId: string;
  amount: number;
  currency: typeof DEFAULT_CURRENCY;
  status: PaymentStatus;
  provider: string;
  providerPaymentId?: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt?: string | null;
}

// ============================================================================
// 10. AUDIT LOG & IDEMPOTENCY
// ============================================================================

export interface AuditLog {
  id: string;
  actorUserId: string;
  actorRole: UserRole;
  action: string;
  entityType: string;
  entityId: string;
  previousData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  createdAt: string;
}

export interface IdempotencyRecord {
  id: string;
  userId: string;
  idempotencyKey: string;
  resultingBookingId?: string | null;
  requestHash?: string | null;
  createdAt: string;
}

// ============================================================================
// 11. MEDIA
// ============================================================================

export interface Media {
  id: string;
  storagePath: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedByUserId: string;
  createdAt: string;
  deletedAt?: string | null;
}

// ============================================================================
// 12. CENTRALIZED BUSINESS STATUS HELPERS
// ============================================================================

/**
 * Returns true if a BookingItem status blocks an employee's availability ledger.
 * Only confirmed items hold ledger capacity.
 */
export function isBlockingBookingItemStatus(status: BookingItemStatus): boolean {
  return status === 'CONFIRMED';
}

/**
 * Returns true if a Booking is in a terminal lifecycle state.
 */
export function isTerminalBookingStatus(status: BookingStatus): boolean {
  return status === 'CANCELLED' || status === 'COMPLETED';
}

/**
 * Validates whether an employee is eligible for public customer booking.
 */
export function isCustomerFacingActive(employee: Pick<Employee, 'employeeType' | 'status'>): boolean {
  return employee.employeeType === 'CUSTOMER_FACING' && employee.status === 'ACTIVE';
}
