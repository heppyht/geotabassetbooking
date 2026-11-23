/*───────────────────── Audit and Concurrency Tests ─────────────────────*/
/* Tests for append-only audit, unique audit IDs, idempotency,
   version conflict detection, overlap validation, and reconciliation. */

import assert from "node:assert/strict";
import { AddInDataRepository } from "../src/repositories/addinData/index.ts";
import { AddInDataGateway } from "../src/data/addinDataService.ts";
import { generateId } from "../src/domain/index.ts";
import { overlaps, withBuffer, findConflict } from "../src/domain/index.ts";
import {
  isValidTransition, canViewBooking, canModifyBooking, canCancelBooking,
  APPROVER_ROLES, ASSIGN_ROLES, CANCEL_ADMIN_ROLES,
} from "../src/domain/index.ts";

/*───────────────────── Mock AddInDataGateway ─────────────────────*/

class MockAddInDataGateway {
  records;
  nextId;
  addInId;
  groupId;

  constructor() {
    this.records = new Map();
    this.nextId = 1;
    this.addInId = "test-addin-id";
    this.groupId = "GroupCompanyId";
  }

  isConfigured() {
    return true;
  }

  async search(typeName, search) {
    const results = [];
    for (const [id, record] of this.records) {
      try {
        const parsed = JSON.parse(record.details);
        if (search && search.recordType && parsed.recordType !== search.recordType) continue;
        if (search && search.periodKey && parsed.periodKey !== search.periodKey) continue;
        results.push({ id, details: parsed });
      } catch {
        // skip malformed
      }
    }
    return results;
  }

  async add(typeName, entity) {
    const id = `rec-${this.nextId++}`;
    this.records.set(id, { details: entity.details });
    return { id };
  }

  async set(typeName, entity) {
    if (!this.records.has(entity.id)) throw new Error("RECORD_NOT_FOUND");
    this.records.set(entity.id, { details: entity.details });
    return { id: entity.id };
  }

  async remove(typeName, entity) {
    this.records.delete(entity.id);
    return { id: entity.id };
  }

  getRecord(id) {
    const r = this.records.get(id);
    return r ? JSON.parse(r.details) : null;
  }

  clear() {
    this.records.clear();
    this.nextId = 1;
  }
}

function makeBooking(overrides) {
  return {
    id: `bk-${generateId().slice(0, 8)}`,
    deviceId: "dev-001",
    requesterUserId: "user-001",
    requestedClass: "PASSENGER",
    startAt: "2026-12-01T08:00:00Z",
    endAt: "2026-12-01T10:00:00Z",
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 30,
    purpose: "Trip",
    destination: null,
    passengerCount: null,
    status: "PENDING_APPROVAL",
    assignedDriverUserId: null,
    approverId: null,
    approvalRemarks: null,
    createdAt: "2026-11-20T08:00:00Z",
    updatedAt: "2026-11-20T08:00:00Z",
    version: 1,
    recordType: "booking",
    schemaVersion: 2,
    ...overrides,
  };
}

function makeAudit(overrides) {
  return {
    id: `audit-${generateId().slice(0, 8)}`,
    booking_id: "bk-001",
    eventId: `evt-${generateId().slice(0, 8)}`,
    eventType: "BOOKING_CREATED",
    actor_user_id: "user-001",
    previous_status: null,
    new_status: "PENDING_APPROVAL",
    changes: [{ field: "status", previousValue: null, newValue: "PENDING_APPROVAL" }],
    details: { source: "test" },
    created_at: "2026-11-20T08:00:00Z",
    schemaVersion: 2,
    ...overrides,
  };
}

