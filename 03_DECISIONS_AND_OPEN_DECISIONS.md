# GALON — DECISIONS AND OPEN DECISIONS

# CLOSED DECISIONS

## D01 — Human Final Authority

CLOSED.

Human is Product Owner and final decision maker.

---

## D02 — Google AI Studio Implementation Gateway

CLOSED.

All implementation goes through Google AI Studio.

---

## D03 — Claude Independent Challenger

CLOSED.

Claude independently reviews High/Critical architecture, security, auth, permissions, booking, payment, and major refactors.

---

## D04 — Firestore

CLOSED.

Firebase Authentication + Firestore + Firebase Admin SDK approved instead of PostgreSQL Hybrid.

Conditions:

* backend enforcement;
* transaction/concurrency correctness;
* least privilege;
* critical mutations through backend.

---

## D05 — Backend Authority

CLOSED.

Backend is authoritative for:

* roles;
* account status;
* protected profile resolution;
* booking-critical mutations.

---

## D06 — Firebase Authentication

CLOSED.

Firebase Auth is identity provider.

Current provider:
Email/Password.

---

## D07 — Backend Registration

CLOSED.

`POST /api/auth/register-profile` is the sole approved profile-registration path.

Client-side profile `setDoc()` is not allowed.

---

## D08 — No Client Auth Firestore Fallback

CLOSED.

Client must not directly query `users/{uid}` when `/api/auth/me` returns `profilePending`.

`profilePending` returns null.

---

## D09 — Roles

CLOSED.

* CUSTOMER
* EMPLOYEE
* ADMIN
* OWNER

---

## D10 — Employee Types

CLOSED.

* CUSTOMER_FACING
* INTERNAL

Internal employees are never public/bookable.

---

## D11 — Admin/Owner Current Permissions

CLOSED.

Admin and Owner currently have the same permissions.

Architecture should allow future separation.

---

## D12 — Fail Closed

CLOSED.

Infrastructure/auth verification failures must not grant access.

---

## D13 — Booking Window

CLOSED.

7 days.

---

## D14 — Minimum Lead Time

CLOSED.

30 minutes.

---

## D15 — Working Hours

CLOSED FOR CURRENT BASELINE.

10:00–20:00.

---

## D16 — Duration Range

CLOSED FOR INITIAL IMPLEMENTATION.

Maximum duration is used for a service duration range.

May be revisited later.

---

## D17 — System Availability

CLOSED.

System calculates feasible appointment slots.

---

## D18 — Multiple Services

CLOSED.

One Booking can contain multiple BookingItems.

Different employees may serve different BookingItems.

---

## D19 — Double Booking Prevention

CLOSED.

Server-side transaction/concurrency protection is mandatory.

---

## D20 — Idempotency

CLOSED.

Repeated valid idempotency key must not create duplicate booking.

---

## D21 — BookingItem Source of Truth

CLOSED.

BookingItem stores service, employee, start/end, duration, price snapshot and service snapshot.

---

## D22 — Customer Cancellation

CLOSED.

Allowed up to 2 hours before appointment.

---

## D23 — Customer Rescheduling

CLOSED.

Allowed when availability permits.

Unlimited reschedules.

All changes logged.

---

## D24 — Employee Booking Changes

CLOSED.

Employee changes require Admin confirmation.

---

## D25 — Salon-Side Booking Changes

CLOSED.

Admin alerted → customer SMS → customer chooses new time/employee → Admin calls if no response.

---

## D26 — Employee Review

CLOSED.

Customer rates employee 1–5 stars with optional comment, linked to booking.

---

## D27 — Customer Rating

CLOSED.

Employee can privately rate customer 1–5 stars with optional comment, linked to booking.

Exact visibility remains open.

---

## D28 — Admin Review Deletion

CLOSED.

Admin can delete reviews.

Deleted reviews remain available to Admin.

---

## D29 — Notification Architecture

CLOSED.

Event → Notification Service → Notification → Delivery.

Persistent Event collection not required at Galon scale.

---

## D30 — Current Notification Channels

CLOSED FOR CURRENT SCOPE.

* website/in-app;
* customer SMS.

---

## D31 — Reminder

CLOSED.

30 minutes before appointment.

---

## D32 — Notification Failure

CLOSED.

Failure is recorded and does not undo successful booking.

---

## D33 — Payments Deferred

CLOSED FOR CURRENT SCOPE.

No online payment implementation now.

---

## D34 — Payment Separate Domain

CLOSED.

Payment is separate from Booking.

---

## D35 — Historical Price Snapshot

CLOSED.

BookingItem stores historical price snapshot.

---

## D36 — Critical Client Access

CLOSED.

Critical collections/mutations are backend-controlled.

---

## D37 — BookingItems Client Access

CLOSED.

Client read/write denied.

---

## D38 — Availability / Idempotency Client Access

CLOSED.

Direct client access denied.

---

## D39 — Secrets

CLOSED.

Secrets remain server-side.

---

## D40 — REST Fallback Removal

CLOSED.

AI Studio's unapproved Firestore REST fallback was removed.

Commit:
`f4369782be4d0274f14458e29480cc6a7d85b476`

Claude:
APPROVE.

---

## D41 — AuthContext Fallback Removal

CLOSED.

Direct client Firestore profile fallback removed.

Commit:
`b80b57b5d7696a1b8ce028bb933da7858257b1aa`

Claude:
APPROVE.

Human browser verification:
PASS.

---

## D42 — Idempotency Key Conflict Policy

CLOSED.

Idempotency key behavior:

* same key + same logical request → return/reference the original Booking result;
* same key + different logical request → deterministic conflict;
* conflicting request causes no Booking mutation;
* conflicting request causes no BookingItem mutation;
* conflicting request causes no availability-ledger mutation.

