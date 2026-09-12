/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Centralized Firebase Admin SDK Initialization Module
 */

import { initializeApp, getApps, getApp, App, cert } from 'firebase-admin/app';
import { getAuth, Auth } from 'firebase-admin/auth';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getStorage, Storage } from 'firebase-admin/storage';

let adminApp: App | null = null;
let adminAuth: Auth | null = null;
let adminDb: Firestore | null = null;
let adminStorage: Storage | null = null;

export function initializeFirebaseAdmin(): App | null {
  if (getApps().length > 0) {
    adminApp = getApp();
    adminAuth = getAuth(adminApp);
    adminDb = getFirestore(adminApp);
    adminStorage = getStorage(adminApp);
    return adminApp;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  try {
    if (projectId && clientEmail && rawPrivateKey) {
      const privateKey = rawPrivateKey.replace(/\\n/g, '\n');
      adminApp = initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
      console.log('[Firebase Admin] Initialized with service account credentials for project:', projectId);
    } else {
      // In GCP / Cloud Run, Application Default Credentials (ADC) are automatically picked up
      adminApp = initializeApp();
      console.log('[Firebase Admin] Initialized using Application Default Credentials (ADC).');
    }

    adminAuth = getAuth(adminApp);
    adminDb = getFirestore(adminApp);
    adminStorage = getStorage(adminApp);
    return adminApp;
  } catch (error) {
    console.warn('[Firebase Admin] Failed to initialize Firebase Admin SDK:', error instanceof Error ? error.message : error);
    return null;
  }
}

// Lazy getters to ensure clean initialization
export function getAdminAuth(): Auth | null {
  if (!adminAuth) initializeFirebaseAdmin();
  return adminAuth;
}

export function getAdminDb(): Firestore | null {
  if (!adminDb) initializeFirebaseAdmin();
  return adminDb;
}

export function getAdminStorage(): Storage | null {
  if (!adminStorage) initializeFirebaseAdmin();
  return adminStorage;
}
