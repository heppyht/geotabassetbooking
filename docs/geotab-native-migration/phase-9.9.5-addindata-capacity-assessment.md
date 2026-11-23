# Phase 9.9.5 — AddInData Capacity Assessment

**Status:** COMPLETE (code-level verification); LIVE VALIDATION BLOCKED
**Date:** 2026-11-23
**Branch:** `main`

---

## 1. Purpose

This document assesses the AddInData capacity and performance characteristics of
the OPEX Asset Booking application. All code-level constraints are verified, but
live MyGeotab quotas, rate limits, and performance characteristics require
authorized test tenant access.

---

## 2. Record-Size Constraint

### 2.1 Implementation

**File:** `apps/web/src/repositories/addinData/addinDataRepository.ts:63-69`
```typescript
function serializeEnvelope<T>(data: T, recordType: string): string {
  const envelope: AddInDataEnvelope<T> = { recordType, schemaVersion: 2, data };
  const json = JSON.stringify(envelope);
  if (json.length > MAX_DETAILS_CHARS) {
    throw new Error(`ADDIN_DATA_DETAILS_EXCEEDED: ${json.length} chars (max ${MAX_DETAILS_CHARS})`);
  }
  return json;
}
```

**File:** `apps/web/src/data/addinDataService.ts:73-78`
```typescript
function assertWithinLimit(value: unknown, label: string): void {
  const json = toJsonString(value);
  if (json.length > MAX_DETAILS_CHARS) {
    throw new Error(`ADDIN_DATA_DETAILS_EXCEEDED: ${label} = ${json.length} chars (max ${MAX_DETAILS_CHARS})`);
  }
}
```

### 2.2 Status: PASS

- `MAX_DETAILS_CHARS = 10000` enforced at the serialization boundary
- Single `JSON.stringify` — no double-serialization
- Envelope format: `{ recordType, schemaVersion: 2, data }`
- Applied to booking, audit, and notification records

### 2.3 Estimated Record Capacity

| Record Type | Estimated Size | Max Records per 1 MB |
|-------------|---------------|---------------------|
| Booking | ~500 bytes | ~2,000 |
| Audit event | ~300 bytes | ~3,300 |
| Notification | ~400 bytes | ~2,500 |

**Note:** These are estimates based on the schema structure. Actual sizes depend
on field values. Live verification required against MyGeotab AddInData API.

---

## 3. PeriodKey Partitioning

### 3.1 Implementation

**File:** `apps/web/src/data/addinDataService.ts:241-247`
```typescript
export function periodKeyFromIso(isoUtc: string): PeriodKey {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
```

**File:** `apps/web/src/data/types.ts`
- `makePeriodKey()` helper
- `PeriodKey` type = `string` in YYYY-MM format

### 3.2 Usage

| Operation | Uses periodKey? | Server-side filter? |
|-----------|----------------|---------------------|
| `getBookingsByPeriod()` | Yes | Unverified (claimed in code) |
| `getAllBookings()` | No (full scan) | N/A |
| `getBooking()` | No (scan by recordType) | N/A |
| `readAuditHistory()` | No (scan by recordType) | N/A |
| `getAuditEventsByPeriod()` | Yes | Unverified |
| `findAuditGaps()` | No (full scan of all bookings) | N/A |

### 3.3 Status: CODE VERIFIED, LIVE UNVERIFIED

periodKey partitioning is implemented in code. Server-side filtering support
for periodKey is claimed but NOT verified against the live MyGeotab AddInData API.

---

## 4. Full-Collection Scan Performance

### 4.1 Operations Using Full-Collection Scans

| Operation | Method | Scan Scope | Concern |
|-----------|--------|------------|---------|
| `getAllBookings()` | `search("AddInData", { addInId, recordType: "booking" })` | All booking records | Grows linearly with booking count |
| `getBooking(bookingId)` | `search("AddInData", { addInId, recordType: "booking" })` + linear scan | All booking records | O(n) lookup |
| `updateBookingStatus()` | `getBooking()` + `set()` | All booking records | O(n) read + write |
| `findBookingByIdempotency()` | `search("AddInData", { addInId, recordType: "booking" })` | All booking records | O(n) scan |
| `readAuditHistory(bookingId)` | `search("AddInData", { addInId, recordType: "booking_audit" })` | All audit records | O(n) scan |
| `findAuditEventByEventId()` | `search("AddInData", { addInId, recordType: "booking_audit" })` | All audit records | O(n) scan |
| `findAuditGaps()` | `listAllBookings()` + per-booking audit check | All bookings + all audits | O(n²) worst case |
| `createNotification()` | `search("AddInData", { addInId, recordType: "notification" })` | All notification records | O(n) idempotency check |
| `updateNotificationDeliveryStatus()` | `search("AddInData", { addInId, recordType: "notification" })` | All notification records | O(n) scan |
| `listPendingNotifications()` | `search("AddInData", { addInId, recordType: "notification" })` | All notification records | O(n) scan |

