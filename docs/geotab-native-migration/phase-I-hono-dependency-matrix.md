# Phase I — Hono Dependency Matrix

## Repository
`C:\04. Project 2026\Geotab\2026\geotabassetbooking`

## Methodology
- Searched `apps/web/src/` for all `fetch()`, `axios`, `/api/`, Hono-related calls — **zero found**
- Frontend uses `geotab.addin.call()` (MyGeotab AddInData JSON-RPC) directly
- Hono API (`apps/api/src/index.ts`) is a separate backend not called by frontend at runtime

## Hono Endpoint Migration Matrix

| # | Endpoint | Method | Auth | Old Implementation (Hono) | New Implementation (Client-side) | Tests | Status |
|---|---|---|---|---|---|---|---|
| 1 | `/api/health` | GET | None | Returns service health, tenant target, storage backend | Not applicable (backend health check) | API tests | Not migrated (backend-only) |
| 2 | `/api/me` | GET | requirePrincipal | Returns verified principal | `resolveAuthenticatedPrincipal()` via `geotab.addin.getSession()` + `api.call("Get", { typeName: "User" })` | Web: identityResolver tests | Migrated (client-side identity) |
| 3 | `/api/vehicles` | GET | requirePrincipal | `gateway.getDevices()` → returns devices | `BookingServiceProvider.getAssets()` → `api.call("Get", { typeName: "Device" })` | Web: provider tests | Migrated (client-side via AddInData) |
| 4 | `/api/bookings` | GET | requirePrincipal | `searchAddInData({ recordType: "booking" })` + client filter by `requesterUserId` | `BookingServiceProvider.getBookings()` → `repository.listAllBookings()` + client-side RBAC filter | Web: provider + security tests | Migrated |
| 5 | `/api/bookings/driver` | GET | requirePrincipal | `getBookingsByDriver()` (full scan + client filter) | `BookingService.getBookingsByDriver()` + `PermissionPolicy.driverScopeFilter()` | Web: security tests | Migrated |
| 6 | `/api/bookings/:id` | GET | requirePrincipal | `findBookingRecord()` + `canViewBooking()` check | `repository.getBooking()` + `PermissionPolicy.canView()` | Web: repository + security tests | Migrated |
| 7 | `/api/bookings` | POST | requirePrincipal | `createBooking()` + overlap check + idempotency key | `BookingService.createBooking()` + `findConflict()` + idempotency key | Web: repository + concurrency tests | Migrated |
| 8 | `/api/bookings/:id/submit-for-approval` | POST | requirePrincipal | Status transition DRAFT→PENDING_APPROVAL | `BookingService.updateBookingStatus({ status: "PENDING_APPROVAL" })` + `isValidTransition()` | Web: domain + provider tests | Migrated |
| 9 | `/api/bookings/:id/approve` | POST | requireRole(APPROVER, MANAGEMENT, ADMIN) | `approveBooking()` + version conflict + audit | `BookingService.updateBookingStatus({ status: "APPROVED", approverId })` + `canApprove()` + `createAuditEvent()` | Web: security + audit tests | Migrated |
| 10 | `/api/bookings/:id/reject` | POST | requireRole(APPROVER, MANAGEMENT, ADMIN) | `rejectBooking()` + version conflict + audit | `BookingService.updateBookingStatus({ status: "REJECTED" })` + `canApprove()` + `createAuditEvent()` | Web: security + audit tests | Migrated |
| 11 | `/api/bookings/:id/assign` | POST | requireRole(GA, ADMIN) | `assignApprovedBooking()` + conflict check + audit | `BookingService.updateBookingStatus({ status: "ASSIGNED", assignedDriverUserId })` + `canAssign()` + `findConflict()` | Web: security + concurrency tests | Migrated |
| 12 | `/api/bookings/:id/cancel` | POST | requirePrincipal | `cancelBooking()` + `canCancelBooking()` + audit | `BookingService.updateBookingStatus({ status: "CANCELLED" })` + `canCancel()` + `createAuditEvent()` | Web: security + audit tests | Migrated |

## Classification Summary

| Classification | Count | Endpoints |
|---|---|---|
| Fully migrated | 11 | #2-#12 (all booking/vehicle/identity endpoints) |
| Partially migrated | 0 | — |
| Not migrated | 1 | #1 (health — backend-only, not called by frontend) |
| Not safe for client-side | 0 | — |

## Frontend Hono Dependency: NONE

The frontend makes **zero direct calls** to any Hono API endpoint. All data operations go through `geotab.addin.call()` → MyGeotab AddInData. The Hono API is preserved for rollback but is not a runtime dependency of the frontend.

## What Cannot Be Migrated to Client-Side

| Capability | Reason |
|---|---|
| Server-side data isolation | AddInData does not support user-scoped server-side filtering; all filtering is client-side after full-collection scans |
| Server-side rate limiting | Rate limits (650 Get/min, 1700 Set/min, etc.) are enforced by MyGeotab, not by client code |
| Server-side audit integrity | Append-only audit relies on client discipline; no server-side enforcement |
| Atomic transactions | AddInData does not support transactions; check-then-Set is not atomic |

## Recommendation

**Hono can be retired from the frontend** — it is not called by the frontend at runtime. However, preserve the Hono API code for rollback until:
1. Live Geotab tenant validation confirms AddInData behavior
2. The server-side data isolation blocker is addressed or accepted as a known risk
