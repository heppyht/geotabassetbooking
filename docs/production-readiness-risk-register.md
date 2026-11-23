# Production Readiness Risk Register (R1–R12)

## Scope

Geotab Asset Booking — MyGeotab AddInData-only storage architecture.
All persistent data lives in MyGeotab AddInData via the REST JSON-RPC API.
No PostgreSQL, Neon, Cloudflare D1, Supabase, Firebase, or Redis.

## Risk Register

---

### R1 — Non-atomic AddInData writes

**Description:** MyGeotab AddInData does not support transactions. A
read-then-write sequence (read booking, modify, Set) is not atomic. Two
concurrent requests can both read the same version, both write, and the
second write silently overwrites the first (lost update).

**Current status:** Mitigated (best-effort, not eliminated)

**Evidence:**
- `apps/api/src/services/booking.ts` — version-based optimistic concurrency
  check on every write (`booking.version !== updated.version - 1` → 409
  `BOOKING_VERSION_CONFLICT`)
- `apps/api/test/integrity.test.mjs` — version conflict test coverage
- `apps/api/test/security.test.mjs` — authorization enforcement on writes

**Mitigation:** Version-based optimistic concurrency on all mutating
operations (create, approve, reject, assign, cancel). Clients retry on 409.
Idempotency keys prevent duplicate creation on retry.

**Remaining limitation:** Does NOT guarantee atomicity. Read-then-write or
version-check-then-Set is a race window. Concurrent writers can still
overwrite each other if they read the same version before either writes.

**Production impact:** Medium. Lost updates possible under concurrent
write load. Mitigated by idempotency keys and retry-on-409 client logic.

---

### R2 — Session hijacking / session ID theft

**Description:** The MyGeotab session ID (`X-Geotab-Session-Id` or
`Authorization: Bearer`) is the sole authentication credential. If
intercepted, an attacker can impersonate the user.

**Current status:** Mitigated (protocol-level)

**Evidence:**
- `apps/api/src/auth.ts` — `resolveVerifiedPrincipal` verifies every
  session via MyGeotab `Get User` before granting access
- `apps/api/src/db.ts` — `verifySession` calls MyGeotab with the caller's
  session credentials; invalid sessions return `valid: false`
- `apps/api/src/index.ts` — CORS restricted to `ALLOWED_ORIGIN` only
- `apps/api/test/security.test.mjs` — tests for invalid/expired/missing sessions

**Mitigation:** All protected routes require `requirePrincipal` middleware
which calls `resolveVerifiedPrincipal`. Session verification is mandatory
and fail-closed. HTTPS transport (Wrangler/TLS) protects session IDs in
transit.

**Remaining limitation:** Session IDs are bearer tokens. If an attacker
obtains a valid session ID (e.g., via XSS, logs, or network sniffing
without TLS), they can impersonate the user until the session expires
(14 days, password change, or 100-concurrent-session limit per MyGeotab).

**Production impact:** High. Full user impersonation. Mitigated by TLS,
short session lifetimes, and CORS origin restriction.

---

### R3 — Privilege escalation via client-supplied roles

**Description:** A client could attempt to supply elevated role claims
(e.g., `ADMIN`, `APPROVER`) in request headers or body to gain
unauthorized access.

**Current status:** Mitigated

**Evidence:**
- `apps/api/src/auth.ts` — Roles are resolved exclusively from the
  verified MyGeotab user record's `role` field, never from client input
  (`MYGEOTAB_ROLE_MAP` maps known MyGeotab roles; unknown roles default
  to `EMPLOYEE`)
- `apps/api/src/db.ts` — `verifySession` returns the user's role from
  the MyGeotab `Get User` response; client cannot influence this
- `apps/api/test/security.test.mjs` — test confirms unknown role defaults
  to `EMPLOYEE` (fail closed)

**Mitigation:** Server-side role resolution only. Client-supplied role
data is never trusted. `IDENTITY_ADAPTER_CONFIGURED` must be `"true"` for
any protected access; otherwise 503.

**Remaining limitation:** Role mapping depends on MyGeotab user records
having a `role` field populated by administrators. If MyGeotab user roles
are not configured, all users default to `EMPLOYEE` and cannot perform
approver/GA/admin actions.

**Production impact:** Medium. Prevents privilege escalation but requires
administrator-managed MyGeotab user role configuration for elevated roles.

---

### R4 — IDOR (Insecure Direct Object Reference) on booking resources

**Description:** An authenticated user could guess or enumerate booking
IDs and access, modify, or cancel another user's booking.

**Current status:** Mitigated

**Evidence:**
- `apps/api/src/index.ts` — `GET /api/bookings/:id` now calls
  `canViewBooking(principal, booking)` before returning data (was
  previously unchecked — IDOR vulnerability)
- `apps/api/src/index.ts` — `POST /api/bookings/:id/cancel` now calls
  `canCancelBooking(principal, booking)` before cancelling
- `apps/api/src/index.ts` — `POST /api/bookings/:id/submit-for-approval`
  checks `requesterUserId === principal.appUserId`
- `apps/api/src/services/booking.ts` — `canViewBooking`, `canModifyBooking`,
  `canCancelBooking` enforce ownership and role-based access
- `apps/api/test/security.test.mjs` — tests for employee accessing
  another employee's booking, driver accessing another driver's booking

**Mitigation:** Server-side authorization on every booking endpoint.
Requesters can only access their own bookings. Approvers/GA/Admin can
access any booking. Assigned drivers can access their assigned bookings.

