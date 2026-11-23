# Architecture Assessment — OPEX Asset Booking Geotab-Native Migration

## Source Repository
`C:\04. Project 2026\Geotab\2026\geotabassetbooking`

## Current Branch
`main` (up to date with `origin/main`)

## Working Tree
Uncommitted changes present (see `git status`). No commits made during this work.

## 1. API Endpoint Inventory (apps/api/src/index.ts)

| Endpoint | Method | Auth | Business Logic | AddInData Operations |
|---|---|---|---|---|
| `/api/health` | GET | None | Service health, tenant target, storage backend | None |
| `/api/me` | GET | requirePrincipal | Return verified principal | None |
| `/api/vehicles` | GET | requirePrincipal | List devices from MyGeotab | `Get Device` |
| `/api/bookings` | GET | requirePrincipal | List bookings filtered by requesterUserId | `Get AddInData` (recordType=booking) + client filter |
| `/api/bookings/driver` | GET | requirePrincipal | List bookings by driver | `getBookingsByDriver` service (full scan + client filter) |
| `/api/bookings/:id` | GET | requirePrincipal | Get booking by ID + canViewBooking check | `findBookingRecord` (full scan) |
| `/api/bookings` | POST | requirePrincipal | Create booking + overlap check + idempotency | `searchAddInData` + `addAddInData` |
| `/api/bookings/:id/submit-for-approval` | POST | requirePrincipal | Status transition DRAFT→PENDING_APPROVAL | `searchAddInData` + `setAddInData` |
| `/api/bookings/:id/approve` | POST | requireRole(APPROVER, MANAGEMENT, ADMIN) | Approve + audit | `approveBooking` service (find + set + audit add + set) |
| `/api/bookings/:id/reject` | POST | requireRole(APPROVER, MANAGEMENT, ADMIN) | Reject + audit | `rejectBooking` service (find + set + audit add + set) |
| `/api/bookings/:id/assign` | POST | requireRole(GA, ADMIN) | Assign vehicle/driver + audit | `assignApprovedBooking` service (find + conflict check + set + audit add + set) |
| `/api/bookings/:id/cancel` | POST | requirePrincipal | Cancel + audit | `cancelBooking` service (find + canCancelBooking + set + audit add + set) |

## 2. AddInData Read/Write Operations

### Read operations (retried via createResilientGateway)
- `searchAddInData(addInId, { recordType })` — full scan, client-side filtering
- `getDevices()` — `Get Device`
- `getUsers()` — `Get User`
- `verifySession()` — `Get User` (search by userName)

### Write operations (NOT retried — idempotency/version safety at service layer)
- `addAddInData(addInId, details, groupId)` — `Add AddInData`
- `setAddInData(addInId, recordId, details, groupId)` — `Set AddInData`
- `removeAddInData(recordId)` — `Remove AddInData`

## 3. Business Logic Mapped to Domain Services

### apps/api/src/services/booking.ts
- `createBooking` — idempotent creation via idempotency key, conflict check
- `approveBooking` — status transition, version conflict, audit event
- `rejectBooking` — status transition, version conflict, audit event
- `cancelBooking` — status transition, version conflict, audit event
- `assignApprovedBooking` — vehicle assignment, conflict check, audit event
- `findBookingRecord` — lookup by server record ID or application ID
- `getBookingsByDriver` — filter by assignedDriverUserId
- `findAuditGaps` — reconciliation: bookings missing audit events
- `generateAuditEventId` — deterministic audit event ID
- `canApprove`, `canAssign`, `canCancel`, `canViewBooking`, `canModifyBooking`, `canCancelBooking` — RBAC helpers
- `isValidTransition` — state machine validation

### apps/api/src/domain/overlap.ts
- `overlaps(a, b)` — half-open interval overlap
- `withBuffer(i, beforeMinutes, afterMinutes)` — extend interval

## 4. Environment Variables & External Dependencies

### apps/api/src/env.ts (Env type)
- `APP_ENV` — "personal-test" or "development"
- `ALLOWED_ORIGIN` — CORS origin (no path, no trailing slash)
- `GEOTAB_DATABASE` — server-configured MyGeotab database (never from client)
- `IDENTITY_ADAPTER_CONFIGURED` — fail-closed switch ("true" to enable)

### External dependencies
- MyGeotab REST API (`my.geotab.com/apiv1`) — JSON-RPC for AddInData, Device, User
- Hono — API framework (Cloudflare Worker)
- No PostgreSQL, no Neon, no Hyperdrive, no external database (already removed)

## 5. RBAC, Driver Isolation, Audit, Idempotency, Concurrency

