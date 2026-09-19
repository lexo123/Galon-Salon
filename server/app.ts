/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Express Application Assembly
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import healthRoutes from './routes/health.ts';
import authRoutes from './routes/auth.ts';
import userRoutes from './routes/users.ts';
import bookingRoutes from './routes/bookings.ts';
import employeeRoutes from './routes/employees.ts';
import { errorHandler } from './utils/errors.ts';
import { logger } from './utils/logger.ts';
import { initializeFirebaseAdmin } from './config/firebaseAdmin.ts';

export function createExpressApp(): Express {
  const app = express();

  // Initialize Firebase Admin SDK
  initializeFirebaseAdmin();

  // Standard middleware
  app.use(cors());
  app.use(express.json());

  // Structured request logger
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.info(`HTTP ${req.method} ${req.path}`);
    next();
  });

  // Register API Routes
  app.use('/api', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/employees', employeeRoutes);

  // Centralized Error Handler
  app.use(errorHandler);

  return app;
}
