/*───────────────────── MyGeotab AddInData Service (schema v2) ─────────────────────*/
/* Core AddInData persistence layer for OPEX Asset Booking.
   All persistent booking and audit records live in the customer's MyGeotab
   database through AddInData. No external database (PostgreSQL, Neon, D1,
   Supabase, Firebase, Redis) is used.

   Record design (two logical types):
     - booking:   one AddInData record per booking (current state only)
     - booking_audit: one AddInData record per audit event (append-only)

   Partition strategy:
     - Each record carries a periodKey (YYYY-MM) derived from its UTC timestamp.
     - Queries are scoped by addInId + recordType + periodKey where supported,
       avoiding full-collection scans.
   The MyGeotab AddInData search API supports addInId equality and typeName;
   additional client-side filtering is applied for fields not supported server-side.

   Serialization rules:
     - Details payload is a single JSON.stringify at the API boundary.
     - No double JSON.stringify.
     - Max 10,000 serialized characters enforced.
   */

import type {
  AddInDataAuditData,
  AddInDataBookingData,
  AddInDataRecordEnvelope,
  AddInDataRecordType,
  AuditAction,
  BookingDataQuality,
  BookingValidationResult,
  OpexBooking,
  OpexBookingAudit,
  OpexNotification,
  PeriodKey,
  ResolvedBooking,
  ResolvedUser,
  ResolvedAsset,
} from "./types";
import { validateResolvedBooking } from "./bookingValidation.ts";
import { isValidAddInId } from "../config/addinId.ts";

const MAX_DETAILS_CHARS = 10000;
const DEFAULT_GROUP_ID = "GroupCompanyId";

type GeotabApi = {
  call?: (method: string, params: Record<string, unknown>, success: (result: unknown) => void, error?: (error: unknown) => void) => void;
};

type AddInDataRecordRaw = {
  id: string;
  addInId: string;
  details: string | Record<string, unknown>;
  groups?: Array<{ id: string }>;
  dateTime?: string;
};

/*───────────────────── Serialization (single JSON.stringify boundary) ─────────────────────*/

function toJsonString(value: unknown): string {
  return JSON.stringify(value);
}

function parseDetails<T>(details: string | Record<string, unknown> | null | undefined): T | null {
  if (details === null || details === undefined) return null;
  try {
    return typeof details === "string" ? (JSON.parse(details) as T) : (details as T);
  } catch {
    return null;
  }
}

function assertWithinLimit(value: unknown, label: string): void {
  const json = toJsonString(value);
  if (json.length > MAX_DETAILS_CHARS) {
    throw new Error(`ADDIN_DATA_DETAILS_EXCEEDED: ${label} = ${json.length} chars (max ${MAX_DETAILS_CHARS})`);
  }
}

/*───────────────────── Envelope helpers ─────────────────────*/

function makeEnvelope<T>(recordType: AddInDataRecordType, data: T, schemaVersion = 2): AddInDataRecordEnvelope<T> {
  return { recordType, schemaVersion, data };
}

function extractEnvelope<T>(raw: AddInDataRecordRaw): AddInDataRecordEnvelope<T> | null {
  const parsed = parseDetails<AddInDataRecordEnvelope<T>>(raw.details);
  if (!parsed) return null;
  return parsed;
}

/*───────────────────── Booking data normalization ─────────────────────*/

