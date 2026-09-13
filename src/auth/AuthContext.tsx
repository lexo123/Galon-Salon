/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Centralized React Authentication Context & Provider
 * Manages Firebase Auth identity, resolves authoritative role and status,
 * and handles customer self-registration with server-verified profile creation.
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  User as FirebaseUser,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  sendPasswordResetEmail,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase.ts';
import { User, UserRole, UserStatus, COLLECTIONS } from '../types/index.ts';

export interface CustomerRegistrationParams {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
  language?: 'ka' | 'en';
}

export interface AuthContextType {
  currentUser: FirebaseUser | null;
  userProfile: User | null;
  role: UserRole | null;
  status: UserStatus | null;
  loading: boolean;
  isConfigured: boolean;
  isAccountDisabled: boolean;
  authError: string | null;
  signIn: (email: string, pass: string) => Promise<void>;
  registerCustomer: (params: CustomerRegistrationParams) => Promise<void>;
  signOut: () => Promise<void>;
  sendResetEmail: (email: string) => Promise<void>;
  refreshProfile: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function mapAuthErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case 'auth/email-already-in-use':
      return 'ეს ელ-ფოსტა უკვე რეგისტრირებულია / This email is already in use.';
    case 'auth/invalid-email':
      return 'არასწორი ელ-ფოსტის ფორმატი / Invalid email address.';
    case 'auth/weak-password':
      return 'პაროლი უნდა შეიცავდეს მინიმუმ 6 სიმბოლოს / Password should be at least 6 characters.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'არასწორი ელ-ფოსტა ან პაროლი / Invalid email or password.';
    case 'auth/too-many-requests':
      return 'ძალიან ბევრი მცდელობა. სცადეთ მოგვიანებით / Too many attempts. Please try again later.';
    case 'auth/user-disabled':
      return 'ანგარიში დაბლოკილია / Account has been disabled.';
    default:
      return 'ავთენტიფიკაციის შეცდომა / Authentication failed. Please try again.';
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  const [userProfile, setUserProfile] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const isConfigured = Boolean(auth);

  const fetchProfile = useCallback(async (firebaseUser: FirebaseUser): Promise<User | null> => {
    try {
      // First try fetching from authenticated backend /api/auth/me
      const token = await firebaseUser.getIdToken();
      const res = await fetch('/api/auth/me', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        if (data.user && !data.user.profilePending) {
          return data.user as User;
        }
      }

      // Direct Firestore fallback if backend /api/auth/me profile is pending
      if (db) {
        const userRef = doc(db, COLLECTIONS.USERS, firebaseUser.uid);
        const snapshot = await getDoc(userRef);
        if (snapshot.exists()) {
          return { id: snapshot.id, ...(snapshot.data() as Omit<User, 'id'>) };
        }
      }
    } catch (err) {
      console.warn('[AuthContext] Failed to resolve profile:', err);
    }
    return null;
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!currentUser) {
      setUserProfile(null);
      return;
    }
    const profile = await fetchProfile(currentUser);
    setUserProfile(profile);
  }, [currentUser, fetchProfile]);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setCurrentUser(firebaseUser);
      setAuthError(null);

      if (firebaseUser) {
        const profile = await fetchProfile(firebaseUser);
        setUserProfile(profile);
      } else {
        setUserProfile(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [fetchProfile]);

  const signIn = async (email: string, pass: string) => {
    if (!auth) throw new Error('Firebase Auth is not configured.');
    setAuthError(null);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), pass);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      const message = mapAuthErrorMessage(code);
      setAuthError(message);
      throw new Error(message);
    }
  };

  /**
   * Customer Registration
   * 1. Creates Firebase Auth user account.
   * 2. Obtains Firebase ID token.
   * 3. Calls backend /api/auth/register-profile to create authoritative Firestore profile.
   * 4. Only sets user profile upon successful backend profile creation.
   */
  const registerCustomer = async (params: CustomerRegistrationParams): Promise<void> => {
    if (!auth) throw new Error('Firebase Auth is not configured.');
    setAuthError(null);

    const email = params.email.trim();
    const firstName = params.firstName.trim();
    const lastName = params.lastName.trim();
    const phone = params.phone.trim();
    const language = params.language || 'ka';

    if (!firstName || !lastName || !phone || !params.password) {
      throw new Error('ყველა სავალდებულო ველი უნდა იყოს შევსებული / All required fields must be filled.');
    }

    try {
      const cred = await createUserWithEmailAndPassword(auth, email, params.password);
      const uid = cred.user.uid;
      const token = await cred.user.getIdToken();

      const response = await fetch('/api/auth/register-profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          firstName,
          lastName,
          phone,
          email,
          language,
        }),
      });

      if (!response.ok) {
        const errPayload = await response.json().catch(() => ({}));
        const errMsg = errPayload.message || 'პროფილის შექმნა ვერ მოხერხდა / Profile registration failed on server.';
        setAuthError(errMsg);
        throw new Error(errMsg);
      }

      const data = await response.json();
      const confirmedUser: User = data.user || {
        id: uid,
        role: 'CUSTOMER',
        firstName,
        lastName,
        phone,
        email,
        language,
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setUserProfile(confirmedUser);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      const message = code ? mapAuthErrorMessage(code) : (err instanceof Error ? err.message : String(err));
      setAuthError(message);
      throw new Error(message);
    }
  };

  const signOut = async () => {
    if (!auth) return;
    setAuthError(null);
    await firebaseSignOut(auth);
    setUserProfile(null);
    setCurrentUser(null);
  };

  const sendResetEmail = async (email: string) => {
    if (!auth) throw new Error('Firebase Auth is not configured.');
    setAuthError(null);
    try {
      await sendPasswordResetEmail(auth, email.trim());
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      const message = mapAuthErrorMessage(code);
      setAuthError(message);
      throw new Error(message);
    }
  };

  const getIdToken = async (): Promise<string | null> => {
    if (!auth || !auth.currentUser) return null;
    return auth.currentUser.getIdToken();
  };

  const clearAuthError = () => setAuthError(null);

  const role: UserRole | null = userProfile?.role ?? null;
  const status: UserStatus | null = userProfile?.status ?? null;
  const isAccountDisabled = status === 'SUSPENDED' || status === 'DELETED';

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        userProfile,
        role,
        status,
        loading,
        isConfigured,
        isAccountDisabled,
        authError,
        signIn,
        registerCustomer,
        signOut,
        sendResetEmail,
        refreshProfile,
        getIdToken,
        clearAuthError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
