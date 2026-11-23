/*───────────────────── Domain: Booking ─────────────────────*/
/* Pure booking business rules: status transitions, authorization helpers,
   booking record shape. No persistence, no Hono, no MyGeotab dependency. */

export type BookingRole = "EMPLOYEE" | "APPROVER" | "GA" | "MANAGEMENT" | "ADMIN" | "DRIVER";

export const APPROVER_ROLES: BookingRole[] = ["APPROVER", "MANAGEMENT", "ADMIN"];
export const ASSIGN_ROLES: BookingRole[] = ["GA", "ADMIN"];
export const CANCEL_ADMIN_ROLES: BookingRole[] = ["MANAGEMENT", "ADMIN"];

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
  COMPLETED: [],
} as const;

export type OpexBooking = {
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
  auditId?: string;
};

export type Principal = {
  appUserId: string;
  geotabUserId: string;
  roles: BookingRole[];
  siteIds: string[];
};

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

export function canViewBooking(principal: Principal, booking: OpexBooking): boolean {
  if (principal.appUserId === booking.requesterUserId) return true;
  if (APPROVER_ROLES.some(r => principal.roles.includes(r))) return true;
  if (ASSIGN_ROLES.some(r => principal.roles.includes(r))) return true;
  if (booking.assignedDriverUserId && principal.appUserId === booking.assignedDriverUserId) return true;
  return false;
}

export function canModifyBooking(principal: Principal, booking: OpexBooking): boolean {
  if (principal.appUserId === booking.requesterUserId) return true;
  if (APPROVER_ROLES.some(r => principal.roles.includes(r))) return true;
  if (ASSIGN_ROLES.some(r => principal.roles.includes(r))) return true;
  return false;
}

export function canCancelBooking(principal: Principal, booking: OpexBooking): boolean {
  if (principal.appUserId === booking.requesterUserId) return true;
  return CANCEL_ADMIN_ROLES.some(r => principal.roles.includes(r));
}

export function canViewDriverBookings(_principal: Principal): boolean {
  return true;
}

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export type BookingCreateInput = {
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
};

export function buildBooking(input: BookingCreateInput): OpexBooking {
  const now = input.createdAt || new Date().toISOString();
  return {
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
}

export type BookingUpdate = {
  status?: string;
  approverId?: string | null;
  approvalRemarks?: string | null;
  assignedDriverUserId?: string | null;
  version: number;
};

export function applyUpdate(booking: OpexBooking, update: BookingUpdate): OpexBooking {
  const now = new Date().toISOString();
  return {
    ...booking,
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(update.approverId !== undefined ? { approverId: update.approverId } : {}),
    ...(update.approvalRemarks !== undefined ? { approvalRemarks: update.approvalRemarks } : {}),
    ...(update.assignedDriverUserId !== undefined ? { assignedDriverUserId: update.assignedDriverUserId } : {}),
    updatedAt: now,
    version: (booking.version || 0) + 1,
  };
}

export function assertVersion(booking: OpexBooking, expectedVersion: number): void {
  if ((booking.version || 0) !== expectedVersion) {
    throw new Error("BOOKING_VERSION_CONFLICT: booking was modified by another request");
  }
}
