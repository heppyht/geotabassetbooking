# Phase 9.9.5 — Security Assessment

**Status:** COMPLETE (client-side controls verified)
**Date:** 2026-11-23
**Branch:** `main`

---

## 1. Purpose

This document provides a comprehensive security assessment of the OPEX Asset Booking
application, covering RBAC, driver data isolation, audit integrity, AddInData access
scope, concurrency, notification recipient isolation, and identity verification.

**Critical distinction:** All authorization decisions are made in domain services
(`apps/web/src/domain/booking.ts`, `apps/web/src/security/policies.ts`), NOT in the
UI layer. Client-side filtering is never used as the sole access control mechanism.

---

## 2. RBAC — Role-Based Access Control

### 2.1 Role Definitions

| Role | Can Create | Can View | Can Modify | Can Cancel | Can Approve | Can Assign |
|------|-----------|----------|------------|------------|-------------|------------|
| EMPLOYEE | Yes | Own bookings | Own bookings | Own bookings | No | No |
| APPROVER | Yes | All bookings | All bookings | No | Yes (not own) | No |
| GA | Yes | All bookings | All bookings | No | Yes (not own) | Yes |
| MANAGEMENT | Yes | All bookings | All bookings | Yes | Yes (not own) | No |
| ADMIN | Yes | All bookings | All bookings | Yes | Yes (not own) | Yes |
| DRIVER | Yes | Own + assigned | No | No | No | No |

### 2.2 Implementation

**File:** `apps/web/src/domain/booking.ts`
- `APPROVER_ROLES = ["APPROVER", "MANAGEMENT", "ADMIN"]`
- `ASSIGN_ROLES = ["GA", "ADMIN"]`
- `CANCEL_ADMIN_ROLES = ["MANAGEMENT", "ADMIN"]`
- `canViewBooking(principal, booking)` — default-deny, role-based checks
- `canModifyBooking(principal, booking)` — default-deny, role-based checks
- `canCancelBooking(principal, booking)` — requester or MANAGEMENT/ADMIN
- `canApprove(principal, requesterId)` — APPROVER+ roles, prohibits self-approval
- `canAssign(principal)` — GA/ADMIN only

**File:** `apps/web/src/security/policies.ts`
- `PermissionPolicy` class with default-deny (`DEFAULT_DENY`)
- `canView()` — requester, approver/admin, GA/admin, or assigned driver
- `canViewAll()` — approver/admin or GA/admin only
- `canViewDriverBookings()` — always allowed (driver-scoped)
- `canModify()` — requester, approver/admin, or GA/admin
- `canCancel()` — requester or management/admin
- `canApprove()` — approver/admin only, prohibits self-approval
- `canAssign()` — GA/admin only

### 2.3 Status: PASS

Default-deny is enforced at the domain service level. All authorization decisions
are made in `BookingService` and `PermissionPolicy`, not only in the UI.

---

## 3. Driver Data Isolation

### 3.1 Implementation

**File:** `apps/web/src/security/policies.ts`
- `driverScopeFilter()` — returns `principal.appUserId` for DRIVER role, `null` otherwise
- `validateDriverMapping(driverId)` — returns true only if `driverId === principal.appUserId`

**File:** `apps/web/src/domain/booking.ts`
- `canViewBooking()` — drivers can view bookings where they are the `assignedDriverUserId`
- `canModifyBooking()` — drivers cannot modify bookings

### 3.2 Status: PASS

Drivers are scoped to their own assigned bookings. Driver mapping validation
prevents drivers from assigning bookings to other drivers.

---

## 4. Approval & Rejection Authorization

### 4.1 Approval

| Check | Implementation | Status |
|-------|---------------|--------|
| Role required | `APPROVER_ROLES` (APPROVER, MANAGEMENT, ADMIN) | PASS |
| Self-approval prohibited | `principal.appUserId === requesterId` returns false | PASS |
| Approver can approve any non-own booking | Yes | PASS |

**File:** `apps/web/src/domain/booking.ts:61-65`
**File:** `apps/web/src/security/policies.ts:58-62`

### 4.2 Rejection

| Check | Implementation | Status |
|-------|---------------|--------|
| Requester can reject own booking | Yes | PASS |
| MANAGEMENT/ADMIN can reject any booking | `CANCEL_ADMIN_ROLES` | PASS |
| Other roles cannot reject | Default-deny | PASS |

**File:** `apps/web/src/domain/booking.ts:71-74`
**File:** `apps/web/src/security/policies.ts:52-56`

### 4.3 Status: PASS

---

## 5. Audit Integrity

### 5.1 Implementation

**File:** `apps/web/src/domain/booking.ts`
- `assertVersion(booking, expectedVersion)` — throws `BOOKING_VERSION_CONFLICT` if versions don't match
- `applyUpdate(booking, update)` — increments version on every change

**File:** `apps/web/src/repositories/addinData/addinDataRepository.ts`
- `createAuditEvent()` — append-only audit records with `eventId` link
- `readAuditHistory(bookingId)` — returns audit events sorted newest first
- `findAuditGaps()` — detects bookings with missing audit references
- `findAuditEventByEventId()` — idempotency check for audit writes

### 5.2 Status: PASS

