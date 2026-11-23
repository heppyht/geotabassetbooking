/*───────────────────── Repository: AddInData ─────────────────────*/
/* Single consistent repository interface for all AddInData operations.
   One JSON serialization boundary (envelope format). 10,000-char record limit.
   periodKey = YYYY-MM partitioning.
   Safe retry only for read operations.
   Read-after-write verification for critical operations.
   Uses the existing AddInDataGateway (geotab.addin.call() wrapper) — no duplicate API client. */

import type { OpexBooking } from "../../domain/booking.ts";
import { AddInDataGateway } from "../../data/addinDataService.ts";
import { makePeriodKey } from "../../data/types.ts";

const GROUP_ID = "GroupCompanyId";
const MAX_DETAILS_CHARS = 10000;
const BOOKING_ADDIN_ID_RECORD_TYPE = "booking";
const AUDIT_ADDIN_ID_RECORD_TYPE = "booking_audit";
const NOTIFICATION_ADDIN_ID_RECORD_TYPE = "notification";

export type BookingRecord = OpexBooking & { recordType: string; schemaVersion: number };

export type AuditEvent = {
  id: string;
  booking_id: string;
  eventId: string;
  eventType: string;
  actor_user_id: string;
  previous_status: string | null;
  new_status: string | null;
  changes: Array<{ field: string; previousValue: unknown; newValue: unknown }>;
  details: Record<string, unknown> | null;
  created_at: string;
  schemaVersion: number;
};

