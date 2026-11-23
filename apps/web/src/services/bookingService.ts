/*───────────────────── Service: Booking ─────────────────────*/
/* Booking service layer combining domain rules with AddInData repository.
   Pure TypeScript — no Hono, no framework dependency. */

import type { OpexBooking, Principal, BookingCreateInput } from "../domain/booking.ts";
import { isValidTransition, canViewBooking, canModifyBooking, canCancelBooking, canApprove, canAssign, buildBooking, applyUpdate, assertVersion } from "../domain/booking.ts";
import { findConflict, type Interval } from "../domain/scheduling.ts";
import type { AddInDataRepository, BookingRecord } from "../repositories/addinData/index.ts";

export type BookingConflict = {
  hasConflict: boolean;
  conflictingBookingId: string | null;
  conflictingStatus: string | null;
};

export class BookingService {
  private readonly repository: AddInDataRepository;

  constructor(repository: AddInDataRepository) {
    this.repository = repository;
  }

  async createBooking(input: BookingCreateInput, principal: Principal): Promise<{ booking: OpexBooking; created: boolean; conflict?: BookingConflict }> {
    const booking = buildBooking(input);

    const existing = await this.repository.listAllBookings();
    const conflictStatuses = ["PENDING_APPROVAL", "APPROVED", "ASSIGNED"];
    const candidate: Interval = { start: new Date(booking.startAt), end: new Date(booking.endAt) };
    const conflict = findConflict(candidate, existing as Array<{ id: string; startAt: string; endAt: string; status: string; deviceId: string }>, booking.deviceId, conflictStatuses);
    if (conflict.hasConflict) {
      return { booking, created: false, conflict };
    }

    const result = await this.repository.createBooking({ ...booking, recordType: "booking", schemaVersion: 2 });
    return { booking: { ...booking, id: result.entityId || booking.id }, created: result.created };
  }

  async getBooking(bookingId: string, principal: Principal): Promise<{ booking: OpexBooking | null; allowed: boolean }> {
    const record = await this.repository.getBooking(bookingId);
    if (!record) return { booking: null, allowed: false };
    const allowed = canViewBooking(principal, record);
    return { booking: allowed ? record : null, allowed };
  }

  async listBookings(principal: Principal): Promise<OpexBooking[]> {
    const all = await this.repository.listAllBookings();
    return all.filter((b: OpexBooking) => {
      if (principal.roles.includes("DRIVER")) {
        return b.assignedDriverUserId === principal.appUserId || b.requesterUserId === principal.appUserId;
      }
      return canViewBooking(principal, b);
    });
  }

  async updateBookingStatus(
    bookingId: string,
    updates: { status?: string; approverId?: string | null; approvalRemarks?: string | null; assignedDriverUserId?: string | null },
    principal: Principal,
    expectedVersion: number,
  ): Promise<{ booking: OpexBooking; verified: boolean }> {
    const record = await this.repository.getBooking(bookingId);
    if (!record) throw new Error("BOOKING_NOT_FOUND");

    if (!canModifyBooking(principal, record)) throw new Error("FORBIDDEN");

    assertVersion(record, expectedVersion);

    const updated = applyUpdate(record, { ...updates, version: (record.version || 0) + 1 });
    const result = await this.repository.updateBooking(record.id, { ...updated, recordType: "booking", schemaVersion: 2 });
    return { booking: updated, verified: result.verified };
  }

  async cancelBooking(bookingId: string, principal: Principal, reason?: string): Promise<{ booking: OpexBooking; verified: boolean }> {
    const record = await this.repository.getBooking(bookingId);
    if (!record) throw new Error("BOOKING_NOT_FOUND");

    if (!canCancelBooking(principal, record)) throw new Error("FORBIDDEN");

    if (!isValidTransition(record.status, "CANCELLED")) {
      throw new Error(`INVALID_TRANSITION: ${record.status} → CANCELLED`);
    }

    const updated = applyUpdate(record, { status: "CANCELLED", version: (record.version || 0) + 1 });
    const result = await this.repository.updateBooking(record.id, { ...updated, recordType: "booking", schemaVersion: 2 });
    return { booking: updated, verified: result.verified };
  }

  async assignBooking(
    bookingId: string,
    vehicleId: string,
    assignedBy: string,
    idempotencyKey: string,
    principal: Principal,
  ): Promise<{ booking: OpexBooking; verified: boolean }> {
    if (!canAssign(principal)) throw new Error("FORBIDDEN");

    const record = await this.repository.getBooking(bookingId);
    if (!record) throw new Error("BOOKING_NOT_FOUND");
    if (record.status !== "APPROVED") throw new Error("BOOKING_NOT_APPROVED");

    const existing = await this.repository.listAllBookings();
    const conflictStatuses = ["PENDING_APPROVAL", "APPROVED", "ASSIGNED"];
    const candidate: Interval = { start: new Date(record.startAt), end: new Date(record.endAt) };
    const conflict = findConflict(candidate, existing as Array<{ id: string; startAt: string; endAt: string; status: string; deviceId: string }>, vehicleId, conflictStatuses);
    if (conflict.hasConflict) throw new Error("VEHICLE_TIME_CONFLICT");

    const updated = applyUpdate(record, {
      status: "ASSIGNED",
      assignedDriverUserId: assignedBy,
      version: (record.version || 0) + 1,
    });
    const result = await this.repository.updateBooking(record.id, { ...updated, recordType: "booking", schemaVersion: 2 });
    return { booking: updated, verified: result.verified };
  }

  async getBookingsByDriver(driverId: string): Promise<OpexBooking[]> {
    const all = await this.repository.listAllBookings();
    return all.filter(b => b.assignedDriverUserId === driverId);
  }
}
