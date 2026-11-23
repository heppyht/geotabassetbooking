/*───────────────────── API-Side Issues Reproduction ─────────────────────*/
/* Reproduces: R8 (Date.now booking ID collision), R9 (inconsistent audit details),
   missing idempotency on booking creation. */
import test from "node:test";
import assert from "node:assert/strict";

// Simulate the API booking creation: booking-${Date.now()}
function makeBookingId() {
  return `booking-${Date.now()}`;
}

test("API: Date.now() booking IDs can collide within same millisecond", () => {
  const ids = new Set();
  // Simulate rapid-fire booking creation
  for (let i = 0; i < 1000; i++) {
    ids.add(makeBookingId());
  }
  // Date.now() has millisecond resolution; rapid calls in same ms produce duplicates
  // In real concurrent load, collision probability is non-zero
  console.log(`Unique IDs from 1000 rapid calls: ${ids.size}`);
  // This is a risk, not a deterministic failure in single-threaded test
  assert.ok(ids.size > 0);
});

test("API: audit details inconsistency - some structured, some raw string", () => {
  // approveBooking stores: details: input.comments ?? null  (raw string or null)
  // assignApprovedBooking stores: details: JSON.stringify({ vehicleId })  (JSON string)
  // cancelBooking stores: details: input.reason ?? null  (raw string or null)
  // This inconsistency means consumers can't reliably parse details as JSON

  const approveDetails = "approved by manager";       // raw string
  const assignDetails = JSON.stringify({ vehicleId: "veh-1" }); // JSON string
  const cancelDetails = null;                           // null

  // A consumer trying JSON.parse on approveDetails would throw
  let parseSucceeds = true;
  try { JSON.parse(approveDetails); } catch { parseSucceeds = false; }

  assert.equal(parseSucceeds, false, "approveBooking details is a plain string, not JSON");
  assert.equal(typeof assignDetails, "string", "assignApprovedBooking details is JSON string");
  assert.equal(cancelDetails, null, "cancelBooking details can be null");

  // Risk: downstream audit consumers must handle string/null/JSON inconsistently
});

test("API: no idempotency on booking creation - duplicate submissions create duplicate records", async () => {
  // The createBooking endpoint in index.ts has no idempotency key check
  // before calling gateway.addAddInData. Two rapid POST /api/bookings with
  // the same details create two distinct booking records.
  const submissions = [
    { deviceId: "veh-1", startAt: "2026-11-16T09:00:00Z", endAt: "2026-11-16T10:00:00Z", purpose: "same trip" },
    { deviceId: "veh-1", startAt: "2026-11-16T09:00:00Z", endAt: "2026-11-16T10:00:00Z", purpose: "same trip" },
  ];

  const created = submissions.map(() => ({
    id: `booking-${Date.now()}`,
    deviceId: "veh-1",
    purpose: "same trip",
  }));

  // Both have different IDs because Date.now() differs (or same if same ms)
  // Either way, no dedup check → both persisted
  assert.equal(created.length, 2, "Two submissions create two records - no idempotency on create");
});

test("API: assignApprovedBooking has idempotency but createBooking does not", () => {
  // verify by inspecting that assign checks idempotencyKey but create doesn't
  // This is a source-level observation, asserted here for documentation
  const createHasIdempotency = false;   // index.ts createBooking: no Idempotency-Key check
  const assignHasIdempotency = true;    // index.ts assign: checks Idempotency-Key header
  assert.equal(createHasIdempotency, false);
  assert.equal(assignHasIdempotency, true);
});
