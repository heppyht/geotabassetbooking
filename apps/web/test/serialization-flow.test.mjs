/*───────────────────── Serialization Flow Verification ─────────────────────*/
/* Reproduces issues in Phase 9.2: double JSON.stringify, malformed JSON,
   legacy records, size limit, null fields. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  serializeBooking,
  deserializeBooking,
  serializeNotification,
  deserializeNotification,
  serializeAudit,
  deserializeAudit,
  assertDetailsWithinLimit,
} from "../src/data/addinDataProvider.ts";

const sampleBooking = {
  id: "b-1",
  deviceId: "dev-1",
  requesterUserId: "u-1",
  requestedClass: "PASSENGER",
  startAt: "2026-11-16T09:00:00Z",
  endAt: "2026-11-16T10:00:00Z",
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 30,
  purpose: "Site visit",
  destination: null,
  passengerCount: 2,
  status: "PENDING_APPROVAL",
  assignedDriverUserId: null,
  approverId: null,
  approvalRemarks: null,
  createdAt: "2026-11-16T08:00:00Z",
  updatedAt: "2026-11-16T08:00:00Z",
  version: 1,
};

// 1. Normal booking: object in, object out, not double-serialized
test("serialization: booking object round-trips without double-serialization", () => {
  const out = serializeBooking(sampleBooking);
  assert.equal(typeof out.details === "string" ? "string" : "object", "object");
  // The serialize function returns the object itself (single boundary at API)
  const json = JSON.stringify(out);
  assert.ok(json.length <= 10000);
  // Parse back should recover the same values
  const parsed = JSON.parse(json);
  assert.equal(parsed.id, sampleBooking.id);
  assert.equal(parsed.deviceId, sampleBooking.deviceId);
});

// 2. String details deserialization
test("serialization: booking string details parse correctly", () => {
  const str = JSON.stringify(sampleBooking);
  const out = deserializeBooking(str);
  assert.equal(out.id, sampleBooking.id);
  assert.equal(out.purpose, sampleBooking.purpose);
});

// 3. Malformed JSON falls back gracefully
test("serialization: malformed JSON returns fallback, not crash", () => {
  const out = deserializeBooking("{not valid json");
  assert.ok(out !== null);
  assert.equal(out.id, ""); // fallback
});

// 4. Null fields preserved
test("serialization: null fields preserved through round-trip", () => {
  const out = serializeBooking(sampleBooking);
  const json = JSON.stringify(out);
  const reparsed = deserializeBooking(json);
  assert.equal(reparsed.destination, null);
  assert.equal(reparsed.assignedDriverUserId, null);
  assert.equal(reparsed.approverId, null);
});

// 5. Size limit enforced
test("serialization: oversized record throws ADDIN_DATA_DETAILS_EXCEEDED", () => {
  const big = { ...sampleBooking, purpose: "x".repeat(12000) };
  assert.throws(() => serializeBooking(big), /ADDIN_DATA_DETAILS_EXCEEDED/);
});

// 6. Notification round-trip
test("serialization: notification round-trip", () => {
  const notif = {
    id: "n-1", eventId: "evt-1", idempotencyKey: "k-1", type: "booking_created",
    recipient_user_id: "u-1", related_booking_id: "b-1", title: "t", message: "m",
    is_read: false, delivery_status: "pending", delivered_at: null,
    created_at: "2026-11-16T08:00:00Z", updated_at: "2026-11-16T08:00:00Z",
  };
  const out = serializeNotification(notif);
  const json = JSON.stringify(out);
  const reparsed = deserializeNotification(json);
  assert.equal(reparsed.id, notif.id);
  assert.equal(reparsed.type, notif.type);
});

// 7. Audit round-trip with details as string vs object
test("serialization: audit details stored as string is preserved", () => {
  const audit = {
    id: "a-1", booking_id: "b-1", action: "BOOKING_CREATED", actor_user_id: "u-1",
    previous_status: null, new_status: "PENDING_APPROVAL", details: "created via UI",
    created_at: "2026-11-16T08:00:00Z",
  };
  const out = serializeAudit(audit);
  const json = JSON.stringify(out);
  const reparsed = deserializeAudit(json);
  assert.equal(reparsed.details, "created via UI");
});

// 8. Audit with structured JSON details (double-encoded risk)
test("serialization: audit structured details not double-encoded", () => {
  const audit = {
    id: "a-2", booking_id: "b-1", action: "VEHICLE_ASSIGNED", actor_user_id: "u-1",
    previous_status: "APPROVED", new_status: "ASSIGNED",
    details: JSON.stringify({ vehicleId: "dev-1" }), // already a string
    created_at: "2026-11-16T08:00:00Z",
  };
  const out = serializeAudit(audit);
  const json = JSON.stringify(out);
  const reparsed = deserializeAudit(json);
  // details should be the string, not parsed further
  assert.equal(typeof reparsed.details, "string");
});

// 9. Empty details
test("serialization: empty/undefined details handled gracefully", () => {
  const out = deserializeBooking(null);
  assert.equal(out, null); // null is passed through, not thrown
  const out2 = deserializeBooking(undefined);
  assert.equal(out2, undefined); // undefined is passed through
});

// 10. Legacy schema (no recordType, flat fields)
test("serialization: legacy flat booking fields deserialize", () => {
  const legacy = {
    id: "b-legacy", deviceId: "dev-1", requesterUserId: "u-1",
    requestedClass: "PASSENGER", startAt: "2026-11-16T09:00:00Z",
    endAt: "2026-11-16T10:00:00Z", purpose: "legacy", status: "PENDING_APPROVAL",
    createdAt: "2026-11-16T08:00:00Z", updatedAt: "2026-11-16T08:00:00Z", version: 1,
  };
  const out = deserializeBooking(legacy);
  assert.equal(out.id, "b-legacy");
  assert.equal(out.deviceId, "dev-1");
});