Logical request identity is determined from the **entire canonicalized request body**.

Canonicalization must ensure that semantically identical request bodies are represented identically before comparison, so non-semantic serialization differences such as JSON field ordering do not create a false conflict.

O18 is therefore formally closed as D42.

This decision applies to Booking creation idempotency.

Formal idempotency-key infrastructure for reschedule/cancellation is outside the current Phase 3 scope.

---

## D43 — Phase 3 Scope

CLOSED.

Phase 3 scope is:

### 3A — Profile-required access boundary

Address the deferred profilePending risk at the boundary of application endpoints that require a complete Firestore application profile.

This does not include:

* registration UX redesign;
* registration retry UI;
* completion wizard;
* orphan cleanup/reconciliation;
* Firebase Auth provider changes.

### 3B — Booking Engine

Implement the approved server-authoritative Booking architecture, including:

* Booking / BookingItem;
* availability calculation;
* Employee-Day Interval Ledger;
* transactional concurrency protection;
* multi-item atomic Booking creation;
* self-overlap validation;
* same employee/date ledger merging;
* Booking cancellation;
* Booking rescheduling;
* target-state retry safety for rescheduling;
* Booking history;
* creation idempotency;
* notification event generation;
* backend authorization and security enforcement.

Payments are not implemented in this phase.

Automatic/manual COMPLETED transition semantics are outside this phase and remain governed by the No-Show Semantics decision.

Architecture Specification v3:
**APPROVED**

Claude Final Independent Architecture Challenge:
**APPROVE**

High/Critical unresolved architecture issues:
**0**

---

## D44 — Customer Self-Overlap Policy

CLOSED.

A customer may have only one service active at any given time.

Overlapping BookingItems belonging to the same customer are not allowed, even when different employees would perform the services.

This applies both:

* within a single booking request (between BookingItems submitted together);
* against the customer's existing confirmed bookings (inter-booking).

Different employees do not permit simultaneous services for the same customer.

Back-to-back, non-overlapping appointments remain allowed.

This rule does not change D18 (different BookingItems may still use different employees, as long as their times do not overlap for the same customer).

Enforcement must be backend-authoritative and must not rely on frontend availability checks.

---

## D45 — Service Price/Duration Authoritative Value Rule

CLOSED.

**Supersedes D16 for duration.**

Authoritative values for service price and duration must be derived server-side from the authoritative Service data, not from client-supplied input.

For bounded ranges (`durationMin`–`durationMax`, `priceMin`–`priceMax`), the backend computes the exact midpoint:

* `durationMinutes = round((durationMin + durationMax) / 2)`
* `price = { min: priceMin, max: priceMax }`

Client-supplied price, duration, or service snapshot values must be ignored or rejected as authoritative input.

Open-ended or invalid ranges (e.g. unbounded maximums, `min <= 0`, `max < min`) must not have invented values. Such cases must be rejected, and the unresolved data item must be reported rather than silently assigned a business value.

D16 (original decision: use maximum duration for a service duration range) is retained in this document for historical traceability and is not deleted. For current authoritative duration calculation, this decision (D45) governs.

---

## D46 — Employee ↔ Service Eligibility Enforcement

CLOSED.

A customer may book a service with an employee only if that employee is explicitly assigned and eligible to perform that service.

Eligibility is verified server-side, inside the transactional read phase, via the `employeeServices` collection, before any Booking-critical writes occur.

Both conditions must hold:

* an eligibility record must exist for the employee/service pair;
* that record's `isActive` field must be `true`.

If any BookingItem within a multi-item Booking request fails eligibility, the entire request is rejected atomically — no partial Booking, BookingItem, ledger, or idempotency mutation occurs.

This validation applies to both Booking creation and Booking rescheduling.

Merely checking that the employee ID and service ID individually exist is not sufficient; the relationship between them must be independently validated.
---

# OPEN DECISIONS

## O01 — Schedule Conflict Policy

Current recommendation:
Warn + Confirm.

Final decision remains open.

---

## O02 — Employee Deactivation With Future Bookings

Need to define:

* future booking handling;
* reassignment;
* customer notification.

---

## O03 — No-Show Semantics

Need to define:

* status;
* who can mark;
* timing;
* consequences.

---

## O04 — CustomerRating Visibility

Private by principle.

Exact employee visibility remains open.

---

## O05 — Review Edit Approval

Exact moderation/approval workflow remains open.

---

## O06 — SMS Provider

Not selected.

---

## O07 — Future Notification Channels

WhatsApp/email/push decisions remain open.

---

## O08 — Payment Provider

Not selected.

---

## O09 — Refund Policy

Not finalized.

---

## O10 — Production Phone Uniqueness

Test mode allows duplicate phone numbers.

Production policy remains open.

---

## O11 — Hosting / Deployment

Production hosting remains open.

---

## O12 — Registration UX

Current Email/Password flow is approved.

Future UX/details may be refined.

---

## O13 — URL Localization

Recommended:
`/ka`
`/en`

Exact implementation remains open.

---

## O14 — Duration Model

Current:
maximum duration for ranges.

May be revisited when service data is finalized.

---

## O15 — Additional Employees

More employees will be added later.

---

## O16 — profilePending Lifecycle

Medium-level deferred issue.

Potential future:

* registration retry;
* completion flow;
* orphan reconciliation.

Do not restore client Firestore fallback.

---

# RULE

Closed decisions should not be reopened without new evidence or a clear business/technical reason.

Open decisions must not be silently treated as finalized.

When an open decision is formally resolved, it must be moved from OPEN DECISIONS to CLOSED DECISIONS and assigned the next available D-number.
