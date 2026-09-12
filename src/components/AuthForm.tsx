/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Minimal Authentication UX for Phase 2 Verification
 * Supports Customer Registration, Customer Login, and Password Reset.
 */

import React, { useState } from 'react';
import { useAuth } from '../auth/AuthContext.tsx';
import { UserCheck, Lock, Mail, Phone, User as UserIcon, AlertTriangle, ArrowRight } from 'lucide-react';

export function AuthForm() {
  const { signIn, registerCustomer, authError, clearAuthError, isConfigured } = useAuth();
  const [mode, setMode] = useState<'LOGIN' | 'REGISTER'>('LOGIN');

  // Form states
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    clearAuthError();

    if (!isConfigured) {
      setLocalError('Firebase is not configured yet. Please check environment configuration.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'LOGIN') {
        if (!email.trim() || !password) {
          setLocalError('გთხოვთ შეიყვანოთ ელ-ფოსტა და პაროლი / Please enter email and password.');
          setSubmitting(false);
          return;
        }
        await signIn(email, password);
      } else {
        if (!firstName.trim() || !lastName.trim() || !phone.trim() || !email.trim() || !password) {
          setLocalError('ყველა ველი სავალდებულოა / All fields are required.');
          setSubmitting(false);
          return;
        }
        if (password.length < 6) {
          setLocalError('პაროლი უნდა შეიცავდეს მინიმუმ 6 სიმბოლოს / Password must be at least 6 characters.');
          setSubmitting(false);
          return;
        }
        await registerCustomer({
          email,
          password,
          firstName,
          lastName,
          phone,
        });
      }
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const errorMessage = localError || authError;

  return (
    <div id="auth-panel" className="bg-white rounded-xl border border-stone-200 p-6 shadow-xs max-w-md w-full mx-auto">
      {/* Tab Switcher */}
      <div className="flex border-b border-stone-200 mb-6">
        <button
          type="button"
          id="tab-login"
          onClick={() => {
            setMode('LOGIN');
            setLocalError(null);
            clearAuthError();
          }}
          className={`pb-3 px-4 text-sm font-medium transition-colors border-b-2 -mb-px ${
            mode === 'LOGIN'
              ? 'border-stone-900 text-stone-900'
              : 'border-transparent text-stone-500 hover:text-stone-700'
          }`}
        >
          შესვლა / Sign In
        </button>
        <button
          type="button"
          id="tab-register"
          onClick={() => {
            setMode('REGISTER');
            setLocalError(null);
            clearAuthError();
          }}
          className={`pb-3 px-4 text-sm font-medium transition-colors border-b-2 -mb-px ${
            mode === 'REGISTER'
              ? 'border-stone-900 text-stone-900'
              : 'border-transparent text-stone-500 hover:text-stone-700'
          }`}
        >
          რეგისტრაცია / Register
        </button>
      </div>

      {/* Error Alert */}
      {errorMessage && (
        <div id="auth-error-alert" className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 text-xs text-red-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === 'REGISTER' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="reg-first-name" className="block text-xs font-medium text-stone-600 mb-1">
                სახელი / First Name
              </label>
              <div className="relative">
                <input
                  id="reg-first-name"
                  type="text"
                  required
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="ანა / Anna"
                  className="w-full pl-8 pr-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-hidden focus:ring-1 focus:ring-stone-800"
                />
                <UserIcon className="w-4 h-4 text-stone-400 absolute left-2.5 top-2.5" />
              </div>
            </div>

            <div>
              <label htmlFor="reg-last-name" className="block text-xs font-medium text-stone-600 mb-1">
                გვარი / Last Name
              </label>
              <div className="relative">
                <input
                  id="reg-last-name"
                  type="text"
                  required
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="ბერიძე / Beridze"
                  className="w-full pl-8 pr-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-hidden focus:ring-1 focus:ring-stone-800"
                />
                <UserIcon className="w-4 h-4 text-stone-400 absolute left-2.5 top-2.5" />
              </div>
            </div>
          </div>
        )}

        {mode === 'REGISTER' && (
          <div>
            <label htmlFor="reg-phone" className="block text-xs font-medium text-stone-600 mb-1">
              ტელეფონი / Phone Number
            </label>
            <div className="relative">
              <input
                id="reg-phone"
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+995 555 12 34 56"
                className="w-full pl-8 pr-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-hidden focus:ring-1 focus:ring-stone-800"
              />
              <Phone className="w-4 h-4 text-stone-400 absolute left-2.5 top-2.5" />
            </div>
          </div>
        )}

        <div>
          <label htmlFor="auth-email" className="block text-xs font-medium text-stone-600 mb-1">
            ელ-ფოსტა / Email
          </label>
          <div className="relative">
            <input
              id="auth-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@example.com"
              className="w-full pl-8 pr-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-hidden focus:ring-1 focus:ring-stone-800"
            />
            <Mail className="w-4 h-4 text-stone-400 absolute left-2.5 top-2.5" />
          </div>
        </div>

        <div>
          <label htmlFor="auth-password" className="block text-xs font-medium text-stone-600 mb-1">
            პაროლი / Password
          </label>
          <div className="relative">
            <input
              id="auth-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full pl-8 pr-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-hidden focus:ring-1 focus:ring-stone-800"
            />
            <Lock className="w-4 h-4 text-stone-400 absolute left-2.5 top-2.5" />
          </div>
        </div>

        <button
          type="submit"
          id="btn-auth-submit"
          disabled={submitting}
          className="w-full py-2.5 px-4 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-800 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {submitting ? (
            <span>მუშავდება / Processing...</span>
          ) : mode === 'LOGIN' ? (
            <>
              <span>შესვლა / Sign In</span>
              <ArrowRight className="w-4 h-4" />
            </>
          ) : (
            <>
              <span>რეგისტრაციის დასრულება / Register</span>
              <UserCheck className="w-4 h-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}
