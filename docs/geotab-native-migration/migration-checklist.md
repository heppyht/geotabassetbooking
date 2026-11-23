# Migration Checklist — OPEX Asset Booking Geotab-Native Migration

## Phase A — Architecture Inspection
- [x] Inventory all Hono API endpoints (11 endpoints documented)
- [x] Map each endpoint to business logic
- [x] Identify all AddInData read/write operations
- [x] Identify Service Add-In notification dependencies
- [x] Identify environment variables and external service dependencies
- [x] Identify RBAC, driver isolation, audit, idempotency, concurrency implementations
- [x] Create `docs/geotab-native-migration/architecture-assessment.md`

## Phase B — Client-side Domain Architecture
- [x] Create `domain/scheduling.ts` — overlap, buffer, conflict detection
- [x] Create `domain/booking.ts` — transitions, RBAC helpers, record shape
- [x] Create `domain/approval.ts` — approval/reject workflow, audit IDs
- [x] Create `services/bookingService.ts` — service layer
- [x] Create `security/policies.ts` — default-deny permission policies
- [x] Create `geotab/addinData.ts` — Geotab AddInData API wrapper
- [x] Create `repositories/addinData/addinDataRepository.ts` — single consistent repository
- [x] Move reusable business rules out of Hono handlers into domain services
- [x] Keep UI components independent from persistence implementation

## Phase C — AddInData Repository
- [x] Get booking by ID
- [x] List bookings by period (YYYY-MM)
- [x] Create booking (idempotent, read-after-write verification)
- [x] Update booking (version conflict, read-after-write verification)
- [x] Create audit event (idempotent, append-only)
- [x] Read audit history
- [x] Create notification
- [x] Update notification delivery status
- [x] Use MyGeotab JS API via `geotab.addin.call()`
- [x] One JSON serialization boundary
- [x] 10,000-character record limit enforced
- [x] periodKey = YYYY-MM partitioning
- [x] Safe retry only for read operations
- [x] No blind retry of Add/Set operations
- [x] Unique UUIDs for audit events
- [x] Read-after-write verification for critical operations

## Phase D — Security and RBAC
- [x] Default deny implemented
- [x] Permission validation in domain services (not just UI)
- [x] Authenticated identity resolved from MyGeotab context
- [x] Driver-to-user mapping validation
- [x] Driver-only-sees-authorized-bookings enforcement
- [x] Driver assignment optional
- [x] No default driver → driverId left empty
- [x] Documented AddInData server-side isolation limitation
- [x] Tests: unauthorized access ✓
- [x] Tests: cross-driver access ✓
- [x] Tests: role escalation ✓
- [x] Tests: invalid driver mapping ✓

## Phase E — Audit and Concurrency
- [x] Append-only audit
- [x] Unique UUID audit ID
- [x] Actor, action, timestamp, booking ID, previous state, new state, correlation ID captured
- [x] Idempotency implemented
- [x] Version conflict detection
- [x] Booking overlap validation
- [x] Stale update rejection
- [x] Reconciliation for partial failures (findAuditGaps)
- [x] Documented residual race conditions (check-then-Set not atomic)
- [x] Concurrency tests added

## Phase F — Service Add-In
- [x] Read pending notifications from AddInData
- [x] Validate recipient identity (idempotency guard on delivery_status)
- [x] Deduplicate notifications (delivery_status check)
- [x] Bounded retries and backoff (30s polling interval, rate limiter)
- [x] Update delivery status (pending → delivered/failed)
- [x] Avoid excessive polling (30s interval)
- [x] Documented external serviceSrc hosting dependency
- [x] Documented Service Add-In is not always-on server

## Phase G — Embedded Geotab Add-In Packaging
- [x] Valid Add-In configuration (`geotab/opex-vbm-config.json`)
- [x] `files` block for embedded HTML/JS/CSS (`dist/index.html`, `dist/assets/`, `dist/serviceAddin.js`)
- [x] `embed` block with supported flag
- [x] Add-In identity and security configuration preserved
- [x] Build output valid (Vite build + Service Add-In bundle)
- [x] Service Add-In hosting separate from frontend hosting
- [x] No automatic deployment or registration

## Phase H — Regression and Reports
- [x] API tests: 234 passed, 0 failed
- [x] Web tests: 157 passed, 0 failed
- [x] TypeScript checks: API pass, Web pass
- [x] Production build: `apps/web/build` (tsc -b && vite build)
- [x] RBAC tests: 44 passed
- [x] Driver isolation tests: included in 44
- [x] Audit tests: 16 passed
- [x] Concurrency tests: included in 16
- [x] Serialization tests: included in existing 155
- [x] Create `docs/geotab-native-migration/implementation-report.md`
- [x] Create `docs/geotab-native-migration/security-assessment.md`
- [x] Create `docs/geotab-native-migration/migration-checklist.md`
- [x] Create `docs/geotab-native-migration/rollback-plan.md`

## Definition of Done
- [x] Frontend can be packaged as a Geotab Add-In (files block in config)
- [x] Business logic is reusable without Hono handlers (domain modules)
- [x] AddInData remains the only persistence layer
- [x] Service Add-In works independently of Hono API
- [x] RBAC and driver isolation have explicit tests (44 tests)
- [x] Audit and idempotency tests pass (16 tests)
- [x] Concurrency limitations are documented
- [x] Existing regression tests pass (234 API + 157 web)
- [x] No production deployment or data modification occurred
- [x] Existing Hono implementation remains available for rollback
