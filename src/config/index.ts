/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BUSINESS_TIMEZONE, DEFAULT_CURRENCY, DEFAULT_LANGUAGE } from '../types/index.ts';

export const APP_CONFIG = {
  timezone: BUSINESS_TIMEZONE,
  currency: DEFAULT_CURRENCY,
  language: DEFAULT_LANGUAGE,
  businessHours: {
    open: '10:00',
    close: '20:00',
  },
  location: {
    nameKa: 'სალონი გალონი',
    nameEn: 'Galon Salon',
    addressKa: 'თბილისი, საირმის ქუჩა 6',
    addressEn: 'Tbilisi, Sairme Street 6',
  },
  bookingConstraints: {
    bookingWindowDays: 7,
    minLeadTimeMinutes: 30,
  },
} as const;

export const FIREBASE_CLIENT_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
  databaseId: import.meta.env.VITE_FIREBASE_DATABASE_ID || '(default)',
};

export function isFirebaseConfigured(): boolean {
  return Boolean(
    FIREBASE_CLIENT_CONFIG.apiKey &&
    FIREBASE_CLIENT_CONFIG.projectId
  );
}
