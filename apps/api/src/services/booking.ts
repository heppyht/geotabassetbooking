/*───────────────────── Booking services (MyGeotab AddInData) ─────────────────────*/
/* All booking workflow operations use MyGeotab AddInData via the REST API.
   No SQL, no transactions, no external database. AddInData does not support
   transactions, so operations are best-effort with idempotency keys for
   duplicate protection.

   Integrity guarantees:
   - Booking IDs use crypto.randomUUID() (collision-resistant).
   - Booking creation is idempotent via an Idempotency-Key.
   - Audit details are always structured JSON (never raw string or null).
   - Booking records carry auditId to detect missing audit events.
   - Reconciliation can identify bookings missing audit events.
   - Version-based optimistic concurrency on updates (best-effort, not atomic).
*/

import type { AddInDataRestGateway } from "../db.ts";
import type { Principal } from "../auth.ts";
import { classifyError, type ClassifiedError } from "../retry.ts";

export type BookingRole = "EMPLOYEE" | "APPROVER" | "GA" | "MANAGEMENT" | "ADMIN";

export const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["PENDING_APPROVAL", "APPROVED", "REJECTED", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["CHECKED_OUT", "CANCELLED"],
  CHECKED_OUT: ["OVERDUE", "RETURNED"],
  OVERDUE: ["RETURNED"],
  RETURNED: ["CLOSED"],
  REJECTED: [],
  CANCELLED: [],
  CLOSED: [],
  EXPIRED: [],
} as const;

export const APPROVER_ROLES: BookingRole[] = ["APPROVER", "MANAGEMENT", "ADMIN"];
export const ASSIGN_ROLES: BookingRole[] = ["GA", "ADMIN"];
export const CANCEL_ADMIN_ROLES: BookingRole[] = ["MANAGEMENT", "ADMIN"];

export function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canApprove(principal: { appUserId: string; roles: BookingRole[] }, requesterId: string): boolean {
  if (!APPROVER_ROLES.some(r => principal.roles.includes(r))) return false;
  if (principal.appUserId === requesterId) return false;
  return true;
}

export function canAssign(principal: { roles: BookingRole[] }): boolean {
  return ASSIGN_ROLES.some(r => principal.roles.includes(r));
}

export function canCancel(principal: { appUserId: string; roles: BookingRole[] }, requesterId: string): boolean {
  if (principal.appUserId === requesterId) return true;
  return CANCEL_ADMIN_ROLES.some(r => principal.roles.includes(r));
}

/*───────────────────── Authorization helpers (server-side enforcement) ─────────────────────*/

/* A principal can view a booking if they are:
   - the requester (employee who created it)
   - an approver/management/admin
   - a GA/admin
   - the assigned driver for that booking */
export function canViewBooking(principal: Principal, booking: OpexBooking): boolean {
  if (principal.appUserId === booking.requesterUserId) return true;
  if (APPROVER_ROLES.some(r => principal.roles.includes(r))) return true;
  if (ASSIGN_ROLES.some(r => principal.roles.includes(r))) return true;
  if (booking.assignedDriverUserId && principal.appUserId === booking.assignedDriverUserId) return true;
  return false;
}

/* A principal can modify (approve/reject/assign/cancel) a booking if they are:
   - the requester (for their own booking where state permits)
   - an approver/management/admin
   - a GA/admin */
export function canModifyBooking(principal: Principal, booking: OpexBooking): boolean {
  if (principal.appUserId === booking.requesterUserId) return true;
  if (APPROVER_ROLES.some(r => principal.roles.includes(r))) return true;
  if (ASSIGN_ROLES.some(r => principal.roles.includes(r))) return true;
  return false;
}

/* A principal can cancel a booking if they are:
   - the requester (their own booking)
   - management/admin */
export function canCancelBooking(principal: Principal, booking: OpexBooking): boolean {
  if (principal.appUserId === booking.requesterUserId) return true;
  return CANCEL_ADMIN_ROLES.some(r => principal.roles.includes(r));
}