**Remaining limitation:** `GET /api/bookings` returns all bookings
filtered client-side by `requesterUserId`. A malicious client could
ignore the filter, but the server only returns bookings matching the
authenticated user's ID (the filter is applied server-side in the route
handler). No sensitive data is exposed to unauthorized users.

**Production impact:** Medium. IDOR prevented on all booking endpoints.

---

### R5 — Cross-tenant data access via database header override

**Description:** A client could supply a `x-geotab-database` header to
access AddInData records in a different MyGeotab database/tenant.

**Current status:** Mitigated

**Evidence:**
- `apps/api/src/auth.ts` — `resolveVerifiedPrincipal` uses `env.GEOTAB_DATABASE`
  exclusively, ignoring `creds.database` from the client
- `apps/api/src/index.ts` — `gatewayForRequest` uses `c.env.GEOTAB_DATABASE`
  only; client-supplied database is ignored
- `apps/api/src/db.ts` — `AddInDataRestGateway` constructor sets
  `this.database = credentials.database`; gateway is always created with
  the server-configured database

**Mitigation:** Tenant/database is always derived from server environment
variables (`GEOTAB_DATABASE`), never from client headers.

**Remaining limitation:** None identified. Client cannot override the
target tenant.

**Production impact:** Low. Cross-tenant access prevented.

---

### R6 — Concurrent booking race conditions

**Description:** Two users booking the same vehicle for overlapping times
could both succeed if the conflict check and write are not atomic.

**Current status:** Mitigated (best-effort, not eliminated)

**Evidence:**
- `apps/api/src/index.ts` — `POST /api/bookings` performs a conflict
  check (loads all bookings, filters overlaps for same device in
  `PENDING_APPROVAL`/`APPROVED`/`ASSIGNED` states) before creating
- `apps/api/src/services/booking.ts` — `assignApprovedBooking` performs
  conflict check on vehicle assignment
- `apps/api/src/services/booking.ts` — version-based optimistic concurrency
  on all writes
- `apps/api/test/overlap.test.mjs` and `apps/api/test/overlap-scenarios.test.mjs`
  — overlap detection tests

**Mitigation:** Pre-write conflict detection + version-based optimistic
concurrency + idempotency keys. Clients retry on conflict.

**Remaining limitation:** Does NOT guarantee atomicity. The conflict check
(load all bookings → check overlaps → write) has a race window. Two
concurrent requests for the same vehicle could both pass the check before
either writes.

**Production impact:** Medium. Double-booking possible under high
concurrency. Mitigated by idempotency keys and retry logic.

---

### R7 — Missing audit events / audit gap

**Description:** A booking state change could be persisted without the
corresponding audit event, creating an incomplete audit trail.

**Current status:** Mitigated (detection, not prevention)

**Evidence:**
- `apps/api/src/services/booking.ts` — Every booking write (approve,
  reject, assign, cancel) writes the audit event and links it via
  `auditId` on the booking record
- `apps/api/src/services/booking.ts` — `findAuditGaps()` identifies
  bookings with missing or dangling audit references
- `apps/web/src/data/addinDataProvider.ts` — `createAuditRecord` persists
  audit events to AddInData
- `apps/api/test/integrity.test.mjs` — audit gap detection tests

**Mitigation:** Audit event written after each booking state change;
`auditId` links booking to audit; `findAuditGaps()` reconciliation
identifies missing events.

**Remaining limitation:** Does NOT prevent audit loss. If the AddInData
write for the audit event fails after the booking write succeeds, the
booking has no audit record. Reconciliation (`findAuditGaps`) detects
this but does not auto-remediate.

**Production impact:** Medium. Incomplete audit trail possible.
Reconciliation required to detect gaps.

---

### R8 — Booking ID collision (Date.now())

**Description:** Booking IDs generated with `Date.now()` can collide when
multiple bookings are created within the same millisecond, causing
overwrites or duplicate IDs.

**Current status:** RESOLVED

**Evidence:**
- `apps/api/src/services/booking.ts` — `generateId()` uses
  `crypto.randomUUID()` (UUID v4 format)
- `apps/web/src/data/addinDataProvider.ts` — `generateBookingId()` uses
  `crypto.randomUUID()`
- `apps/api/test/integrity.test.mjs` — test confirms UUID v4 format and
  uniqueness across 100 calls

**Mitigation:** `crypto.randomUUID()` for all booking and audit IDs.
Collision probability is negligible (UUID v4 randomness).

**Remaining limitation:** None. UUID v4 provides sufficient uniqueness.

**Production impact:** None. Risk resolved.

---

### R9 — Inconsistent audit details serialization

**Description:** Audit `details` field was inconsistently serialized
(plain string, JSON string, or null) across different booking actions,
making audit consumers unable to reliably parse details.

**Current status:** RESOLVED

**Evidence:**
- `apps/api/src/services/booking.ts` — All audit records use
  `details: Record<string, unknown> | null` (structured JSON object)
- `apps/api/src/services/booking.ts` — `OpexBookingAudit.details` typed
  as `Record<string, unknown> | null`, "always structured JSON, never raw string"
- `apps/web/src/data/addinDataProvider.ts` — `serializeAudit` enforces
  single `JSON.stringify` boundary at API edge
- `apps/api/test/integrity.test.mjs` — test confirms audit details are
  structured JSON objects

**Mitigation:** Single `JSON.stringify` at the API boundary. Audit details
always stored as structured JSON objects.

**Remaining limitation:** Legacy schema v1 records may have inconsistent
details; they are readable but new writes use schema v2.

