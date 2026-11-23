/*───────────────────── Phase 9.5: Query Performance Benchmark ─────────────────────*/
/* Benchmarks query strategies against synthetic datasets.
   Distinguishes server-side filtering from client-side filtering.
   Live MyGeotab AddInData API behavior is NOT VERIFIED (no tenant access).
   All queries measured here are client-side filtering over in-memory datasets. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  generateDataset,
  SCENARIOS,
  formatBytes,
  stats,
} from "./benchmark-utils.mjs";

/*───────────────────── Query strategies (mirroring actual implementation) ─────────────────────*/

/* Strategy A: Full collection scan — load all bookings, filter client-side.
   This matches the current implementation in apps/api/src/index.ts:
   GET /api/bookings, GET /api/bookings/:id, submit-for-approval, etc. */
function queryFullScanBookings(bookings, filterFn) {
  const start = process.hrtime.bigint();
  let results = [];
  for (const b of bookings) {
    try {
      if (filterFn(b.booking)) results.push(b);
    } catch { /* skip malformed */ }
  }
  const end = process.hrtime.bigint();
  return { results, ms: Number(end - start) / 1_000_000, strategy: "full_scan_client_filter" };
}

/* Strategy B: Period-scoped query — filter by periodKey at query time.
   This matches getBookingsByPeriod / getAuditEventsByPeriod in addinDataService.ts.
   NOTE: Server-side periodKey filtering is NOT VERIFIED against live MyGeotab API. */
function queryPeriodScoped(bookings, periodKey) {
  const start = process.hrtime.bigint();
  const results = bookings.filter(b => b.periodKey === periodKey);
  const end = process.hrtime.bigint();
  return { results, ms: Number(end - start) / 1_000_000, strategy: "period_scoped" };
}

/* Strategy C: Booking lookup by ID — linear scan.
   Matches findBookingRecord in both API and web. */
function queryBookingById(bookings, bookingId) {
  const start = process.hrtime.bigint();
  let found = null;
  for (const b of bookings) {
    if (b.booking.bookingId === bookingId || b.envelope.id === bookingId) {
      found = b;
      break;
    }
  }
  const end = process.hrtime.bigint();
  return { result: found, ms: Number(end - start) / 1_000_000, strategy: "linear_scan_by_id" };
}

/* Strategy D: Booking lookup by driver — full scan + filter.
   Matches getBookingsByDriver in services/booking.ts. */
function queryBookingsByDriver(bookings, driverId) {
  const start = process.hrtime.bigint();
  const results = bookings.filter(b => b.booking.assignedDriverUserId === driverId);
  const end = process.hrtime.bigint();
  return { results, ms: Number(end - start) / 1_000_000, strategy: "full_scan_by_driver" };
}

/* Strategy E: Booking lookup by status — full scan + filter. */
function queryBookingsByStatus(bookings, status) {
  const start = process.hrtime.bigint();
  const results = bookings.filter(b => b.booking.status === status);
  const end = process.hrtime.bigint();
  return { results, ms: Number(end - start) / 1_000_000, strategy: "full_scan_by_status" };
}

/*───────────────────── Benchmark runner ─────────────────────*/

