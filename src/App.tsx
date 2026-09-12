/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Galon Beauty Salon — Foundation & Authentication Status View (Phase 2)
 */

import React, { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext.tsx';
import { AuthForm } from './components/AuthForm.tsx';
import { APP_CONFIG, isFirebaseConfigured } from './config/index.ts';
import { CheckCircle2, AlertCircle, ShieldCheck, Clock, Database, LogOut, User as UserIcon, Lock, AlertTriangle } from 'lucide-react';

interface HealthResponse {
  status: string;
  timestamp: string;
  timezone: string;
  service: string;
}

function FoundationDashboard() {
  const {
    currentUser,
    userProfile,
    role,
    status,
    loading: authLoading,
    isConfigured: authConfigured,
    isAccountDisabled,
    signOut,
    getIdToken,
  } = useAuth();

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [checkingHealth, setCheckingHealth] = useState<boolean>(true);

  // RBAC diagnostic test results
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testingEndpoint, setTestingEndpoint] = useState<boolean>(false);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: HealthResponse) => {
        setHealth(data);
        setCheckingHealth(false);
      })
      .catch((err: Error) => {
        setHealthError(err.message);
        setCheckingHealth(false);
      });
  }, []);

  const runRbacTest = async (endpoint: string, label: string) => {
    setTestingEndpoint(true);
    setTestResult(null);
    try {
      const token = await getIdToken();
      const res = await fetch(endpoint, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      setTestResult(`${label} → HTTP ${res.status}: ${JSON.stringify(data, null, 2)}`);
    } catch (err: unknown) {
      setTestResult(`${label} → Network Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTestingEndpoint(false);
    }
  };

  return (
    <main id="galon-foundation-container" className="min-h-screen bg-stone-50 text-stone-900 font-sans p-6 md:p-12">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Salon Header */}
        <header id="salon-header" className="border-b border-stone-200 pb-6 flex flex-col md:flex-row md:items-baseline md:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-serif tracking-tight text-stone-900">
              სალონი გალონი <span className="text-xl font-sans font-light text-stone-500">/ Galon Salon</span>
            </h1>
            <p className="text-stone-600 mt-1 text-sm">
              {APP_CONFIG.location.addressKa} ({APP_CONFIG.location.addressEn})
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-stone-200/60 rounded-full text-xs text-stone-700 font-medium">
              <span>Timezone:</span>
              <span className="font-mono">{APP_CONFIG.timezone}</span>
            </div>
            {currentUser && (
              <button
                id="btn-logout"
                onClick={() => signOut()}
                className="inline-flex items-center gap-1.5 px-3 py-1 bg-stone-900 text-white rounded-full text-xs font-medium hover:bg-stone-800 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>გასვლა / Sign Out</span>
              </button>
            )}
          </div>
        </header>

        {/* Disabled Account Warning Banner */}
        {isAccountDisabled && (
          <div id="account-disabled-banner" className="p-4 bg-amber-50 border border-amber-300 rounded-xl flex items-center gap-3 text-amber-800 text-sm">
            <AlertTriangle className="w-5 h-5 shrink-0 text-amber-600" />
            <div>
              <p className="font-semibold">თქვენი ანგარიში დაბლოკილია / Account Suspended</p>
              <p className="text-xs text-amber-700 mt-0.5">
                თქვენი ანგარიში შეჩერებულია ადმინისტრაციის მიერ. დაცული ფუნქციები მიუწვდომელია.
              </p>
            </div>
          </div>
        )}

        {/* Phase 2 Authentication & Identity Panel */}
        <section id="phase2-auth-section" className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-stone-800">
              Phase 2: Authentication &amp; RBAC Subsystem
            </h2>
            <span className="text-xs font-mono text-stone-500 bg-stone-100 px-2 py-0.5 rounded-sm">
              Status: ACTIVE
            </span>
          </div>

          {authLoading ? (
            <div className="bg-white p-6 rounded-xl border border-stone-200 text-sm text-stone-500 text-center">
              ავთენტიფიკაციის შემოწმება / Verifying session state...
            </div>
          ) : currentUser ? (
            /* Authenticated Profile View */
            <div id="authenticated-profile-card" className="bg-white p-6 rounded-xl border border-stone-200 shadow-xs space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-stone-100">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-stone-900 text-white flex items-center justify-center font-serif text-lg">
                    {userProfile?.firstName ? userProfile.firstName.charAt(0) : 'U'}
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-stone-900">
                      {userProfile ? `${userProfile.firstName} ${userProfile.lastName}` : (currentUser.email || 'Authenticated User')}
                    </h3>
                    <p className="text-xs text-stone-500 font-mono">{currentUser.email || currentUser.uid}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-stone-100 border border-stone-200 rounded-full text-xs font-medium text-stone-800">
                    <span className="text-stone-400">Role:</span>
                    <span className="font-mono font-bold text-stone-900">{role || 'CUSTOMER'}</span>
                  </div>
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 border border-emerald-200 rounded-full text-xs font-medium text-emerald-800">
                    <span className="text-emerald-500">Status:</span>
                    <span className="font-mono">{status || 'ACTIVE'}</span>
                  </div>
                </div>
              </div>

              {/* Profile Details */}
              {userProfile && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs text-stone-600 pt-1">
                  <div>
                    <span className="text-stone-400 block mb-0.5">ტელეფონი / Phone:</span>
                    <span className="font-medium text-stone-800">{userProfile.phone || '—'}</span>
                  </div>
                  <div>
                    <span className="text-stone-400 block mb-0.5">ენა / Language:</span>
                    <span className="font-medium text-stone-800 uppercase">{userProfile.language}</span>
                  </div>
                  <div>
                    <span className="text-stone-400 block mb-0.5">რეგისტრირებულია:</span>
                    <span className="font-mono text-stone-700">{userProfile.createdAt ? new Date(userProfile.createdAt).toLocaleDateString() : '—'}</span>
                  </div>
                  <div>
                    <span className="text-stone-400 block mb-0.5">Firebase UID:</span>
                    <span className="font-mono text-stone-700 truncate block">{userProfile.id}</span>
                  </div>
                </div>
              )}

              {/* Live RBAC Verification Tools */}
              <div className="pt-4 border-t border-stone-100 space-y-3">
                <p className="text-xs font-medium text-stone-700">RBAC API Verification Tools (Live Server Ping):</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    id="btn-test-auth-me"
                    disabled={testingEndpoint}
                    onClick={() => runRbacTest('/api/auth/me', 'GET /api/auth/me')}
                    className="px-3 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-lg text-xs font-medium transition-colors"
                  >
                    Test /api/auth/me (Self)
                  </button>
                  <button
                    type="button"
                    id="btn-test-admin-users"
                    disabled={testingEndpoint}
                    onClick={() => runRbacTest('/api/admin/users', 'GET /api/admin/users (Admin-Only)')}
                    className="px-3 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-lg text-xs font-medium transition-colors"
                  >
                    Test /api/admin/users (RBAC Guard)
                  </button>
                  <button
                    type="button"
                    id="btn-test-unauthorized-user"
                    disabled={testingEndpoint}
                    onClick={() => runRbacTest('/api/users/other_user_uid_123', 'GET /api/users/:otherUser (Ownership Guard)')}
                    className="px-3 py-1.5 bg-stone-100 hover:bg-stone-200 text-stone-800 rounded-lg text-xs font-medium transition-colors"
                  >
                    Test Other User Access (Ownership Guard)
                  </button>
                </div>

                {testResult && (
                  <pre id="rbac-test-output" className="p-3 bg-stone-900 text-stone-100 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                    {testResult}
                  </pre>
                )}
              </div>
            </div>
          ) : (
            /* Unauthenticated Auth Form */
            <div className="space-y-4">
              <AuthForm />
              <p className="text-xs text-stone-500 text-center">
                რეგისტრაცია ხელმისაწვდომია მხოლოდ მომხმარებლებისთვის (CUSTOMER). თანამშრომლებისა და ადმინისტრატორების ანგარიშები იმართება ავტორიზებული სერვერული მექანიზმებით.
              </p>
            </div>
          )}
        </section>

        {/* Phase 1 System Diagnostics Grid */}
        <section id="phase1-diagnostics" className="space-y-4">
          <h2 className="text-lg font-medium text-stone-800">
            System &amp; Infrastructure Baseline
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Backend Health Card */}
            <div id="status-card-backend" className="bg-white p-5 rounded-xl border border-stone-200 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-stone-500">Express Backend</span>
                <Clock className="w-4 h-4 text-stone-400" />
              </div>
              <div className="flex items-center gap-2">
                {checkingHealth ? (
                  <span className="text-sm text-stone-400">Pinging /api/health...</span>
                ) : health ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                    <span className="text-base font-semibold text-emerald-700">Healthy (200 OK)</span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-5 h-5 text-amber-600" />
                    <span className="text-sm font-medium text-amber-700">{healthError}</span>
                  </>
                )}
              </div>
              {health && (
                <p className="text-xs text-stone-500 font-mono">
                  Reported TZ: {health.timezone}
                </p>
              )}
            </div>

            {/* Firebase Foundation Card */}
            <div id="status-card-firebase" className="bg-white p-5 rounded-xl border border-stone-200 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-stone-500">Firebase Client</span>
                <Database className="w-4 h-4 text-stone-400" />
              </div>
              <div className="flex items-center gap-2">
                {isFirebaseConfigured() ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                    <span className="text-base font-semibold text-emerald-700">Connected</span>
                  </>
                ) : (
                  <>
                    <span className="inline-block w-2.5 h-2.5 rounded-full bg-stone-400" />
                    <span className="text-sm font-medium text-stone-600">Pending Project Link</span>
                  </>
                )}
              </div>
              <p className="text-xs text-stone-500">
                {isFirebaseConfigured() ? 'Firebase Auth & Firestore configured' : 'Awaiting VITE_FIREBASE_* credentials'}
              </p>
            </div>

            {/* Security Rules Baseline */}
            <div id="status-card-security" className="bg-white p-5 rounded-xl border border-stone-200 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-stone-500">Security Architecture</span>
                <ShieldCheck className="w-4 h-4 text-stone-400" />
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <span className="text-base font-semibold text-stone-800">RBAC &amp; Locked Rules</span>
              </div>
              <p className="text-xs text-stone-500">
                Zero-trust Firestore rules &amp; backend authorization
              </p>
            </div>
          </div>
        </section>

        {/* Phase Scope Checklist */}
        <section id="phase-checklist" className="bg-stone-100/70 p-6 rounded-xl border border-stone-200/80 text-xs text-stone-600 space-y-2">
          <div className="font-semibold uppercase tracking-wider text-stone-500">Phase 2 Governance &amp; Security Boundary</div>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 list-disc list-inside">
            <li>Customer registration with server-enforced role CUSTOMER</li>
            <li>Role escalation strictly blocked by backend &amp; Firestore rules</li>
            <li>Authoritative role &amp; status resolution from Firestore users collection</li>
            <li>Suspended/deactivated accounts rejected from protected endpoints</li>
            <li>Ownership enforcement: Customer A cannot access Customer B data</li>
            <li>Admin &amp; Owner authorization required for /api/admin/* routes</li>
          </ul>
        </section>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <FoundationDashboard />
    </AuthProvider>
  );
}