**Production impact:** None. Risk resolved.

---

### R10 — No idempotency on booking creation

**Description:** Duplicate booking submissions (e.g., double-click, retry
after network error) could create duplicate booking records.

**Current status:** RESOLVED

**Evidence:**
- `apps/api/src/services/booking.ts` — `createBooking` checks
  `findBookingByIdempotency` before creating; returns existing booking
  if idempotency key matches
- `apps/api/src/index.ts` — `POST /api/bookings` sends `Idempotency-Key`
  header (client-provided or derived from request parameters)
- `apps/api/test/integrity.test.mjs` — idempotency tests (same key returns
  existing booking, different keys create different bookings)

**Mitigation:** Idempotency key check before every booking creation.
Same key → returns existing booking. Different keys → new booking.

**Remaining limitation:** Idempotency key is client-generated. A client
could use different keys for the same logical booking, creating duplicates.
Server-side deduplication based on booking content is not implemented.

**Production impact:** Low. Duplicate creation mitigated for well-behaved
clients.

---

### R11 — AddInData size limit (10,000 characters)

**Description:** MyGeotab AddInData `details` field has a practical size
limit. Large booking or audit records could exceed the limit and fail to
persist.

**Current status:** Mitigated

**Evidence:**
- `apps/web/src/data/addinDataProvider.ts` — `assertDetailsWithinLimit`
  enforces max 10,000 serialized characters before AddInData write
- `apps/api/src/services/booking.ts` — Booking and audit records are
  small (fields are strings, numbers, nulls, small arrays)
- `apps/web/test/addinData.serialization.test.mjs` — serialization limit tests

**Mitigation:** Client-side enforcement of 10,000 character limit before
any AddInData `Add` or `Set` operation. Error thrown if exceeded.

**Remaining limitation:** If a booking record legitimately exceeds
10,000 characters (e.g., very long purpose text, many audit changes),
the write fails. No automatic truncation or compression.

**Production impact:** Low. Booking records are typically well under
10,000 characters. Large records rejected with clear error.

---

### R12 — Session expiration / token theft

**Description:** MyGeotab session IDs expire after 14 days, on password
change, or at the 100-concurrent-session limit. Expired sessions cause
authentication failures. Stolen sessions remain valid until expiration.

**Current status:** Mitigated (protocol-level)

**Evidence:**
- `apps/api/src/auth.ts` — `resolveVerifiedPrincipal` verifies session on
  every request; expired/invalid sessions return null (401/503)
- `apps/api/src/db.ts` — `verifySession` calls MyGeotab `Get User` with
  the session; invalid sessions throw or return `valid: false`
- `apps/api/test/security.test.mjs` — tests for session verification
  failure, network errors, invalid sessions

**Mitigation:** Every request re-verifies the session. Failed verification
results in access denial. Client must re-authenticate with MyGeotab to
obtain a new session.

**Remaining limitation:** No session refresh mechanism. Client must
re-authenticate through the MyGeotab Add-In host when the session expires.

**Production impact:** Medium. Users must re-authenticate on session
expiry. No silent token refresh.

---

### R13 — AddInData write throughput (Add rate limit)

**Description:** The MyGeotab AddInData `Add` operation has an unverified
rate limit of ~100 requests/minute. This is the most restrictive API limit
and directly constrains booking creation and audit event logging throughput.

**Current status:** NOT VERIFIED — requires Geotab confirmation

**Evidence:**
- `docs/phase-9.5-addindata-capacity-performance-report.md` — Section E
- `apps/api/test/rate-limit.test.mjs` — rate limit analysis tests
- Bulk write of 50,000 bookings + 250,000 audits = 300,000 Add operations
  would take ~50 hours at 100/min (unverified)

**Mitigation:** Implement client-side request queuing with exponential
backoff. Spread write operations over time to stay under the rate limit.
Consider batching audit events where possible.

**Remaining limitation:** Rate limit is UNVERIFIED. Actual limit may be
higher or lower. No client-side throttling currently exists in the codebase.

**Production impact:** High. Write throughput is the primary constraint
for scaling beyond small deployments.

---

### R14 — Full-collection scan query performance

**Description:** All AddInData queries perform full-collection scans followed
by client-side filtering. Query latency grows super-linearly with dataset
size (50x data → ~105x latency increase). At 50,000 bookings, a full scan
takes ~1.9 seconds.

**Current status:** Mitigated (partial — periodKey scoping claimed but NOT VERIFIED)

**Evidence:**
- `apps/api/src/index.ts` — `GET /api/bookings` loads all bookings, filters
  client-side by `requesterUserId`
- `apps/api/src/services/booking.ts` — `findBookingRecord`, `loadAllBookings`,
  `findAuditEventByBookingAndEventId`, `findBookingByIdempotency` all use
  full-collection scans
- `apps/web/src/data/addinDataService.ts` — `getAllBookings`, `findBookingById`,
  `getAuditEventsByBooking`, `findAuditEventByIdempotency` all use full scans
- `apps/api/test/query-performance.test.mjs` — query performance benchmarks

**Mitigation:** Verify and use `periodKey` server-side filtering. Add
in-memory caching for read-heavy operations. Avoid loading audit/notification
records when only bookings are needed.

**Remaining limitation:** Server-side `periodKey` filtering is NOT VERIFIED
against the live MyGeotab AddInData API. Cannot claim query optimization
without live verification.

**Production impact:** High. Query latency will degrade significantly
beyond 10,000 records.

---

### R15 — Unknown AddInData storage quota

