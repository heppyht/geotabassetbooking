# Rate-Limit Handling Design — OPEX Asset Booking

**Phase:** 9.9.1
**Status:** COMPLETE (implementation + automated tests)
**Live validation:** BLOCKED (no MyGeotab test tenant credentials)

---

## 1. Purpose

This document describes the rate-limit handling implementation for MyGeotab
AddInData API operations. It addresses risk R16 (no client-side rate-limit
handling) by providing:

- Centralized error classification for MyGeotab REST responses
- Exponential backoff retry with jitter for transient failures
- Write safety via idempotency keys and deterministic audit event IDs
- User-facing error messages that never expose credentials or internals

---

## 2. Audit Findings (Step 1)

Before implementation, the following was confirmed:

| Component | Finding |
|-----------|---------|
| `apps/api/src/db.ts` — `AddInDataRestGateway.jsonRpc()` | No retry, no 429 handling, no Retry-After parsing |
| `apps/api/src/integrations/mygeotab/adapter.ts` — `jsonRpc()` | Same — no retry |
| `apps/api/src/services/booking.ts` | All AddInData writes called once, no retry |
| `apps/web/src/data/addinDataService.ts` — `AddInDataGateway.call()` | Callback-based, no retry |
| `apps/web/src/data/addinDataProvider.ts` | No retry on `apiCall()` |
| `apps/web/src/serviceAddin.ts` | NotificationRateLimiter exists (6 calls/min) but only for notifications |
| `apps/api/test/rate-limit.test.mjs` | `fetchWithRetry` helper exists only in tests, not production |

**Confirmed gaps:**
- No client-side rate-limit throttling in production code
- No Retry-After header parsing in any gateway
- No automatic retry on HTTP 429
- Add operation (~100/min unverified) is the most restrictive limit
- No distinction between retryable (429, 5xx, network) and permanent (401, 403, 400, version conflict) errors

---

## 3. Error Classification (Step 2)

### Categories

| Category | Retryable? | Example |
|----------|-----------|---------|
| `rate_limit` | Yes | HTTP 429, "rate limit exceeded" |
| `temporary_network_failure` | Yes | HTTP 5xx, fetch/timeout errors |
| `network_timeout` | Yes | Fetch timeout |
| `authentication_failure` | No | HTTP 401 |
| `permission_error` | No | HTTP 403 |
| `validation_error` | No | HTTP 400, details exceeded |
| `concurrency_conflict` | No | Version conflict, invalid transition |
| `permanent_api_error` | No | Other permanent errors |
| `unknown` | No | Unrecognized errors |

### Classification Logic

Errors are classified by examining:
1. HTTP status code from `MYGEOTAB_HTTP_ERROR: <status>` messages
2. JSON-RPC error messages containing "rate limit", "throttl", "too many requests"
3. `Retry-After` header values parsed from error messages
4. Network/timeout keywords (fetch, network, timeout, ECONNREFUSED, ENOTFOUND)
5. Known application error codes (BOOKING_VERSION_CONFLICT, INVALID_TRANSITION, etc.)

More specific patterns are checked before generic ones (e.g., `INVALID_TRANSITION`
before `INVALID`).

### Limitation

Live MyGeotab throttling response format is UNVERIFIED. The classification handles
known signals (HTTP 429, Retry-After, common error messages) and is designed to
be extended once live tenant validation is available.

---

## 4. Retry Strategy (Step 3)

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `maxAttempts` | 3 | Maximum total attempts (initial + retries) |
| `initialDelayMs` | 500 | Initial delay before first retry |
| `backoffMultiplier` | 2 | Exponential backoff multiplier |
| `maxDelayMs` | 5000 | Maximum delay between retries |
| `maxTotalDurationMs` | 30000 | Maximum total time spent retrying |
| `jitter` | true | ±20% jitter on delays |

### Behavior

