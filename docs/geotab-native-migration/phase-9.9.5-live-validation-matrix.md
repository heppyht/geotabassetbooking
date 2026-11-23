# Phase 9.9.5 — Live Validation Matrix

**Status:** BLOCKED — No live MyGeotab credentials available
**Date:** 2026-11-23
**Branch:** `main`

---

## 1. Purpose

This document defines the validation matrix for live MyGeotab integration testing.
Each item is marked with its current status. Items requiring live tenant access
are marked BLOCKED until authorized credentials are obtained.

---

## 2. Authentication & Session Verification

| # | Validation Item | Method | Evidence Required | Status |
|---|-----------------|--------|-------------------|--------|
| 2.1 | MyGeotab session verification | Call `geotab.addin.call("Get", { typeName: "Session" })` or `service.api.getSession()` | Valid session with `userName`, `database`, `server` | BLOCKED — No test tenant credentials |
| 2.2 | Identity resolution | Call `resolveAuthenticatedPrincipal(api)` with live API object | `IdentityResolutionState.status === "authenticated"` with valid principal | BLOCKED — No test tenant credentials |
| 2.3 | Role extraction | Lookup User record via `api.call("Get", { typeName: "User", search: { name: userName } })` | User record with `role` field (APPROVER, GA, MANAGEMENT, ADMIN, DRIVER, EMPLOYEE) | BLOCKED — No test tenant credentials |
| 2.4 | Session expiration handling | Simulate expired session | `canPerformLiveWriteStrict()` returns false; fail-closed behavior | BLOCKED — No test tenant credentials |
| 2.5 | Cross-tenant protection | Verify `GEOTAB_DATABASE` matches session database | All AddInData operations scoped to `opex_trial` | BLOCKED — No test tenant credentials |

---

## 3. Add-In Registration & Loading

| # | Validation Item | Method | Evidence Required | Status |
|---|-----------------|--------|-------------------|--------|
| 3.1 | Add-In registration | Register `geotab/opex-vbm-config.json` in tenant System Settings → Add-Ins | Add-In appears in tenant's Add-In list | BLOCKED — No tenant administrator access |
| 3.2 | Add-In loading | Open Add-In from MyGeotab menu | Frontend loads at `https://heppyh.github.io/opexassetbooking/` | BLOCKED — No tenant administrator access |
| 3.3 | Add-In embedded mode | Verify `embed.supported: true` in config | Add-In renders within MyGeotab iframe | BLOCKED — No tenant administrator access |
| 3.4 | AddInId configuration | Verify `DEFAULT_ADDIN_ID` matches registered Add-In ID | `isValidAddInId(DEFAULT_ADDIN_ID)` returns true; AddInData operations succeed | BLOCKED — No test tenant credentials |
| 3.5 | External serviceSrc | Verify `serviceAddin.js` accessible at GitHub Pages URL | Service Add-In registration succeeds | BLOCKED — No tenant administrator access |

---

## 4. AddInData CRUD Operations

| # | Validation Item | Method | Evidence Required | Status |
|---|-----------------|--------|-------------------|--------|
| 4.1 | AddInData Add | Call `gateway.add("AddInData", { addInId, details, groups })` | Record created with entity ID; read-back succeeds | BLOCKED — No test tenant credentials |
| 4.2 | AddInData Get | Call `gateway.search("AddInData", { addInId, recordType: "booking" })` | Returns booking records matching criteria | BLOCKED — No test tenant credentials |
| 4.3 | AddInData Set | Call `gateway.set("AddInData", { addInId, id, details, groups })` | Record updated; read-back reflects changes | BLOCKED — No test tenant credentials |
| 4.4 | AddInData Remove | Call `gateway.remove("AddInData", { id })` with disposable test record only | Record removed; subsequent Get returns empty | BLOCKED — Requires explicit authorization |
| 4.5 | Read-after-write verification | Write record, immediately read it back | Read returns the written record | BLOCKED — No test tenant credentials |
| 4.6 | Record size limit (10 KB) | Attempt to write record exceeding 10,000 serialized chars | `ADDIN_DATA_DETAILS_EXCEEDED` error thrown | BLOCKED — No test tenant credentials |
| 4.7 | periodKey partitioning | Query with `periodKey` filter | Returns only records matching YYYY-MM partition | BLOCKED — Server-side filtering unverified |
| 4.8 | Full-collection scan | Query without periodKey filter | Returns all records for addInId + recordType | BLOCKED — Performance unverified |

---

## 5. Booking Operations

