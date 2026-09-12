/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Centralized Backend Error Hierarchy & Express Error Handler
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from './logger.ts';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly metadata?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    metadata?: Record<string, unknown>
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED', metadata?: Record<string, unknown>) {
    super(401, code, message, metadata);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden', code = 'FORBIDDEN', metadata?: Record<string, unknown>) {
    super(403, code, message, metadata);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = 'NOT_FOUND', metadata?: Record<string, unknown>) {
    super(404, code, message, metadata);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', code = 'BAD_REQUEST', metadata?: Record<string, unknown>) {
    super(400, code, message, metadata);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'CONFLICT', metadata?: Record<string, unknown>) {
    super(409, code, message, metadata);
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const code = isAppError ? err.code : 'INTERNAL_SERVER_ERROR';
  const message = isAppError ? err.message : 'An unexpected error occurred';

  logger.error('Unhandled request error', {
    method: req.method,
    path: req.path,
    statusCode,
    code,
    error: err.message,
  });

  res.status(statusCode).json({
    status: 'error',
    code,
    message,
    ...(isAppError && err.metadata ? { details: err.metadata } : {}),
  });
}