export type NotificationRecord = {
  id: string;
  eventId: string;
  idempotencyKey: string;
  type: string;
  recipient_user_id: string;
  related_booking_id: string | null;
  title: string;
  message: string;
  is_read: boolean;
  delivery_status: "pending" | "delivered" | "failed";
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AddInDataEnvelope<T> = {
  recordType: string;
  schemaVersion: number;
  data: T;
};

export type AddInDataRepositoryOptions = {
  api: AddInDataGateway;
  addInId: string;
  groupId?: string;
};

function serializeEnvelope<T>(data: T, recordType: string): string {
  const envelope: AddInDataEnvelope<T> = { recordType, schemaVersion: 2, data };
  const json = JSON.stringify(envelope);
  if (json.length > MAX_DETAILS_CHARS) {
    throw new Error(`ADDIN_DATA_DETAILS_EXCEEDED: ${json.length} chars (max ${MAX_DETAILS_CHARS})`);
  }
  return json;
}

function deserializeEnvelope<T>(details: string | Record<string, unknown> | null | undefined): AddInDataEnvelope<T> | null {
  if (!details) return null;
  try {
    const parsed = typeof details === "string" ? (JSON.parse(details) as AddInDataEnvelope<T>) : (details as AddInDataEnvelope<T>);
    if (parsed && typeof parsed.recordType === "string" && typeof parsed.schemaVersion === "number" && parsed.data) return parsed;
    return null;
  } catch {
    return null;
  }
}

export class AddInDataRepository {
  private readonly api: AddInDataGateway;
  private readonly addInId: string;
  private readonly groupId: string;

  constructor(options: AddInDataRepositoryOptions) {
    this.api = options.api;
    this.addInId = options.addInId;
    this.groupId = options.groupId ?? GROUP_ID;
  }

  /*───────────────────── Booking operations ─────────────────────*/

  async getBooking(bookingId: string): Promise<BookingRecord | null> {
    const records = await this.api.search("AddInData", {
      addInId: this.addInId,
      recordType: BOOKING_ADDIN_ID_RECORD_TYPE,
    });
    for (const record of records) {
      if (record.id === bookingId) {
        const env = deserializeEnvelope<BookingRecord>(record.details);
        if (env) return env.data;
      }
      const env = deserializeEnvelope<BookingRecord>(record.details);
      if (env && env.data.id === bookingId) return env.data;
    }
    return null;
  }

  async listBookingsByPeriod(periodKey: string): Promise<BookingRecord[]> {
    const records = await this.api.search("AddInData", {
      addInId: this.addInId,
      recordType: BOOKING_ADDIN_ID_RECORD_TYPE,
      periodKey,
    });
    const result: BookingRecord[] = [];
    for (const record of records) {
      const env = deserializeEnvelope<BookingRecord>(record.details);
      if (env) result.push(env.data);
    }
    return result;
  }

  async listAllBookings(): Promise<BookingRecord[]> {
    const records = await this.api.search("AddInData", {
      addInId: this.addInId,
      recordType: BOOKING_ADDIN_ID_RECORD_TYPE,
    });
    const result: BookingRecord[] = [];
    for (const record of records) {
      const env = deserializeEnvelope<BookingRecord>(record.details);
      if (env) result.push(env.data);
    }
    return result;
  }

  async createBooking(booking: BookingRecord): Promise<{ created: boolean; entityId?: string }> {
    /* Idempotency: check if booking with this idempotency key already exists. */
    if (booking.idempotencyKey) {
      const existing = await this.findBookingByIdempotency(booking.idempotencyKey);
      if (existing) return { created: false, entityId: existing.recordId };
    }

    const details = serializeEnvelope(booking, BOOKING_ADDIN_ID_RECORD_TYPE);

    const result = await this.api.add("AddInData", {
      addInId: this.addInId,
      details,
      groups: [{ id: this.groupId }],
    });
    const entityId = result?.id ?? "";
    if (!entityId) throw new Error("ADDIN_DATA_ADD_FAILED: no entity id returned");

    /* Read-after-write verification. */
    const verify = await this.getBooking(entityId);
    if (!verify) throw new Error("ADDIN_DATA_ADD_FAILED: read-after-write verification failed");

    return { created: true, entityId };
  }

  async updateBooking(recordId: string, booking: BookingRecord): Promise<{ verified: boolean }> {
    const existing = await this.getBookingByRecordId(recordId);
    if (!existing) throw new Error("BOOKING_NOT_FOUND");

    /* Optimistic concurrency check. */
    if ((existing.version || 0) !== (booking.version || 0) - 1) {
      throw new Error("BOOKING_VERSION_CONFLICT: booking was modified by another request");
    }

    const details = serializeEnvelope(booking, BOOKING_ADDIN_ID_RECORD_TYPE);

    await this.api.set("AddInData", {
      addInId: this.addInId,
      id: recordId,
      details,
      groups: [{ id: this.groupId }],
    });

    /* Read-after-write verification. */
    const verify = await this.getBookingByRecordId(recordId);
    if (!verify) throw new Error("ADDIN_DATA_SET_FAILED: read-after-write verification failed");

    return { verified: true };
  }

  private async getBookingByRecordId(recordId: string): Promise<BookingRecord | null> {
    const records = await this.api.search("AddInData", {
      addInId: this.addInId,
      recordType: BOOKING_ADDIN_ID_RECORD_TYPE,
    });
    for (const record of records) {
      if (record.id === recordId) {
        const env = deserializeEnvelope<BookingRecord>(record.details);
        return env ? env.data : null;
      }
    }
    return null;
  }

  private async findBookingByIdempotency(idempotencyKey: string): Promise<{ recordId: string; booking: BookingRecord } | null> {
    const records = await this.api.search("AddInData", {
      addInId: this.addInId,
      recordType: BOOKING_ADDIN_ID_RECORD_TYPE,
    });
    for (const record of records) {
      const env = deserializeEnvelope<BookingRecord>(record.details);
      if (env && env.data.idempotencyKey === idempotencyKey) {
        return { recordId: record.id, booking: env.data };
      }
    }
    return null;
  }

  /*───────────────────── Audit operations ─────────────────────*/

  async createAuditEvent(audit: AuditEvent): Promise<{ entityId: string }> {
    /* Idempotency: check for existing audit with same eventId. */
    const existing = await this.findAuditEventByEventId(audit.booking_id, audit.eventId);
    if (existing) return { entityId: existing.recordId };

    const details = serializeEnvelope(audit, AUDIT_ADDIN_ID_RECORD_TYPE);

    const result = await this.api.add("AddInData", {
      addInId: this.addInId,
      details,
      groups: [{ id: this.groupId }],
    });
    const entityId = result?.id ?? "";
    if (!entityId) throw new Error("ADDIN_DATA_ADD_FAILED: audit entity id missing");

    return { entityId };
  }

  async readAuditHistory(bookingId: string): Promise<AuditEvent[]> {
    const records = await this.api.search("AddInData", {
      addInId: this.addInId,
      recordType: AUDIT_ADDIN_ID_RECORD_TYPE,
    });
    const result: AuditEvent[] = [];
    for (const record of records) {
      const env = deserializeEnvelope<AuditEvent>(record.details);
      if (env && env.data.booking_id === bookingId) result.push(env.data);
    }
    result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return result;
  }

  async findAuditEventByEventId(bookingId: string, eventId: string): Promise<{ recordId: string; audit: AuditEvent } | null> {
    const records = await this.api.search("AddInData", {
      addInId: this.addInId,
      recordType: AUDIT_ADDIN_ID_RECORD_TYPE,
    });
    for (const record of records) {
      const env = deserializeEnvelope<AuditEvent>(record.details);
      if (env && env.data.booking_id === bookingId && env.data.eventId === eventId) {
        return { recordId: record.id, audit: env.data };
      }
    }
    return null;
  }

  async findAuditGaps(): Promise<Array<{ bookingId: string; recordId: string; auditId: string | null }>> {
    const bookings = await this.listAllBookings();
    const gaps: Array<{ bookingId: string; recordId: string; auditId: string | null }> = [];
    for (const booking of bookings) {
      if (booking.auditId) {
        const exists = await this.findAuditEventByEventId(booking.id, booking.auditId);
        if (!exists) {
          gaps.push({ bookingId: booking.id, recordId: booking.id, auditId: booking.auditId });
        }
      } else {
        gaps.push({ bookingId: booking.id, recordId: booking.id, auditId: null });
      }
    }
    return gaps;
  }

  /*───────────────────── Notification operations ─────────────────────*/

  async createNotification(notification: NotificationRecord): Promise<{ created: boolean; entityId?: string }> {
    if (notification.idempotencyKey) {
      const existing = await this.findNotificationByIdempotency(notification.idempotencyKey);
      if (existing) return { created: false, entityId: existing.recordId };
    }

    const details = serializeEnvelope(notification, NOTIFICATION_ADDIN_ID_RECORD_TYPE);

    const result = await this.api.add("AddInData", {
      addInId: this.addInId,
      details,
      groups: [{ id: this.groupId }],
    });
    const entityId = result?.id ?? "";
    if (!entityId) throw new Error("ADDIN_DATA_ADD_FAILED: notification entity id missing");

    return { created: true, entityId };
  }

  async updateNotificationDeliveryStatus(recordId: string, status: "pending" | "delivered" | "failed"): Promise<void> {
    const records = await this.api.search("AddInData", {
      addInId: this.addInId,
      recordType: NOTIFICATION_ADDIN_ID_RECORD_TYPE,
    });
    for (const record of records) {
      if (record.id !== recordId) continue;
      const env = deserializeEnvelope<NotificationRecord>(record.details);
      if (!env) continue;
      const notification = { ...env.data, delivery_status: status, delivered_at: status === "delivered" ? new Date().toISOString() : env.data.delivered_at, updated_at: new Date().toISOString() };
      await this.api.set("AddInData", {
        addInId: this.addInId,
        id: recordId,
        details: serializeEnvelope(notification, NOTIFICATION_ADDIN_ID_RECORD_TYPE),
        groups: [{ id: this.groupId }],
      });
      return;
    }
  }

  async listPendingNotifications(limit = 10): Promise<NotificationRecord[]> {
    const records = await this.api.search("AddInData", {
      addInId: this.addInId,
      recordType: NOTIFICATION_ADDIN_ID_RECORD_TYPE,
    });
    const result: NotificationRecord[] = [];
    for (const record of records) {
      const env = deserializeEnvelope<NotificationRecord>(record.details);
      if (env && env.data.delivery_status === "pending") result.push(env.data);
    }
    return result.slice(0, limit);
  }

  private async findNotificationByIdempotency(idempotencyKey: string): Promise<{ recordId: string; notification: NotificationRecord } | null> {
    const records = await this.api.search("AddInData", {
      addInId: this.addInId,
      recordType: NOTIFICATION_ADDIN_ID_RECORD_TYPE,
    });
    for (const record of records) {
      const env = deserializeEnvelope<NotificationRecord>(record.details);
      if (env && env.data.idempotencyKey === idempotencyKey) {
        return { recordId: record.id, notification: env.data };
      }
    }
    return null;
  }
}
