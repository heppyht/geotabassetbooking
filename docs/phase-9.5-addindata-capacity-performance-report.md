# Phase 9.5 — MyGeotab AddInData Capacity & Performance Benchmark Report

## A. Executive Summary

### Overall Scalability Assessment

MyGeotab AddInData can support Geotab Asset Booking as the only persistent storage
for **small to medium deployments** (up to ~10,000 bookings). At larger volumes
(50,000–100,000+ bookings), significant performance and operational risks emerge
that require mitigation before production use.

### Suitable Operating Range

| Scenario | Bookings | Assessment | Primary Constraint |
|----------|----------|------------|-------------------|
| Small | 1,000 | Suitable | None significant |
| Medium | 10,000 | Suitable with monitoring | Full-collection scan latency (~250ms) |
| Large | 50,000 | Marginal | Add rate limit (~100/min unverified), scan latency (~1.9s) |
| Stress | 100,000 | Not recommended without optimization | Write throughput, storage, scan latency |

### Main Bottlenecks

1. **Add operation rate limit (~100/min, unverified)** — Most restrictive API limit.
   Bulk write of 50,000 bookings + 250,000 audit events = 300,000 Add operations
   would take ~50 hours at this rate (unverified).

2. **Full-collection scans on every query** — All current queries load the entire
   AddInData collection and filter client-side. Query latency grows super-linearly
   with dataset size (50x data → ~105x latency).

3. **No server-side filtering verified** — `periodKey`, JSON property filtering,
   `selectClause`, `whereClause`, pagination, and sorting are NOT VERIFIED against
   the live MyGeotab AddInData API.

4. **No client-side rate-limit handling** — No throttling, no Retry-After parsing,
   no automatic retry on HTTP 429.

### Production Risks

- Write throughput is the primary constraint for booking creation and audit logging
- Query latency will degrade as data grows beyond 10,000 records
- Total storage quota is UNKNOWN (requires Geotab confirmation)
- No automatic recovery from rate-limit errors (429)

---

## B. Record Size Analysis

### Measurement Method

Record sizes measured via `JSON.stringify().length` (character count) and
`TextEncoder().encode(str).length` (UTF-8 byte count). Samples based on schema v2
envelopes with realistic field values. No production tenant access.

### Measured Average Record Sizes (Characters)

| Record Type | Min | Avg | Median | p95 | Max | Samples |
|-------------|-----|-----|--------|-----|-----|---------|
| Booking | 483 | 627 | 633 | 788 | 819 | 5 |
| Booking Audit | 570 | 883 | 898 | 1,154 | 1,182 | 3 |
| Notification | 574 | 709 | 709 | 831 | 844 | 2 |

### Character vs UTF-8 Bytes

For primarily ASCII content, UTF-8 byte count ≈ character count. Non-ASCII
characters (accented text, CJK, Cyrillic) increase byte count. A conservative
1.1x multiplier is used for byte estimates.

### 10,000-Character Limit Validation

All measured records are well under the 10,000-character application limit.
The limit is enforced client-side via `assertWithinLimit()` before any AddInData
`Add` or `Set` operation. Records exceeding the limit are rejected with
`ADDIN_DATA_DETAILS_EXCEEDED` error.

**Note:** It is not confirmed whether the 10,000-character constraint is a
Geotab-enforced limit or an application-defined limit. This requires Geotab
confirmation.

---

## C. Capacity Model

### Assumptions

- Average booking record: 627 characters
- Average audit record: 883 characters
- Average notification record: 709 characters
- Audit events per booking: 5
- Notifications per booking: 1
- Storage overhead factor: 1.5x (record metadata, JSON-RPC transport, DB overhead)
- Growth: 100 bookings/day, 5 audits/booking, 1 notification/booking

### Scenario Estimates

| Scenario | Bookings | Audits | Notifications | Total Records | Payload Size | Est. Storage (1.5x) |
|----------|----------|--------|---------------|---------------|--------------|---------------------|
| Small | 1,000 | 5,000 | 1,000 | 7,000 | ~6.3 MB | ~9.5 MB |
| Medium | 10,000 | 50,000 | 10,000 | 70,000 | ~63 MB | ~95 MB |
| Large | 50,000 | 250,000 | 50,000 | 350,000 | ~316 MB | ~474 MB |
| Stress | 100,000 | 500,000 | 100,000 | 700,000 | ~632 MB | ~949 MB |