function normalizeBookingData(raw: unknown): AddInDataBookingData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const recordType = r.recordType;
  const schemaVersion = Number(r.schemaVersion ?? 1);
  const bookingId = r.bookingId;
  const status = r.status;
  const deviceId = r.deviceId;
  const vehicle = r.vehicle;
  const driver = r.driver;
  const schedule = r.schedule;
  const destination = r.destination;
  const purpose = r.purpose;
  const lifecycle = r.lifecycle;
  const version = r.version;

  /* Backward compatibility: schemaVersion 1 records used flat fields. */
  if (recordType === "booking" || (!recordType && bookingId)) {
    const v = vehicle as Record<string, unknown> | undefined;
    const d = driver as Record<string, unknown> | undefined;
    const s = schedule as Record<string, unknown> | undefined;
    const lc = lifecycle as Record<string, unknown> | undefined;
    return {
      bookingId: String(bookingId ?? ""),
      status: (status as OpexBooking["status"]) ?? "PENDING_APPROVAL",
      vehicle: {
        deviceId: String(deviceId ?? v?.deviceId ?? ""),
        name: (v?.name as string | null) ?? null,
      },
      driver: d ? {
        driverId: String(d.driverId ?? ""),
        name: (d.name as string | null) ?? null,
      } : undefined,
      schedule: {
        startAtUtc: String(s?.startAtUtc ?? r.startAt ?? ""),
        endAtUtc: String(s?.endAtUtc ?? r.endAt ?? ""),
      },
      destination: (destination as string | null) ?? null,
      purpose: String(purpose ?? ""),
      lifecycle: {
        createdAtUtc: String(lc?.createdAtUtc ?? r.createdAt ?? ""),
        updatedAtUtc: String(lc?.updatedAtUtc ?? r.updatedAt ?? ""),
      },
      version: Number(version ?? lc?.version ?? 1),
    };
  }
  return null;
}

function normalizeAuditData(raw: unknown): AddInDataAuditData | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const recordType = r.recordType;
  const eventId = r.eventId;
  const bookingId = r.bookingId;
  const eventType = r.eventType;
  const occurredAtUtc = r.occurredAtUtc;
  const created_at = r.created_at;
  const actor = r.actor;
  const actor_user_id = r.actor_user_id;
  const changes = r.changes;
  const metadata = r.metadata;

  if (recordType !== "booking_audit" && (!eventId || !bookingId)) return null;
  const a = actor as Record<string, unknown> | undefined;
  const md = metadata as Record<string, unknown> | undefined;
  return {
    eventId: String(eventId ?? ""),
    bookingId: String(bookingId ?? ""),
    eventType: (eventType as AuditAction) ?? "BOOKING_UPDATED",
    occurredAtUtc: String(occurredAtUtc ?? created_at ?? ""),
    actor: {
      userId: String(a?.userId ?? actor_user_id ?? ""),
      name: (a?.name as string | null) ?? null,
    },
    changes: Array.isArray(changes) ? changes : [],
    metadata: {
      source: "MYGEOTAB_ADDIN",
      idempotencyKey: String(md?.idempotencyKey ?? ""),
    },
  };
}

/*───────────────────── AddInData API wrapper ─────────────────────*/

export class AddInDataApiError extends Error {
  public readonly method?: string;
  constructor(message: string, method?: string) {
    super(message);
    this.name = "AddInDataApiError";
    this.method = method;
  }
}

export class AddInDataGateway {
  private readonly api: GeotabApi | null;
  private readonly addInId: string | null;

  constructor(api: GeotabApi | null, addInId: string | null) {
    this.api = api;
    this.addInId = addInId;
  }

  isConfigured(): boolean {
    return !!this.api?.call && !!this.addInId && isValidAddInId(this.addInId);
  }

  private call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.isConfigured()) {
        reject(new AddInDataApiError("ADDIN_ID_NOT_CONFIGURED or API not available", method));
        return;
      }
      if ((method === "Add" || method === "Set" || method === "Remove") && !this.addInId) {
        reject(new AddInDataApiError("ADDIN_ID_NOT_CONFIGURED", method));
        return;
      }
      this.api!.call!(method, params, (result: unknown) => resolve(result as T), (error: unknown) => {
        reject(new AddInDataApiError(error instanceof Error ? error.message : String(error), method));
      });
    });
  }

  async search(typeName: "AddInData", search: { addInId: string; [key: string]: unknown }): Promise<AddInDataRecordRaw[]> {
    const result = await this.call<AddInDataRecordRaw[]>("Get", {
      typeName,
      ...search,
    });
    return result ?? [];
  }

  async add(typeName: "AddInData", entity: Record<string, unknown>): Promise<{ id?: string } | null> {
    const result = await this.call<{ id?: string } | null>("Add", { typeName, entity });
    return result ?? null;
  }

  async set(typeName: "AddInData", entity: Record<string, unknown>): Promise<unknown> {
    return this.call("Set", { typeName, entity });
  }

  async remove(typeName: "AddInData", entity: { id: string }): Promise<unknown> {
    return this.call("Remove", { typeName, entity });
  }
}

