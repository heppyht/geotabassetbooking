/*───────────────────── Concurrency Race Condition Reproduction ─────────────────────*/
/* Reproduces R6: Two users create overlapping bookings for the same vehicle
   concurrently. AddInData has no transactions, so read-then-write is not atomic.
   The mock defers Add writes so both Get calls complete before any write,
   simulating true distributed concurrent requests.
*/
import test from "node:test";
import assert from "node:assert/strict";

function makeConcurrentApi({ bookings = [] } = {}) {
  const records = bookings.map((b, i) => ({
    id: `rec-${i}`, addInId: "aDJjMmVmZWMtYzU1OC00MTJ", details: b,
    groups: [{ id: "GroupCompanyId" }] }));
  const api = {
    call(method, params, success, error) {
      if (method === "Get" && params.typeName === "AddInData") {
        return success(records);
      }
      if (method === "Add") {
        // Defer the write so concurrent Gets all see the pre-write state
        setTimeout(() => {
          const booking = params.entity.details;
          const newRecord = { id: `rec-${records.length}`, addInId: "aDJjMmVmZWMtYzU1OC00MTJ", details: booking,
            groups: [{ id: "GroupCompanyId" }] };
          records.push(newRecord);
          success({ id: `booking-${records.length}` });
        }, 50);
        return;
      }
      if (method === "Set" || method === "Remove") return success({});
      return success(null);
    },
  };
  return { api, records };
}

async function createBookingConcurrent(api, input) {
  const getResp = await new Promise((res) => api.call("Get", { typeName: "AddInData", search: { addInId: "x" } }, res));
  const existing = getResp.map(r => r.details);
  const conflictStatuses = ["PENDING_APPROVAL", "APPROVED", "ASSIGNED"];
  const newStart = new Date(input.startAt);
  const newEnd = new Date(input.endAt);
  const conflict = existing.find(b => {
    if (b.deviceId !== input.deviceId) return false;
    if (!conflictStatuses.includes(b.status)) return false;
    return newStart < new Date(b.endAt) && new Date(b.startAt) < newEnd;
  });
  if (conflict) throw new Error("ASSET_CONFLICT");
  const booking = { ...input, id: `booking-${Date.now()}`, status: "PENDING_APPROVAL", version: 1 };
  await new Promise((res) => api.call("Add", { typeName: "AddInData", entity: { addInId: "x", details: booking, groups: [{ id: "GroupCompanyId" }] } }, res));
  return booking;
}

test("concurrency: two overlapping bookings for same vehicle can both succeed (race condition)", async () => {
  const { api, records } = makeConcurrentApi({
    bookings: [{
      id: "existing-1", deviceId: "veh-1", requesterUserId: "u-1",
      requestedClass: "PASSENGER", startAt: "2026-11-16T08:00:00Z",
      endAt: "2026-11-16T09:00:00Z", purpose: "trip", status: "APPROVED",
      createdAt: "2026-11-16T07:00:00Z", updatedAt: "2026-11-16T07:00:00Z", version: 1,
    }],
  });

  // Two users attempt overlapping bookings at the same time (both 9:30-10:30)
  // Neither overlaps with the existing 8:00-9:00 booking
  const user1 = createBookingConcurrent(api, {
    deviceId: "veh-1", requesterUserId: "u-2",
    requestedClass: "PASSENGER", startAt: "2026-11-16T09:30:00Z",
    endAt: "2026-11-16T10:30:00Z", purpose: "trip A",
  });
  const user2 = createBookingConcurrent(api, {
    deviceId: "veh-1", requesterUserId: "u-3",
    requestedClass: "PASSENGER", startAt: "2026-11-16T09:45:00Z",
    endAt: "2026-11-16T10:45:00Z", purpose: "trip B",
  });

  const results = await Promise.allSettled([user1, user2]);
  await new Promise(r => setTimeout(r, 200)); // let deferred Adds complete

  const succeeded = results.filter(r => r.status === "fulfilled").length;
  const failed = results.filter(r => r.status === "rejected").length;

  console.log(`Concurrent booking results: ${succeeded} succeeded, ${failed} failed`);
  console.log(`Total records after: ${records.length}`);

  // BUG: Both succeed because each read before either wrote → duplicate overlapping bookings
  assert.equal(succeeded, 2, "Both concurrent bookings succeed due to non-atomic read-then-write");
  assert.equal(failed, 0, "No conflict detected because each request read before the other wrote");
  assert.equal(records.length, 3, "Both bookings persisted → 3 total records (1 existing + 2 new)");
});

test("concurrency: sequential booking correctly rejects overlap", async () => {
  const { api } = makeConcurrentApi({
    bookings: [{
      id: "existing-1", deviceId: "veh-1", requesterUserId: "u-1",
      requestedClass: "PASSENGER", startAt: "2026-11-16T08:00:00Z",
      endAt: "2026-11-16T09:00:00Z", purpose: "trip", status: "APPROVED",
      createdAt: "2026-11-16T07:00:00Z", updatedAt: "2026-11-16T07:00:00Z", version: 1,
    }],
  });

  // First booking succeeds
  const first = await createBookingConcurrent(api, {
    deviceId: "veh-1", requesterUserId: "u-2",
    requestedClass: "PASSENGER", startAt: "2026-11-16T10:30:00Z",
    endAt: "2026-11-16T11:30:00Z", purpose: "trip A",
  });
  assert.ok(first);

  // Second overlapping booking should fail (sequential, so read sees the first write)
  await assert.rejects(
    createBookingConcurrent(api, {
      deviceId: "veh-1", requesterUserId: "u-3",
      requestedClass: "PASSENGER", startAt: "2026-11-16T11:00:00Z",
      endAt: "2026-11-16T12:00:00Z", purpose: "trip B",
    }),
    /ASSET_CONFLICT/
  );
});