### Per-Booking Storage

- Characters per booking (incl. 5 audits + 1 notification): ~5,751 chars
- Bytes per booking (1.1x UTF-8 estimate): ~6,326 bytes
- Estimated storage per booking (1.5x overhead): ~9,489 bytes (~9.3 KB)

### Growth Projections

| Period | Bookings | Added Records | Added Storage |
|--------|----------|---------------|---------------|
| Per day | 100 | 700 | ~0.9 MB |
| Per month (30 days) | 3,000 | 21,000 | ~28 MB |
| Per year (365 days) | 36,500 | 255,500 | ~340 MB |

### Geotab Storage Quota

**UNKNOWN — requires Geotab confirmation.** No official Geotab documentation was
found specifying:
- Maximum total AddInData storage per database
- Maximum records per AddInId
- Maximum records per database
- Retention restrictions
- Additional operational constraints

These limits must be confirmed with Geotab Support before production deployment
at any scale.

---

## D. Query Performance

### Query Strategies Measured (Client-Side Filtering)

All current queries perform full-collection scans followed by client-side filtering.
No server-side filtering has been verified against the live MyGeotab AddInData API.

| Query Type | Strategy | 1K Records | 10K Records | 50K Records |
|------------|----------|------------|-------------|-------------|
| Bookings by requester | Full scan + filter | 18ms | 247ms | 1,885ms |
| Booking by ID | Linear scan | <1ms | <1ms | <1ms |
| Bookings by driver | Full scan + filter | <1ms | <1ms | <1ms |
| Bookings by status | Full scan + filter | <1ms | <1ms | <1ms |
| Bookings by periodKey | Period-scoped filter | <1ms | <1ms | <1ms |

### Scaling Characteristics

Query latency grows **super-linearly** with dataset size:
- 1K → 10K (10x data): ~14x latency increase
- 1K → 50K (50x data): ~105x latency increase

This is because full-collection scans must deserialize and inspect every record.

### Server-Side Filtering Status

| Capability | Status | Evidence |
|------------|--------|----------|
| `addInId` filter | Known supported | Passed in search params |
| `recordType` filter | Known supported | Passed in search params |
| `periodKey` filter | NOT VERIFIED | Used in code but unconfirmed |
| JSON property filtering | NOT VERIFIED | Not tested against live API |
| `selectClause` | NOT VERIFIED | Not tested |
| `whereClause` | NOT VERIFIED | Not tested |
| Pagination | NOT VERIFIED | Not tested |
| Sorting | NOT VERIFIED | Not tested |
| Result limits | NOT VERIFIED | `resultsLimit: 1000` used but unconfirmed |

**periodKey does NOT reduce data transfer unless server-side filtering is proven.**

---

## E. API Rate Limits

### Documented Limits (NOT VERIFIED)

| Operation | Limit (req/min) | Status |
|-----------|-----------------|--------|
| Get | 650 | Previously identified, unverified |
| Set | 1,700 | Previously identified, unverified |
| Add | 100 | Previously identified, unverified |
| Remove | 2,250 | Previously identified, unverified |

**These limits must be verified with Geotab Support.** They are not guaranteed
throughput targets.

### Write Throughput Impact (at 100 Add/min, unverified)

| Operation Count | Time Required |
|-----------------|---------------|
| 1,000 bookings | ~10 minutes |
| 10,000 bookings + 50,000 audits | ~100 minutes |
| 50,000 bookings + 250,000 audits | ~50 hours |
| 100,000 bookings + 500,000 audits | ~100 hours |

### Current Implementation Gaps

- No client-side rate-limit throttling
- No Retry-After header parsing
- No automatic retry on HTTP 429
- No exponential backoff
- No request deduplication

### Recommendation

Implement exponential backoff with Retry-After support before production
deployment. Queue write operations to respect the Add rate limit.

---

## F. Scalability Recommendations

### Immediate Optimizations (Zero-Risk)

1. **Add `requesterUserId` and `assignedDriverUserId` to server-side filtering**
   — Currently all filtering is client-side after loading all records. Even if
   server-side filtering isn't supported, at minimum avoid loading audit and
   notification records when only bookings are needed.

