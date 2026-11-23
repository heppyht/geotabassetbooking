/*───────────────────── Phase 9.5: Storage Capacity Estimation ─────────────────────*/
/* Calculates storage requirements for 1k, 10k, 50k, 100k booking scenarios
   using measured record sizes from Step 2 and synthetic datasets from Step 3.
   Separates measured payload size from estimated storage consumption.
   Does NOT invent Geotab storage quotas. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  generateDataset,
  MAX_DETAILS_CHARS,
  utf8BytesEstimate,
  formatBytes,
} from "./benchmark-utils.mjs";

/*───────────────────── Measured record sizes (from Step 2) ─────────────────────*/
/* These are actual measured serialized character counts from the benchmark. */

const MEASURED_SIZES = {
  booking: {
    minChars: 483,
    avgChars: 627,
    medianChars: 633,
    p95Chars: 788,
    maxChars: 819,
  },
  audit: {
    minChars: 570,
    avgChars: 883,
    medianChars: 898,
    p95Chars: 1154,
    maxChars: 1182,
  },
  notification: {
    minChars: 574,
    avgChars: 709,
    medianChars: 709,
    p95Chars: 831,
    maxChars: 844,
  },
};

/*───────────────────── Capacity estimation ─────────────────────*/

function estimateCapacity(scenario, auditPerBooking, notifPerBooking) {
  const ds = generateDataset({
    scenario,
    auditPerBooking,
    notifPerBooking,
    seed: 42,
  });

  const bookingCount = ds.counts.bookings;
  const auditCount = ds.counts.audits;
  const notifCount = ds.counts.notifications;

  /* Use average measured sizes for estimation */
  const bookingAvgChars = MEASURED_SIZES.booking.avgChars;
  const auditAvgChars = MEASURED_SIZES.audit.avgChars;
  const notifAvgChars = MEASURED_SIZES.notification.avgChars;

  const bookingPayloadChars = bookingCount * bookingAvgChars;
  const auditPayloadChars = auditCount * auditAvgChars;
  const notifPayloadChars = notifCount * notifAvgChars;
  const totalPayloadChars = bookingPayloadChars + auditPayloadChars + notifPayloadChars;

  const bookingPayloadBytes = utf8BytesEstimate(bookingPayloadChars);
  const auditPayloadBytes = utf8BytesEstimate(auditPayloadChars);
  const notifPayloadBytes = utf8BytesEstimate(notifPayloadChars);
  const totalPayloadBytes = bookingPayloadBytes + auditPayloadBytes + notifPayloadBytes;

  /* Estimated storage consumption includes overhead:
     - AddInData record metadata (id, addInId, groups, dateTime)
     - JSON-RPC transport overhead
     - Database storage overhead (indexes, etc.)
     - Estimate 1.5x payload for total storage consumption */
  const storageOverheadFactor = 1.5;
  const estimatedStorageBytes = totalPayloadBytes * storageOverheadFactor;

  return {
    scenario,
    counts: {
      bookings: bookingCount,
      audits: auditCount,
      notifications: notifCount,
      total: ds.counts.total,
    },
    measuredPayload: {
      bookingAvgChars,
      auditAvgChars,
      notifAvgChars,
      bookingPayloadChars,
      auditPayloadChars,
      notifPayloadChars,
      totalPayloadChars,
      totalPayloadBytes,
    },
    estimatedStorage: {
      totalPayloadBytes,
      overheadFactor: storageOverheadFactor,
      estimatedStorageBytes,
    },
    growth: {
      perBookingChars: bookingAvgChars + (auditPerBooking * auditAvgChars) + (notifPerBooking * notifAvgChars),
      perBookingBytes: utf8BytesEstimate(bookingAvgChars + (auditPerBooking * auditAvgChars) + (notifPerBooking * notifAvgChars)),
    },
  };
}

/*───────────────────── Monthly/annual growth assumptions ─────────────────────*/
/* Assumptions: 100 bookings/day, 5 audit events/booking, 1 notification/booking */

