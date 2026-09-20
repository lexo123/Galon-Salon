# Architecture Decisions and Open Decisions Log

**Project**: Galon Beauty Salon Web Application  
**Governance Authority**: Product Owner (Human)  
**Implementation Gateway**: Google AI Studio  
**Current Phase**: Phase 3 (Booking Engine & Transactional Availability)

---

## 1. Closed Architecture Decisions (D01 – D45)

### D01: System Timezone
- **Status**: CLOSED
- **Decision**: `Asia/Tbilisi` (UTC+04:00) is the sole authoritative timezone for all business operations, calendar schedules, working hours, availability ledgers, and booking calculations. All server-side validation and storage timestamps must parse and normalize times within `Asia/Tbilisi`.

---

### D02: Default System Currency
- **Status**: CLOSED
- **Decision**: The authoritative currency of the salon is Georgian Lari (`GEL`, ₾). All service pricing snapshots, totals, and future payment calculations are stored and processed in `GEL`.

---

### D03: Bilingual Localization Architecture
- **Status**: CLOSED
- **Decision**: The system officially supports Georgian (`ka`) as the primary default language and English (`en`) as the secondary language. Domain entities containing localized text (e.g., service names, descriptions, categories) use multilingual dictionary structures `{ ka: string, en: string }`.

---

### D04: Full-Stack Application Architecture
- **Status**: CLOSED
- **Decision**: A unified full-stack architecture combining a React 19 SPA frontend (powered by Vite and Tailwind CSS) and an Express.js backend on Node.js, served on port 3000. All mutations and sensitive queries are mediated strictly via server-side API endpoints (`/api/*`).

---

### D05: Cloud Database Selection
- **Status**: CLOSED
- **Decision**: Google Cloud Firestore is the authoritative document database for application state, users, catalog, availability ledgers, bookings, and audit records.

---

### D06: Identity & Authentication Provider
- **Status**: CLOSED
- **Decision**: Firebase Authentication (Google Identity Platform) is the authoritative identity provider. Client tokens are verified server-side on each request via Firebase Admin SDK.

---

### D07: Media & Asset Storage
- **Status**: CLOSED
- **Decision**: Firebase Storage is used for binary assets (salon photos, employee profile avatars, service images). Storage rules enforce zero-trust public read with administrative-only upload.

---

### D08: Role-Based Access Control (RBAC) Architecture
- **Status**: CLOSED
- **Decision**: Four distinct user roles are defined: `CUSTOMER`, `EMPLOYEE`, `ADMIN`, and `OWNER`. Permissions are enforced both in server middleware (`server/middleware/rbac.ts`) and Firestore security rules.

---

### D09: Customer-Facing vs. Internal Staff Separation
- **Status**: CLOSED
- **Decision**: Employees are categorized as either `CUSTOMER_FACING` or `INTERNAL`. Internal staff (e.g., cleaning, management, inventory specialists) must NEVER appear in customer booking lists and cannot be booked for client services.

---

### D10: Zero-Trust Security Rules & Client Mutation Prohibition
- **Status**: CLOSED
- **Decision**: Firestore security rules enforce a strict default-deny policy. Direct client writes are completely disabled for sensitive collections: `bookings`, `bookingItems`, `bookingHistory`, `availability`, `idempotency`, `customerRatings`, and `auditLogs`. All mutations MUST occur via backend endpoints.

---

### D11: Authorization & Privilege Escalation Guardrails
- **Status**: CLOSED
- **Decision**: Client requests are strictly prevented from modifying user roles or account statuses. Privilege assignment is reserved exclusively for ADMIN and OWNER through authenticated, auditable server operations.

---

### D12: Account Lifecycle States & Status Enforcement
- **Status**: CLOSED
- **Decision**: Accounts support three lifecycle states: `ACTIVE`, `SUSPENDED`, and `DELETED`. Any request from a `SUSPENDED` or `DELETED` account is rejected at the authentication middleware layer with HTTP 403 Forbidden.

---

### D13: Physical Location & Single-Salon Scope
- **Status**: CLOSED
- **Decision**: The system operates for a single physical salon location: Sairme Street 6, Tbilisi, Georgia. Multi-location tenant routing is excluded from current project scope.

---

### D14: Service Catalog & Category Hierarchy
- **Status**: CLOSED
- **Decision**: The service catalog is organized into top-level `categories` (e.g., Hair, Nails, Cosmetology) with child `services` referencing `categoryId`.