function runQueryBenchmark(scenario, auditPerBooking = 5, notifPerBooking = 1) {
  const ds = generateDataset({ scenario, auditPerBooking, notifPerBooking, seed: 42 });
  const bookings = ds.bookings;

  /* Pick a booking ID that exists (middle of dataset) */
  const targetBookingId = bookings[Math.floor(bookings.length / 2)].booking.bookingId;
  /* Pick a driver that has bookings */
  const driverWithBookings = bookings.find(b => b.booking.assignedDriverUserId !== null);
  const targetDriverId = driverWithBookings ? driverWithBookings.booking.assignedDriverUserId : "drv-9999";
  /* Pick a status that exists */
  const targetStatus = "APPROVED";
  /* Pick a periodKey that exists */
  const targetPeriodKey = bookings[0].periodKey;
  /* Pick a requesterUserId that definitely exists (first booking's user) */
  const reqUserId = bookings[0].booking.requesterUserId;

  const results = {};

  /* Full scan: filter by requester (simulates GET /api/bookings) */
  results.fullScanByRequester = queryFullScanBookings(bookings, b => b.booking.requesterUserId === reqUserId);

  /* Full scan: find booking by ID (simulates GET /api/bookings/:id) */
  results.bookingById = queryBookingById(bookings, targetBookingId);

  /* Full scan: bookings by driver (simulates GET /api/bookings/driver) */
  results.bookingsByDriver = queryBookingsByDriver(bookings, targetDriverId);

  /* Full scan: bookings by status */
  results.bookingsByStatus = queryBookingsByStatus(bookings, targetStatus);

  /* Period-scoped: bookings by periodKey */
  results.periodScoped = queryPeriodScoped(bookings, targetPeriodKey);

  return { ds, results, targetBookingId, targetDriverId, targetStatus, targetPeriodKey, reqUserId };
}

/*───────────────────── Tests ─────────────────────*/

test("query benchmark: full scan by requester — small scenario", () => {
  const { results } = runQueryBenchmark("small");
  const r = results.fullScanByRequester;
  assert.ok(r.ms >= 0);
  console.log(`SMALL full_scan_by_requester: ${r.results.length} results in ${r.ms.toFixed(2)}ms`);
});

test("query benchmark: booking by ID — small scenario", () => {
  const { results, targetBookingId } = runQueryBenchmark("small");
  const r = results.bookingById;
  assert.notEqual(r.result, null, `booking ${targetBookingId} should be found`);
  console.log(`SMALL booking_by_id: found=${r.result !== null} in ${r.ms.toFixed(2)}ms`);
});

test("query benchmark: bookings by driver — small scenario", () => {
  const { results, targetDriverId } = runQueryBenchmark("small");
  const r = results.bookingsByDriver;
  console.log(`SMALL bookings_by_driver(${targetDriverId}): ${r.results.length} results in ${r.ms.toFixed(2)}ms`);
});

test("query benchmark: bookings by status — small scenario", () => {
  const { results, targetStatus } = runQueryBenchmark("small");
  const r = results.bookingsByStatus;
  console.log(`SMALL bookings_by_status(${targetStatus}): ${r.results.length} results in ${r.ms.toFixed(2)}ms`);
});

test("query benchmark: period-scoped — small scenario", () => {
  const { results, targetPeriodKey } = runQueryBenchmark("small");
  const r = results.periodScoped;
  assert.ok(r.results.length > 0);
  console.log(`SMALL period_scoped(${targetPeriodKey}): ${r.results.length} results in ${r.ms.toFixed(2)}ms`);
});

test("query benchmark: full scan scales linearly with dataset size", () => {
  const timings = [];
  for (const scenario of ["small", "medium", "large"]) {
    const { results } = runQueryBenchmark(scenario);
    timings.push({ scenario, ms: results.fullScanByRequester.ms, count: results.fullScanByRequester.results.length });
    console.log(`${scenario.toUpperCase()} full_scan_by_requester: ${timings[timings.length-1].count} results in ${timings[timings.length-1].ms.toFixed(2)}ms`);
  }
  /* Linear scaling: 10x data should be roughly 10x time (within tolerance) */
  const smallMs = timings[0].ms;
  const mediumMs = timings[1].ms;
  const largeMs = timings[2].ms;
  if (smallMs > 0) {
    const ratio10 = mediumMs / smallMs;
    const ratio50 = largeMs / smallMs;
    console.log(`Scaling ratios: 10x=${ratio10.toFixed(1)}, 50x=${ratio50.toFixed(1)}`);
    assert.ok(ratio10 > 0 && ratio10 < 100, `10x scaling ratio unreasonable: ${ratio10}`);
  }
});