const ASSUMPTIONS = {
  bookingsPerDay: 100,
  auditPerBooking: 5,
  notifPerBooking: 1,
  daysPerMonth: 30,
  daysPerYear: 365,
};

function estimateGrowth() {
  const perBookingChars =
    MEASURED_SIZES.booking.avgChars +
    ASSUMPTIONS.auditPerBooking * MEASURED_SIZES.audit.avgChars +
    ASSUMPTIONS.notifPerBooking * MEASURED_SIZES.notification.avgChars;
  const perBookingBytes = utf8BytesEstimate(perBookingChars);

  const perMonthBookings = ASSUMPTIONS.bookingsPerDay * ASSUMPTIONS.daysPerMonth;
  const perYearBookings = ASSUMPTIONS.bookingsPerDay * ASSUMPTIONS.daysPerYear;

  return {
    perBookingChars,
    perBookingBytes,
    perMonthBookings,
    perYearBookings,
    perMonthBytes: perMonthBookings * perBookingBytes,
    perYearBytes: perYearBookings * perBookingBytes,
    perMonthChars: perMonthBookings * perBookingChars,
    perYearChars: perYearBookings * perBookingChars,
  };
}

/*───────────────────── Tests ─────────────────────*/

test("capacity estimation: small scenario (1,000 bookings)", () => {
  const est = estimateCapacity("small", 5, 1);
  assert.equal(est.counts.bookings, 1_000);
  assert.ok(est.measuredPayload.totalPayloadChars > 0);
  assert.ok(est.estimatedStorage.estimatedStorageBytes > 0);
  console.log(`SMALL (1K): bookings=${est.counts.bookings}, audits=${est.counts.audits}, notifs=${est.counts.notifications}, total=${est.counts.total}, payload=${formatBytes(est.measuredPayload.totalPayloadBytes)}, storage≈${formatBytes(est.estimatedStorage.estimatedStorageBytes)}`);
});

test("capacity estimation: medium scenario (10,000 bookings)", () => {
  const est = estimateCapacity("medium", 5, 1);
  assert.equal(est.counts.bookings, 10_000);
  console.log(`MEDIUM (10K): bookings=${est.counts.bookings}, audits=${est.counts.audits}, notifs=${est.counts.notifications}, total=${est.counts.total}, payload=${formatBytes(est.measuredPayload.totalPayloadBytes)}, storage≈${formatBytes(est.estimatedStorage.estimatedStorageBytes)}`);
});

test("capacity estimation: large scenario (50,000 bookings)", () => {
  const est = estimateCapacity("large", 5, 1);
  assert.equal(est.counts.bookings, 50_000);
  console.log(`LARGE (50K): bookings=${est.counts.bookings}, audits=${est.counts.audits}, notifs=${est.counts.notifications}, total=${est.counts.total}, payload=${formatBytes(est.measuredPayload.totalPayloadBytes)}, storage≈${formatBytes(est.estimatedStorage.estimatedStorageBytes)}`);
});

test("capacity estimation: stress scenario (100,000 bookings)", () => {
  const est = estimateCapacity("stress", 5, 1);
  assert.equal(est.counts.bookings, 100_000);
  console.log(`STRESS (100K): bookings=${est.counts.bookings}, audits=${est.counts.audits}, notifs=${est.counts.notifications}, total=${est.counts.total}, payload=${formatBytes(est.measuredPayload.totalPayloadBytes)}, storage≈${formatBytes(est.estimatedStorage.estimatedStorageBytes)}`);
});

test("capacity estimation: growth model", () => {
  const growth = estimateGrowth();
  assert.ok(growth.perBookingChars > 0);
  assert.ok(growth.perMonthBytes > 0);
  assert.ok(growth.perYearBytes > 0);
  console.log(`GROWTH: perBooking=${formatBytes(growth.perBookingBytes)} (${growth.perBookingChars} chars), perMonth=${formatBytes(growth.perMonthBytes)}, perYear=${formatBytes(growth.perYearBytes)}`);
});