**Description:** No official Geotab documentation was found specifying the
maximum total AddInData storage per database, maximum records per AddInId,
maximum records per database, or retention restrictions. Storage capacity
cannot be confirmed.

**Current status:** UNKNOWN — requires Geotab confirmation

**Evidence:**
- `docs/phase-9.5-addindata-capacity-performance-report.md` — Section G
- `apps/api/test/capacity-estimation.test.mjs` — storage quota test
  explicitly reports as UNKNOWN

**Mitigation:** Contact Geotab Support to confirm storage quotas. Monitor
record count growth and set alerts at 50%, 75%, 90% of any known quota.

**Remaining limitation:** No storage limit has been verified. Application
has no mechanism to detect when approaching quota.

**Production impact:** High. Cannot plan capacity without verified quotas.

---

### R16 — No client-side rate-limit handling

**Description:** The AddInData gateway implementations
(`AddInDataRestGateway` in API, `AddInDataGateway` in web) have no built-in
rate-limit throttling, no Retry-After header parsing, and no automatic retry
on HTTP 429 responses. Rate-limit errors will cause request failures.

**Current status:** Not mitigated

**Evidence:**
- `apps/api/src/db.ts` — `AddInDataRestGateway` has no retry logic
- `apps/web/src/data/addinDataService.ts` — `AddInDataGateway` has no retry
  logic
- `apps/api/test/rate-limit.test.mjs` — confirms no throttling, no
  Retry-After parsing, no automatic retry

**Mitigation:** Implement exponential backoff with Retry-After parsing.
Queue write operations. Add circuit breaker for repeated failures.

**Remaining limitation:** No retry logic exists. All AddInData write failures
are immediately propagated to the caller.

**Production impact:** Medium. Rate-limit errors will cause write failures
under load.

---

## Phase 9.6 — MyGeotab AddInData Integration Validation (Offline)

### Validation Method

Offline mock-gateway integration tests (`apps/api/test/addindata-integration.test.mjs`)
validated all AddInData CRUD, serialization, idempotency, optimistic concurrency,
audit trail, tenant isolation, and legacy v1 compatibility without live MyGeotab
credentials. 18 new tests, all passing (206 total API tests, 0 failures).

### Validated Offline (mock gateway)

- **R1 (Non-atomic writes):** Version-based optimistic concurrency verified on
  create, approve, reject, assign, cancel. Version increments correctly on each
  write. Conflict returns 409 `BOOKING_VERSION_CONFLICT`.
- **R4 (IDOR):** `canViewBooking`, `canCancelBooking`, `canModifyBooking`
  enforced on all endpoints. Owner-only, role-based, and driver-scoped access
  verified.
- **R5 (Cross-tenant):** Gateway always uses server-configured `GEOTAB_DATABASE`.
  Client-supplied database header is ignored. `verifySession` confirms database
  match.
- **R6 (Concurrent booking):** Pre-write conflict detection verified. Overlapping
  bookings on same device in `PENDING_APPROVAL`/`APPROVED`/`ASSIGNED` states
  rejected with 409 `ASSET_CONFLICT`.
- **R7 (Missing audit events):** Every state change writes an audit event linked
  via `auditId`. `findAuditGaps()` detects bookings with missing or dangling
  audit references. Audit gap reconciliation verified.
- **R8 (Booking ID collision):** `crypto.randomUUID()` used for all IDs. No
  collisions in 100+ test calls.
- **R9 (Audit details serialization):** All audit `details` are structured JSON
  objects, never raw strings or null. Single `JSON.stringify` boundary at API
  edge. No double-serialization.
- **R10 (Idempotency):** `Idempotency-Key` checked before every booking creation.
  Same key returns existing booking. No duplicate records.
- **R11 (Size limit):** 10,000 char limit enforced before AddInData write.
  Records at exactly 10,000 chars accepted; oversized rejected.
- **R12 (Session expiration):** `requirePrincipal` verifies session on every
  request. Expired/invalid sessions return null (503/401).

### NOT Verified (require live MyGeotab credentials)

Steps 3, 10 and the following risk items require live tenant access:

- **R13 (AddInData write throughput):** Add rate limit (~100/min) is UNVERIFIED.
  No client-side throttling exists. Requires Geotab confirmation.
- **R14 (Full-collection scan queries):** Server-side `periodKey` filtering is
  claimed in code but NOT VERIFIED against live MyGeotab AddInData API.
- **R15 (Unknown storage quota):** No Geotab documentation found for AddInData
  storage quotas. Requires Geotab Support confirmation.
- **R16 (No client-side rate-limit handling):** PARTIALLY RESOLVED — Exponential
  backoff retry with jitter implemented in `apps/api/src/retry.ts`. Error
  classification distinguishes retryable (429, 5xx, network) from permanent
  (401, 403, 400, version conflict) errors. Write safety via idempotency keys
  and deterministic audit event IDs. Live throttling behavior UNVERIFIED —
  requires authorized test tenant credentials.

### Steps Blocked

- **Step 3 (MyGeotab API connectivity):** Requires live MyGeotab test tenant
  credentials (userName, database, sessionId) for `opex_trial` or equivalent.
- **Step 10 (Storage quota confirmation):** Requires Geotab Support to confirm
  AddInData storage quotas per database.
- **Step 7 part 2 (Live Add-In integration):** Requires live Add-In host
  integration test with the `addin-booking-app` AddInId.

### Updated Production Blockers

Same as before plus:

