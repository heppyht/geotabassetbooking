import test from "node:test";
import assert from "node:assert/strict";
import { AddInDataBookingDataProvider } from "../src/data/addinDataProvider.ts";

/* ── Mock API helper ───────────────────────────────────────────────────── */

function makeApi({
  session = { userName: "jdoe@company.com", database: "opex_trial", server: "srv" },
  userRecord = { id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq"] },
  users = [],
  devices = [],
  groups = [],
  addInData = [],
} = {}) {
  const calls = [];
  const api = {
    getSession(cb) { cb(session ?? null); },
    call(method, params, success, error) {
      calls.push({ method, params, typeName: params?.typeName });
      if (method !== "Get") return success(null);
      if (params.typeName === "Device") {
        if (params.search?.groups) {
          const wanted = new Set(params.search.groups.map((g) => g.id));
          return success(devices.filter((d) => (d.groupIds ?? []).some((gid) => wanted.has(gid))));
        }
        if (params.search?.userIds) {
          const wanted = new Set(params.search.userIds);
          return success(users.filter((u) => wanted.has(u.id)));
        }
        return success(devices);
      }
      if (params.typeName === "User") {
        if (params.search?.name !== undefined) {
          return success(users.filter((u) => (u.name ?? "").toLowerCase() === params.search.name.toLowerCase()));
        }
        if (params.search?.userIds) {
          const wanted = new Set(params.search.userIds);
          return success(users.filter((u) => wanted.has(u.id)));
        }
        return success(users);
      }
      if (params.typeName === "Group") {
        if (params.search?.id !== undefined) {
          return success(groups.filter((g) => g.id === params.search.id));
        }
        return success(groups);
      }
      if (params.typeName === "AddInData") {
        return success(addInData);
      }
      return success(null);
    },
  };
  return { api, calls };
}

function makeProvider({ api, addInId = "aDJjMmVmZWMtYzU1OC00MTJ" } = {}) {
  return new AddInDataBookingDataProvider(api, addInId);
}

/* ───────────────────────── ensurePrincipal override ───────────────────── */

function overrideEnsurePrincipal(provider, principal) {
  provider.ensurePrincipal = async () => {
    provider.principalCache = null;
    return principal;
  };
}

/* ───────────────────────── Core Permission Tests ────────────────────── */

test("getAssets scopes devices to principal's groups via DeviceSearch groups", async () => {
  const { api, calls } = makeApi({
    session: { userName: "jdoe@company.com", database: "opex_trial", server: "srv" },
    userRecord: { id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq", "grp-city"] },
    users: [{ id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq", "grp-city"] }],
    devices: [
      { id: "dev-1", name: "Toyota Fortuner", groupIds: ["grp-hq"], status: "AVAILABLE" },
      { id: "dev-2", name: "Toyota Zenix", groupIds: ["grp-city"], status: "AVAILABLE" },
      { id: "dev-3", name: "Toyota Hilux", groupIds: ["grp-warehouse"], status: "AVAILABLE" },
    ],
    groups: [
      { id: "grp-hq", name: "Head Office" },
      { id: "grp-city", name: "City Office" },
      { id: "grp-warehouse", name: "Warehouse" },
    ],
  });
  const provider = makeProvider({ api });
  overrideEnsurePrincipal(provider, {
    id: "u-1",
    name: "jdoe@company.com",
    companyGroups: ["grp-hq", "grp-city"],
    role: "APPROVER",
  });
  const assets = await provider.getAssets();
  const deviceGets = calls.filter(
    (c) => c.method === "Get" && c.typeName === "Device" && c.search?.groups,
  );
  assert.equal(deviceGets.length, 2, "Two group-scoped Device Get calls (grp-hq and grp-city)");
  assert.ok(deviceGets.every((c) => c.search.groups && c.search.groups.length > 0));
  const devIds = assets.map((a) => a.geotab_device_id);
  assert.ok(!devIds.includes("dev-3"), "Device outside principal's groups not returned");
});

test("getAssets returns [] when principal has no companyGroups", async () => {
  const { api } = makeApi({
    session: { userName: "jdoe@company.com", database: "opex_trial", server: "srv" },
    userRecord: { id: "u-1", name: "jdoe@company.com", role: "EMPLOYEE", companyGroups: [] },
  });
  const provider = makeProvider({ api, addInId: null });
  overrideEnsurePrincipal(provider, {
    id: "u-1",
    name: "jdoe@company.com",
    companyGroups: [],
    role: "EMPLOYEE",
  });
  const assets = await provider.getAssets();
  assert.ok(Array.isArray(assets) && assets.length === 0);
});

test("getUsers returns only the authenticated principal", async () => {
  const { api, calls } = makeApi({
    users: [{ id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq"] },
            { id: "u-2", name: "jane@company.com", role: "EMPLOYEE", companyGroups: ["grp-hq"] }],
    userRecord: { id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq"] },
  });
  const provider = makeProvider({ api });
  overrideEnsurePrincipal(provider, {
    id: "u-1",
    name: "jdoe@company.com",
    companyGroups: ["grp-hq"],
    role: "APPROVER",
  });
  const users = await provider.getUsers();
  assert.equal(users.length, 1, "getUsers returns exactly one user (the principal)");
  assert.equal(users[0].id, "u-1");
  assert.equal(users[0].name, "jdoe@company.com");
  const userGets = calls.filter(
    (c) => c.method === "Get" && c.typeName === "User" && c.search?.name,
  );
  assert.equal(userGets.length, 1, "One targeted User Get by name");
});

test("getUsers returns [] when not authenticated", async () => {
  const { api } = makeApi({ session: null });
  const provider = makeProvider({ api });
  overrideEnsurePrincipal(provider, null);
  const users = await provider.getUsers();
  assert.ok(Array.isArray(users) && users.length === 0);
});

test("getGroups returns principal's companyGroups with names", async () => {
  const { api, calls } = makeApi({
    users: [{ id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq", "grp-city"] }],
    groups: [
      { id: "grp-hq", name: "Head Office", parentId: undefined },
      { id: "grp-city", name: "City Office", parentId: "grp-hq" },
    ],
  });
  const provider = makeProvider({ api });
  overrideEnsurePrincipal(provider, {
    id: "u-1",
    name: "jdoe@company.com",
    companyGroups: ["grp-hq", "grp-city"],
    role: "APPROVER",
  });
  const groups = await provider.getGroups();
  assert.equal(groups.length, 2, "getGroups returns 2 groups");
  assert.ok(groups.map((g) => g.name).includes("Head Office"));
  assert.ok(groups.map((g) => g.name).includes("City Office"));
});

test("getGroups returns [] when principal has no groups", async () => {
  const { api } = makeApi({
    session: { userName: "jdoe@company.com", database: "opex_trial", server: "srv" },
    userRecord: { id: "u-1", name: "jdoe@company.com", role: "EMPLOYEE", companyGroups: [] },
  });
  const provider = makeProvider({ api, addInId: null });
  overrideEnsurePrincipal(provider, {
    id: "u-1",
    name: "jdoe@company.com",
    companyGroups: [],
    role: "EMPLOYEE",
  });
  const groups = await provider.getGroups();
  assert.ok(Array.isArray(groups) && groups.length === 0);
});

test("getApprovers includes principal when APPROVER and resolves from booking records", async () => {
  const { api } = makeApi({
    session: { userName: "jdoe@company.com", database: "opex_trial", server: "srv" },
    userRecord: { id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq"] },
    users: [
      { id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq"] },
      { id: "u-2", name: "jane@company.com", role: "EMPLOYEE", companyGroups: ["grp-hq"] },
      { id: "u-3", name: "bob@company.com", role: "EMPLOYEE", companyGroups: ["grp-hq"] },
    ],
  });
  const provider = makeProvider({ api, addInId: "test-id" });
  const originalSearch = provider["gateway"].search;
  provider["gateway"].search = async (search) => {
    if (search.typeName === "AddInData" && search.addInId === "test-id") {
      return [
        { id: "rec-1", addInId: "test-id", details: JSON.stringify({ id: "b-1", requesterUserId: "u-1", assignedDriverUserId: "u-2", status: "APPROVED", approverId: "u-3", requesterUserId: "u-1", deviceId: "dev-1", purpose: "test", startAt: "2026-11-13T08:00:00Z", endAt: "2026-11-13T17:00:00Z", bufferBeforeMinutes: 0, bufferAfterMinutes: 30, purpose: "test", destination: null, passengerCount: null }) },
        { id: "rec-2", addInId: "test-id", details: JSON.stringify({ id: "b-2", requesterUserId: "u-2", assignedDriverUserId: "u-1", status: "PENDING_APPROVAL", approverId: "u-4", requesterUserId: "u-2", deviceId: "dev-1", purpose: "test2", startAt: "2026-11-14T09:00:00Z", endAt: "2026-11-14T16:00:00Z", bufferBeforeMinutes: 0, bufferAfterMinutes: 30, purpose: "test2", destination: null, passengerCount: null }) },
      ];
    }
    return originalSearch?.(search) ?? [];
  };
  const approvers = await provider.getApprovers();
  const approverIds = approvers.map((a) => a.id);
  assert.ok(approverIds.includes("u-1"), "Principal (APPROVER) included as approver");
  assert.ok(approverIds.includes("u-3"), "Additional approver u-3 from booking records included");
  assert.ok(approverIds.includes("u-4"), "Additional approver u-4 from booking records included");
});

test("getBookings scopes devices to groups and resolves users by targeted lookup", async () => {
  const { api, calls } = makeApi({
    session: { userName: "jdoe@company.com", database: "opex_trial", server: "srv" },
    userRecord: { id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq"] },
    users: [
      { id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq"] },
      { id: "u-2", name: "jane@company.com", role: "EMPLOYEE", companyGroups: ["grp-hq"] },
    ],
    devices: [
      { id: "dev-1", name: "Toyota Fortuner", groupIds: ["grp-hq"], status: "AVAILABLE" },
      { id: "dev-2", name: "Toyota Hilux", groupIds: ["grp-warehouse"], status: "AVAILABLE" },
    ],
    addInData: [
      {
        id: "rec-1",
        addInId: "test-id",
        details: JSON.stringify({
          id: "b-1", deviceId: "dev-1", requesterUserId: "u-1", requestedClass: "PASSENGER",
          startAt: "2026-11-13T08:00:00Z", endAt: "2026-11-13T17:00:00Z",
          bufferBeforeMinutes: 0, bufferAfterMinutes: 30, purpose: "Site survey",
          destination: "Plantation A", passengerCount: 2, status: "PENDING_APPROVAL",
          assignedDriverUserId: null, approverId: null, approvalRemarks: null,
          createdAt: "2026-11-11T08:00:00Z", updatedAt: "2026-11-11T08:00:00Z", version: 1,
        }),
        groups: [{ id: "grp-hq" }],
      },
      {
        id: "rec-2",
        addInId: "test-id",
        details: JSON.stringify({
          id: "b-2", deviceId: "dev-2", requesterUserId: "u-2", requestedClass: "OPERATIONAL_4X4",
          startAt: "2026-11-14T09:00:00Z", endAt: "2026-11-14T16:00:00Z",
          bufferBeforeMinutes: 0, bufferAfterMinutes: 30, purpose: "Field inspection",
          destination: "Warehouse", passengerCount: 1, status: "PENDING_APPROVAL",
          assignedDriverUserId: "u-1", approverId: null, approvalRemarks: null,
          createdAt: "2026-11-11T09:00:00Z", updatedAt: "2026-11-11T09:00:00Z", version: 1,
        }),
        groups: [{ id: "grp-hq" }],
      },
    ],
  });
  const provider = makeProvider({ api, addInId: "test-id" });
  overrideEnsurePrincipal(provider, {
    id: "u-1",
    name: "jdoe@company.com",
    companyGroups: ["grp-hq"],
    role: "APPROVER",
  });
  const bookings = await provider.getBookings();
  assert.equal(bookings.length, 2, "Two bookings loaded");
  const b1 = bookings.find((b) => b.id === "b-1");
  assert.ok(b1, "Booking b-1 found");
  assert.equal(b1.dataQuality, "VALID", "Booking b-1 has VALID dataQuality");
  assert.equal(b1.asset_code, "VEH-101", "Booking b-1 asset_code from dev-1");
  const b2 = bookings.find((b) => b.id === "b-2");
  assert.ok(b2, "Booking b-2 found");
  assert.equal(b2.dataQuality, "MISSING_ASSET", "Booking b-2 has MISSING_ASSET dataQuality (device outside groups)");
  assert.ok(b2.asset_code === null || b2.asset_code === undefined, "Booking b-2 asset_code is null");
  assert.ok(b2.asset_name === null, "Booking b-2 asset_name is null");
  assert.equal(b2.requester_name, "jane@company.com", "Booking b-2 requester resolved from targeted lookup");
});

test("getBookings preserves booking with unresolved user reference (dataQuality MISSING_REQUESTER)", async () => {
  const { api } = makeApi({
    session: { userName: "jdoe@company.com", database: "opex_trial", server: "srv" },
    userRecord: { id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq"] },
    users: [{ id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq"] }],
    devices: [{ id: "dev-1", name: "Toyota Fortuner", groupIds: ["grp-hq"], status: "AVAILABLE" }],
    addInData: [
      {
        id: "rec-1",
        addInId: "test-id",
        details: JSON.stringify({
          id: "b-1", deviceId: "dev-1", requesterUserId: "u-99",
          requestedClass: "PASSENGER", startAt: "2026-11-13T08:00:00Z", endAt: "2026-11-13T17:00:00Z",
          bufferBeforeMinutes: 0, bufferAfterMinutes: 30, purpose: "Test",
          destination: null, passengerCount: null, status: "PENDING_APPROVAL",
          assignedDriverUserId: null, approverId: null, approvalRemarks: null,
          createdAt: "2026-11-11T08:00:00Z", updatedAt: "2026-11-11T08:00:00Z", version: 1,
        }),
        groups: [{ id: "grp-hq" }],
      },
    ],
  });
  const provider = makeProvider({ api, addInId: "test-id" });
  overrideEnsurePrincipal(provider, {
    id: "u-1",
    name: "jdoe@company.com",
    companyGroups: ["grp-hq"],
    role: "APPROVER",
  });
  const bookings = await provider.getBookings();
  const b1 = bookings.find((b) => b.id === "b-1");
  assert.ok(b1, "Booking preserved despite unresolved user");
  assert.equal(b1.dataQuality, "MISSING_REQUESTER", "dataQuality = MISSING_REQUESTER");
  assert.equal(b1.requester_name, "Unknown User", "requester_name = Unknown User");
  assert.equal(b1.requester_id, "u-99", "requester_id preserved as u-99");
});

test("getBookingById resolves target booking with scoped devices + targeted users", async () => {
  const { api } = makeApi({
    session: { userName: "jdoe@company.com", database: "opex_trial", server: "srv" },
    userRecord: { id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq"] },
    users: [
      { id: "u-1", name: "jdoe@company.com", role: "APPROVER", companyGroups: ["grp-hq"] },
      { id: "u-2", name: "jane@company.com", role: "EMPLOYEE", companyGroups: ["grp-hq"] },
    ],
    devices: [{ id: "dev-1", name: "Toyota Fortuner", groupIds: ["grp-hq"], status: "AVAILABLE" }],
    addInData: [
      {
        id: "rec-b1", addInId: "test-id",
        details: JSON.stringify({ id: "b-1", requesterUserId: "u-1", assignedDriverUserId: "u-2", status: "APPROVED" }),
        groups: [{ id: "grp-hq" }],
      },
    ],
  });
  const provider = makeProvider({ api, addInId: "test-id" });
  overrideEnsurePrincipal(provider, {
    id: "u-1",
    name: "jdoe@company.com",
    companyGroups: ["grp-hq"],
    role: "APPROVER",
  });
  const found = await provider.getBookingById("b-1");
  assert.ok(found, "Booking b-1 found by id");
  assert.equal(found.id, "b-1", "Resolved booking id matches");
  assert.equal(found.requester_name, "jdoe@company.com", "Requester resolved");
  assert.equal(found.driver_name, "jane@company.com", "Driver resolved from targeted lookup");
});

test("getBookingById returns null for non-existent booking", async () => {
  const { api } = makeApi({ session: { userName: "jdoe@company.com", database: "opex_trial", server: "srv" } });
  const provider = makeProvider({ api });
  overrideEnsurePrincipal(provider, {
    id: "u-1",
    name: "jdoe@company.com",
    companyGroups: ["grp-hq"],
    role: "APPROVER",
  });
  const found = await provider.getBookingById("non-existent-id");
  assert.ok(found === null, "getBookingById returns null for non-existent booking");
});