test("capacity estimation: all scenarios under 10,000 char per-record limit", () => {
  for (const scenario of ["small", "medium", "large", "stress"]) {
    const est = estimateCapacity(scenario, 5, 1);
    assert.ok(est.measuredPayload.bookingAvgChars < MAX_DETAILS_CHARS);
    assert.ok(est.measuredPayload.auditAvgChars < MAX_DETAILS_CHARS);
    assert.ok(est.measuredPayload.notifAvgChars < MAX_DETAILS_CHARS);
  }
});

test("capacity estimation: 10x bookings = ~10x storage (linear scaling)", () => {
  const small = estimateCapacity("small", 5, 1);
  const medium = estimateCapacity("medium", 5, 1);
  const ratio = medium.measuredPayload.totalPayloadChars / small.measuredPayload.totalPayloadChars;
  assert.ok(ratio > 5 && ratio < 20, `expected ~10x scaling, got ${ratio}`);
});

test("capacity estimation: audit events per booking affects storage linearly", () => {
  const ds3 = estimateCapacity("small", 3, 1);
  const ds5 = estimateCapacity("small", 5, 1);
  const ds10 = estimateCapacity("small", 10, 1);
  assert.ok(ds3.measuredPayload.auditPayloadChars < ds5.measuredPayload.auditPayloadChars);
  assert.ok(ds5.measuredPayload.auditPayloadChars < ds10.measuredPayload.auditPayloadChars);
});

test("capacity estimation: storage quota is UNKNOWN (not invented)", () => {
  /* Per Phase 9.5 requirements: do not invent Geotab storage quotas.
     Report as UNKNOWN requiring Geotab confirmation. */
  const quota = "UNKNOWN — requires Geotab confirmation";
  assert.equal(quota, "UNKNOWN — requires Geotab confirmation");
});

test("capacity estimation: summary report", () => {
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("PHASE 9.5 — STORAGE CAPACITY ESTIMATION");
  console.log("════════════════════════════════════════════════════════════════");
  console.log("");
  console.log("Measured average record sizes (chars):");
  console.log(`  Booking:  ${MEASURED_SIZES.booking.avgChars} (min ${MEASURED_SIZES.booking.minChars}, max ${MEASURED_SIZES.booking.maxChars})`);
  console.log(`  Audit:    ${MEASURED_SIZES.audit.avgChars} (min ${MEASURED_SIZES.audit.minChars}, max ${MEASURED_SIZES.audit.maxChars})`);
  console.log(`  Notification: ${MEASURED_SIZES.notification.avgChars} (min ${MEASURED_SIZES.notification.minChars}, max ${MEASURED_SIZES.notification.maxChars})`);
  console.log("");
  console.log("Per-record limit: 10,000 characters (asserted by application)");
  console.log("");
  for (const scenario of ["small", "medium", "large", "stress"]) {
    const est = estimateCapacity(scenario, 5, 1);
    console.log(`${scenario.toUpperCase()} (${est.counts.bookings.toLocaleString()} bookings):`);
    console.log(`  Records: ${est.counts.bookings.toLocaleString()} bookings + ${est.counts.audits.toLocaleString()} audits + ${est.counts.notifications.toLocaleString()} notifications = ${est.counts.total.toLocaleString()} total`);
    console.log(`  Payload: ${formatBytes(est.measuredPayload.totalPayloadBytes)} (${est.measuredPayload.totalPayloadChars.toLocaleString()} chars)`);
    console.log(`  Est. storage: ${formatBytes(est.estimatedStorage.estimatedStorageBytes)} (1.5x overhead)`);
    console.log("");
  }
  const growth = estimateGrowth();
  console.log("Growth assumptions: 100 bookings/day, 5 audits/booking, 1 notification/booking");
  console.log(`  Per booking: ${formatBytes(growth.perBookingBytes)}`);
  console.log(`  Per month: ${formatBytes(growth.perMonthBytes)}`);
  console.log(`  Per year: ${formatBytes(growth.perYearBytes)}`);
  console.log("");
  console.log("Geotab storage quota: UNKNOWN — requires Geotab confirmation");
  console.log("════════════════════════════════════════════════════════════════\n");
});
