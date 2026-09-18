/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Notification Service
 * Enforces Phase 3 Notification Event Generation:
 * - Generates in-app notifications in Firestore after successful transaction commits.
 * - Simulates SMS channel delivery logging.
 * - External delivery failures do not roll back already-committed Firestore transactions.
 */

import { getAdminDb } from '../config/firebaseAdmin.ts';
import { COLLECTIONS, Notification } from '../../src/types/index.ts';
import { logger } from '../utils/logger.ts';

export interface NotificationParams {
  recipientUserId: string;
  bookingId: string;
  title: string;
  message: string;
  type: 'BOOKING_CREATED' | 'BOOKING_CANCELLED' | 'BOOKING_RESCHEDULED';
}

export class NotificationService {
  /**
   * Dispatches notifications across IN_APP and simulated SMS channels.
   * Executed strictly AFTER successful transaction commit.
   */
  public static async dispatchBookingEvent(params: NotificationParams): Promise<void> {
    try {
      const now = new Date().toISOString();
      const adminDb = getAdminDb();

      // 1. IN_APP Notification
      if (adminDb) {
        const notifDocRef = adminDb.collection(COLLECTIONS.NOTIFICATIONS).doc();
        const notificationRecord: Notification = {
          id: notifDocRef.id,
          recipientUserId: params.recipientUserId,
          type: params.type,
          title: params.title,
          message: params.message,
          channel: 'IN_APP',
          status: 'SENT',
          relatedBookingId: params.bookingId,
          createdAt: now,
          sentAt: now,
          readAt: null,
          failedAt: null,
        };

        await notifDocRef.set(notificationRecord);
        logger.info(`In-app notification generated for user ${params.recipientUserId}`, {
          notificationId: notifDocRef.id,
          bookingId: params.bookingId,
          type: params.type,
        });
      }

      // 2. SMS Delivery Simulation / Abstraction
      this.simulateSmsDelivery(params);
    } catch (err: unknown) {
      // Must not propagate failure to the caller or fail the transaction
      logger.error('Post-commit notification delivery encountered an issue', {
        error: (err as Error)?.message,
        bookingId: params.bookingId,
        recipientUserId: params.recipientUserId,
      });
    }
  }

  private static simulateSmsDelivery(params: NotificationParams): void {
    logger.info(`[SMS Dispatch Simulation] To: User ${params.recipientUserId} | Message: ${params.message}`);
  }
}