8. Live MyGeotab test tenant credentials must be obtained to complete Steps 3,
   7 (live), and 10, and to verify R13, R14, R15 against the live API.

---

| Risk | Status | Mitigation Type |
|------|--------|-----------------|
| R1 Non-atomic writes | Mitigated | Version-based optimistic concurrency (best-effort) |
| R2 Session hijacking | Mitigated | Server-side session verification on every request |
| R3 Privilege escalation | Mitigated | Server-side role resolution; fail closed to EMPLOYEE |
| R4 IDOR on bookings | Mitigated | `canViewBooking`/`canCancelBooking` on all endpoints |
| R5 Cross-tenant access | Mitigated | Server-configured database only; client header ignored |
| R6 Concurrent booking | Mitigated | Conflict check + optimistic concurrency (best-effort) |
| R7 Missing audit events | Mitigated | Audit link via `auditId`; `findAuditGaps()` reconciliation |
| R8 Booking ID collision | RESOLVED | `crypto.randomUUID()` |
| R9 Audit details inconsistency | RESOLVED | Structured JSON details; single serialization boundary |
| R10 No idempotency | RESOLVED | Idempotency-key checks on booking creation |
| R11 AddInData size limit | Mitigated | 10,000 char enforcement before write |
| R12 Session expiration | Mitigated | Re-verify on every request; client re-authenticates |
| R13 AddInData write throughput | Not mitigated | Requires client-side throttling + Geotab verification |
| R14 Full-collection scan queries | Mitigated (partial) | periodKey scoping claimed but NOT VERIFIED |
| R15 Unknown storage quota | UNKNOWN | Requires Geotab Support confirmation |
| R16 No client-side rate-limit handling | PARTIALLY RESOLVED | Exponential backoff + Retry-After parsing implemented; live throttling UNVERIFIED |

## Production Blockers

None identified that block production deployment at small scale (~10,000
bookings), provided:

1. `IDENTITY_ADAPTER_CONFIGURED` is set to `"true"` only after MyGeotab
   session verification is validated against `GEOTAB_DATABASE`
2. MyGeotab user records have `role` fields configured for users needing
   APPROVER/GA/MANAGEMENT/ADMIN access
3. Clients implement retry-on-409 for version conflicts
4. Periodic `findAuditGaps()` reconciliation is run to detect audit gaps
5. Geotab Support confirms storage quotas and rate limits (R13, R15)
6. Client-side rate-limit handling is implemented (R16)
7. Query performance is monitored and acceptable for expected data volume (R14)

Larger deployments (>10,000 bookings) require R13, R14, R15, and R16 to be
addressed before production use.

---

## Phase 9.7 — Deployment-Specific Risks (D1–D5)

### D1 — CI/CD secret exposure

**Description:** GitHub Actions workflows could accidentally expose secrets
(e.g., `CLOUDFLARE_API_TOKEN`) in logs or to pull requests from untrusted forks.

**Current status:** Mitigated

**Evidence:**
- `.github/workflows/ci.yml` — `permissions: contents: read` only, no secrets
  referenced
- `.github/workflows/deploy-worker.yml` — `CLOUDFLARE_API_TOKEN` referenced as
  `${{ secrets.CLOUDFLARE_API_TOKEN }}`, job runs on `production` environment
- `.github/workflows/deploy-pages.yml` — `permissions: contents: read, pages:
  write, id-token: write`, no secrets referenced

**Mitigation:** Secrets are never echoed in workflow steps. `workflow_dispatch`
and push-to-main triggers only. PRs from forks do not receive secrets by
default in GitHub Actions.

**Remaining limitation:** If a workflow author adds `echo $SECRET` or similar,
the secret would appear in Action logs. No secret scanning is configured.

**Production impact:** High. Exposed API tokens could allow unauthorized
Worker deployments.

---

### D2 — Frontend base path misconfiguration

**Description:** Vite `base` must match the GitHub Pages repository path
(`/opexassetbooking/`). A wrong base path causes 404s on all assets.

**Current status:** Mitigated

**Evidence:**
- `apps/web/vite.config.ts` — `base: "/opexassetbooking/"`
- `docs/GITHUB_PAGES.md` — documents `Vite base path: /opexassetbooking/`
- Production build verified: `dist/index.html` references
  `/opexassetbooking/assets/...`

**Mitigation:** Base path is set explicitly in `vite.config.ts`. Build
output verified to reference correct path.

**Remaining limitation:** If `base` is changed without updating
`GITHUB_PAGES.md` or the Add-In URL, assets will 404. No automated check
verifies base path consistency.

**Production impact:** Medium. Entire frontend becomes unreachable.

---

### D3 — Worker deployment without approval

**Description:** The `deploy-worker.yml` workflow triggers on push to `main`,
which could deploy untested code to the production Worker.

**Current status:** Mitigated

**Evidence:**
- `.github/workflows/deploy-worker.yml` — targets `production` environment,
  which can have GitHub environment protection rules requiring manual approval
- CI (`ci.yml`) runs on every push and PR, providing a validation gate

**Mitigation:** Environment protection rules in GitHub can require manual
approval for production deployments. CI must pass before merge to `main`.

**Remaining limitation:** Without environment protection rules enabled, any
push to `main` deploys the Worker automatically.

**Production impact:** High. Untested Worker code could break the API.

---

### D4 — AddInData records not rollback-safe

**Description:** Application rollback (Worker or frontend) does not roll back
AddInData records in MyGeotab. A bad deployment could leave booking/audit
records in an inconsistent state that code rollback cannot fix.

