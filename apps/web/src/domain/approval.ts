/*───────────────────── Domain: Approval ─────────────────────*/
/* Pure approval workflow business rules. No persistence, no Hono dependency. */

import type { OpexBooking, Principal, BookingRole } from "./booking.ts";
import { APPROVER_ROLES, ASSIGN_ROLES, CANCEL_ADMIN_ROLES, isValidTransition, canApprove, canAssign, canCancel, canCancelBooking } from "./booking.ts";

export type ApprovalDecision = "approve" | "reject";

export type ApprovalInput = {
  bookingId: string;
  approverId: string;
  comments?: string;
  stepNo?: number;
};

export type RejectionInput = {
  bookingId: string;
  rejecterId: string;
  reason?: string;
  comments?: string;
  stepNo?: number;
};

export type ApprovalResult = {
  bookingId: string;
  status: string;
  approval: { id: string; comments: string | null; reason: string | null };
  auditId: string;
  auditPersisted: boolean;
};

export function canPerformApproval(principal: Principal, requesterId: string): boolean {
  return canApprove(principal, requesterId);
}

export function canPerformAssignment(principal: Principal): boolean {
  return canAssign(principal);
}

export function canPerformCancellation(principal: Principal, requesterId: string): boolean {
  return canCancel(principal, requesterId);
}

export function validateApprovalTransition(booking: OpexBooking, decision: ApprovalDecision): boolean {
  if (decision === "approve") return isValidTransition(booking.status, "APPROVED");
  if (decision === "reject") return isValidTransition(booking.status, "REJECTED");
  return false;
}

export function buildApprovalChanges(booking: OpexBooking, decision: ApprovalDecision, actorId: string, comments?: string, reason?: string) {
  const now = new Date().toISOString();
  const changes: Array<{ field: string; previousValue: unknown; newValue: unknown }> = [];

  if (decision === "approve") {
    changes.push({ field: "status", previousValue: booking.status, newValue: "APPROVED" });
    changes.push({ field: "approverId", previousValue: booking.approverId, newValue: actorId });
    return {
      status: "APPROVED",
      approverId: actorId,
      approvalRemarks: comments ?? null,
      changes,
      eventType: "BOOKING_APPROVED",
      previousStatus: booking.status,
      newStatus: "APPROVED",
      details: { comments: comments ?? null },
    };
  }

  changes.push({ field: "status", previousValue: booking.status, newValue: "REJECTED" });
  changes.push({ field: "approvalRemarks", previousValue: booking.approvalRemarks, newValue: comments ?? null });
  return {
    status: "REJECTED",
    approverId: booking.approverId,
    approvalRemarks: comments ?? null,
    changes,
    eventType: "BOOKING_REJECTED",
    previousStatus: booking.status,
    newStatus: "REJECTED",
    details: { reason: reason ?? null, comments: comments ?? null },
  };
}

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