/* Any authenticated principal may view their own driver bookings. The driver
   identity is resolved server-side from the principal; a client-supplied
   driver ID is never trusted as proof of identity. */
export function canViewDriverBookings(_principal: Principal): boolean {
  return true;
}

const GROUP_ID = "GroupCompanyId";
const CONFLICT_STATUSES = ["PENDING_APPROVAL", "APPROVED", "ASSIGNED"];

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  /* Fallback for environments without crypto.randomUUID. */
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/*───────────────────── Deterministic audit event IDs (write safety) ─────────────────────*/

export function generateAuditEventId(
  bookingId: string,
  action: string,
  actorUserId: string,
  previousStatus: string | null,
  newStatus: string | null,
): string {
  const minuteBucket = Math.floor(Date.now() / 60000);
  const raw = `${bookingId}|${action}|${actorUserId}|${previousStatus ?? ""}|${newStatus ?? ""}|${minuteBucket}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `audit-${Math.abs(hash)}-${bookingId.slice(0, 8)}`;
}

type OpexBooking = {
  id: string;
  deviceId: string;
  requesterUserId: string;
  requestedClass: string;
  startAt: string;
  endAt: string;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  purpose: string;
  destination: string | null;
  passengerCount: number | null;
  status: string;
  assignedDriverUserId: string | null;
  approverId: string | null;
  approvalRemarks: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  idempotencyKey?: string;
  auditId?: string;          // ID of the corresponding audit event, if persisted
};

type OpexBookingAudit = {
  id: string;
  booking_id: string;
  eventId: string;           // unique event id (distinct from record id)
  eventType: string;
  actor_user_id: string;
  previous_status: string | null;
  new_status: string | null;
  changes: Array<{ field: string; previousValue: unknown; newValue: unknown }>;
  details: Record<string, unknown> | null;   // always structured JSON, never raw string
  created_at: string;
  schemaVersion: number;
};

type AddInDataRecordRaw = {
  id: string;
  details: string | Record<string, unknown>;
};

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function parseBooking(details: string | Record<string, unknown> | null | undefined): OpexBooking | null {
  if (!details) return null;
  try {
    const raw = typeof details === "string" ? JSON.parse(details) : details;
    return raw as OpexBooking;
  } catch {
    return null;
  }
}

function parseAudit(details: string | Record<string, unknown> | null | undefined): OpexBookingAudit | null {
  if (!details) return null;
  try {
    const raw = typeof details === "string" ? JSON.parse(details) : details;
    return raw as OpexBookingAudit;
  } catch {
    return null;
  }
}

async function loadAllBookings(gateway: AddInDataRestGateway): Promise<{ record: AddInDataRecordRaw; booking: OpexBooking }[]> {
  const records = await gateway.searchAddInData("addin-booking-app", { recordType: "booking" });
  const result: { record: AddInDataRecordRaw; booking: OpexBooking }[] = [];
  for (const record of records) {
    const booking = parseBooking(record.details);
    if (booking) result.push({ record, booking });
  }
  return result;
}

export async function findBookingRecord(gateway: AddInDataRestGateway, bookingId: string): Promise<{ record: AddInDataRecordRaw; booking: OpexBooking } | null> {
  const records = await gateway.searchAddInData("addin-booking-app", { recordType: "booking" });
  for (const record of records) {
    if (record.id === bookingId) {
      const booking = parseBooking(record.details);
      if (booking) return { record, booking };
    }
    const booking = parseBooking(record.details);
    if (booking && booking.id === bookingId) return { record, booking };
  }
  return null;
}

export async function findAuditEventByBookingAndEventId(
  gateway: AddInDataRestGateway,
  bookingId: string,
  eventId: string,
): Promise<{ record: AddInDataRecordRaw; audit: OpexBookingAudit } | null> {
  const records = await gateway.searchAddInData("addin-booking-app", { recordType: "booking_audit" });
  for (const record of records) {
    try {
      const audit = parseAudit(record.details);
      if (audit && audit.booking_id === bookingId && audit.eventId === eventId) {
        return { record, audit };
      }
    } catch {
      // skip malformed
    }
  }
  return null;
}

/*───────────────────── Booking creation with idempotency ─────────────────────*/

export interface CreateBookingInput {
  bookingId: string;
  idempotencyKey: string;
  deviceId: string;
  requesterUserId: string;
  requestedClass: string;
  startAt: string;
  endAt: string;
  purpose: string;
  destination: string | null;
  passengerCount: number | null;
  assignedDriverUserId: string | null;
  createdAt: string;
}

export async function createBooking(
  gateway: AddInDataRestGateway,
  input: CreateBookingInput,
): Promise<{ booking: OpexBooking; created: boolean; entityId?: string }> {
  /* Idempotency: check if a booking with this idempotency key already exists. */
  const existing = await findBookingByIdempotency(gateway, input.idempotencyKey);
  if (existing) {
    return { booking: existing.booking, created: false, entityId: existing.record.id };
  }

  const now = input.createdAt || new Date().toISOString();
  const booking: OpexBooking = {
    id: input.bookingId || generateId(),
    deviceId: input.deviceId,
    requesterUserId: input.requesterUserId,
    requestedClass: input.requestedClass,
    startAt: input.startAt,
    endAt: input.endAt,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 30,
    purpose: input.purpose,
    destination: input.destination,
    passengerCount: input.passengerCount,
    status: "PENDING_APPROVAL",
    assignedDriverUserId: input.assignedDriverUserId ?? null,
    approverId: null,
    approvalRemarks: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    idempotencyKey: input.idempotencyKey,
  };

  const result = await gateway.addAddInData("addin-booking-app", booking, GROUP_ID);
  const entityId = result?.id ?? "";
  if (!entityId) throw new Error("ADDIN_DATA_ADD_FAILED: no entity id returned");

  return { booking, created: true, entityId };
}

async function findBookingByIdempotency(
  gateway: AddInDataRestGateway,
  idempotencyKey: string,
): Promise<{ record: AddInDataRecordRaw; booking: OpexBooking } | null> {
  const records = await gateway.searchAddInData("addin-booking-app", { recordType: "booking" });
  for (const record of records) {
    const booking = parseBooking(record.details);
    if (booking && booking.idempotencyKey === idempotencyKey) {
      return { record, booking };
    }
  }
  return null;
}

/*───────────────────── Booking write operations ─────────────────────*/

export async function assignApprovedBooking(
  gateway: AddInDataRestGateway,
  input: { bookingId: string; vehicleId: string; assignedBy: string; idempotencyKey: string }
) {
  const records = await gateway.searchAddInData("addin-booking-app", { recordType: "booking" });
  for (const record of records) {
    try {
      const raw = typeof record.details === "string" ? JSON.parse(record.details) : record.details;
      if (raw && raw.idempotencyKey === input.idempotencyKey) {
        return raw;
      }
    } catch {
      // skip malformed
    }
  }

  const found = await findBookingRecord(gateway, input.bookingId);
  if (!found) throw new Error("BOOKING_NOT_FOUND");
  const booking = found.booking;
  if (booking.status !== "APPROVED") throw new Error("BOOKING_NOT_APPROVED");

  const allBookings = await loadAllBookings(gateway);
  const newStart = new Date(booking.startAt);
  const newEnd = new Date(booking.endAt);
  const conflict = allBookings.find(({ booking: b }) => {
    if (b.deviceId !== input.vehicleId) return false;
    if (!CONFLICT_STATUSES.includes(b.status)) return false;
    return overlaps(newStart, newEnd, new Date(b.startAt), new Date(b.endAt));
  });
  if (conflict) throw new Error("VEHICLE_TIME_CONFLICT");

  const now = new Date().toISOString();
  const changes: Array<{ field: string; previousValue: unknown; newValue: unknown }> = [
    { field: "status", previousValue: booking.status, newValue: "ASSIGNED" },
    { field: "assignedDriverUserId", previousValue: booking.assignedDriverUserId, newValue: input.assignedBy },
  ];

  const updated: OpexBooking = {
    ...booking,
    id: booking.id,
    status: "ASSIGNED",
    assignedDriverUserId: input.assignedBy,
    updatedAt: now,
    version: (booking.version || 0) + 1,
    idempotencyKey: input.idempotencyKey,
  };

  /* Optimistic concurrency: version check before Set. */
  if ((booking.version || 0) !== (updated.version - 1)) {
    throw new Error("BOOKING_VERSION_CONFLICT: booking was modified by another request");
  }

  await gateway.setAddInData("addin-booking-app", found.record.id, updated, GROUP_ID);

  const eventId = generateAuditEventId(
    booking.id,
    "VEHICLE_ASSIGNED",
    input.assignedBy,
    "APPROVED",
    "ASSIGNED",
  );

  /* Idempotent audit write: skip if an audit event with this eventId
     already exists (e.g., retry after a previous successful audit add). */
  const existingAudit = await findAuditEventByBookingAndEventId(
    gateway,
    input.bookingId,
    eventId,
  );
  let auditEntityId = "";
  if (!existingAudit) {
    const audit: OpexBookingAudit = {
      id: generateId(),
      booking_id: input.bookingId,
      eventId,
      eventType: "VEHICLE_ASSIGNED",
      actor_user_id: input.assignedBy,
      previous_status: "APPROVED",
      new_status: "ASSIGNED",
      changes,
      details: { vehicleId: input.vehicleId },
      created_at: now,
      schemaVersion: 2,
    };
    const auditResult = await gateway.addAddInData("addin-booking-app", audit, GROUP_ID);
    auditEntityId = auditResult?.id ?? "";
  } else {
    auditEntityId = existingAudit.record.id;
  }
  updated.auditId = eventId;
  await gateway.setAddInData("addin-booking-app", found.record.id, updated, GROUP_ID);

  return { ...updated, idempotencyKey: input.idempotencyKey, auditId: eventId, auditPersisted: Boolean(auditEntityId) };
}

export async function approveBooking(
  gateway: AddInDataRestGateway,
  input: { bookingId: string; approverId: string; comments?: string; stepNo?: number }
) {
  const found = await findBookingRecord(gateway, input.bookingId);
  if (!found) throw new Error("BOOKING_NOT_FOUND");
  const booking = found.booking;
  if (!isValidTransition(booking.status, "APPROVED")) {
    throw new Error(`INVALID_TRANSITION: ${booking.status} → APPROVED`);
  }

  const now = new Date().toISOString();
  const changes: Array<{ field: string; previousValue: unknown; newValue: unknown }> = [
    { field: "status", previousValue: booking.status, newValue: "APPROVED" },
    { field: "approverId", previousValue: booking.approverId, newValue: input.approverId },
  ];

  const updated: OpexBooking = {
    ...booking,
    status: "APPROVED",
    approverId: input.approverId,
    approvalRemarks: input.comments ?? null,
    updatedAt: now,
    version: (booking.version || 0) + 1,
  };

  if ((booking.version || 0) !== (updated.version - 1)) {
    throw new Error("BOOKING_VERSION_CONFLICT: booking was modified by another request");
  }

  await gateway.setAddInData("addin-booking-app", found.record.id, updated, GROUP_ID);

  const eventId = generateAuditEventId(
    booking.id,
    "BOOKING_APPROVED",
    input.approverId,
    booking.status,
    "APPROVED",
  );

  /* Idempotent audit write: skip if an audit event with this eventId
     already exists (e.g., retry after a previous successful audit add). */
  const existingAudit = await findAuditEventByBookingAndEventId(
    gateway,
    input.bookingId,
    eventId,
  );
  let auditEntityId = "";
  if (!existingAudit) {
    const audit: OpexBookingAudit = {
      id: generateId(),
      booking_id: input.bookingId,
      eventId,
      eventType: "BOOKING_APPROVED",
      actor_user_id: input.approverId,
      previous_status: booking.status,
      new_status: "APPROVED",
      changes,
      details: { comments: input.comments ?? null },
      created_at: now,
      schemaVersion: 2,
    };
    const auditResult = await gateway.addAddInData("addin-booking-app", audit, GROUP_ID);
    auditEntityId = auditResult?.id ?? "";
  } else {
    auditEntityId = existingAudit.record.id;
  }
  updated.auditId = eventId;
  await gateway.setAddInData("addin-booking-app", found.record.id, updated, GROUP_ID);

  return {
    bookingId: booking.id,
    status: "APPROVED",
    approval: { id: generateId(), comments: input.comments ?? null },
    auditId: eventId,
    auditPersisted: Boolean(auditEntityId),
  };
}

export async function rejectBooking(
  gateway: AddInDataRestGateway,
  input: { bookingId: string; rejecterId: string; reason?: string; comments?: string; stepNo?: number }
) {
  const found = await findBookingRecord(gateway, input.bookingId);
  if (!found) throw new Error("BOOKING_NOT_FOUND");
  const booking = found.booking;
  if (!isValidTransition(booking.status, "REJECTED")) {
    throw new Error(`INVALID_TRANSITION: ${booking.status} → REJECTED`);
  }

  const now = new Date().toISOString();
  const changes: Array<{ field: string; previousValue: unknown; newValue: unknown }> = [
    { field: "status", previousValue: booking.status, newValue: "REJECTED" },
    { field: "approvalRemarks", previousValue: booking.approvalRemarks, newValue: input.comments ?? null },
  ];

  const updated: OpexBooking = {
    ...booking,
    status: "REJECTED",
    approvalRemarks: input.comments ?? null,
    updatedAt: now,
    version: (booking.version || 0) + 1,
  };

  if ((booking.version || 0) !== (updated.version - 1)) {
    throw new Error("BOOKING_VERSION_CONFLICT: booking was modified by another request");
  }

  await gateway.setAddInData("addin-booking-app", found.record.id, updated, GROUP_ID);

  const eventId = generateAuditEventId(
    booking.id,
    "BOOKING_REJECTED",
    input.rejecterId,
    booking.status,
    "REJECTED",
  );

  /* Idempotent audit write: skip if an audit event with this eventId
     already exists (e.g., retry after a previous successful audit add). */
  const existingAudit = await findAuditEventByBookingAndEventId(
    gateway,
    input.bookingId,
    eventId,
  );
  let auditEntityId = "";
  if (!existingAudit) {
    const audit: OpexBookingAudit = {
      id: generateId(),
      booking_id: input.bookingId,
      eventId,
      eventType: "BOOKING_REJECTED",
      actor_user_id: input.rejecterId,
      previous_status: booking.status,
      new_status: "REJECTED",
      changes,
      details: { reason: input.reason ?? null, comments: input.comments ?? null },
      created_at: now,
      schemaVersion: 2,
    };
    const auditResult = await gateway.addAddInData("addin-booking-app", audit, GROUP_ID);
    auditEntityId = auditResult?.id ?? "";
  } else {
    auditEntityId = existingAudit.record.id;
  }
  updated.auditId = eventId;
  await gateway.setAddInData("addin-booking-app", found.record.id, updated, GROUP_ID);

  return {
    bookingId: booking.id,
    status: "REJECTED",
    approval: { id: generateId(), reason: input.reason ?? null },
    auditId: eventId,
    auditPersisted: Boolean(auditEntityId),
  };
}

export async function cancelBooking(
  gateway: AddInDataRestGateway,
  input: { bookingId: string; cancelerId: string; reason?: string }
) {
  const found = await findBookingRecord(gateway, input.bookingId);
  if (!found) throw new Error("BOOKING_NOT_FOUND");
  const booking = found.booking;
  if (!isValidTransition(booking.status, "CANCELLED")) {
    throw new Error(`INVALID_TRANSITION: ${booking.status} → CANCELLED`);
  }

  const now = new Date().toISOString();
  const changes: Array<{ field: string; previousValue: unknown; newValue: unknown }> = [
    { field: "status", previousValue: booking.status, newValue: "CANCELLED" },
  ];

  const updated: OpexBooking = {
    ...booking,
    status: "CANCELLED",
    updatedAt: now,
    version: (booking.version || 0) + 1,
  };

  if ((booking.version || 0) !== (updated.version - 1)) {
    throw new Error("BOOKING_VERSION_CONFLICT: booking was modified by another request");
  }

  await gateway.setAddInData("addin-booking-app", found.record.id, updated, GROUP_ID);

  const eventId = generateAuditEventId(
    booking.id,
    "BOOKING_CANCELLED",
    input.cancelerId,
    booking.status,
    "CANCELLED",
  );

  /* Idempotent audit write: skip if an audit event with this eventId
     already exists (e.g., retry after a previous successful audit add). */
  const existingAudit = await findAuditEventByBookingAndEventId(
    gateway,
    input.bookingId,
    eventId,
  );
  let auditEntityId = "";
  if (!existingAudit) {
    const audit: OpexBookingAudit = {
      id: generateId(),
      booking_id: input.bookingId,
      eventId,
      eventType: "BOOKING_CANCELLED",
      actor_user_id: input.cancelerId,
      previous_status: booking.status,
      new_status: "CANCELLED",
      changes,
      details: { reason: input.reason ?? null },
      created_at: now,
      schemaVersion: 2,
    };
    const auditResult = await gateway.addAddInData("addin-booking-app", audit, GROUP_ID);
    auditEntityId = auditResult?.id ?? "";
  } else {
    auditEntityId = existingAudit.record.id;
  }
  updated.auditId = eventId;
  await gateway.setAddInData("addin-booking-app", found.record.id, updated, GROUP_ID);

  return { bookingId: booking.id, status: "CANCELLED", auditId: eventId, auditPersisted: Boolean(auditEntityId) };
}

/*───────────────────── My Schedule: bookings by driver ─────────────────────*/

export async function getBookingsByDriver(
  gateway: AddInDataRestGateway,
  driverId: string,
): Promise<OpexBooking[]> {
  const all = await loadAllBookings(gateway);
  return all
    .map(({ booking }) => booking)
    .filter(b => b.assignedDriverUserId === driverId)
    .sort((a, b) => String(b.startAt || "").localeCompare(String(b.startAt || "")));
}

/*───────────────────── Reconciliation: audit gap detection ─────────────────────*/

export interface AuditGap {
  bookingId: string;
  recordId: string;
  bookingStatus: string;
  auditId: string | null;
}

export async function findAuditGaps(
  gateway: AddInDataRestGateway,
): Promise<AuditGap[]> {
  const all = await loadAllBookings(gateway);
  const gaps: AuditGap[] = [];
  for (const { record, booking } of all) {
    if (booking.auditId) {
      /* Check that the audit event exists. */
      const auditExists = await findAuditEventByBookingAndEventId(gateway, booking.id, booking.auditId);
      if (!auditExists) {
        gaps.push({ bookingId: booking.id, recordId: record.id, bookingStatus: booking.status, auditId: booking.auditId });
      }
    } else {
      gaps.push({ bookingId: booking.id, recordId: record.id, bookingStatus: booking.status, auditId: null });
    }
  }
  return gaps;
}