**Current status:** Not mitigated (architectural constraint)

**Evidence:**
- `docs/deployment/rollback-and-recovery.md` — explicitly states AddInData
  records are NOT rolled back and must remain append-only
- `apps/api/src/services/booking.ts` — audit records are append-only,
  booking records are current-state-only

**Mitigation:** Documented as an architectural constraint. Recovery requires
manual intervention in MyGeotab, not code rollback. Version-based optimistic
concurrency and `findAuditGaps()` help detect inconsistencies.

**Remaining limitation:** No automated AddInData rollback mechanism exists.
Bad writes persist until manually corrected in the tenant.

**Production impact:** High. Data inconsistencies from bad deployments
require manual MyGeotab tenant intervention.

---

### D5 — Missing production secrets (CLOUDFLARE_API_TOKEN)

**Description:** The Worker deployment workflow requires `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` in GitHub Actions. These are not yet configured.

**Current status:** NOT VERIFIED — credentials not yet configured

**Evidence:**
- `.github/workflows/deploy-worker.yml` — references `${{
  secrets.CLOUDFLARE_API_TOKEN }}` and `${{ vars.CLOUDFLARE_ACCOUNT_ID }}`
- No Cloudflare credentials exist in the repository or GitHub Actions yet

**Mitigation:** Configure `CLOUDFLARE_API_TOKEN` as a GitHub Actions secret
and `CLOUDFLARE_ACCOUNT_ID` as a variable before the first Worker deployment.

**Remaining limitation:** Cannot deploy the Worker via GitHub Actions until
credentials are configured.

**Production impact:** High. No automated Worker deployment path exists.

---

## Updated Production Blockers

Same as Phase 9.6 plus:

8. `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` must be configured in
   GitHub Actions before the Worker can be deployed via CI/CD.
9. GitHub environment protection rules should be enabled for the `production`
   environment to require manual approval for Worker deployments.
10. Live MyGeotab tenant credentials must be obtained to complete Steps 3, 7
    (live), and 10, and to verify R13, R14, R15 against the live API.

CI passing alone does NOT constitute production readiness.

---

## Phase 9.8 — Production Release Preparation Validation

### CI/CD Validation Results (local execution)

| Check | Command | Result |
|-------|---------|--------|
| API TypeScript | `npm --workspace apps/api run typecheck` | Clean (exit 0) |
| Web TypeScript | `npx tsc -p apps/web/tsconfig.json --noEmit` | Clean (exit 0) |
| API tests | `npm --workspace apps/api run test` | 206 pass, 0 fail |
| Web tests | `npm --workspace apps/web run test` | 155 pass, 0 fail |
| Web production build | `npm --workspace apps/web run build` | Successful |
| Deployment config validation | `node test/deployment-config.test.mjs` | 12 pass, 0 fail |

All CI/CD validation passes. Test counts match Phase 9.6/9.7 baseline (API: 206, Web: 155). No regressions.

### Deployment Configuration Readiness

| Item | Status | Evidence |
|------|--------|----------|
| `wrangler.toml` — no PostgreSQL/D1/KV bindings | READY | Clean config, AddInData only |
| `wrangler.toml` — `IDENTITY_ADAPTER_CONFIGURED` unset | READY | Fail-closed until live validation |
| `vite.config.ts` — base path `/opexassetbooking/` | READY | Correct for GitHub Pages |
| `CLOUDFLARE_API_TOKEN` GitHub Secret | NOT CONFIGURED | Required for Worker deployment |
| `CLOUDFLARE_ACCOUNT_ID` GitHub Variable | NOT CONFIGURED | Required for Worker deployment |
| `VITE_API_BASE_URL` GitHub Variable | NOT CONFIGURED | Required for frontend API connection |
| Staging infrastructure | NOT AVAILABLE | No staging environment provisioned |
| Live MyGeotab tenant credentials | NOT AVAILABLE | Required for R13-R15 verification |

### Staging Validation

| Item | Status | Evidence |
|------|--------|----------|
| Staging deployment | BLOCKED | No staging infrastructure or credentials |
| Live MyGeotab integration | BLOCKED | No test tenant credentials |
| AddInData storage quota | UNKNOWN | Requires Geotab Support confirmation |
| AddInData write throughput | NOT TESTED | ~100/min unverified |
| Server-side `periodKey` filtering | NOT TESTED | Unverified against live API |

---

## Updated Production Blockers

Same as Phase 9.6 and 9.7 plus:

11. Staging infrastructure must be provisioned before staging validation can occur.
12. Live MyGeotab test tenant credentials must be obtained to verify R13, R14, R15 against the live API.
13. GitHub Actions secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and variable (`CLOUDFLARE_ACCOUNT_ID`, `VITE_API_BASE_URL`) must be configured before any deployment.

**Final release readiness decision: BLOCKED** — CI/CD validation passes but live integration validation remains blocked. Do not declare production readiness.

---

## Phase 9.9.2 — Staging Infrastructure & Configuration

### Configuration Status

| Item | Status | Evidence |
|------|--------|----------|
| `wrangler.toml` `[environments.staging]` | IMPLEMENTED | Separate Worker `opex-vbm-api-staging` |
| `wrangler.toml` no secrets | IMPLEMENTED | Plain `[vars]` only |
| `.github/workflows/deploy-worker.yml` staging job | IMPLEMENTED | `environment: staging`, `--env staging` |
| `.github/workflows/deploy-worker.yml` production job | IMPLEMENTED | `environment: production`, manual approval gate |
| `.github/workflows/deploy-pages.yml` staging jobs | IMPLEMENTED | `build-staging`, `deploy-staging` |
| `.github/workflows/deploy-pages.yml` production jobs | IMPLEMENTED | `build-production`, `deploy-production` |
| `vite.config.ts` base path `/opexassetbooking/` | IMPLEMENTED | Verified in production build |
| Staging config validation tests | IMPLEMENTED | 18 tests, all pass |

