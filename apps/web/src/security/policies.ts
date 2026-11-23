/*───────────────────── Security: Centralized Permission Policies ─────────────────────*/
/* Default-deny authorization policies. Validated in domain services, not only
   in UI. Resolves authenticated identity from MyGeotab context.
   Never assumes client-side filtering provides server-side data isolation. */

import type { Principal, BookingRole } from "../domain/booking.ts";
import type { OpexBooking } from "../domain/booking.ts";
import { APPROVER_ROLES, ASSIGN_ROLES, CANCEL_ADMIN_ROLES } from "../domain/booking.ts";

export type PolicyDecision = { allowed: boolean; reason?: string };

export type Permission = "booking:create" | "booking:view" | "booking:modify" | "booking:cancel" | "booking:approve" | "booking:assign" | "booking:view-all" | "booking:view-driver";

export class PermissionPolicy {
  private readonly principal: Principal;

  constructor(principal: Principal) {
    this.principal = principal;
  }

  private defaultDeny(): PolicyDecision {
    return { allowed: false, reason: "DEFAULT_DENY" };
  }

  canCreate(): PolicyDecision {
    return { allowed: true };
  }

  canView(booking: OpexBooking): PolicyDecision {
    if (this.principal.appUserId === booking.requesterUserId) return { allowed: true };
    if (this.isApproverOrAdmin()) return { allowed: true };
    if (this.isGAOrAdmin()) return { allowed: true };
    if (booking.assignedDriverUserId && this.principal.appUserId === booking.assignedDriverUserId) return { allowed: true };
    return this.defaultDeny();
  }

  canViewAll(): PolicyDecision {
    if (this.isApproverOrAdmin() || this.isGAOrAdmin()) return { allowed: true };
    return this.defaultDeny();
  }

  canViewDriverBookings(): PolicyDecision {
    return { allowed: true };
  }

  canModify(booking: OpexBooking): PolicyDecision {
    if (this.principal.appUserId === booking.requesterUserId) return { allowed: true };
    if (this.isApproverOrAdmin() || this.isGAOrAdmin()) return { allowed: true };
    return this.defaultDeny();
  }

  canCancel(booking: OpexBooking): PolicyDecision {
    if (this.principal.appUserId === booking.requesterUserId) return { allowed: true };
    if (this.isManagementOrAdmin()) return { allowed: true };
    return this.defaultDeny();
  }

  canApprove(booking: OpexBooking): PolicyDecision {
    if (!this.isApproverOrAdmin()) return this.defaultDeny();
    if (this.principal.appUserId === booking.requesterUserId) return { allowed: false, reason: "SELF_APPROVAL_PROHIBITED" };
    return { allowed: true };
  }

  canAssign(): PolicyDecision {
    if (this.isGAOrAdmin()) return { allowed: true };
    return this.defaultDeny();
  }

  driverScopeFilter(): string | null {
    if (this.principal.roles.includes("DRIVER")) {
      return this.principal.appUserId;
    }
    return null;
  }

  validateDriverMapping(driverId: string | null): boolean {
    if (!driverId) return true;
    return driverId === this.principal.appUserId;
  }

  private isApproverOrAdmin(): boolean {
    return APPROVER_ROLES.some((r: BookingRole) => this.principal.roles.includes(r));
  }

  private isGAOrAdmin(): boolean {
    return ASSIGN_ROLES.some((r: BookingRole) => this.principal.roles.includes(r));
  }

  private isManagementOrAdmin(): boolean {
    return CANCEL_ADMIN_ROLES.some((r: BookingRole) => this.principal.roles.includes(r));
  }
}

export function createPermissionPolicy(principal: Principal): PermissionPolicy {
  return new PermissionPolicy(principal);
}
