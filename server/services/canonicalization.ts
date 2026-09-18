/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Deterministic Request Canonicalization & Hashing
 * Enforces Phase 3 Idempotency Policy (D42):
 * - Sorts object keys recursively to eliminate false conflicts caused by serialization ordering.
 * - Produces deterministic SHA-256 hash for idempotent request matching.
 */

import crypto from 'node:crypto';

/**
 * Recursively normalizes an arbitrary value into a deterministic structure
 * where all object keys are sorted lexicographically.
 */
export function canonicalizeValue(val: unknown): unknown {
  if (val === null || val === undefined) {
    return null;
  }

  if (typeof val === 'number' || typeof val === 'boolean') {
    return val;
  }

  if (typeof val === 'string') {
    return val.trim();
  }

  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }

  if (typeof val === 'object') {
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(val as Record<string, unknown>).sort();
    for (const key of keys) {
      const nestedVal = (val as Record<string, unknown>)[key];
      if (nestedVal !== undefined) {
        sortedObj[key] = canonicalizeValue(nestedVal);
      }
    }
    return sortedObj;
  }

  return val;
}

/**
 * Returns a deterministic canonical JSON string for a given payload.
 */
export function canonicalizeJson(payload: unknown): string {
  const normalized = canonicalizeValue(payload);
  return JSON.stringify(normalized);
}

/**
 * Computes a deterministic SHA-256 hash of the canonicalized payload.
 */
export function hashCanonicalRequest(payload: unknown): string {
  const canonicalString = canonicalizeJson(payload);
  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}