---

### D15: Service Pricing Snapshot Model
- **Status**: CLOSED
- **Decision**: When a service is booked, an authoritative price snapshot is captured on the `BookingItem` record (`priceSnapshot`: `{ min, max, currency: 'GEL' }`) to ensure historical booking records remain immutable if catalog prices change later.

---

### D16: Service Duration Specification (Original Decision) — SUPERSEDED by D45
- **Status**: SUPERSEDED by D45
- **Historical Text**: Service durations were initially proposed to be handled as flexible ranges (`durationMin` - `durationMax`) with client-selected or minimum default durations.
- **Traceability Note**: Retained strictly for historical traceability. Do not delete or renumber. For current authoritative calculation rules, refer to **D45**.

---

### D17: Employee Weekly Schedule Architecture
- **Status**: CLOSED
- **Decision**: Each employee possesses a weekly recurring schedule (`weeklySchedules` subcollection/collection) defining working status and daily hours (`startTime` to `endTime`) for Monday through Sunday (days 1 to 7).

---

### D18: Employee Schedule Breaks Model
- **Status**: CLOSED
- **Decision**: Configurable breaks within an employee's shift are defined in `scheduleBreaks` (`startTime` to `endTime`). Booking requests overlapping an active employee break are strictly rejected.

---

### D19: Schedule Exceptions Architecture
- **Status**: CLOSED
- **Decision**: Date-specific schedule overrides are defined in `scheduleExceptions` with types `OFF` (employee day off) or `CUSTOM_HOURS` (custom start and end times for a specific date).

---

### D20: Daily Employee Availability Ledger Architecture
- **Status**: CLOSED
- **Decision**: Operational scheduling concurrency is managed via dedicated daily ledger documents stored in `availability/{employeeId}_{YYYY-MM-DD}`.

---

### D21: Availability Ledger Booked Interval Schema
- **Status**: CLOSED
- **Decision**: Each availability ledger document contains an array of `bookedIntervals`:
  ```ts
  {
    startTime: string;      // HH:mm
    endTime: string;        // HH:mm
    bookingId: string;
    bookingItemId: string;
    serviceId: string;
  }
  ```

---

### D22: Availability Concurrency & Mutation Pattern
- **Status**: CLOSED
- **Decision**: Concurrency control uses transactional reads, in-memory interval collision checks and array transformations, and full array rewrites within Firestore transactions. Use of `arrayUnion` or `arrayRemove` is strictly prohibited.

---

### D23: Booking Lifecycle & Status State Machine
- **Status**: CLOSED
- **Decision**: Bookings follow an authoritative state machine: `PENDING` → `CONFIRMED` → `IN_PROGRESS` → `COMPLETED`, with branching to terminal states `CANCELLED` or `NO_SHOW`.

---

### D24: Multi-Item Booking Document Structure
- **Status**: CLOSED
- **Decision**: A booking order is represented by a parent `Booking` document and one or more `BookingItem` child documents, enabling customers to book multiple services or specialists within a single reservation.

---

### D25: Atomic Transactional Booking Creation
- **Status**: CLOSED
- **Decision**: Creating a booking atomically verifies availability, creates the parent `Booking`, writes all `BookingItem` records, updates all relevant employee `AvailabilityLedger` documents, records initial `BookingHistory`, and produces an audit entry within a single Firestore transaction.

---

### D26: Booking Cancellation & Ledger Release Model
- **Status**: CLOSED
- **Decision**: Cancellation updates the booking and item statuses to `CANCELLED`, atomically removes the booked intervals from employee availability ledgers, logs the cancellation history, and provides target-state retry safety (idempotent cancellation).

---

### D27: Booking Rescheduling Workflow
- **Status**: CLOSED
- **Decision**: Rescheduling validates the new employee, date, and time slot against working hours, exceptions, and availability ledgers. In a single transaction, it releases the old ledger interval, reserves the new interval, updates the booking item, and appends a `BookingHistory` record.

---

### D28: Customer Self-Registration Guardrails
- **Status**: CLOSED
- **Decision**: Public user registration defaults strictly to `CUSTOMER` role with `ACTIVE` status. Self-assignment of `EMPLOYEE`, `ADMIN`, or `OWNER` roles during registration is impossible and rejected.

---

### D29: Immutable Audit Logging Model
- **Status**: CLOSED
- **Decision**: Significant business actions (status transitions, administrative changes, role updates) write immutable records to the `auditLogs` collection with actor ID, IP/user-agent metadata, timestamp, and before/after payloads.

