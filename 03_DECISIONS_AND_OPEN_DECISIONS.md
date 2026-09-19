# Architecture Decisions and Open Decisions Log

**Project**: Galon Beauty Salon Web Application  
**Governance Authority**: Product Owner (Human)  
**Implementation Gateway**: Google AI Studio  
**Current Phase**: Phase 3 (Booking Engine & Transactional Availability)

---

## 1. Closed Architecture Decisions

### D16: Service Duration Specification (Original Decision) — SUPERSEDED by D45
- **Status**: SUPERSEDED by D45
- **Historical Text**: Service durations were initially proposed to be handled as flexible ranges (`durationMin` - `durationMax`) with client-selected or minimum default durations.
- **Traceability Note**: Retained strictly for historical traceability. Do not delete or renumber. For current authoritative calculation rules, refer to **D45**.

---

### D42: Request Idempotency Model
- **Status**: CLOSED
- **Decision**: 
  - Clients provide optional `Idempotency-Key` header for mutation requests.
  - The backend stores idempotency keys keyed by `${userId}_${idempotencyKey}` in the `idempotency` collection.
  - Payloads are canonicalized and hashed deterministically (SHA-256).
  - Exact match of key and request hash replays the original response with HTTP 200/201 without duplicate side-effects.
  - Re-using the same key with a differing payload triggers HTTP 409 Conflict (`IDEMPOTENCY_CONFLICT`).

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

## 3. Open Decisions

### O01: Payment Gateway Integration (Phase 5)
- **Status**: OPEN
- **Scope**: Payment provider selection (e.g., Bank of Georgia, TBC Bank, Stripe) and payment state machines will be finalized in Phase 5. Phase 3 bookings are created in `CONFIRMED` status with cash/salon settlement.
