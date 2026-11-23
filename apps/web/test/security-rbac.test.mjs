/*───────────────────── Security / RBAC Tests ─────────────────────*/
/* Tests for default-deny permission policies, driver isolation,
   role escalation prevention, and invalid driver mapping. */

import assert from "node:assert/strict";
import { createPermissionPolicy } from "../src/security/index.ts";
import {
  canApprove, canAssign, canCancel, canViewBooking,
  canModifyBooking, canCancelBooking, APPROVER_ROLES,
  ASSIGN_ROLES, CANCEL_ADMIN_ROLES, isValidTransition,
} from "../src/domain/index.ts";

function principal(overrides) {
  return {
    appUserId: "user-001",
    geotabUserId: "user-001",
    roles: ["EMPLOYEE"],
    siteIds: [],
    ...overrides,
  };
}

const booking = {
  id: "bk-001",
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
};

const driverBooking = {
  ...booking,
  id: "bk-002",
  assignedDriverUserId: "driver-001",
};

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

  /*───────────────────── Default deny ─────────────────────*/
  await test("default deny: EMPLOYEE cannot approve another's booking", async () => {
    const p = principal({ roles: ["EMPLOYEE"] });
    const policy = createPermissionPolicy(p);
    const decision = policy.canApprove({ ...booking, requesterUserId: "user-002" });
    assert.equal(decision.allowed, false);
  });

  await test("default deny: EMPLOYEE cannot assign", async () => {
    const p = principal({ roles: ["EMPLOYEE"] });
    const policy = createPermissionPolicy(p);
    const decision = policy.canAssign();
    assert.equal(decision.allowed, false);
  });

  await test("default deny: EMPLOYEE cannot cancel another's booking", async () => {
    const p = principal({ roles: ["EMPLOYEE"] });
    const policy = createPermissionPolicy(p);
    const decision = policy.canCancel({ ...booking, requesterUserId: "user-002" });
    assert.equal(decision.allowed, false);
  });

  await test("default deny: empty principal cannot view all", async () => {
    const p = principal({ appUserId: "", roles: [] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canViewAll().allowed, false);
    assert.equal(policy.canAssign().allowed, false);
  });

  /*───────────────────── Role-based access ─────────────────────*/
  await test("APPROVER can approve another's booking", async () => {
    const p = principal({ roles: ["APPROVER"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canApprove({ ...booking, requesterUserId: "user-002" }).allowed, true);
  });

  await test("MANAGEMENT can approve another's booking", async () => {
    const p = principal({ roles: ["MANAGEMENT"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canApprove({ ...booking, requesterUserId: "user-002" }).allowed, true);
  });

  await test("ADMIN can approve another's booking", async () => {
    const p = principal({ roles: ["ADMIN"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canApprove({ ...booking, requesterUserId: "user-002" }).allowed, true);
  });

  await test("GA can assign", async () => {
    const p = principal({ roles: ["GA"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canAssign().allowed, true);
  });

  await test("ADMIN can assign", async () => {
    const p = principal({ roles: ["ADMIN"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canAssign().allowed, true);
  });

  await test("MANAGEMENT can cancel any booking", async () => {
    const p = principal({ roles: ["MANAGEMENT"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canCancel({ ...booking, requesterUserId: "user-002" }).allowed, true);
  });

  await test("ADMIN can cancel any booking", async () => {
    const p = principal({ roles: ["ADMIN"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canCancel({ ...booking, requesterUserId: "user-002" }).allowed, true);
  });

  await test("APPROVER cannot cancel another's booking", async () => {
    const p = principal({ roles: ["APPROVER"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canCancel({ ...booking, requesterUserId: "user-002" }).allowed, false);
  });

  await test("APPROVER cannot assign", async () => {
    const p = principal({ roles: ["APPROVER"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canAssign().allowed, false);
  });

  /*───────────────────── Self-approval prohibition ─────────────────────*/
  await test("self-approval prohibited: APPROVER cannot approve own booking", async () => {
    const p = principal({ roles: ["APPROVER"], appUserId: "user-001" });
    const policy = createPermissionPolicy(p);
    const decision = policy.canApprove({ ...booking, requesterUserId: "user-001" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "SELF_APPROVAL_PROHIBITED");
  });

  /*───────────────────── Role escalation prevention ─────────────────────*/
  await test("role escalation: APPROVER_ROLES does not include DRIVER or EMPLOYEE", async () => {
    assert.equal(APPROVER_ROLES.includes("DRIVER"), false);
    assert.equal(APPROVER_ROLES.includes("EMPLOYEE"), false);
  });

  await test("role escalation: ASSIGN_ROLES does not include DRIVER or EMPLOYEE", async () => {
    assert.equal(ASSIGN_ROLES.includes("DRIVER"), false);
    assert.equal(ASSIGN_ROLES.includes("EMPLOYEE"), false);
  });

  await test("role escalation: CANCEL_ADMIN_ROLES does not include DRIVER or APPROVER", async () => {
    assert.equal(CANCEL_ADMIN_ROLES.includes("DRIVER"), false);
    assert.equal(CANCEL_ADMIN_ROLES.includes("APPROVER"), false);
  });

  await test("domain: EMPLOYEE cannot approve (canApprove helper)", async () => {
    const p = principal({ roles: ["EMPLOYEE"] });
    assert.equal(canApprove(p, "user-002"), false);
  });

  await test("domain: DRIVER cannot approve", async () => {
    const p = principal({ roles: ["DRIVER"] });
    assert.equal(canApprove(p, "user-002"), false);
  });

  await test("domain: GA cannot approve", async () => {
    const p = principal({ roles: ["GA"] });
    assert.equal(canApprove(p, "user-002"), false);
  });

  await test("domain: DRIVER cannot assign", async () => {
    const p = principal({ roles: ["DRIVER"] });
    assert.equal(canAssign(p), false);
  });

  /*───────────────────── Driver isolation ─────────────────────*/
  await test("driver isolation: driver can view their assigned booking", async () => {
    const p = principal({ roles: ["DRIVER"], appUserId: "driver-001" });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canView(driverBooking).allowed, true);
  });

  await test("driver isolation: driver cannot view another driver's booking", async () => {
    const p = principal({ roles: ["DRIVER"], appUserId: "driver-002" });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canView(driverBooking).allowed, false);
  });

  await test("driver isolation: driverScopeFilter returns driver id for DRIVER role", async () => {
    const p = principal({ roles: ["DRIVER"], appUserId: "driver-001" });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.driverScopeFilter(), "driver-001");
  });

  await test("driver isolation: driverScopeFilter returns null for non-driver", async () => {
    const p = principal({ roles: ["EMPLOYEE"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.driverScopeFilter(), null);
  });

  await test("driver isolation: requester can view own booking even as driver", async () => {
    const p = principal({ roles: ["DRIVER"], appUserId: "user-001" });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.canView({ ...booking, assignedDriverUserId: "driver-002", requesterUserId: "user-001" }).allowed, true);
  });

  /*───────────────────── Invalid driver mapping ─────────────────────*/
  await test("invalid driver mapping: driverId does not match principal", async () => {
    const p = principal({ roles: ["DRIVER"], appUserId: "driver-001" });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.validateDriverMapping("driver-002"), false);
  });

  await test("invalid driver mapping: matching driverId is valid", async () => {
    const p = principal({ roles: ["DRIVER"], appUserId: "driver-001" });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.validateDriverMapping("driver-001"), true);
  });

  await test("invalid driver mapping: null driverId is always valid", async () => {
    const p = principal({ roles: ["EMPLOYEE"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.validateDriverMapping(null), true);
  });

  await test("invalid driver mapping: empty string driverId is valid (no driver)", async () => {
    const p = principal({ roles: ["EMPLOYEE"] });
    const policy = createPermissionPolicy(p);
    assert.equal(policy.validateDriverMapping(""), true);
  });

  /*───────────────────── canViewBooking domain helper ─────────────────────*/
  await test("domain: canViewBooking - requester can view own", async () => {
    const p = principal({ roles: ["EMPLOYEE"], appUserId: "user-001" });
    assert.equal(canViewBooking(p, booking), true);
  });

  await test("domain: canViewBooking - employee cannot view another's", async () => {
    const p = principal({ roles: ["EMPLOYEE"], appUserId: "user-002" });
    assert.equal(canViewBooking(p, booking), false);
  });

  await test("domain: canViewBooking - approver can view any", async () => {
    const p = principal({ roles: ["APPROVER"], appUserId: "user-003" });
    assert.equal(canViewBooking(p, booking), true);
  });

  await test("domain: canViewBooking - assigned driver can view", async () => {
    const p = principal({ roles: ["DRIVER"], appUserId: "driver-001" });
    assert.equal(canViewBooking(p, driverBooking), true);
  });

  await test("domain: canViewBooking - driver cannot view another's assigned booking", async () => {
    const p = principal({ roles: ["DRIVER"], appUserId: "driver-002" });
    assert.equal(canViewBooking(p, driverBooking), false);
  });

  /*───────────────────── canModifyBooking domain helper ─────────────────────*/
  await test("domain: canModifyBooking - requester can modify own", async () => {
    const p = principal({ roles: ["EMPLOYEE"], appUserId: "user-001" });
    assert.equal(canModifyBooking(p, booking), true);
  });

  await test("domain: canModifyBooking - employee cannot modify another's", async () => {
    const p = principal({ roles: ["EMPLOYEE"], appUserId: "user-002" });
    assert.equal(canModifyBooking(p, booking), false);
  });

  await test("domain: canModifyBooking - admin can modify any", async () => {
    const p = principal({ roles: ["ADMIN"], appUserId: "user-003" });
    assert.equal(canModifyBooking(p, booking), true);
  });

  /*───────────────────── canCancelBooking domain helper ─────────────────────*/
  await test("domain: canCancelBooking - requester can cancel own", async () => {
    const p = principal({ roles: ["EMPLOYEE"], appUserId: "user-001" });
    assert.equal(canCancelBooking(p, booking), true);
  });

  await test("domain: canCancelBooking - employee cannot cancel another's", async () => {
    const p = principal({ roles: ["EMPLOYEE"], appUserId: "user-002" });
    assert.equal(canCancelBooking(p, booking), false);
  });

  await test("domain: canCancelBooking - approver cannot cancel another's", async () => {
    const p = principal({ roles: ["APPROVER"], appUserId: "user-003" });
    assert.equal(canCancelBooking(p, booking), false);
  });

  /*───────────────────── Transition validity ─────────────────────*/
  await test("transition: PENDING_APPROVAL → APPROVED is valid", async () => {
    assert.equal(isValidTransition("PENDING_APPROVAL", "APPROVED"), true);
  });

  await test("transition: PENDING_APPROVAL → ASSIGNED is invalid", async () => {
    assert.equal(isValidTransition("PENDING_APPROVAL", "ASSIGNED"), false);
  });

  await test("transition: terminal state CANCELLED has no outgoing", async () => {
    assert.equal(isValidTransition("CANCELLED", "APPROVED"), false);
  });

  console.log(`\n# ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
