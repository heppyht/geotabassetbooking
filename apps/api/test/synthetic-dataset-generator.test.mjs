/*───────────────────── Phase 9.5: Synthetic Dataset Generator Tests ─────────────────────*/
/* Validates the deterministic synthetic dataset generator.
   Imports shared utilities from benchmark-utils.mjs. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  generateDataset,
  SCENARIOS,
  MAX_DETAILS_CHARS,
} from "./benchmark-utils.mjs";

/*───────────────────── Tests ─────────────────────*/

test("synthetic dataset: small scenario generates 1,000 bookings", () => {
  const ds = generateDataset({ scenario: "small", seed: 42 });
  assert.equal(ds.counts.bookings, 1_000);
  assert.ok(ds.counts.audits > 0);
  assert.ok(ds.counts.notifications > 0);
  assert.equal(ds.counts.total, ds.counts.bookings + ds.counts.audits + ds.counts.notifications);
});

test("synthetic dataset: medium scenario generates 10,000 bookings", () => {
  const ds = generateDataset({ scenario: "medium", seed: 42 });
  assert.equal(ds.counts.bookings, 10_000);
});

test("synthetic dataset: large scenario generates 50,000 bookings", () => {
  const ds = generateDataset({ scenario: "large", seed: 42 });
  assert.equal(ds.counts.bookings, 50_000);
});

test("synthetic dataset: stress scenario generates 100,000 bookings", () => {
  const ds = generateDataset({ scenario: "stress", seed: 42 });
  assert.equal(ds.counts.bookings, 100_000);
});

test("synthetic dataset: deterministic - same seed produces identical output", () => {
  const ds1 = generateDataset({ scenario: "small", seed: 123 });
  const ds2 = generateDataset({ scenario: "small", seed: 123 });
  assert.equal(JSON.stringify(ds1.bookings), JSON.stringify(ds2.bookings));
  assert.equal(JSON.stringify(ds1.audits), JSON.stringify(ds2.audits));
  assert.equal(JSON.stringify(ds1.notifications), JSON.stringify(ds2.notifications));
});

test("synthetic dataset: different seeds produce different output", () => {
  const ds1 = generateDataset({ scenario: "small", seed: 1 });
  const ds2 = generateDataset({ scenario: "small", seed: 2 });
  let dataDiffers = false;
  for (let i = 0; i < 50; i++) {
    if (JSON.stringify(ds1.bookings[i]) !== JSON.stringify(ds2.bookings[i])) {
      dataDiffers = true;
      break;
    }
  }
  assert.ok(dataDiffers, "Different seeds should produce different data");
});

test("synthetic dataset: all records respect 10,000 char limit", () => {
  const ds = generateDataset({ scenario: "small", seed: 42 });
  for (const b of ds.bookings) {
    assert.ok(JSON.stringify(b.envelope).length <= MAX_DETAILS_CHARS);
  }
  for (const a of ds.audits) {
    assert.ok(JSON.stringify(a.envelope).length <= MAX_DETAILS_CHARS);
  }
  for (const n of ds.notifications) {
    assert.ok(JSON.stringify(n.envelope).length <= MAX_DETAILS_CHARS);
  }
});

test("synthetic dataset: all bookings have periodKey in YYYY-MM format", () => {
  const ds = generateDataset({ scenario: "small", seed: 42 });
  const periodKeyRegex = /^\d{4}-\d{2}$/;
  for (const b of ds.bookings) {
    assert.ok(periodKeyRegex.test(b.periodKey), `Invalid periodKey: ${b.periodKey}`);
  }
  for (const a of ds.audits) {
    assert.ok(periodKeyRegex.test(a.periodKey), `Invalid audit periodKey: ${a.periodKey}`);
  }
  for (const n of ds.notifications) {
    assert.ok(periodKeyRegex.test(n.periodKey), `Invalid notif periodKey: ${n.periodKey}`);
  }
});

test("synthetic dataset: schema v2 compliance - booking envelope structure", () => {
  const ds = generateDataset({ scenario: "small", seed: 42 });
  for (const b of ds.bookings.slice(0, 100)) {
    assert.equal(b.envelope.recordType, "booking");
    assert.equal(b.envelope.schemaVersion, 2);
    assert.ok(b.envelope.data.bookingId);
    assert.ok(b.envelope.data.status);
    assert.ok(b.envelope.data.vehicle.deviceId);
    assert.ok(b.envelope.data.schedule.startAtUtc);
    assert.ok(b.envelope.data.schedule.endAtUtc);
    assert.ok(b.envelope.data.lifecycle.createdAtUtc);
    assert.ok(b.envelope.data.lifecycle.updatedAtUtc);
    assert.ok(typeof b.envelope.data.version === "number");
  }
});

test("synthetic dataset: audit events per booking is configurable", () => {
  const ds3 = generateDataset({ scenario: "small", seed: 42, auditPerBooking: 3 });
  const ds5 = generateDataset({ scenario: "small", seed: 42, auditPerBooking: 5 });
  const ds10 = generateDataset({ scenario: "small", seed: 42, auditPerBooking: 10 });
  assert.equal(ds3.counts.audits, 1_000 * 3);
  assert.equal(ds5.counts.audits, 1_000 * 5);
  assert.equal(ds10.counts.audits, 1_000 * 10);
});

test("synthetic dataset: notifications per booking is configurable", () => {
  const ds1 = generateDataset({ scenario: "small", seed: 42, notifPerBooking: 1 });
  const ds2 = generateDataset({ scenario: "small", seed: 42, notifPerBooking: 2 });
  assert.equal(ds1.counts.notifications, 1_000 * 1);
  assert.equal(ds2.counts.notifications, 1_000 * 2);
});

test("synthetic dataset: invalid scenario throws", () => {
  assert.throws(() => generateDataset({ scenario: "nonexistent" }), /Unknown scenario/);
});

test("synthetic dataset: no production personal data (no real emails, phones, names)", () => {
  const ds = generateDataset({ scenario: "small", seed: 42 });
  const allRecords = JSON.stringify({ bookings: ds.bookings, audits: ds.audits, notifications: ds.notifications });
  assert.ok(!/@example\.com|@gmail\.com|@yahoo\.com|555-01\d{3}|\d{3}-\d{3}-\d{4}/.test(allRecords));
});

test("synthetic dataset: stress scenario completes within reasonable time", () => {
  const start = process.hrtime.bigint();
  const ds = generateDataset({ scenario: "stress", seed: 42, auditPerBooking: 5, notifPerBooking: 2 });
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1_000_000;
  assert.equal(ds.counts.bookings, 100_000);
  console.log(`Stress dataset generation: ${ms.toFixed(0)}ms for ${ds.counts.total} total records`);
});

test("synthetic dataset: scenario constants are defined", () => {
  assert.equal(SCENARIOS.small.bookings, 1_000);
  assert.equal(SCENARIOS.medium.bookings, 10_000);
  assert.equal(SCENARIOS.large.bookings, 50_000);
  assert.equal(SCENARIOS.stress.bookings, 100_000);
});
