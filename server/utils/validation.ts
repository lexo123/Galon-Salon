/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Centralized Input Validation Utilities
 */

import { BadRequestError } from './errors.ts';

export function assertString(val: unknown, fieldName: string, min = 1, max = 255): string {
  if (typeof val !== 'string' || val.trim().length < min || val.trim().length > max) {
    throw new BadRequestError(
      `Invalid field '${fieldName}': must be a string between ${min} and ${max} characters`,
      'VALIDATION_FAILED',
      { fieldName, min, max }
    );
  }
  return val.trim();
}

export function assertEnum<T extends string>(val: unknown, fieldName: string, allowed: readonly T[]): T {
  if (typeof val !== 'string' || !allowed.includes(val as T)) {
    throw new BadRequestError(
      `Invalid field '${fieldName}': must be one of [${allowed.join(', ')}]`,
      'VALIDATION_FAILED',
      { fieldName, allowed }
    );
  }
  return val as T;
}

export function assertId(val: unknown, fieldName: string): string {
  if (typeof val !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(val)) {
    throw new BadRequestError(
      `Invalid ID for '${fieldName}': must match /^[a-zA-Z0-9_-]{1,128}$/`,
      'INVALID_ID',
      { fieldName }
    );
  }
  return val;
}

export function assertDateString(val: unknown, fieldName: string): string {
  if (typeof val !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    throw new BadRequestError(
      `Invalid date format for '${fieldName}': must match YYYY-MM-DD`,
      'INVALID_DATE_FORMAT',
      { fieldName }
    );
  }
  return val;
}

export function assertTimeString(val: unknown, fieldName: string): string {
  if (typeof val !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(val)) {
    throw new BadRequestError(
      `Invalid time format for '${fieldName}': must match HH:mm`,
      'INVALID_TIME_FORMAT',
      { fieldName }
    );
  }
  return val;
}