async function main() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`ok  - ${name}`);
      passed++;
    } catch (e) {
      console.log(`not ok - ${name}`);
      console.log(`  ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  /*───────────────────── Audit: Append-only ─────────────────────*/
  await test("audit: createAuditEvent appends a new record each time", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });
    const a1 = makeAudit({ eventId: "evt-a" });
    const a2 = makeAudit({ eventId: "evt-b" });
    await repo.createAuditEvent(a1);
    await repo.createAuditEvent(a2);
    const history = await repo.readAuditHistory("bk-001");
    assert.equal(history.length, 2);
    client.clear();
  });

  await test("audit: audit events are never overwritten (append-only)", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });
    await repo.createAuditEvent(makeAudit({ eventId: "evt-1" }));
    await repo.createAuditEvent(makeAudit({ eventId: "evt-2" }));
    const history = await repo.readAuditHistory("bk-001");
    const eventIds = history.map(h => h.eventId);
    assert.equal(eventIds.includes("evt-1"), true);
    assert.equal(eventIds.includes("evt-2"), true);
    client.clear();
  });

  /*───────────────────── Audit: Unique IDs ─────────────────────*/
  await test("audit: generateId produces unique IDs", async () => {
    const id1 = generateId();
    const id2 = generateId();
    assert.notEqual(id1, id2);
  });

  await test("audit: audit event has required fields", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });
    const audit = makeAudit();
    await repo.createAuditEvent(audit);
    const history = await repo.readAuditHistory("bk-001");
    const h = history[0];
    assert.equal(h.booking_id, "bk-001");
    assert.equal(h.actor_user_id, "user-001");
    assert.equal(h.eventType, "BOOKING_CREATED");
    assert.equal(h.previous_status, null);
    assert.equal(h.new_status, "PENDING_APPROVAL");
    assert.ok(h.created_at);
    assert.ok(h.eventId);
    client.clear();
  });

  /*───────────────────── Audit: Idempotency ─────────────────────*/
  await test("audit: same eventId is not duplicated (idempotent)", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });
    const audit = makeAudit({ eventId: "evt-same" });
    const r1 = await repo.createAuditEvent(audit);
    const r2 = await repo.createAuditEvent(audit);
    assert.equal(r1.entityId, r2.entityId);
    const history = await repo.readAuditHistory("bk-001");
    assert.equal(history.length, 1);
    client.clear();
  });

  /*───────────────────── Concurrency: Version conflict ─────────────────────*/
  await test("concurrency: version conflict detected on stale update", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });
    const booking = makeBooking({ id: "bk-conflict", version: 1 });
    const created = await repo.createBooking(booking);
    const recordId = created.entityId;

    const update1 = { ...booking, version: 2, status: "APPROVED" };
    await repo.updateBooking(recordId, update1);

    const staleUpdate = { ...booking, version: 2, status: "CANCELLED" };
    try {
      await repo.updateBooking(recordId, staleUpdate);
      assert.fail("Should have thrown BOOKING_VERSION_CONFLICT");
    } catch (e) {
      assert.equal(e.message, "BOOKING_VERSION_CONFLICT: booking was modified by another request");
    }
    client.clear();
  });

  await test("concurrency: correct version update succeeds", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });
    const booking = makeBooking({ id: "bk-ok", version: 1 });
    const created = await repo.createBooking(booking);
    const recordId = created.entityId;

    const update1 = { ...booking, version: 2, status: "APPROVED" };
    const result1 = await repo.updateBooking(recordId, update1);
    assert.equal(result1.verified, true);

    const update2 = { ...update1, version: 3, status: "ASSIGNED" };
    const result2 = await repo.updateBooking(recordId, update2);
    assert.equal(result2.verified, true);
    client.clear();
  });

  /*───────────────────── Concurrency: Booking overlap ─────────────────────*/
  await test("concurrency: overlapping bookings for same vehicle detected", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });

    const b1 = makeBooking({
      id: "bk-overlap-1",
      deviceId: "dev-001",
      startAt: "2026-12-01T08:00:00Z",
      endAt: "2026-12-01T10:00:00Z",
      status: "APPROVED",
    });
    await repo.createBooking(b1);

    const b2 = makeBooking({
      id: "bk-overlap-2",
      deviceId: "dev-001",
      startAt: "2026-12-01T09:00:00Z",
      endAt: "2026-12-01T11:00:00Z",
      status: "PENDING_APPROVAL",
    });

    const existing = await repo.listAllBookings();
    const conflict = findConflict(
      { start: new Date(b2.startAt), end: new Date(b2.endAt) },
      existing,
      "dev-001",
      ["PENDING_APPROVAL", "APPROVED", "ASSIGNED"]
    );
    assert.equal(conflict.hasConflict, true);
    assert.equal(conflict.conflictingBookingId, "bk-overlap-1");
    client.clear();
  });

  await test("concurrency: adjacent bookings do not conflict (half-open intervals)", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });

    const b1 = makeBooking({
      id: "bk-adj-1",
      deviceId: "dev-001",
      startAt: "2026-12-01T08:00:00Z",
      endAt: "2026-12-01T10:00:00Z",
      status: "APPROVED",
    });
    await repo.createBooking(b1);

    const b2 = makeBooking({
      id: "bk-adj-2",
      deviceId: "dev-001",
      startAt: "2026-12-01T10:00:00Z",
      endAt: "2026-12-01T12:00:00Z",
      status: "PENDING_APPROVAL",
    });

    const existing = await repo.listAllBookings();
    const conflict = findConflict(
      { start: new Date(b2.startAt), end: new Date(b2.endAt) },
      existing,
      "dev-001",
      ["PENDING_APPROVAL", "APPROVED", "ASSIGNED"]
    );
    assert.equal(conflict.hasConflict, false);
    client.clear();
  });

  /*───────────────────── Concurrency: Overlap helper ─────────────────────*/
  await test("concurrency: overlaps returns true for overlapping intervals", async () => {
    const a = { start: new Date("2026-12-01T08:00:00Z"), end: new Date("2026-12-01T10:00:00Z") };
    const b = { start: new Date("2026-12-01T09:00:00Z"), end: new Date("2026-12-01T11:00:00Z") };
    assert.equal(overlaps(a, b), true);
  });

  await test("concurrency: overlaps returns false for adjacent intervals", async () => {
    const a = { start: new Date("2026-12-01T08:00:00Z"), end: new Date("2026-12-01T10:00:00Z") };
    const b = { start: new Date("2026-12-01T10:00:00Z"), end: new Date("2026-12-01T12:00:00Z") };
    assert.equal(overlaps(a, b), false);
  });

  await test("concurrency: withBuffer extends interval", async () => {
    const i = { start: new Date("2026-12-01T08:00:00Z"), end: new Date("2026-12-01T10:00:00Z") };
    const buffered = withBuffer(i, 0, 30);
    assert.equal(buffered.end.getTime(), new Date("2026-12-01T10:30:00Z").getTime());
    assert.equal(buffered.start.getTime(), new Date("2026-12-01T08:00:00Z").getTime());
  });

  /*───────────────────── Reconciliation: Audit gaps ─────────────────────*/
  await test("reconciliation: findAuditGaps detects booking without auditId", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });
    const booking = makeBooking({ id: "bk-gap-1", auditId: null });
    await repo.createBooking(booking);
    const gaps = await repo.findAuditGaps();
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].bookingId, "bk-gap-1");
    assert.equal(gaps[0].auditId, null);
    client.clear();
  });

  await test("reconciliation: findAuditGaps detects missing audit event", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });
    const booking = makeBooking({ id: "bk-gap-2", auditId: "evt-missing" });
    await repo.createBooking(booking);
    const gaps = await repo.findAuditGaps();
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].auditId, "evt-missing");
    client.clear();
  });

  await test("reconciliation: findAuditGaps returns empty when all audits present", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });
    const booking = makeBooking({ id: "bk-ok-audit", auditId: "evt-exists" });
    await repo.createBooking(booking);
    await repo.createAuditEvent(makeAudit({ booking_id: "bk-ok-audit", eventId: "evt-exists" }));
    const gaps = await repo.findAuditGaps();
    assert.equal(gaps.length, 0);
    client.clear();
  });

  /*───────────────────── Read-after-write verification ─────────────────────*/
  await test("repository: createBooking read-after-write verification", async () => {
    const client = new MockAddInDataGateway();
    const repo = new AddInDataRepository({ api: client, addInId: client.addInId });
    const booking = makeBooking();
    const result = await repo.createBooking(booking);
    assert.equal(result.created, true);
    assert.ok(result.entityId);
    const verify = await repo.getBooking(result.entityId);
    assert.ok(verify);
    assert.equal(verify.id, booking.id);
    client.clear();
  });

  console.log(`\n# ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