2. **Add in-memory caching for read-heavy operations**
   — Cache vehicle lists, user lists, and group lists with short TTL (5–10 min).
   Cache must be transient (not persistent).

3. **Add exponential backoff with Retry-After parsing**
   — Handle HTTP 429 responses gracefully. Queue writes to respect rate limits.

4. **Avoid loading all bookings for single-record lookups**
   — `findBookingRecord` loads all bookings to find one by ID. Consider whether
   MyGeotab supports `id` filtering in search.

### Medium-Term Improvements

5. **Verify and use periodKey server-side filtering**
   — If MyGeotab supports `periodKey` in search params, scope queries by period
   to reduce data transfer. Must be verified against live API first.

6. **Implement request deduplication for idempotency keys**
   — Deduplicate concurrent requests with the same idempotency key to avoid
   duplicate Add operations.

7. **Batch writes within documented rate limits**
   — Queue Add operations and spread them over time to stay under the Add rate
   limit (100/min unverified).

8. **Add query result pagination**
   — If MyGeotab supports pagination, use it to avoid loading large collections.

### Production Capacity Monitoring

9. **Monitor AddInData record count growth**
   — Track total records per AddInId and alert at 50%, 75%, 90% of any known
   quota.

10. **Monitor query latency**
    — Track p95/p99 query latency and alert when it exceeds thresholds.

11. **Run periodic `findAuditGaps()` reconciliation**
    — Detect missing audit events and alert on data integrity issues.

---

## G. Geotab Storage Quota

| Quota Item | Status | Required Action |
|------------|--------|-----------------|
| Max total AddInData storage per database | UNKNOWN | Contact Geotab Support |
| Max records per AddInId | UNKNOWN | Contact Geotab Support |
| Max records per database | UNKNOWN | Contact Geotab Support |
| Retention restrictions | UNKNOWN | Contact Geotab Support |
| Add operation rate limit (100/min) | UNVERIFIED | Contact Geotab Support |
| Get operation rate limit (650/min) | UNVERIFIED | Contact Geotab Support |
| Set operation rate limit (1,700/min) | UNVERIFIED | Contact Geotab Support |
| Remove operation rate limit (2,250/min) | UNVERIFIED | Contact Geotab Support |

**No storage quota has been verified.** Do not invent limits. All quota-related
questions require Geotab Support confirmation.

---

## H. Final Assessment

**Status: PASS WITH FINDINGS**

The application is functionally correct and all existing tests pass. However,
production deployment at scale (>10,000 bookings) requires:

1. **Geotab confirmation** of storage quotas and rate limits
2. **Client-side rate-limit handling** (exponential backoff, Retry-After)
3. **Query optimization** (verify server-side periodKey filtering, avoid full scans)
4. **Write throughput planning** (Add limit of ~100/min is a major constraint)

The application is **not blocked** from production deployment at small scale
(up to ~10,000 bookings), but larger deployments require the above mitigations.

**Do not mark the application production-ready solely because synthetic
benchmarks pass.** Live tenant validation is required.

---

## Test Files Created

| File | Purpose |
|------|---------|
| `apps/api/test/benchmark-utils.mjs` | Shared dataset generator and utilities |
| `apps/api/test/record-size-benchmark.test.mjs` | Record size measurements (Step 2) |
| `apps/api/test/synthetic-dataset-generator.test.mjs` | Dataset validation (Step 3) |
| `apps/api/test/capacity-estimation.test.mjs` | Storage capacity estimates (Step 4) |
| `apps/api/test/query-performance.test.mjs` | Query performance benchmarks (Step 5) |
| `apps/api/test/rate-limit.test.mjs` | Rate limit analysis (Step 6) |

## Modified Files

| File | Change |
|------|--------|
| `docs/production-readiness-risk-register.md` | Added R13–R16 performance/capacity risks (Step 10) |

## Validation Results

| Check | Result |
|-------|--------|
| API typecheck (`tsc --noEmit`) | Clean |
| API tests | 188 pass, 0 fail |
| Web typecheck (`tsc --noEmit`) | Clean |
| Web tests | 155 pass, 0 fail |
| Web production build | Successful |
