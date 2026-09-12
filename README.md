# Galon Beauty Salon (სალონი გალონი)

Official web application for Galon beauty salon located at Sairme Street 6, Tbilisi, Georgia.

## Approved Architecture Baseline

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, Lucide React, Motion.
- **Backend**: Node.js, Express, TypeScript (`tsx` dev server, `esbuild` production bundle).
- **Database**: Cloud Firestore.
- **Authentication**: Firebase Authentication.
- **Storage**: Firebase Storage.
- **Timezone**: `Asia/Tbilisi` (authoritative business timezone across all operations).
- **Default Currency**: `GEL` (₾).
- **Languages**: Georgian (`ka`) and English (`en`).

---

## Phase 1 Implementation Status: Foundation / Infrastructure

Phase 1 establishes the structural, security, domain, and server foundations without premature business workflow implementation.

### Key Foundations Established

1. **Express + Vite Full-Stack Server**:
   - `server.ts`: Central server entry point supporting Vite middleware in dev and optimized static serving in prod.
   - `server/app.ts`: Express application assembly with CORS, JSON parsing, and request logging.
   - `GET /api/health`: Health endpoint returning server status, ISO timestamp, and `Asia/Tbilisi` timezone.

2. **Domain Type System (`src/types/domain.ts`)**:
   - Centralized interfaces for User, Employee, Category, Service, WeeklySchedule, ScheduleException, Booking, BookingItem, BookingHistory, AvailabilityLedger, Review, CustomerRating, Notification, Payment, and AuditLog.
   - Authoritative business status helpers (`isBlockingBookingItemStatus`, `isTerminalBookingStatus`, `isCustomerFacingActive`).
   - Strict role definitions: `CUSTOMER`, `EMPLOYEE`, `ADMIN`, `OWNER`.
   - Employee separation: `CUSTOMER_FACING` vs. `INTERNAL`.

3. **Firebase Client SDK (`src/lib/firebase.ts`)**:
   - Centralized initialization for App, Auth, Firestore, and Storage.
   - Diagnostic `handleFirestoreError` helper following ABAC guidelines.
   - React Auth Context (`src/auth/AuthContext.tsx`) with customer self-registration guard (employee/admin self-registration strictly prevented).

4. **Firebase Admin SDK (`server/config/firebaseAdmin.ts`)**:
   - Modular initialization supporting Application Default Credentials (ADC) and server-side environment variables.
   - Server-side auth verification and role retrieval middleware (`server/middleware/auth.ts`, `server/middleware/rbac.ts`).

5. **Zero-Trust Security Rules**:
   - `firestore.rules`:
     - Default-deny catch-all.
     - Client write access strictly **DENIED** for `bookings`, `bookingItems`, `bookingHistory`, `availability`, `idempotency`, `customerRatings`, and `auditLogs`.
     - Client read access strictly **DENIED** for internal ledger (`availability`), `idempotency`, and private `customerRatings`.
     - Internal employees concealed from public queries.
     - Privilege escalation blocked on user profile operations.
   - `storage.rules`:
     - Default-deny with public read-only for salon/staff assets; client writes denied.

6. **Testing**:
   - Vitest suite in `tests/foundation.test.ts` covering timezone enforcement, domain status helpers, input validation, and HTTP error classes.

---

## Development Scripts

```bash
# Start development server on port 3000
npm run dev

# Run unit tests
npm test

# Type-check codebase
npm run lint

# Build production bundle
npm run build

# Start production server
npm start
```
