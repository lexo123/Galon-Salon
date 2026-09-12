/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Centralized Structured Logging Infrastructure
 * Ensures no sensitive credentials, tokens, or private secrets are logged.
 */

export type LogLevel = 'info' | 'warn' | 'error';

interface LogPayload {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

function sanitize(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const sanitized: Record<string, unknown> = {};
  const REDACTED_KEYS = new Set([
    'password',
    'token',
    'authorization',
    'idtoken',
    'privatekey',
    'secret',
    'credential',
    'apikey',
    'phone',
  ]);

  for (const [key, value] of Object.entries(data)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitize(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function emitLog(level: LogLevel, message: string, context?: Record<string, unknown>) {
  const payload: LogPayload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(context ? { context: sanitize(context) } : {}),
  };

  const output = JSON.stringify(payload);
  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => emitLog('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emitLog('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emitLog('error', message, context),
};