---

### D30: Multi-Channel Notification Dispatch
- **Status**: CLOSED
- **Decision**: Lifecycle events trigger notifications. In Phase 3, this includes in-app notification records in `notifications` and structured SMS dispatch simulation logged in Georgian and English.

---

### D31: Customer Ratings & Reviews Privacy
- **Status**: CLOSED
- **Decision**: Customer reviews and internal staff ratings (`customerRatings`) are protected by zero-trust security rules and are accessible only by authorized salon staff and administrators.

---

### D32: Employee ↔ Service Eligibility Assignment Model
- **Status**: CLOSED
- **Decision**:
  - A customer may book a service with an employee ONLY if that employee is explicitly assigned and eligible to perform that service.
  - Eligibility is verified server-side inside the transactional read phase via the `employeeServices` collection (`${employeeId}_${serviceId}` or queried by pair).
  - Both conditions must be met: the record must exist, and `isActive` must be `true`.
  - If any item in a multi-item booking request fails eligibility, the entire transaction is atomically aborted with HTTP 400 (`EMPLOYEE_SERVICE_NOT_ASSIGNED` or `EMPLOYEE_SERVICE_INACTIVE`).

---

### D33: Transactional Read-Before-Write Ordering Rule
- **Status**: CLOSED
- **Decision**: In compliance with Firestore transactional constraints, all `transaction.get()` read operations across all documents must be executed completely before any `transaction.set()`, `transaction.update()`, or `transaction.delete()` write operations.

---

### D34: Transaction Read/Write Ceiling Compliance
- **Status**: CLOSED
- **Decision**: Multi-item booking transactions are architected and bounded to ensure total document reads and writes remain well below Firestore's hard limit of 500 operations per transaction.

---

### D35: Past-Date Booking Prohibition
- **Status**: CLOSED
- **Decision**: Booking creation and rescheduling requests for dates or times in the past (relative to current server time in `Asia/Tbilisi`) are strictly rejected with HTTP 400 (`CANNOT_BOOK_IN_PAST`).

---

### D36: Salon Operating Hours Boundaries
- **Status**: CLOSED
- **Decision**: Salon operational boundaries are defined between 09:00 and 21:00 (`Asia/Tbilisi`). Booking items falling outside salon business hours are rejected.

---

### D37: Granular RBAC Permissions Matrix
- **Status**: CLOSED
- **Decision**: Granular permissions (e.g., `bookings:create:own`, `bookings:read:assigned`, `employees:manage`, `admin:access`) are defined in code and mapped to roles to ensure precise authorization evaluation.

---

### D38: Server-Side Request Validation & Sanitization
- **Status**: CLOSED
- **Decision**: All incoming HTTP payloads are validated against strict type schemas prior to processing. Malformed requests or missing required fields are rejected immediately with HTTP 400 Bad Request.

---

### D39: Standardized HTTP Error Response Schema
- **Status**: CLOSED
- **Decision**: All API error responses follow a uniform JSON schema:
  ```json
  {
    "success": false,
    "error": {
      "code": "ERROR_CODE_STRING",
      "message": "Human-readable description"
    }
  }
  ```

---

### D40: Health & Readiness Monitoring Endpoint
- **Status**: CLOSED
- **Decision**: A public monitoring endpoint `GET /api/health` returns HTTP 200 with server status, authoritative timestamp, environment info, and `Asia/Tbilisi` timezone.

---

### D41: Client-Side State Management & Auth Context
- **Status**: CLOSED
- **Decision**: The frontend uses React Context (`AuthContext`) for centralized authentication and profile state management, with automatic token refresh and role-aware navigation.

---

### D42: Request Idempotency Model
- **Status**: CLOSED
- **Decision**: 
  - Clients provide optional `Idempotency-Key` header for mutation requests.
  - The backend stores idempotency records keyed by `${userId}_${idempotencyKey}` in the `idempotency` collection.
  - Payloads are canonicalized and hashed deterministically (SHA-256).
  - Exact match of key and request hash replays the original response with HTTP 200/201 without duplicate side-effects.
  - Re-using the same key with a differing payload triggers HTTP 409 Conflict (`IDEMPOTENCY_CONFLICT`).

---