- **Server-provided Retry-After takes precedence** over exponential backoff
- **Non-retryable errors** throw immediately without retry
- **Retry exhaustion** throws the last classified error
- **Total duration limit** stops retries even if attempts remain
- **Read operations** (search, getDevices, getUsers, verifySession) are retried automatically via `createResilientGateway`
- **Write operations** (add, set, remove) are NOT retried at the gateway level — write safety depends on idempotency keys and version checks at the service layer

### Implementation

`apps/api/src/retry.ts` exports:
- `classifyError(error)` — returns a `ClassifiedError` with category, retryable flag, and optional retryAfterMs
- `withRetry(fn, config, onClassifiedError)` — executes a function with exponential backoff retry
- `DEFAULT_RETRY_CONFIG` — default retry configuration
- `sleep(ms)` — utility sleep function

---

## 5. Write Safety and Idempotency (Step 4)

### Problem

AddInData does not support transactions or atomic compare-and-set. Retrying a
write operation (Add/Set) after a transient failure could create duplicates or
overwrite newer data.

### Solution

#### Booking creation (`createBooking`)
- Idempotency key checked via `findBookingByIdempotency` before Add
- Same idempotency key returns existing booking without creating duplicate
- Safe to retry at the caller level with the same idempotency key

#### Audit writes (`approveBooking`, `rejectBooking`, `cancelBooking`, `assignApprovedBooking`)
- **Deterministic audit event IDs** via `generateAuditEventId(bookingId, action, actorUserId, previousStatus, newStatus)`
- Before adding an audit record, check `findAuditEventByBookingAndEventId` for existing event with same ID
- If found, skip Add and link to existing audit record
- Prevents duplicate audit records on retried operations

#### State transitions
- State transition validation (`isValidTransition`) prevents re-applying the same transition
- E.g., approving an already-approved booking returns `INVALID_TRANSITION`, not a duplicate
- Version-based optimistic concurrency on all booking updates (`BOOKING_VERSION_CONFLICT`)

#### Limitations
- AddInData provides NO atomic transactions or atomic compare-and-set
- Write safety depends on application-level idempotency, not storage-level guarantees
- If safe reconciliation cannot be established, a clear recoverable error is returned

---

## 6. Polling and Concurrency Protection (Step 5)

### API Layer

No polling operations exist in the Cloudflare Worker API. All operations are
request-driven. Retry protection is provided by:
- `createResilientGateway` for read operations (idempotent, safe to retry)
- Write safety via idempotency keys and deterministic audit IDs (Step 4)

### Frontend Layer (`apps/web/src/serviceAddin.ts`)

`NotificationRateLimiter` already exists:
- Maximum 6 notification calls per rolling minute
- Maximum 2 visible notifications at a time

No changes needed — this is application-level rate limiting for notifications,
not AddInData operations.

### Multi-Instance Consideration

No external distributed lock is introduced (per architecture constraints: no
Redis, no Cloudflare KV, no external database). Multiple independent application
instances do not share in-memory locks. This is acceptable because:
- AddInData operations are per-database (tenant-scoped)
- Write safety is provided by idempotency keys and version checks
- Read operations are inherently safe to retry

---

## 7. User-Facing Error Handling (Step 6)

`apps/api/src/index.ts` — `errorResponse` now uses `classifyError` to map errors
to user-friendly messages:

| Category | User-Facing Message |
|----------|--------------------|
| `rate_limit` | "MyGeotab is temporarily busy. Please try again shortly." |
| `temporary_network_failure` | "Unable to connect to MyGeotab. Please check your connection and retry." |
| `network_timeout` | "The request timed out. Please try again." |
| `authentication_failure` | "Your MyGeotab session has expired. Please sign in again." |
| `permission_error` | "You do not have permission to perform this action." |
| `validation_error` | "Invalid request. Please check your input and try again." |
| `concurrency_conflict` | "The booking was modified by another request. Please refresh and try again." |
| `permanent_api_error` / `unknown` | Default message (e.g., "BOOKING_CREATE_FAILED") |

Security: Error `detail` field is only included when `APP_ENV === "development"`.
No credentials, session IDs, stack traces, or raw payloads are exposed.