| # | Validation Item | Method | Evidence Required | Status |
|---|-----------------|--------|-------------------|--------|
| 5.1 | Booking creation | `createBooking()` via `bookingServiceProvider` | Booking record created with status PENDING_APPROVAL | BLOCKED — No test tenant credentials |
| 5.2 | Booking approval | `updateBookingStatus()` to APPROVED | Status changes to APPROVED; audit event created | BLOCKED — Requires APPROVER role user |
| 5.3 | Booking rejection | `updateBookingStatus()` to REJECTED | Status changes to REJECTED; audit event created | BLOCKED — Requires APPROVER role user |
| 5.4 | Booking cancellation | `updateBookingStatus()` to CANCELLED | Status changes to CANCELLED; audit event created | BLOCKED — Requires requester or MANAGEMENT/ADMIN |
| 5.5 | Driver assignment | `updateBookingStatus()` with assignedDriverUserId | Driver field set; audit event created | BLOCKED — Requires GA/ADMIN role user |
| 5.6 | Self-approval prevention | Approver attempts to approve own booking | `SELF_APPROVAL_PROHIBITED` error | BLOCKED — Requires APPROVER role user |
| 5.7 | Idempotency | Same idempotencyKey on createBooking | Returns existing booking, no duplicate | BLOCKED — No test tenant credentials |
| 5.8 | Version conflict | Concurrent update with stale version | `BOOKING_VERSION_CONFLICT` error | BLOCKED — Requires concurrent access |
| 5.9 | Tenant isolation | Attempt cross-database access | Rejected; `GEOTAB_DATABASE` enforced | BLOCKED — No test tenant credentials |
| 5.10 | Legacy schema v1 compatibility | Read legacy booking record (no recordType) | Record parsed without error | BLOCKED — No legacy records in test tenant |

---

## 6. Audit Operations

| # | Validation Item | Method | Evidence Required | Status |
|---|-----------------|--------|-------------------|--------|
| 6.1 | Audit event creation | `createAuditEvent()` on state transition | Audit record appended with eventId link | BLOCKED — No test tenant credentials |
| 6.2 | Audit append-only | Attempt to modify existing audit record | Modification rejected or not supported | BLOCKED — No test tenant credentials |
| 6.3 | Audit gap detection | `findAuditGaps()` | Returns bookings with missing auditId | BLOCKED — No test tenant credentials |
| 6.4 | Audit history retrieval | `readAuditHistory(bookingId)` | Returns all audit events for booking, newest first | BLOCKED — No test tenant credentials |

---

## 7. Service Add-In Validation

| # | Validation Item | Method | Evidence Required | Status |
|---|-----------------|--------|-------------------|--------|
| 7.1 | Service Add-In registration | Register `geotab/opex-vbm-service-config.json` | Service appears in tenant's Service Add-In list | BLOCKED — No tenant administrator access |
| 7.2 | Service Add-In initialization | Service loads within MyGeotab WebWorker context | `self.geotab.addin.service` callback fires | BLOCKED — No tenant administrator access |
| 7.3 | Notification polling | Service polls AddInData every 30 seconds | Pending notifications detected and delivered | BLOCKED — No test tenant credentials |
| 7.4 | Notification delivery | `service.notifications.show()` called | Notification appears in MyGeotab UI | BLOCKED — No test tenant credentials |
| 7.5 | Delivery acknowledgement | `delivery_status` updated to "delivered" | AddInData record reflects delivered status | BLOCKED — No test tenant credentials |
| 7.6 | Rate limit enforcement | Rapid notification creation | Max 6 calls/min rolling window, max 2 visible | BLOCKED — No test tenant credentials |
| 7.7 | Behavior when MyGeotab closed | Close MyGeotab, create notification | Notification remains pending; delivered when reopened | BLOCKED — No test tenant credentials |

---

## 8. Storage Quota & Rate Limits

| # | Validation Item | Method | Evidence Required | Status |
|---|-----------------|--------|-------------------|--------|
| 8.1 | Storage quota confirmation | Contact Geotab Support | Written confirmation of AddInData storage limits per database | BLOCKED — Requires Geotab Support |
| 8.2 | Write throughput | Sequential AddInData Add operations | Operations/minute measured; compare to ~100/min claim | BLOCKED — No test tenant credentials |
| 8.3 | Rate-limit behavior | Burst AddInData operations | HTTP 429 or throttling response observed | BLOCKED — No test tenant credentials |
| 8.4 | periodKey server-side filtering | Query with `periodKey` in search | Server returns only matching partition | BLOCKED — Server-side filtering unverified |

---

## 9. Items Requiring Geotab Support Confirmation

| Item | Question | Status |
|------|----------|--------|
| 9.1 | What is the AddInData storage quota per database (opex_trial)? | UNKNOWN — Requires Geotab Support |
| 9.2 | What is the maximum number of AddInData records per AddInId? | UNKNOWN — Requires Geotab Support |
| 9.3 | What is the AddInData write throughput limit (operations/minute)? | UNKNOWN — Requires Geotab Support |
| 9.4 | Does AddInData search support server-side `periodKey` filtering? | UNKNOWN — Requires Geotab documentation/Support |
| 9.5 | What is the AddInData API rate limit (requests/minute)? | UNKNOWN — Requires Geotab Support |
| 9.6 | Is there a retention policy for AddInData records? | UNKNOWN — Requires Geotab Support |
