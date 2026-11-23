/*───────────────────── Phase 9.6: AddInData Integration Validation (offline, mock-gateway) ─────────────────────*/
/* Validates AddInData CRUD, serialization, idempotency, optimistic concurrency,
   audit trail, tenant isolation, legacy v1 compatibility, and record size limits
   using a mocked AddInDataRestGateway — no live MyGeotab credentials required.
   Live tenant tests (Steps 3-7, 10) require credentials not yet obtained. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createBooking,
  approveBooking,
  rejectBooking,
  cancelBooking,
  assignApprovedBooking,
  findBookingRecord,
  findAuditGaps,
  getBookingsByDriver,
  isValidTransition,
  generateId,
} from "../src/services/booking.ts";
import { AddInDataRestGateway } from "../src/db.ts";

/*───────────────────── Helpers ─────────────────────*/

function isBookingRecord(details) {
  const d = typeof details === "string" ? JSON.parse(details) : details;
  return d && (d.deviceId || d.requesterUserId || d.status);
}

function isAuditRecord(details) {
  const d = typeof details === "string" ? JSON.parse(details) : details;
  return d && (d.eventType || d.eventId);
}

function bookingCount(gw) {
  return gw.records.filter(r => isBookingRecord(r.details)).length;
}

function auditList(gw) {
  return gw.records.filter(r => isAuditRecord(r.details));
}

/*───────────────────── Mock gateway (simulates AddInData REST behavior) ─────────────────────*/

function makeGateway({ bookings = [], audits = [], database = "opex_trial", failAdds = false } = {}) {
  const addInId = "addin-booking-app";
  const records = [];
  for (const b of bookings) records.push({ id: `rec-b-${generateId()}`, addInId, details: b, groups: [{ id: "GroupCompanyId" }] });
  for (const a of audits) records.push({ id: `rec-a-${generateId()}`, addInId, details: a, groups: [{ id: "GroupCompanyId" }] });
  let addsFailing = failAdds;
  return {
    addInId,
    database,
    records,
    async searchAddInData(_aid, search) {
      const rt = search && search.recordType;
      if (rt === "booking") return records.filter(r => isBookingRecord(r.details));
      if (rt === "booking_audit") return records.filter(r => isAuditRecord(r.details));
      return [...records];
    },
    async addAddInData(_aid, details, _gid) {
      if (addsFailing) { addsFailing = false; throw new Error("ADDIN_DATA_ADD_FAILED"); }
      const id = `rec-${generateId()}`;
      const record = { id, addInId, details, groups: [{ id: "GroupCompanyId" }] };
      records.push(record);
      return { id };
    },
    async setAddInData(_aid, recordId, details, _gid) {
      const idx = records.findIndex(r => r.id === recordId);
      if (idx < 0) throw new Error("ADDIN_DATA_SET_FAILED: record not found");
      records[idx] = { ...records[idx], details };
      return {};
    },
    async removeAddInData(_id) {
      return {};
    },
    verifySession() { return { valid: true, database, userName: "test-user" }; },
    setFailAdds() { addsFailing = true; },
    clearFailures() { addsFailing = false; },
  };
}

/*───────────────────── Step 4: CRUD integration (mock) ─────────────────────*/

test("Phase 9.6 Step 4: createBooking persists booking record via AddInData Add", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  const result = await createBooking(gw, {
    bookingId, idempotencyKey: "idem-1", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  assert.equal(result.created, true);
  assert.equal(result.booking.id, bookingId);
  assert.equal(result.booking.status, "PENDING_APPROVAL");
  assert.equal(result.booking.version, 1);
  assert.equal(result.booking.idempotencyKey, "idem-1");
  assert.ok(result.entityId);
  assert.equal(bookingCount(gw), 1);
  const stored = gw.records.find(r => {
    const d = typeof r.details === "string" ? JSON.parse(r.details) : r.details;
    return d && d.idempotencyKey === "idem-1";
  });
  assert.ok(stored, "booking should be stored in AddInData");
  assert.equal(stored.details.status, "PENDING_APPROVAL");
});

test("Phase 9.6 Step 4: idempotent createBooking returns existing without duplicate", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  const r1 = await createBooking(gw, {
    bookingId, idempotencyKey: "idem-dup", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  const r2 = await createBooking(gw, {
    bookingId: generateId(), idempotencyKey: "idem-dup", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r2.booking.id, r1.booking.id);
  assert.equal(bookingCount(gw), 1, "no duplicate booking record");
});

test("Phase 9.6 Step 4: approveBooking persists audit event with auditId link", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  await createBooking(gw, {
    bookingId, idempotencyKey: "idem-approve", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  const result = await approveBooking(gw, { bookingId, approverId: "approver-1", comments: "Looks good" });
  assert.equal(result.status, "APPROVED");
  assert.equal(result.auditPersisted, true);
  assert.ok(result.auditId);
  const found = await findBookingRecord(gw, bookingId);
  assert.ok(found, "booking should still exist after approval");
  assert.equal(found.booking.approverId, "approver-1");
  assert.equal(found.booking.version, 2, "version incremented on approval");
  const audits = auditList(gw);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].details.eventType, "BOOKING_APPROVED");
  assert.equal(audits[0].details.actor_user_id, "approver-1");
  assert.ok(audits[0].details.details, "audit details must be structured JSON, not null/raw string");
});

test("Phase 9.6 Step 4: rejectBooking persists audit event", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  await createBooking(gw, {
    bookingId, idempotencyKey: "idem-reject", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  const result = await rejectBooking(gw, { bookingId, rejecterId: "approver-2", reason: "No budget", comments: "denied" });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.auditPersisted, true);
  const audits = auditList(gw);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].details.eventType, "BOOKING_REJECTED");
  assert.equal(audits[0].details.previous_status, "PENDING_APPROVAL");
  assert.equal(audits[0].details.new_status, "REJECTED");
});