### Infrastructure Status (NOT PROVISIONED)

| Item | Status | Required Action |
|------|--------|-----------------|
| Cloudflare staging Worker | NOT PROVISIONED | `npx wrangler deploy --env staging` |
| Cloudflare production Worker | NOT PROVISIONED | `npx wrangler deploy` |
| GitHub Environments | NOT CREATED | `staging`, `production`, `github-pages`, `github-pages-staging` |
| GitHub Actions `CLOUDFLARE_API_TOKEN` | NOT CONFIGURED | Secret |
| GitHub Actions `CLOUDFLARE_ACCOUNT_ID` | NOT CONFIGURED | Variable |
| GitHub Actions `VITE_API_BASE_URL` | NOT CONFIGURED | Variable |
| MyGeotab `opex_trial` credentials | NOT OBTAINED | Geotab Admin |

---

## Phase 9.9.2 — Staging Infrastructure Risks (S1–S3)

### S1 — Staging secrets not configured

**Description:** GitHub Actions secrets (`CLOUDFLARE_API_TOKEN`) and variables (`CLOUDFLARE_ACCOUNT_ID`, `VITE_API_BASE_URL`) are not configured, preventing any Worker deployment.

**Current status:** NOT CONFIGURED

**Evidence:**
- `.github/workflows/deploy-worker.yml` references `${{ secrets.CLOUDFLARE_API_TOKEN }}` and `${{ vars.CLOUDFLARE_ACCOUNT_ID }}`
- No values exist in GitHub repository Settings > Secrets and variables > Actions

**Mitigation:** Configure `CLOUDFLARE_API_TOKEN` as a secret and `CLOUDFLARE_ACCOUNT_ID`, `VITE_API_BASE_URL` as variables before first deployment.

**Remaining limitation:** Cannot deploy staging or production Worker via CI/CD until credentials are configured.

**Production impact:** High. No automated Worker deployment path exists.

---

### S2 — Staging and production share MyGeotab test tenant

**Description:** Both staging and production Workers use the same `opex_trial` database. Staging writes could affect production data and vice versa.

**Current status:** Architectural constraint (mitigated by test tenant)

**Evidence:**
- `wrangler.toml` production: `GEOTAB_DATABASE = "opex_trial"`
- `wrangler.toml` staging: `GEOTAB_DATABASE = "opex_trial"`

**Mitigation:** `opex_trial` is already a test tenant, not production data. Staging and production both write to the same test tenant. Logical separation by deployment context only — no hard isolation at the storage layer.

**Remaining limitation:** No hard isolation between staging and production writes to AddInData. Staging test data could interleave with production test data.

**Production impact:** Medium. Test data from staging and production could interleave in `opex_trial`.

---

### S3 — GitHub Environments not created

**Description:** GitHub Environments (`staging`, `production`, `github-pages`, `github-pages-staging`) are not created, so deployment approval gates and environment-specific secrets cannot be enforced.

**Current status:** NOT CREATED

**Evidence:**
- `.github/workflows/deploy-worker.yml` references `environment: staging` and `environment: production`
- `.github/workflows/deploy-pages.yml` references `environment: github-pages-staging` and `environment: github-pages`
- No environments exist in GitHub repository Settings > Environments

**Mitigation:** Create all four environments in GitHub repository settings. Enable required reviewers for `production` and `github-pages`.

**Remaining limitation:** Without environments, deployment approval gates cannot be enforced, and secrets cannot be scoped to specific environments.

**Production impact:** High. No environment-level access control for deployments.

---

## Updated Production Blockers

Same as Phase 9.6, 9.7, 9.8, and 9.9.1 plus:

18. Staging infrastructure must be provisioned (Cloudflare Worker, GitHub Environments, secrets, variables).
19. MyGeotab test tenant credentials must be obtained to validate staging against live API.
20. GitHub Actions secrets and variables must be configured before any deployment.

CI passing alone does NOT constitute production readiness.

---

## Phase 9.9.1 — Rate-Limit Handling (R16)

### Implementation Summary

Implemented in `apps/api/src/retry.ts` with 28 automated tests
(`apps/api/test/rate-limit-handling.test.mjs`):

**Error Classification (10 tests):**
- HTTP 429 → `rate_limit`, retryable
- HTTP 5xx → `temporary_network_failure`, retryable
- HTTP 401 → `authentication_failure`, not retryable
- HTTP 403 → `permission_error`, not retryable
- HTTP 400 → `validation_error`, not retryable
- Version conflict / invalid transition → `concurrency_conflict`, not retryable
- Network/timeout → `temporary_network_failure`, retryable
- Retry-After parsing from error messages

**Retry Strategy (8 tests):**
- Exponential backoff with jitter
- Configurable max attempts, delays, total duration
- Server Retry-After takes precedence
- Non-retryable errors not retried

**Write Safety (8 tests):**
- Deterministic audit event IDs via `generateAuditEventId()`
- Idempotent audit writes via `findAuditEventByBookingAndEventId` pre-check
- createBooking idempotent via idempotency key
- Version conflict check exists in booking service