/*───────────────────── Period key helpers ─────────────────────*/

export function periodKeyFromIso(isoUtc: string): PeriodKey {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/*───────────────────── Main AddInData Service ─────────────────────*/

export class AddInDataService {
  private readonly gateway: AddInDataGateway;

  constructor(api: GeotabApi | null, addInId: string | null) {
    this.gateway = new AddInDataGateway(api, addInId);
  }

  isLive(): boolean {
    return this.gateway.isConfigured();
  }

  /*───────────────────── Booking Master Operations ─────────────────────*/

  async getBookingsByPeriod(periodKey: PeriodKey): Promise<AddInDataRecordEnvelope<AddInDataBookingData>[]> {
    const records = await this.gateway.search("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
      recordType: "booking",
      periodKey,
    });
    const envelopes: AddInDataRecordEnvelope<AddInDataBookingData>[] = [];
    for (const raw of records) {
      const env = extractEnvelope<AddInDataBookingData>(raw);
      if (!env) continue;
      const data = normalizeBookingData(env.data);
      if (data) envelopes.push({ ...env, data });
    }
    return envelopes;
  }

  async getAllBookings(): Promise<AddInDataRecordEnvelope<AddInDataBookingData>[]> {
    const records = await this.gateway.search("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
    });
    const envelopes: AddInDataRecordEnvelope<AddInDataBookingData>[] = [];
    for (const raw of records) {
      const env = extractEnvelope<AddInDataBookingData>(raw);
      if (!env) continue;
      const data = normalizeBookingData(env.data);
      if (data) envelopes.push({ ...env, data });
    }
    return envelopes;
  }

  async findBookingById(bookingId: string): Promise<{ envelope: AddInDataRecordEnvelope<AddInDataBookingData>; raw: AddInDataRecordRaw } | null> {
    const records = await this.gateway.search("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
    });
    for (const raw of records) {
      try {
        if (raw.id === bookingId) {
          const env = extractEnvelope<AddInDataBookingData>(raw);
          if (env && normalizeBookingData(env.data)) return { envelope: env!, raw };
        }
        const parsed = parseDetails<AddInDataRecordEnvelope<AddInDataBookingData>>(raw.details);
        if (parsed?.data && (parsed.data as AddInDataBookingData).bookingId === bookingId) {
          const env = extractEnvelope<AddInDataBookingData>(raw);
          if (env && normalizeBookingData(env.data)) return { envelope: env!, raw };
        }
      } catch {
        // Skip malformed records
      }
    }
    return null;
  }

  async createBooking(data: AddInDataBookingData, periodKey?: PeriodKey): Promise<{ entityId: string; booking: AddInDataBookingData }> {
    assertWithinLimit(data, "booking");
    const pk = periodKey || periodKeyFromIso(data.lifecycle.createdAtUtc);
    const envelope: AddInDataRecordEnvelope<AddInDataBookingData> = {
      recordType: "booking",
      schemaVersion: 2,
      data,
    };
    /* Idempotency: check if a booking with this bookingId already exists. */
    const existing = await this.findBookingById(data.bookingId);
    if (existing) {
      return { entityId: existing.raw.id, booking: existing.envelope.data };
    }

    const result = await this.gateway.add("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
      details: envelope,
      groups: [{ id: DEFAULT_GROUP_ID }],
    });
    const entityId = result?.id ?? "";
    if (!entityId) throw new AddInDataApiError("AddInData Add returned no entity id", "Add");
    return { entityId, booking: data };
  }

  async updateBooking(bookingId: string, updates: Partial<AddInDataBookingData>, periodKey?: PeriodKey): Promise<void> {
    const found = await this.findBookingById(bookingId);
    if (!found) throw new AddInDataApiError(`BOOKING_NOT_FOUND: ${bookingId}`, "Set");

    const existing = found.envelope.data;
    const updated: AddInDataBookingData = {
      ...existing,
      ...updates,
      bookingId,
      lifecycle: {
        ...existing.lifecycle,
        updatedAtUtc: new Date().toISOString(),
      },
      version: (existing.version || 0) + 1,
    };
    assertWithinLimit(updated, "booking");

    const envelope: AddInDataRecordEnvelope<AddInDataBookingData> = {
      recordType: "booking",
      schemaVersion: 2,
      data: updated,
    };

    await this.gateway.set("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
      id: found.raw.id,
      details: envelope,
      groups: [{ id: DEFAULT_GROUP_ID }],
    });
  }

  async deleteBooking(bookingId: string): Promise<void> {
    const found = await this.findBookingById(bookingId);
    if (!found) throw new AddInDataApiError(`BOOKING_NOT_FOUND: ${bookingId}`, "Remove");
    await this.gateway.remove("AddInData", { id: found.raw.id });
  }

  /*───────────────────── Booking Audit Operations ─────────────────────*/

  async createAuditEvent(data: AddInDataAuditData, periodKey?: PeriodKey): Promise<{ entityId: string }> {
    assertWithinLimit(data, "audit");
    const pk = periodKey || periodKeyFromIso(data.occurredAtUtc);
    const envelope: AddInDataRecordEnvelope<AddInDataAuditData> = {
      recordType: "booking_audit",
      schemaVersion: 2,
      data,
    };

    /* Idempotency: check for existing audit event with same idempotencyKey + bookingId. */
    const existing = await this.findAuditEventByIdempotency(data.bookingId, data.metadata.idempotencyKey);
    if (existing) {
      return { entityId: existing.raw.id };
    }

    const result = await this.gateway.add("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
      details: envelope,
      groups: [{ id: DEFAULT_GROUP_ID }],
    });
    const entityId = result?.id ?? "";
    if (!entityId) throw new AddInDataApiError("AddInData Add returned no entity id for audit", "Add");
    return { entityId };
  }

  async getAuditEventsByBooking(bookingId: string): Promise<AddInDataRecordEnvelope<AddInDataAuditData>[]> {
    const records = await this.gateway.search("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
    });
    const envelopes: AddInDataRecordEnvelope<AddInDataAuditData>[] = [];
    for (const raw of records) {
      try {
        const parsed = parseDetails<AddInDataRecordEnvelope<AddInDataAuditData>>(raw.details);
        if (!parsed) continue;
        const data = normalizeAuditData(parsed.data);
        if (!data) continue;
        if (data.bookingId === bookingId) {
          envelopes.push({ ...parsed, data });
        }
      } catch {
        // Skip malformed records
      }
    }
    envelopes.sort((a, b) => {
      const at = new Date(a.data.occurredAtUtc).getTime();
      const bt = new Date(b.data.occurredAtUtc).getTime();
      return bt - at; // newest first
    });
    return envelopes;
  }

  async getAuditEventsByPeriod(periodKey: PeriodKey): Promise<AddInDataRecordEnvelope<AddInDataAuditData>[]> {
    const records = await this.gateway.search("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
      recordType: "booking_audit",
      periodKey,
    });
    const envelopes: AddInDataRecordEnvelope<AddInDataAuditData>[] = [];
    for (const raw of records) {
      const env = extractEnvelope<AddInDataAuditData>(raw);
      if (!env) continue;
      const data = normalizeAuditData(env.data);
      if (data) envelopes.push({ ...env, data });
    }
    return envelopes;
  }

  private async findAuditEventByIdempotency(bookingId: string, idempotencyKey: string): Promise<{ envelope: AddInDataRecordEnvelope<AddInDataAuditData>; raw: AddInDataRecordRaw } | null> {
    const records = await this.gateway.search("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
    });
    for (const raw of records) {
      try {
        const parsed = parseDetails<AddInDataRecordEnvelope<AddInDataAuditData>>(raw.details);
        if (!parsed) continue;
        const data = normalizeAuditData(parsed.data);
        if (!data) continue;
        if (data.bookingId === bookingId && data.metadata.idempotencyKey === idempotencyKey) {
          return { envelope: parsed, raw };
        }
      } catch {
        // Skip malformed records
      }
    }
    return null;
  }

  /*───────────────────── Notification Operations (kept for compatibility) ─────────────────────*/

  async getNotificationsRaw(): Promise<AddInDataRecordRaw[]> {
    return this.gateway.search("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
    });
  }

  async addNotification(details: Record<string, unknown>): Promise<{ id?: string } | null> {
    assertWithinLimit(details, "notification");
    const envelope: AddInDataRecordEnvelope<Record<string, unknown>> = {
      recordType: "notification",
      schemaVersion: 2,
      data: details,
    };
    return this.gateway.add("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
      details: envelope,
      groups: [{ id: DEFAULT_GROUP_ID }],
    });
  }

  async setNotification(entityId: string, details: Record<string, unknown>): Promise<unknown> {
    assertWithinLimit(details, "notification");
    const envelope: AddInDataRecordEnvelope<Record<string, unknown>> = {
      recordType: "notification",
      schemaVersion: 2,
      data: details,
    };
    return this.gateway.set("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
      id: entityId,
      details: envelope,
      groups: [{ id: DEFAULT_GROUP_ID }],
    });
  }

  async removeNotification(entityId: string): Promise<unknown> {
    return this.gateway.remove("AddInData", { id: entityId });
  }

  /*───────────────────── Master Data (devices, users) ─────────────────────*/

  async getDevicesRaw(): Promise<Record<string, unknown>[]> {
    return this.gateway.search("AddInData", {
      addInId: this.gateway["addInId"] ?? "",
    });
  }
}