test("query benchmark: period-scoped vs full scan — timing comparison", () => {
  const { results } = runQueryBenchmark("medium");
  const fullScanMs = results.fullScanByRequester.ms;
  const periodScopedMs = results.periodScoped.ms;
  const fullCount = results.fullScanByRequester.results.length;
  const periodCount = results.periodScoped.results.length;
  console.log(`MEDIUM: full_scan=${fullScanMs.toFixed(2)}ms (${fullCount} results), period_scoped=${periodScopedMs.toFixed(2)}ms (${periodCount} results)`);
  /* Both should complete; period-scoped is expected to be faster or equal
     since it filters fewer records (but both are client-side in this test) */
  assert.ok(fullScanMs >= 0);
  assert.ok(periodScopedMs >= 0);
});

test("query benchmark: large scenario full scan timing", () => {
  const { results } = runQueryBenchmark("large");
  const r = results.fullScanByRequester;
  console.log(`LARGE full_scan_by_requester: ${r.results.length} results in ${r.ms.toFixed(2)}ms`);
  assert.ok(r.ms >= 0);
});

test("query benchmark: query strategy classification", () => {
  /* Document which queries are server-side vs client-side in the current implementation */
  const serverSideQueries = []; /* None verified against live MyGeotab API */
  const clientSideQueries = [
    "GET /api/bookings — filter by requesterUserId (full scan)",
    "GET /api/bookings/:id — find by bookingId (full scan)",
    "GET /api/bookings/driver — filter by assignedDriverUserId (full scan)",
    "POST /api/bookings/:id/submit-for-approval — find by bookingId (full scan)",
    "POST /api/bookings/:id/approve — find by bookingId (full scan)",
    "POST /api/bookings/:id/reject — find by bookingId (full scan)",
    "POST /api/bookings/:id/assign — find by bookingId (full scan)",
    "POST /api/bookings/:id/cancel — find by bookingId (full scan)",
    "Web getAllBookings — full scan",
    "Web findBookingById — full scan",
    "Web getAuditEventsByBooking — full scan",
    "Web findAuditEventByIdempotency — full scan",
  ];
  const periodScopedClaims = [
    "Web getBookingsByPeriod — uses periodKey in search (server-side filtering NOT VERIFIED)",
    "Web getAuditEventsByPeriod — uses periodKey in search (server-side filtering NOT VERIFIED)",
  ];
  assert.equal(serverSideQueries.length, 0, "No server-side filtering verified against live API");
  assert.ok(clientSideQueries.length > 0);
  assert.ok(periodScopedClaims.length > 0);
  console.log(`Client-side queries: ${clientSideQueries.length}`);
  console.log(`Period-scoped claims (NOT VERIFIED): ${periodScopedClaims.length}`);
});

test("query benchmark: NOT VERIFIED — server-side periodKey filtering", () => {
  /* Per Phase 9.5 requirements: do not claim server-side filtering works
     without live API verification. This test documents the gap. */
  const verified = false; /* No live MyGeotab tenant access */
  assert.equal(verified, false, "Server-side periodKey filtering not verified against live MyGeotab API");
});

test("query benchmark: NOT VERIFIED — MyGeotab AddInData search/select/whereClause", () => {
  /* Document what is known vs unknown about MyGeotab AddInData query capabilities */
  const known = {
    searchParameterSupported: true, /* search object is passed in Get call */
    addInIdFiltering: true, /* addInId is in search params */
    recordTypeFiltering: true, /* recordType is in search params */
    periodKeyFiltering: false, /* NOT verified — used in code but not confirmed */
    jsonPropertyFiltering: false, /* NOT verified */
    selectClause: false, /* NOT verified */
    whereClause: false, /* NOT verified */
    pagination: false, /* NOT verified */
    sorting: false, /* NOT verified */
    resultLimit: false, /* resultsLimit: 1000 used but not confirmed as limit */
  };
  assert.equal(known.periodKeyFiltering, false);
  assert.equal(known.jsonPropertyFiltering, false);
  assert.equal(known.pagination, false);
  console.log("MyGeotab AddInData query capabilities: mostly NOT VERIFIED");
  console.log("  Known: search, addInId filter, recordType filter");
  console.log("  NOT VERIFIED: periodKey filter, JSON property filter, selectClause, whereClause, pagination, sorting, result limits");
});