### RBAC
- Roles: EMPLOYEE, APPROVER, GA, MANAGEMENT, ADMIN (from MyGeotab user.role); DRIVER is application-level (assignedDriverUserId)
- `requirePrincipal` middleware — fail-closed (503 if identity not configured)
- `requireRole(...)` middleware — role-based endpoint protection
- Role escalation prevented: unknown MyGeotab roles default to EMPLOYEE

### Driver isolation
- `canViewBooking` — driver can view only their assigned booking
- `getBookingsByDriver` — server-side filter by assignedDriverUserId
- Driver assignment optional; `assignedDriverUserId` may be null

### Audit
- Append-only audit events in AddInData (recordType=booking_audit)
- Audit fields: id, booking_id, eventId, eventType, actor_user_id, previous_status, new_status, changes, details, created_at, schemaVersion
- Deterministic `generateAuditEventId` for idempotent audit writes
- `findAuditGaps` — reconciliation for missing audit events

### Idempotency
- `createBooking` — idempotency key check before Add
- `assignApprovedBooking` — idempotency key check
- Audit writes — check existing eventId before Add
- Deterministic audit event ID (hash of bookingId + action + actor + statuses + minute bucket)

### Concurrency
- Version-based optimistic concurrency: `(booking.version || 0) !== (updated.version - 1)` → BOOKING_VERSION_CONFLICT
- Check-then-Set is NOT atomic — residual race conditions documented
- Overlap validation on create and assign

## 6. Web Frontend (apps/web/)

### Data providers
- `AddInDataBookingDataProvider` — live MyGeotab AddInData via `geotab.addin.call()`
- `LocalBookingDataProvider` — localStorage demo mode (fallback)
- `AddInDataService` — envelope-based schema v2 with periodKey partitioning

### Service Add-In (apps/web/src/serviceAddin.ts)
- `deliverPendingNotifications` — polls AddInData for pending notifications
- Rate limiter: 6 calls/minute, 2 visible max
- Updates delivery_status (pending → delivered/failed)
- Registered as `geotab.addin.service` (WebWorker context)

### Identity (apps/web/src/auth/identityResolver.ts)
- Modes: DEMO | ADDIN_DATA
- `resolveAuthenticatedPrincipal` — session + User lookup via `api.call`
- `canPerformLiveWrite` — LIVE mode requires verified identity
- Fail-closed: unresolved identity blocks writes

## 7. Geotab Add-In Configuration

### geotab/opex-vbm-config.json (custom-page Add-In)
- Name: OPEX Asset Booking Management
- URL: `https://heppyh.github.io/opexassetbooking/` (ActivityLink)
- Menu: ActivityLink → AddIns → OPEX Asset Booking

### geotab/opex-vbm-service-config.json (Service Add-In)
- serviceName: OPEX Notification Service
- serviceSrc: `https://heppyh.github.io/opexassetbooking/serviceAddin.js`

## 8. Existing Tests

### API tests (apps/api/test/) — 234 tests, all passing
- addindata-integration, auth-booking, security, overlap, overlap-scenarios
- rate-limit, rate-limit-handling, record-size-benchmark, capacity-estimation
- integrity, query-performance, benchmark-utils, synthetic-dataset-generator
- api-issues, deployment-config

### Web tests (apps/web/test/) — 155 tests, all passing
- addinData.serialization, addinDataBookingIdentifier, auditTrail
- bookingDriverDatetime, bookingValidation, concurrency-race
- identityResolver, reportingIntegrity, safetyGuards, serialization-flow
- service-addin, sortingHelpers, statusHelpers, workflowRegression

## 9. Gap Assessment vs Target Architecture

| Requirement | Current State | Gap |
|---|---|---|
| Frontend: Geotab embedded Add-In | Custom-page Add-In (ActivityLink) + Service Add-In | Need embedded packaging config; serviceSrc external hosting dependency documented |
| Business logic: Client-side TypeScript | Split between API services (Hono) and web providers | Need domain modules reusable without Hono handlers |
| Persistence: AddInData ONLY | Already AddInData-only | None |
| External backend: Remove progressively | Hono API still present | Keep for rollback until client-side parity demonstrated |
| External database: PROHIBITED | No external database | None |
| AddInData repository | Multiple implementations (gateway, provider, service) | Need single consistent repository interface |
| Security/RBAC tests | RBAC helpers exist; security.test.mjs covers auth | Need unauthorized access, cross-driver, role escalation, invalid driver mapping tests |
| Concurrency tests | concurrency-race.test.mjs exists | Need version conflict, stale update, reconciliation tests |
| Architecture assessment doc | None | This document |

## 10. Rollback Path

The existing Hono API implementation remains intact and available for rollback. No production data modified. No deployment performed. The Hono backend can be re-enabled at any time by pointing the frontend at the API base URL.