**Gateway Retry (1 test):**
- `createResilientGateway()` retries read operations (search, getDevices, getUsers, verifySession)
- Write operations NOT retried at gateway level — write safety at service layer

### CI/CD Validation Results (local execution, post-Phase 9.9.1)

| Check | Command | Result |
|-------|---------|--------|
| API TypeScript | `npm --workspace apps/api run typecheck` | Clean (exit 0) |
| Web TypeScript | `npx tsc -p apps/web/tsconfig.json --noEmit` | Clean (exit 0) |
| API tests | `npm --workspace apps/api run test` | 234 pass, 0 fail (+28) |
| Web tests | `npm --workspace apps/web run test` | 155 pass, 0 fail |
| Web production build | `npm --workspace apps/web run build` | Successful |
| Deployment config validation | `node test/deployment-config.test.mjs` | 12 pass, 0 fail |

### R16 Status: PARTIALLY RESOLVED

**Resolved:** Client-side retry with exponential backoff + jitter, error
classification distinguishing retryable vs non-retryable errors, write safety
via idempotency keys and deterministic audit event IDs, user-facing error
messages.

**Not resolved (pending live validation):** Live MyGeotab throttling behavior,
actual rate-limit thresholds, Retry-After header support from live API.

Live MyGeotab validation required to fully resolve R16.

---

## Updated Production Blockers

Same as Phase 9.6, 9.7, and 9.8 plus:

14. R16 live validation requires authorized MyGeotab test tenant credentials to
    confirm throttling behavior and Retry-After support.

CI passing alone does NOT constitute production readiness.

---

## Phase 9.9.3 — Production Release Preparation (Direct Deployment)

### Configuration Changes

| Item | Before | After | Status |
|------|--------|-------|--------|
| Deploy workflow | staging + production jobs | production only | REMOVED STAGING |
| wrangler.toml | `[environments.staging]` | removed | REMOVED STAGING |
| APP_ENV | `"personal-test"` | `"production"` | UPDATED |
| Staging-config test | 18 tests | removed | REMOVED |
| GitHub branches | `[main, staging]` | `[main]` | REMOVED STAGING |

### Staging Infrastructure Risks (S1–S3) Status

| Risk | Status | Reason |
|------|--------|--------|
| S1 — Staging secrets not configured | OBSOLETE | Staging removed; production secrets still needed |
| S2 — Staging/production share tenant | OBSOLETE | Staging removed; only production uses `opex_trial` |
| S3 — GitHub Environments not created | PENDING | `production` and `github-pages` environments still needed |

### New Production Risks (P1–P3)

#### P1 — Direct production deployment without staging

**Description:** With staging removed, there is no pre-production validation environment. Code changes go directly to production after CI passes and approval is granted.

**Current status:** Architectural decision

**Evidence:**
- `.github/workflows/deploy-worker.yml` — only `deploy-production` job
- `.github/workflows/deploy-pages.yml` — only `deploy-production` job
- No staging branch or staging Worker exists

**Mitigation:** CI serves as the primary validation gate. All tests must pass before merge. Production environment requires manual approval via GitHub environment protection rules.

**Remaining limitation:** No staging environment to catch integration issues before production. Rollback is the primary recovery mechanism.

**Production impact:** Medium. Issues found in production require rollback rather than staging fix-and-redeploy.

---

#### P2 — Production secrets not configured

**Description:** GitHub Actions secrets and variables required for production deployment are not configured.

**Current status:** NOT CONFIGURED

**Evidence:**
- `.github/workflows/deploy-worker.yml` references `${{ secrets.CLOUDFLARE_API_TOKEN }}` and `${{ vars.CLOUDFLARE_ACCOUNT_ID }}`
- `.github/workflows/deploy-pages.yml` references `${{ vars.VITE_API_BASE_URL }}`
- No values exist in GitHub repository Settings > Secrets and variables > Actions

**Mitigation:** Configure `CLOUDFLARE_API_TOKEN` as a secret and `CLOUDFLARE_ACCOUNT_ID`, `VITE_API_BASE_URL` as variables before first deployment.

**Remaining limitation:** Cannot deploy production Worker or frontend via CI/CD until credentials are configured.

**Production impact:** High. No automated deployment path exists.

---

#### P3 — GitHub Environments not created

**Description:** GitHub Environments (`production`, `github-pages`) are not created, so deployment approval gates cannot be enforced.

**Current status:** NOT CREATED

**Evidence:**
- `.github/workflows/deploy-worker.yml` references `environment: production`
- `.github/workflows/deploy-pages.yml` references `environment: github-pages`
- No environments exist in GitHub repository Settings > Environments

**Mitigation:** Create both environments in GitHub repository settings. Enable required reviewers for `production` and `github-pages`.

**Remaining limitation:** Without environments, deployment approval gates cannot be enforced.

**Production impact:** High. No environment-level access control for deployments.

---

## Updated Production Blockers

Same as Phase 9.6, 9.7, 9.8, and 9.9.1 plus:

21. GitHub Actions secrets (`CLOUDFLARE_API_TOKEN`) and variables
    (`CLOUDFLARE_ACCOUNT_ID`, `VITE_API_BASE_URL`) must be configured
    before any production deployment.
22. GitHub Environments (`production`, `github-pages`) must be created with
    approval rules before production deployment.
23. MyGeotab test tenant credentials must be obtained to validate production
    against the live API (R13, R14, R15).
24. R16 live validation requires authorized MyGeotab test tenant credentials
    to confirm throttling behavior and Retry-After support.

CI passing alone does NOT constitute production readiness.