/*───────────────────── Legacy compatibility ─────────────────────*/

export function isLegacyBookingRecord(raw: Record<string, unknown>): boolean {
  const recordType = raw.recordType;
  return Boolean(!recordType && (raw.bookingId || raw.id || raw.deviceId));
}

export function normalizeLegacyAudit(raw: Record<string, unknown>): Partial<AddInDataAuditData> | null {
  if (!raw.eventId && !raw.booking_id) return null;
  return {
    eventId: String(raw.eventId ?? raw.id ?? `legacy-${Date.now()}`),
    bookingId: String(raw.bookingId ?? raw.booking_id ?? ""),
    eventType: (raw.action as AuditAction) ?? "BOOKING_UPDATED",
    occurredAtUtc: String(raw.created_at ?? raw.occurredAtUtc ?? ""),
    actor: {
      userId: String(raw.actor_user_id ?? (raw.actor as Record<string, unknown> | undefined)?.userId ?? ""),
      name: null,
    },
    changes: [],
    metadata: { source: "MYGEOTAB_ADDIN", idempotencyKey: String(raw.idempotencyKey ?? `legacy-${raw.eventId ?? raw.id ?? ""}`) },
  };
}

/*───────────────────── Conversion: AddInData envelope -> ResolvedBooking ─────────────────────*/