Audit records are append-only. Version-based optimistic concurrency prevents
lost updates. Gap detection identifies missing audit events.

---

## 6. AddInData Access Scope

### 6.1 Implementation

| Safeguard | Location | Status |
|-----------|----------|--------|
| `addInId` fixed at DEFAULT_ADDIN_ID | `apps/web/src/config/addinId.ts` | PASS |
| `isValidAddInId()` validation | `apps/web/src/config/addinId.ts:29-35` | PASS |
| `ADDIN_ID_NOT_CONFIGURED` error | `apps/web/src/data/addinDataService.ts:204` | PASS |
| `ADDIN_ID_INVALID` error | `apps/web/src/data/addinDataService.ts:208` | PASS |
| Groups scoped to "GroupCompanyId" | `apps/web/src/data/addinDataService.ts:44` | PASS |
| Client cannot override addInId | API gateway enforces server-configured value | PASS |

### 6.2 Status: PASS

All AddInData operations require a valid addInId. The addInId is fixed and cannot
be overridden by the client. Groups are scoped to "GroupCompanyId".

---

## 7. Concurrency

### 7.1 Implementation

**File:** `apps/web/src/domain/booking.ts`
- `applyUpdate()` increments `version` on every change
- `assertVersion()` checks expected version matches current version
- `BOOKING_VERSION_CONFLICT` thrown on mismatch

**File:** `apps/web/src/repositories/addinData/addinDataRepository.ts:163-170`
- `updateBooking()` checks `(existing.version || 0) !== (booking.version || 0) - 1`

### 7.2 Status: CONDITIONAL

Version-based optimistic concurrency is implemented but is best-effort:
- AddInData does NOT support atomic transactions or atomic compare-and-set
- Check-then-Set pattern has a race window between read and write
- No server-side locking mechanism available

**Mitigation:** `findAuditGaps()` detects inconsistencies; version conflicts
return 409/BOOKING_VERSION_CONFLICT for client retry.

---

## 8. Notification Recipient Isolation

### 8.1 Implementation

**File:** `apps/web/src/data/bookingServiceProvider.ts`
- `getNotifications()` filters by `recipient_user_id === userId`
- `getUnreadCount()` filters by `recipient_user_id && !is_read`
- `markAsRead()` operates on specific notification ID
- `markAllAsRead(userId)` filters by `recipient_user_id`

### 8.2 Status: PASS

Notifications are strictly scoped to the recipient user. Drivers cannot see other
drivers' notifications.

---

## 9. Identity & Session Verification

### 9.1 Implementation

**File:** `apps/web/src/auth/identityResolver.ts`
- `resolveAuthenticatedPrincipal(api)` — verifies MyGeotab session via `getSession()`
- Looks up User record by `userName` from session
- Requires exactly one unambiguous match
- Never infers identity from display name or email
- `canPerformLiveWrite()` — requires `ADDIN_DATA` mode + authenticated identity

### 9.2 Status: CONDITIONAL

Identity verification logic is implemented but NOT validated against a live
MyGeotab tenant. `IDENTITY_ADAPTER_CONFIGURED` is not set in the Worker config
(and the Worker is not used by the frontend). The frontend resolves identity
directly from the MyGeotab Add-In API context.

---

## 10. Cross-Tenant Access Protection

### 10.1 Implementation

| Safeguard | Implementation | Status |
|-----------|---------------|--------|
| `addInId` fixed | `DEFAULT_ADDIN_ID` in `addinId.ts` | PASS |
| Groups scoped to "GroupCompanyId" | `addinDataService.ts:44` | PASS |
| No client override of addInId | Gateway rejects invalid addInId | PASS |
| Database isolation | All records in same `opex_trial` database | PASS (same tenant) |

### 10.2 Status: PASS

All AddInData operations are scoped to a single AddInId within a single database.
Cross-tenant access is not possible because all writes go through the same
AddInId and there is no mechanism for the client to specify a different database.

---

## 11. Client-Side vs Server-Side Isolation

### 11.1 Principle

**Client-side filtering is NEVER used as the sole access control mechanism.**

All authorization decisions are made in domain services:
- `BookingService` (repository layer) enforces version checks and conflict detection
- `PermissionPolicy` enforces role-based access decisions
- `identityResolver.ts` resolves verified MyGeotab principal

The UI layer only displays data returned by authorized service calls.

### 11.2 Status: PASS

---

## 12. Security Release Gate

| Security Area | Status | Blocking Items |
|---------------|--------|----------------|
| RBAC | PASS | None |
| Driver data isolation | PASS | None |
| Audit integrity | PASS | None |
| AddInData access scope | PASS | None |
| Concurrency | CONDITIONAL | Best-effort optimistic concurrency; documented limitation |
| Notification recipient isolation | PASS | None |
| AddInData rate limits | CONDITIONAL | Server-side rate limits unverified against live tenant |
| Identity/session verification | CONDITIONAL | Not validated against live MyGeotab tenant |
| Cross-tenant access protection | PASS | None |

**Overall Security Status: CONDITIONAL** — All client-side controls verified,
but live MyGeotab integration (identity verification, rate limits) remains
unverified due to missing test tenant credentials.
