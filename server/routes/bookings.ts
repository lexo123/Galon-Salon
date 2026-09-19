/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Booking Management Endpoints
 * Enforces Phase 3A Profile Access Boundary & Phase 3B Booking Engine
 */

import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken } from '../middleware/auth.ts';
import {
  requireAuthenticatedUser,
  requireActiveAccount,
  requireCompleteProfile,
} from '../middleware/rbac.ts';
import { BookingEngine } from '../services/bookingEngine.ts';
import { getAdminDb } from '../config/firebaseAdmin.ts';
import { COLLECTIONS, Booking, BookingItem, isAdminRole, isStaffRole } from '../../src/types/index.ts';
import { NotFoundError, ForbiddenError, BadRequestError } from '../utils/errors.ts';
import { assertId } from '../utils/validation.ts';

const router = Router();

/**
 * POST /api/bookings
 * Creates a new booking with multi-item atomicity, ledger concurrency control,
 * and D42 idempotency enforcement.
 * Enforces:
 * - Token authentication
 * - Active account status
 * - Complete authoritative user profile (Phase 3A)
 */
router.post(
  '/',
  authenticateToken,
  requireAuthenticatedUser,
  requireActiveAccount,
  requireCompleteProfile,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;
      const body = req.body || {};

      // If customerId is specified, caller must be self or Admin/Owner
      let targetCustomerId = user.uid;
      if (body.customerId && body.customerId !== user.uid) {
        if (!isAdminRole(user.role)) {
          return next(
            new ForbiddenError(
              'Cannot create bookings on behalf of another user without administrative role',
              'ROLE_ESCALATION_BLOCKED'
            )
          );
        }
        targetCustomerId = body.customerId;
      }

      const idempotencyKey =
        (req.headers['idempotency-key'] as string | undefined) ||
        (body.idempotencyKey as string | undefined);

      const result = await BookingEngine.createBooking({
        customerId: targetCustomerId,
        actorRole: user.role,
        idempotencyKey,
        rawPayload: body,
        items: body.items,
      });

      const statusCode = result.isIdempotentReplay ? 200 : 201;
      res.status(statusCode).json({
        status: 'ok',
        isIdempotentReplay: result.isIdempotentReplay || false,
        booking: result.booking,
        items: result.items,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/bookings/:id
 * Retrieves booking details, associated items, and history.
 * Enforces ownership: customer owner OR staff/admin.
 */
router.get(
  '/:id',
  authenticateToken,
  requireAuthenticatedUser,
  requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bookingId = assertId(req.params.id, 'id');
      const user = req.user!;
      const adminDb = getAdminDb();

      if (!adminDb) {
        throw new BadRequestError('Database service unavailable', 'DB_UNAVAILABLE');
      }

      const bookingDoc = await adminDb.collection(COLLECTIONS.BOOKINGS).doc(bookingId).get();
      if (!bookingDoc.exists) {
        return next(new NotFoundError(`Booking #${bookingId} not found`, 'BOOKING_NOT_FOUND'));
      }

      const booking = bookingDoc.data() as Booking;

      const itemsSnapshot = await adminDb
        .collection(COLLECTIONS.BOOKING_ITEMS)
        .where('bookingId', '==', bookingId)
        .get();

      const items = itemsSnapshot.docs.map((d: any) => d.data() as BookingItem);

      // Ownership enforcement
      if (!isAdminRole(user.role)) {
        if (user.role === 'EMPLOYEE') {
          // Employee can view booking if assigned to them or if they are the customer
          let employeeId = user.uid;
          const empSnap = await adminDb
            .collection(COLLECTIONS.EMPLOYEES)
            .where('userId', '==', user.uid)
            .limit(1)
            .get();
          if (!empSnap.empty) {
            employeeId = empSnap.docs[0].id;
          }

          const hasAssignedItem = items.some((it) => it.employeeId === employeeId);
          const isCustomer = booking.customerId === user.uid;

          if (!hasAssignedItem && !isCustomer) {
            return next(
              new ForbiddenError(
                'You do not have permission to view this booking',
                'OWNERSHIP_REQUIRED'
              )
            );
          }
        } else if (booking.customerId !== user.uid) {
          // Regular customer can only view their own bookings
          return next(
            new ForbiddenError(
              'You do not have permission to view this booking',
              'OWNERSHIP_REQUIRED'
            )
          );
        }
      }

      // Only staff/admins get history
      let history: unknown[] = [];
      if (isAdminRole(user.role) || isStaffRole(user.role)) {
        const histSnapshot = await adminDb
          .collection(COLLECTIONS.BOOKING_HISTORY)
          .where('bookingId', '==', bookingId)
          .get();
        history = histSnapshot.docs.map((d: any) => d.data());
      }

      res.status(200).json({
        status: 'ok',
        booking,
        items,
        history,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/bookings
 * Lists bookings:
 * - CUSTOMER: sees only own bookings.
 * - EMPLOYEE: sees bookings assigned to their employee identity, plus own bookings.
 * - ADMIN / OWNER: sees all salon bookings (with optional customerId or employeeId filters).
 */
router.get(
  '/',
  authenticateToken,
  requireAuthenticatedUser,
  requireActiveAccount,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user!;
      const adminDb = getAdminDb();

      if (!adminDb) {
        return res.status(200).json({ status: 'ok', bookings: [] });
      }

      if (isAdminRole(user.role)) {
        let query: any = adminDb.collection(COLLECTIONS.BOOKINGS);
        if (req.query.customerId) {
          query = query.where('customerId', '==', req.query.customerId);
        }
        const snapshot = await query.limit(100).get();
        const bookings = snapshot.docs.map((d: any) => d.data() as Booking);
        return res.status(200).json({ status: 'ok', bookings });
      }

      if (user.role === 'EMPLOYEE') {
        // Resolve employee identity from userId mapping
        let employeeId = user.uid;
        const empSnap = await adminDb
          .collection(COLLECTIONS.EMPLOYEES)
          .where('userId', '==', user.uid)
          .limit(1)
          .get();
        if (!empSnap.empty) {
          employeeId = empSnap.docs[0].id;
        }

        // Query booking items assigned to this employee
        const itemsSnap = await adminDb
          .collection(COLLECTIONS.BOOKING_ITEMS)
          .where('employeeId', '==', employeeId)
          .get();

        const assignedBookingIds = Array.from(
          new Set(itemsSnap.docs.map((d: any) => d.data().bookingId))
        );

        // Also query any bookings where the employee is the customer
        const custBookingsSnap = await adminDb
          .collection(COLLECTIONS.BOOKINGS)
          .where('customerId', '==', user.uid)
          .get();

        const customerBookingIds = custBookingsSnap.docs.map((d: any) => d.id);
        const allTargetBookingIds = Array.from(
          new Set([...assignedBookingIds, ...customerBookingIds])
        );

        const bookings: Booking[] = [];
        for (const bId of allTargetBookingIds) {
          const bDoc = await adminDb.collection(COLLECTIONS.BOOKINGS).doc(bId).get();
          if (bDoc.exists) {
            bookings.push(bDoc.data() as Booking);
          }
        }

        return res.status(200).json({ status: 'ok', bookings });
      }

      // CUSTOMER: only see own bookings
      const query = adminDb
        .collection(COLLECTIONS.BOOKINGS)
        .where('customerId', '==', user.uid)
        .limit(50);
      const snapshot = await query.get();
      const bookings = snapshot.docs.map((d: any) => d.data() as Booking);

      res.status(200).json({
        status: 'ok',
        bookings,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/bookings/:id/cancel
 * Cancels a booking and releases intervals from employee availability ledgers.
 */
router.post(
  '/:id/cancel',
  authenticateToken,
  requireAuthenticatedUser,
  requireActiveAccount,
  requireCompleteProfile,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bookingId = assertId(req.params.id, 'id');
      const user = req.user!;
      const { reason } = req.body || {};

      const result = await BookingEngine.cancelBooking({
        bookingId,
        actorUserId: user.uid,
        actorRole: user.role,
        reason,
      });

      res.status(200).json({
        status: 'ok',
        message: 'Booking successfully cancelled',
        booking: result.booking,
        cancelledItemsCount: result.cancelledItemsCount,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/bookings/:id/reschedule
 * Reschedules booking items to new times/dates/employees.
 */
router.post(
  '/:id/reschedule',
  authenticateToken,
  requireAuthenticatedUser,
  requireActiveAccount,
  requireCompleteProfile,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bookingId = assertId(req.params.id, 'id');
      const user = req.user!;
      const { reschedules } = req.body || {};

      const result = await BookingEngine.rescheduleBooking({
        bookingId,
        actorUserId: user.uid,
        actorRole: user.role,
        reschedules,
      });

      res.status(200).json({
        status: 'ok',
        message: 'Booking successfully rescheduled',
        booking: result.booking,
        items: result.items,
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