### D43: Employee Own-Booking Visibility Rule
- **Status**: CLOSED
- **Decision**: 
  - Customers can only view their own bookings (`customerId == user.uid`).
  - Employees can view bookings assigned to their employee profile (derived from `employees` where `userId == user.uid`), as well as bookings where they are the customer.
  - Employees cannot view other employees' unassigned bookings.
  - Admins and Salon Owners retain full salon-wide booking visibility.

---

### D44: Customer Self-Overlap Policy
- **Status**: CLOSED
- **Decision**: 
  - A customer cannot have overlapping booked services, regardless of which employee is assigned.
  - Must be backend-enforced authoritatively inside the transactional booking creation and rescheduling operations.
  - Enforcement applies both:
    1. **Intra-request**: Between multiple items submitted in the same `createBooking` or `rescheduleBooking` request.
    2. **Inter-booking**: Against the customer's existing confirmed bookings and booking items in Firestore.
  - Rejects overlapping requests with HTTP 400 (`CUSTOMER_SELF_OVERLAP`) or HTTP 409 (`CUSTOMER_SELF_OVERLAP`). Back-to-back non-overlapping appointments (e.g. 14:00–15:00 followed immediately by 15:00–16:00) are permitted.

---

### D45: Service Price/Duration Authoritative Value Rule
- **Status**: CLOSED (Supersedes D16 for duration)
- **Decision**:
  - Authoritative values for service price and duration must be derived server-side from the Firestore `services/{serviceId}` catalog.
  - Client-supplied durations, price snapshots, or service snapshots must be completely ignored or rejected.
  - **Bounded Ranges Midpoint Rule**: For bounded service ranges (`durationMin` to `durationMax`, and `priceMin` to `priceMax`), the backend must compute the exact mathematical midpoint:
    - `durationMinutes = Math.round((durationMin + durationMax) / 2)`
    - `priceSnapshot = { min: priceMin, max: priceMax, currency: 'GEL' }`
  - **Open-Ended Ranges Prohibition**: Open-ended, unbounded, or invalid configurations (`min <= 0` or `max < min`) must NOT have invented values; they must be rejected with HTTP 400 (`INVALID_SERVICE_CONFIGURATION`).

---

## 2. Additional Closed Rules in Phase 3

### R1: Internal Employee Booking Prohibition
- Employees marked with `employeeType == 'INTERNAL'` are strictly private to internal operations.
- They must NEVER be displayed in customer-facing employee lists.
- Any booking or rescheduling request attempting to assign an INTERNAL employee is rejected server-side with HTTP 400 (`EMPLOYEE_NOT_BOOKABLE`).

### R2: Employee Own Booking Visibility
- Customers can only view their own bookings (`customerId == user.uid`).
- Employees can view bookings assigned to their employee identity (derived from `employees` where `userId == user.uid`), as well as bookings where they are the customer. Employees cannot view other employees' unassigned bookings.
- Admins and Salon Owners retain full salon-wide booking visibility.

### R3: Transactional Read-Before-Write Ordering
- All transactional operations in Firestore (`createBooking`, `cancelBooking`, `rescheduleBooking`) must execute all `transaction.get()` read operations prior to executing any `transaction.set()` or `transaction.update()` write operations.

### R4: Employee Day Availability Ledger
- Concurrency control is enforced via `availability/{employeeId}_{YYYY-MM-DD}` documents.
- Mutated exclusively via transactional read → in-memory collision detection and merging → full array rewrite.
- Firestore `arrayUnion` and `arrayRemove` are strictly forbidden.

---

## 3. Open Decisions (O-Series)

### O01: Payment Gateway Integration (Phase 5)
- **Status**: OPEN
- **Scope**: Payment provider selection (e.g., Bank of Georgia, TBC Bank, Stripe) and payment state machines will be finalized in Phase 5. Phase 3 bookings are created in `CONFIRMED` status with cash/salon settlement.

### O02: Customer Loyalty & Promotions Engine (Phase 6)
- **Status**: OPEN
- **Scope**: Tiered loyalty discounts, promotional promo codes, and referral bonuses will be specified in Phase 6.

### O03: Live SMS Provider Selection (Phase 4)
- **Status**: OPEN
- **Scope**: Production SMS gateway vendor selection (e.g., Twilio, MagtiCom, Silknet SMS API) for customer booking reminders and notifications. Phase 3 uses server-side logging simulation.

### O04: Multilingual Catalog Content Administration (Phase 4)
- **Status**: OPEN
- **Scope**: Administrative UI tools for dynamic management of translations across services, categories, and salon notices.