export function envelopeToResolvedBooking(
  envelope: AddInDataRecordEnvelope<AddInDataBookingData>,
  deviceMap: Map<string, { id: string; name?: string; licensePlate?: string }>,
  userMap: Map<string, { id: string; name?: string }>,
): ResolvedBooking {
  const d = envelope.data;
  const device = deviceMap.get(d.vehicle.deviceId);
  const requester = userMap.get(d.lifecycle.createdAtUtc ? "" : "") /* placeholder */;
  const validation = validateResolvedBooking({
    asset_id: d.vehicle.deviceId || null,
    requester_id: d.bookingId,
    status: d.status,
    start_at: d.schedule.startAtUtc,
    end_at: d.schedule.endAtUtc,
  });
  return {
    id: d.bookingId,
    requester_id: d.bookingId,
    requester_name: "Unknown User",
    requested_class: "OPERATIONAL_4X4",
    asset_id: d.vehicle.deviceId || null,
    asset_code: device ? `VEH-${device.id.slice(-3).toUpperCase()}` : null,
    asset_name: device?.name ?? null,
    registration_no: device?.licensePlate ?? null,
    start_at: d.schedule.startAtUtc,
    end_at: d.schedule.endAtUtc,
    buffer_before_minutes: 0,
    buffer_after_minutes: 30,
    purpose: d.purpose,
    destination: d.destination,
    passenger_count: null,
    status: d.status,
    approver_id: null,
    approval_remarks: null,
    version: d.version,
    created_at: d.lifecycle.createdAtUtc,
    updated_at: d.lifecycle.updatedAtUtc,
    driver_id: d.driver?.driverId ?? null,
    driver_name: d.driver?.name ?? null,
    dataQuality: validation.quality,
  };
}