### 4.2 Status: NOT VERIFIED

Full-collection scans are implemented because MyGeotab AddInData search API
supports `addInId` equality and `typeName` filter, but server-side `periodKey`
filtering is unverified. Performance degradation is expected as record counts
grow. Live performance testing required.

### 4.3 Questions for Geotab Support

1. Does AddInData search support server-side filtering beyond `addInId` and `typeName`?
2. What is the maximum number of records returned per search call?
3. Is there a `resultsLimit` parameter for AddInData search?
4. Does `resultsLimit` limit server-side scanning or just client-side results?

---

## 5. Read/Write Operation Volume

### 5.1 Operation Types

| Operation | AddInData API Call | Frequency Pattern |
|-----------|-------------------|-------------------|
| Booking creation | `Add` | On demand (user action) |
| Booking update | `Set` | On demand (user action) |
| Booking retrieval | `Get` | On page load + on state change |
| Audit event creation | `Add` | On every state transition |
| Notification creation | `Add` | On state transitions |
| Notification delivery | `Set` | On service poll (30-second interval) |
| Master data load | `Get` (Device, User) | On page load |

### 5.2 Rate-Limit Handling

**Client-side (Service Add-In):**
- `NotificationRateLimiter` — 6 calls per rolling minute, 2 visible max
- 30-second polling interval
- Max 10 notifications per poll

**Client-side (Retry):**
- `apps/api/src/retry.ts` — exponential backoff with jitter (Worker path, not used by frontend)

**Server-side:** UNKNOWN — requires Geotab confirmation

### 5.3 Status: PARTIAL

Client-side rate limiting is implemented for notifications. Retry logic exists
in the Worker code path (not used by frontend). Server-side rate limits are
UNVERIFIED.

---

## 6. Storage Quota

### 6.1 Current Status: UNKNOWN

| Item | Value | Source |
|------|-------|--------|
| Maximum storage per database | UNKNOWN | Requires Geotab Support |
| Maximum records per AddInId | UNKNOWN | Requires Geotab Support |
| Retention policy | UNKNOWN | Requires Geotab Support |
| AddInData API rate limit | UNKNOWN | Requires Geotab Support |

### 6.2 Questions for Geotab Support

| # | Question |
|---|----------|
| 1 | What is the AddInData storage quota per database (e.g., opex_trial)? |
| 2 | What is the maximum number of AddInData records per AddInId? |
| 3 | What is the AddInData write throughput limit (operations/minute)? |
| 4 | Does AddInData search support server-side `periodKey` filtering? |
| 5 | What is the AddInData API rate limit (requests/minute)? |
| 6 | Is there a retention policy for AddInData records? |
| 7 | Are there per-AddInId or per-database request quotas? |

---

## 7. Capacity Risks

| Risk | Severity | Mitigation | Residual Risk |
|------|----------|------------|---------------|
| Storage quota exhaustion | High | Monitor record count; archive old bookings | UNKNOWN until quota confirmed |
| Full-collection scan degradation | Medium | Use periodKey partitioning where supported | Performance unverified at scale |
| Rate-limit exhaustion | Medium | Client-side rate limiter (6 calls/min) | Server limits unverified |
| Record size exceeded | Low | 10 KB enforcement at serialization boundary | LOW — enforced in code |
| Audit growth | Medium | Append-only audit grows unbounded | Archive/retention policy needed |

---

## 8. Summary

| Item | Status |
|------|--------|
| 10 KB record-size constraint | PASS (enforced in code) |
| periodKey partitioning | CODE VERIFIED, LIVE UNVERIFIED |
| Full-collection scan performance | NOT VERIFIED |
| Read/write operation volume | NOT VERIFIED |
| API rate-limit handling | PARTIAL (client-side only) |
| Storage quota | UNKNOWN (requires Geotab Support) |

**Overall Capacity Status: CONDITIONAL** — Code-level constraints verified,
but live capacity characteristics (quota, rate limits, scan performance)
require authorized test tenant access and Geotab Support confirmation.