---

## 8. Files Created or Modified

### Created

| File | Purpose |
|------|---------|
| `apps/api/src/retry.ts` | Error classification, retry strategy, resilient gateway wrapper |
| `apps/api/test/rate-limit-handling.test.mjs` | 28 tests covering classification, retry, write safety |
| `docs/technical/rate-limit-handling-design.md` | This document |
| `docs/phase-9.9.1-rate-limit-handling-report.md` | Phase final report |

### Modified

| File | Change |
|------|--------|
| `apps/api/src/db.ts` | Added `createResilientGateway()` factory; made `jsonRpc` and `addInId` public; added retry for read methods |
| `apps/api/src/index.ts` | Use `createResilientGateway`; added user-facing error mapping via `classifyError`; error detail hidden in production |
| `apps/api/src/services/booking.ts` | Added `generateAuditEventId()`; deterministic audit event IDs for approve/reject/cancel/assign; idempotent audit writes via `findAuditEventByBookingAndEventId` check before Add |

---

## 9. Test Results

| Check | Result |
|-------|--------|
| API TypeScript check | Clean |
| API tests (before) | 206 pass, 0 fail |
| API tests (after) | 234 pass, 0 fail (+28 new) |
| Web TypeScript check | Clean |
| Web tests | 155 pass, 0 fail (unchanged) |
| Web production build | Successful |

### New Test Coverage (28 tests)

**Error Classification (10 tests):**
- HTTP 429 → rate_limit, retryable
- HTTP 500 → temporary_network_failure, retryable
- HTTP 401 → authentication_failure, not retryable
- HTTP 403 → permission_error, not retryable
- HTTP 400 → validation_error, not retryable
- BOOKING_VERSION_CONFLICT → concurrency_conflict, not retryable
- INVALID_TRANSITION → concurrency_conflict, not retryable
- ADDIN_DATA_DETAILS_EXCEEDED → validation_error, not retryable
- Network/timeout → temporary_network_failure, retryable
- Unknown → not retryable
- Retry-After parsing from message

**Retry Behavior (8 tests):**
- Successful first attempt
- Successful retry after transient failure
- Retry exhaustion after maxAttempts
- Non-retryable errors not retried
- maxTotalDurationMs limit
- Exponential delay progression
- Jitter

**Write Safety (8 tests):**
- generateAuditEventId is deterministic
- Different actions produce different eventIds
- createBooking idempotent via idempotency key
- Audit idempotency via deterministic eventId (approve, reject, cancel)
- assignApprovedBooking idempotent via idempotency key
- Version conflict check exists in booking service
- Failed write reported accurately

**Gateway Retry (1 test):**
- searchAddInData retries on transient failure

---

## 10. Remaining Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| Live MyGeotab throttling behavior UNVERIFIED | Error classification may not match actual API responses | Classification is extensible; requires live tenant validation (R16 partially resolved) |
| Write operations not auto-retried at gateway level | Callers must handle write retries with idempotency keys | Idempotency keys + deterministic audit IDs provide write safety at service layer |
| No client-side request throttling (preemptive rate limiting) | Could still hit rate limits under high load | Retry with backoff handles 429 responses; rate limits unverified |
| Version conflict check is defensive only | Cannot be unit-tested in single-threaded execution | Verified by code inspection; existing integrity tests verify version increment |
| AddInData has no atomic transactions | Partial failures can leave inconsistent state | Audit gap detection (`findAuditGaps()`) identifies missing audit events |

---

## 11. R16 Status

**R16: PARTIALLY RESOLVED**

- **Resolved:** Client-side retry with exponential backoff + jitter, error classification distinguishing retryable vs non-retryable errors, write safety via idempotency keys and deterministic audit event IDs, user-facing error messages
- **Not resolved (pending live validation):** Live MyGeotab throttling behavior, actual rate-limit thresholds, Retry-After header support from live API

Live MyGeotab validation is required to fully resolve R16.