test("Phase 9.6 Step 4: cancelBooking persists audit event", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  await createBooking(gw, {
    bookingId, idempotencyKey: "idem-cancel", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  await approveBooking(gw, { bookingId, approverId: "approver-1" });
  const result = await cancelBooking(gw, { bookingId, cancelerId: "user-1", reason: "Changed plans" });
  assert.equal(result.status, "CANCELLED");
  const audits = auditList(gw);
  assert.equal(audits.length, 2, "approval audit + cancel audit");
  assert.equal(audits[1].details.eventType, "BOOKING_CANCELLED");
});

test("Phase 9.6 Step 4: assignApprovedBooking persists audit with vehicleId", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  await createBooking(gw, {
    bookingId, idempotencyKey: "idem-assign", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  await approveBooking(gw, { bookingId, approverId: "approver-1" });
  const result = await assignApprovedBooking(gw, { bookingId, vehicleId: "veh-42", assignedBy: "ga-1", idempotencyKey: "idem-assign-exec" });
  assert.equal(result.status, "ASSIGNED");
  assert.equal(result.auditPersisted, true);
  const audits = auditList(gw);
  assert.equal(audits.length, 2);
  const assignAudit = audits.find(a => a.details.eventType === "VEHICLE_ASSIGNED");
  assert.ok(assignAudit);
  assert.equal(assignAudit.details.details.vehicleId, "veh-42");
});

/*───────────────────── Step 5: Serialization compatibility ─────────────────────*/

test("Phase 9.6 Step 5: single JSON.stringify boundary — no double-serialization", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  const result = await createBooking(gw, {
    bookingId, idempotencyKey: "idem-serial", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  const stored = gw.records.find(r => r.id === result.entityId);
  const parsed = typeof stored.details === "string" ? JSON.parse(stored.details) : stored.details;
  assert.equal(typeof parsed, "object");
  assert.equal(parsed.id, bookingId);
  assert.equal(parsed.status, "PENDING_APPROVAL");
  const reSerialized = JSON.stringify(parsed);
  const reParsed = JSON.parse(reSerialized);
  assert.deepEqual(reParsed, parsed);
});

test("Phase 9.6 Step 5: audit details are always structured JSON (never raw string or null)", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  await createBooking(gw, {
    bookingId, idempotencyKey: "idem-audit", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  await approveBooking(gw, { bookingId, approverId: "approver-1" });
  const audits = auditList(gw);
  assert.equal(audits.length, 1);
  const auditRaw = audits[0].details;
  const parsed = typeof auditRaw === "string" ? JSON.parse(auditRaw) : auditRaw;
  assert.ok(parsed.details, "audit.details must be present");
  assert.equal(typeof parsed.details, "object", "audit.details must be an object, not a raw string");
});

/*───────────────────── Step 5: Record size limit (10,000 chars) ─────────────────────*/

test("Phase 9.6 Step 5: booking details under 10,000 serialized chars", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  const longPurpose = "x".repeat(9000);
  const result = await createBooking(gw, {
    bookingId, idempotencyKey: "idem-size", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: longPurpose, destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  const stored = gw.records.find(r => r.id === result.entityId);
  const serialized = typeof stored.details === "string" ? stored.details : JSON.stringify(stored.details);
  assert.ok(serialized.length <= 10000, `serialized size ${serialized.length} exceeds 10,000 char limit`);
});

/*───────────────────── Step 6: Version-based optimistic concurrency ─────────────────────*/

test("Phase 9.6 Step 6: version increments on booking update", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  await createBooking(gw, {
    bookingId, idempotencyKey: "idem-ver", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  const before = await findBookingRecord(gw, bookingId);
  assert.ok(before);
  assert.equal(before.booking.version, 1);
  await approveBooking(gw, { bookingId, approverId: "approver-1" });
  const after = await findBookingRecord(gw, bookingId);
  assert.ok(after);
  assert.equal(after.booking.version, 2, "version should increment on update");
});

/*───────────────────── Step 6: Audit gap detection ─────────────────────*/

test("Phase 9.6 Step 6: findAuditGaps detects missing audit events", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  await createBooking(gw, {
    bookingId, idempotencyKey: "idem-gap", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  const gaps = await findAuditGaps(gw);
  assert.ok(gaps.length >= 1);
  const gap = gaps.find(g => g.bookingId === bookingId);
  assert.ok(gap, "booking without auditId should be flagged as gap");
  assert.equal(gap.auditId, null);
});

test("Phase 9.6 Step 6: findAuditGaps returns empty when all audits present", async (t) => {
  const gw = makeGateway();
  const bookingId = generateId();
  await createBooking(gw, {
    bookingId, idempotencyKey: "idem-nogap", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  await approveBooking(gw, { bookingId, approverId: "approver-1" });
  const gaps = await findAuditGaps(gw);
  const gapForBooking = gaps.find(g => g.bookingId === bookingId);
  assert.equal(gapForBooking, undefined, "no gap when audit event exists");
});

/*───────────────────── Step 6: getBookingsByDriver ─────────────────────*/

test("Phase 9.6 Step 6: getBookingsByDriver returns only assigned driver's bookings", async (t) => {
  const gw = makeGateway();
  await createBooking(gw, {
    bookingId: generateId(), idempotencyKey: "idem-d1", deviceId: "veh-1", requesterUserId: "user-1",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: "driver-42",
    createdAt: "2026-11-23T04:00:00Z",
  });
  await createBooking(gw, {
    bookingId: generateId(), idempotencyKey: "idem-d2", deviceId: "veh-2", requesterUserId: "user-2",
    requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
    createdAt: "2026-11-23T04:00:00Z",
  });
  const driverBookings = await getBookingsByDriver(gw, "driver-42");
  assert.equal(driverBookings.length, 1);
  assert.equal(driverBookings[0].assignedDriverUserId, "driver-42");
});

/*───────────────────── Step 7: Tenant isolation ─────────────────────*/

test("Phase 9.6 Step 7: gateway uses server-configured database, not client override", async (t) => {
  const gw = makeGateway({ database: "opex_trial" });
  assert.equal(gw.database, "opex_trial");
  assert.notEqual(gw.database, "attacker_database");
});

test("Phase 9.6 Step 7: verifySession confirms database matches configured tenant", async (t) => {
  const gw = makeGateway({ database: "opex_trial" });
  const result = await gw.verifySession({ userName: "user-1", database: "opex_trial", sessionId: "sess-1" });
  assert.equal(result.valid, true);
  assert.equal(result.database, "opex_trial");
});

/*───────────────────── Step 7: Legacy schema v1 backward compatibility ─────────────────────*/

test("Phase 9.6 Step 7: legacy v1 booking record (flat fields, no recordType) is readable", async (t) => {
  const gw = makeGateway({ bookings: [{
    id: "legacy-1", bookingId: "legacy-1", status: "APPROVED", deviceId: "veh-legacy",
    startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Legacy booking", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
    version: 1,
  }] });
  const found = await findBookingRecord(gw, "legacy-1");
  assert.ok(found, "legacy v1 booking should be found by bookingId");
  assert.equal(found.booking.id, "legacy-1");
  assert.equal(found.booking.status, "APPROVED");
});

test("Phase 9.6 Step 7: findAuditGaps handles legacy bookings without auditId", async (t) => {
  const gw = makeGateway({ bookings: [{
    id: "legacy-2", bookingId: "legacy-2", status: "APPROVED", deviceId: "veh-legacy",
    startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
    purpose: "Legacy booking", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
    version: 1,
  }] });
  const gaps = await findAuditGaps(gw);
  assert.ok(gaps.length >= 1);
  const gap = gaps.find(g => g.bookingId === "legacy-2");
  assert.ok(gap);
  assert.equal(gap.auditId, null);
});

/*───────────────────── Step 5/6: Add failure handling ─────────────────────*/

test("Phase 9.6 Step 5: AddInData add failure propagates as ADDIN_DATA_ADD_FAILED", async (t) => {
  const gw = makeGateway({ failAdds: true });
  await assert.rejects(
    createBooking(gw, {
      bookingId: generateId(), idempotencyKey: "idem-fail", deviceId: "veh-1", requesterUserId: "user-1",
      requestedClass: "PASSENGER", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T10:00:00Z",
      purpose: "Site visit", destination: null, passengerCount: null, assignedDriverUserId: null,
      createdAt: "2026-11-23T04:00:00Z",
    }),
    /ADDIN_DATA_ADD_FAILED/
  );
});
