/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Centralized Firebase Client SDK Initialization Module
 */

import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getFirestore, Firestore } from 'firebase/firestore';
import { getStorage, FirebaseStorage } from 'firebase/storage';
import { FIREBASE_CLIENT_CONFIG, isFirebaseConfigured } from '../config/index.ts';

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let storage: FirebaseStorage | null = null;

if (isFirebaseConfigured()) {
  try {
    app = getApps().length > 0 ? getApp() : initializeApp(FIREBASE_CLIENT_CONFIG);
    auth = getAuth(app);
    db = getFirestore(app, FIREBASE_CLIENT_CONFIG.databaseId);
    storage = getStorage(app);
  } catch (err) {
    console.error('[Firebase Client] Failed to initialize Firebase:', err);
  }
} else {
  console.warn(
    '[Firebase Client] Configuration missing or incomplete. Please set VITE_FIREBASE_* environment variables in your environment.'
  );
}

export { app, auth, db, storage };

// ============================================================================
// FIRESTORE ERROR HANDLING (ABAC & Diagnostic Error Context)
// ============================================================================

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const currentAuth = auth?.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentAuth?.uid ?? null,
      email: currentAuth?.email ?? null,
      emailVerified: currentAuth?.emailVerified ?? null,
      isAnonymous: currentAuth?.isAnonymous ?? null,
      tenantId: currentAuth?.tenantId ?? null,
      providerInfo:
        currentAuth?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };

  console.error('[Firestore Error]:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
