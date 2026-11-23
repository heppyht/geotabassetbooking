/*───────────────────── MyGeotab AddInData Booking Provider (schema v2) ─────────────────────*/
/* Booking transactions stored in MyGeotab AddInData.
   One AddInData record per booking (current state only).
   One AddInData record per audit event (append-only).
   Master data (devices/users/groups) loaded live from MyGeotab Get calls.
   No localStorage, no external database, no PostgreSQL/Neon/Cloudflare.

   Record design:
     - booking:    recordType="booking", schemaVersion=2, periodKey=YYYY-MM
     - booking_audit: recordType="booking_audit", schemaVersion=2, periodKey=YYYY-MM

   Partition strategy:
     - Each record carries a periodKey (YYYY-MM) derived from its UTC timestamp.
     - Queries are scoped by addInId + recordType + periodKey where supported.
     - Additional client-side filtering is applied for fields not supported server-side.

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
  MyGeotabGroup,
  MyGeotabStatusData,
  MyGeotabLogRecord,
  OpexBooking,
  OpexBookingAudit,
  OpexNotification,
  PeriodKey,
  ResolvedAsset,
  ResolvedBooking,
  ResolvedUser,
  BookingDataProvider,
  NotificationDataProvider,
  NotificationType,
} from "./types";
import { AddInDataGateway, AddInDataApiError } from "./addinDataService.ts";
import { isValidAddInId } from "../config/addinId.ts";
import { validateResolvedBooking } from "./bookingValidation.ts";

/*───────────────────── Geotab API type (Add-In context) ─────────────────────*/

type GeotabApi = {
  call?: (method: string, params: Record<string, unknown>, success: (result: unknown) => void, error?: (error: unknown) => void) => void;
  getSession?: (callback: (session: { userName?: string; database?: string; server?: string } | null) => void) => void;
};

const MAX_DETAILS_CHARS = 10000;
const DEFAULT_GROUP_ID = "GroupCompanyId";
const NOTIFICATION_GROUP_ID = DEFAULT_GROUP_ID;
const AUDIT_GROUP_ID = DEFAULT_GROUP_ID;

function generateBookingId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

type AddInDataDetails = string | Record<string, unknown>;

/*───────────────────── Diagnostic Logging ─────────────────────*/
function diagLog(message: string, detail?: unknown): void {
  try {
    if (typeof console !== "undefined" && console.log) {
      const detailStr = detail !== undefined ? ` | detail=${String(detail).slice(0, 100)}` : "";
      console.log(`[OPEX-VBM-AddInData] ${message}${detailStr}`);
    }
  } catch {
    // Logging must never throw
  }
}

/*───────────────────── Raw MyGeotab record shapes ─────────────────────*/

type RawMyGeotabDevice = {
  id: string;
  name?: string;
  serialNumber?: string;
  licensePlate?: string;
  make?: string;
  model?: string;
  vehicleClass?: string;
  groupIds?: string[];
  status?: string;
};

type RawMyGeotabUser = {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  companyGroups?: string[];
  role?: string;
  siteCode?: string;
};

type RawMyGeotabGroup = {
  id: string;
  name: string;
  parentId?: string;
};

type AddInDataRecord = {
  id: string;
  addInId: string;
  details: AddInDataDetails;
  groups?: Array<{ id: string }>;
  dateTime?: string;
};

/*───────────────────── Mapping helpers ─────────────────────*/

function mapLiveAsset(raw: RawMyGeotabDevice): ResolvedAsset {
  return {
    id: raw.id,
    asset_code: `VEH-${raw.id.slice(-3).toUpperCase()}`,
    asset_name: parseVehicleName(raw.name ?? ""),
    serial_number: raw.serialNumber ?? null,
    make_model: `${raw.make ?? "Unknown"} ${raw.model ?? "Asset"}`,
    asset_class: raw.vehicleClass ?? "OPERATIONAL_4X4",
    registration_no: raw.licensePlate ?? null,
    status: raw.status ?? "AVAILABLE",
    geotab_device_id: raw.id,
  };
}

function parseVehicleName(rawName: string): string {
  if (!rawName || rawName.trim() === "") return "Unknown Vehicle";
  const parts = rawName.split("_");
  if (parts.length <= 1) return rawName.trim();
  const nameParts = parts.slice(1);
  if (nameParts.length === 1) return nameParts[0].trim();
  const prefix = nameParts.slice(0, -1).join(" ").trim();
  const suffix = nameParts[nameParts.length - 1].trim();
  return `${prefix} - ${suffix}`;
}

function mapLiveUser(raw: RawMyGeotabUser): ResolvedUser {
  return {
    id: raw.id,
    name: raw.name || "Unknown",
    roles: raw.role ? [raw.role] : ["EMPLOYEE"],
    companyGroups: raw.companyGroups ?? [],
  };
}

function mapLiveGroup(raw: RawMyGeotabGroup): MyGeotabGroup {
  return { id: raw.id, name: raw.name, parentId: raw.parentId };
}

/*───────────────────── Booking serialization (single JSON.stringify boundary) ─────────────────────*/

function serializeBooking(booking: OpexBooking): OpexBooking {
  assertDetailsWithinLimit(booking);
  return booking;
}

function deserializeBooking(details: AddInDataDetails): OpexBooking {
  if (typeof details === "string") {
    try { return JSON.parse(details) as OpexBooking; } catch { return fallbackBooking(); }
  }
  return details as unknown as OpexBooking;
}

function fallbackBooking(): OpexBooking {
  return {
    id: "",
    deviceId: "",
    requesterUserId: "",
    requestedClass: "PASSENGER",
    startAt: "",
    endAt: "",
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    purpose: "",
    destination: null,
    passengerCount: null,
    status: "PENDING_APPROVAL",
    assignedDriverUserId: null,
    approverId: null,
    approvalRemarks: null,
    createdAt: "",
    updatedAt: "",
    version: 0,
  };
}

function assertDetailsWithinLimit(value: unknown): void {
  const json = JSON.stringify(value);
  if (json.length > MAX_DETAILS_CHARS) {
    throw new Error(`ADDIN_DATA_DETAILS_EXCEEDED: ${json.length} characters (max ${MAX_DETAILS_CHARS})`);
  }
}

/*───────────────────── Conflict check helper ─────────────────────*/

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/*───────────────────── AddInData Booking Data Provider ─────────────────────*/

export class AddInDataBookingDataProvider implements BookingDataProvider, NotificationDataProvider {
  private readonly api: GeotabApi | null;
  private readonly addInId: string | null;
  private readonly groupId: string;
  private readonly gateway: AddInDataGateway;
  private principalCache: Promise<RawMyGeotabUser | null> | null = null;

  constructor(api: GeotabApi | null, addInId: string | null, groupId: string = DEFAULT_GROUP_ID) {
    this.api = api;
    this.addInId = addInId;
    this.groupId = groupId;
    this.gateway = new AddInDataGateway(api, addInId);
    diagLog("AddInDataBookingDataProvider constructed", {
      hasApi: !!api,
      hasAddInId: !!addInId,
      addInIdValid: addInId ? isValidAddInId(addInId) : false,
    });
  }

  /*───────────────────── JSON-RPC wrapper over geotab.addin API ─────────────────────*/

  private async apiCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
    diagLog(`AddInData API call started`, { method, typeName: params.typeName });
    return new Promise((resolve, reject) => {
      if (!this.api?.call) {
        diagLog("AddInData API call failed: geotabApi.call not available", { method });
        reject(new Error("GEOTAB_API_NOT_AVAILABLE: running outside MyGeotab Add-In context"));
        return;
      }
      if ((method === "Add" || method === "Set" || method === "Remove") && !this.addInId) {
        diagLog("AddInData API call failed: addInId not configured", { method });
        reject(new Error("ADDIN_ID_NOT_CONFIGURED: set addInId before using AddInData storage"));
        return;
      }
      if ((method === "Add" || method === "Set" || method === "Remove") && this.addInId && !isValidAddInId(this.addInId)) {
        diagLog("AddInData API call failed: addInId invalid format", { method });
        reject(new Error("ADDIN_ID_INVALID: stored addInId does not match Geotab Storage API format. Enter a valid AddInId."));
        return;
      }
      this.api.call(method, params, (result: unknown) => {
        diagLog(`AddInData API call succeeded`, { method, typeName: params.typeName });
        resolve(result as T);
      }, (error: unknown) => {
        diagLog(`AddInData API call failed`, { method, typeName: params.typeName, error: error instanceof Error ? error.message : String(error) });
        reject(error ?? new Error("GEOTAB_API_ERROR"));
      });
    });
  }

  /*───────────────────── Authenticated principal resolution (MyGeotab Add-In session context) ─────────────────────*/

  private async openSession(): Promise<{ userName: string; database?: string; server?: string } | null> {
    if (!this.api?.getSession) return null;
    return new Promise((resolve) => {
      try {
        this.api!.getSession!((session) => {
          resolve(session ? { userName: session.userName ?? "", database: session.database, server: session.server } : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Resolve the authenticated MyGeotab principal from the live Add-In session.
   * Performs a targeted User lookup by session userName (permission-compatible);
   * never enumerates all users. Cached for the lifetime of the provider.
   */
  private async ensurePrincipal(): Promise<RawMyGeotabUser | null> {
    if (this.principalCache !== null) return this.principalCache;
    this.principalCache = (async () => {
      const session = await this.openSession();
      if (!session || !session.userName) return null;
      const users = await this.apiCall<RawMyGeotabUser[]>("Get", {
        typeName: "User",
        search: { name: session.userName },
        resultsLimit: 10,
      });
      const arr = Array.isArray(users) ? users : [];
      return arr.find((u) => (u.name ?? "").toLowerCase() === session.userName.toLowerCase()) ?? arr[0] ?? null;
    })();
    return this.principalCache;
  }

  /*───────────────────── Read-only master data (live from MyGeotab, permission-compatible) ─────────────────────*/

  async getAssets(): Promise<ResolvedAsset[]> {
    const principal = await this.ensurePrincipal();
    const groupIds = principal ? (principal.companyGroups ?? []) : [];
    if (groupIds.length === 0) return [];
    const deviceSets = await Promise.all(
      groupIds.map((gid) =>
        this.apiCall<RawMyGeotabDevice[]>("Get", {
          typeName: "Device",
          search: { groups: [{ id: gid }] },
          resultsLimit: 1000,
        }),
      ),
    );
    const devices = Array.from(new Map(deviceSets.flat().map((d) => [d.id, d] as [string, RawMyGeotabDevice])).values());
    return devices.map(mapLiveAsset);
  }

  async getUsers(): Promise<ResolvedUser[]> {
    const principal = await this.ensurePrincipal();
    return principal ? [mapLiveUser(principal)] : [];
  }

  async getGroups(): Promise<MyGeotabGroup[]> {
    const principal = await this.ensurePrincipal();
    const groupIds = principal ? (principal.companyGroups ?? []) : [];
    if (groupIds.length === 0) return [];
    const groups = await Promise.all(
      groupIds.map(async (gid) => {
        const found = await this.apiCall<RawMyGeotabGroup[]>("Get", {
          typeName: "Group",
          search: { id: gid },
          resultsLimit: 10,
        });
        const arr = Array.isArray(found) ? found : [];
        return arr.length > 0 ? arr[0] : null;
      }),
    );
    return groups.filter((g): g is RawMyGeotabGroup => g !== null).map(mapLiveGroup);
  }

  async getStatusData(): Promise<MyGeotabStatusData[]> {
    return [];
  }

  async getLogRecords(): Promise<MyGeotabLogRecord[]> {
    return [];
  }

  /*───────────────────── Booking transactions (AddInData storage) ─────────────────────*/

  /**
   * Devices visible to the authenticated principal, scoped to the groups the
   * principal is verified to belong to (companyGroups). Uses the documented
   * DeviceSearch `groups: [{ id }]` shape — never an unrestricted Device Get.
   */
  private async getDevicesRaw(): Promise<RawMyGeotabDevice[]> {
    const principal = await this.ensurePrincipal();
    const groupIds = principal ? (principal.companyGroups ?? []) : [];
    if (groupIds.length === 0) return [];
    const deviceSets = await Promise.all(
      groupIds.map((gid) =>
        this.apiCall<RawMyGeotabDevice[]>("Get", {
          typeName: "Device",
          search: { groups: [{ id: gid }] },
          resultsLimit: 1000,
        }),
      ),
    );
    return Array.from(new Map(deviceSets.flat().map((d) => [d.id, d] as [string, RawMyGeotabDevice])).values());
  }

  /**
   * Resolve only the users actually referenced by the bookings being loaded,
   * via a targeted UserSearch `userIds` lookup. Never enumerates all users.
   * Users that cannot be resolved (permission or not found) simply stay absent
   * from the map, so dependent bookings keep an explicit unresolved-reference
   * state (dataQuality MISSING_REQUESTER / asset fields null) rather than being
   * dropped or replaced with demo data.
   */
  private async getUsersRaw(userIds: string[]): Promise<RawMyGeotabUser[]> {
    const distinct = Array.from(new Set(userIds.filter(Boolean)));
    if (distinct.length === 0) return [];
    const users = await this.apiCall<RawMyGeotabUser[]>("Get", {
      typeName: "User",
      search: { userIds: distinct },
      resultsLimit: 1000,
    });
    return Array.isArray(users) ? users : [];
  }

  async getBookings(): Promise<ResolvedBooking[]> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    const devices = await this.getDevicesRaw();
    const userIds = new Set<string>();
    for (const record of records || []) {
      try {
        const b = deserializeBooking(record.details);
        if (b.requesterUserId) userIds.add(b.requesterUserId);
        if (b.assignedDriverUserId) userIds.add(b.assignedDriverUserId);
      } catch {
        // Skip malformed records when collecting references
      }
    }
    const users = await this.getUsersRaw(Array.from(userIds));
    const deviceMap = new Map(devices.map((d) => [d.id, d]));
    const userMap = new Map(users.map((u) => [u.id, u]));
    return (records || []).map((r) => resolveAddInDataBooking(r, deviceMap, userMap));
  }

  async getBookingById(bookingId: string): Promise<ResolvedBooking | null> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    let target: { record: AddInDataRecord; booking: OpexBooking } | null = null;
    for (const record of records || []) {
      let booking: OpexBooking | null = null;
      try {
        if (record.id === bookingId) {
          booking = deserializeBooking(record.details);
        } else {
          const parsed = deserializeBooking(record.details);
          if (parsed.id === bookingId) booking = parsed;
        }
      } catch {
        // Skip malformed records
      }
      if (booking) {
        target = { record, booking };
        break;
      }
    }
    if (!target) return null;
    const devices = await this.getDevicesRaw();
    const userIds = new Set<string>();
    if (target.booking.requesterUserId) userIds.add(target.booking.requesterUserId);
    if (target.booking.assignedDriverUserId) userIds.add(target.booking.assignedDriverUserId);
    const users = await this.getUsersRaw(Array.from(userIds));
    const deviceMap = new Map(devices.map((d) => [d.id, d]));
    const userMap = new Map(users.map((u) => [u.id, u]));
    return resolveAddInDataBookingToResolved(target.booking, target.record.id, deviceMap, userMap);
  }

  async createBooking(input: {
    deviceId: string;
    requesterUserId: string;
    requestedClass: "OPERATIONAL_4X4" | "PASSENGER";
    startAt: string;
    endAt: string;
    purpose: string;
    destination: string | null;
    passengerCount: number | null;
    driverId?: string | null;
    driverName?: string | null;
  }): Promise<ResolvedBooking> {
    // Best-effort conflict check: load all bookings, filter overlaps for same asset
    const existing = await this.getBookings();
    const conflictStatuses = ["PENDING_APPROVAL", "APPROVED", "ASSIGNED"];
    const newStart = new Date(input.startAt);
    const newEnd = new Date(input.endAt);
    const conflict = existing.find(b => {
      if (b.asset_id !== input.deviceId) return false;
      if (!conflictStatuses.includes(b.status)) return false;
      return overlaps(newStart, newEnd, new Date(b.start_at), new Date(b.end_at));
    });
    if (conflict) {
      throw new Error(`ASSET_CONFLICT: Asset ${input.deviceId} already has a ${conflict.status.replace(/_/g, " ").toLowerCase()} booking overlapping the requested time.`);
    }

    const now = new Date().toISOString();
    const booking: OpexBooking = {
      id: `addin-${generateBookingId()}`,
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
      assignedDriverUserId: input.driverId ?? null,
      approverId: null,
      approvalRemarks: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    const details = serializeBooking(booking);
    const response = await this.apiCall<{ id?: string }>("Add", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        details,
        groups: [{ id: this.groupId }],
      },
    });
    const serverRecordId = response?.id ?? "";
    if (serverRecordId) {
      booking.id = serverRecordId;
    }

    const resolved = await this.getBookings();
    return resolved.find(b => b.id === booking.id) ?? resolveBookingToResolved(booking, serverRecordId);
  }

  async updateBookingStatus(id: string, status: string, approverId?: string, approvalRemarks?: string): Promise<void> {
    const record = await this.findBookingRecord(id);
    if (!record) throw new Error(`BOOKING_NOT_FOUND: ${id}`);
    const booking = deserializeBooking(record.details);
    booking.status = status as OpexBooking["status"];
    if (approverId !== undefined) booking.approverId = approverId;
    if (approvalRemarks !== undefined) booking.approvalRemarks = approvalRemarks;
    booking.updatedAt = new Date().toISOString();
    booking.version = (booking.version || 0) + 1;
    await this.apiCall<unknown>("Set", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        id: record.id,
        details: serializeBooking(booking),
        groups: [{ id: this.groupId }],
      },
    });
  }

  /**
   * Shared booking record lookup that resolves the AddInData server record ID.
   * Matches by either:
   *   - record.id === bookingId (server record ID)
   *   - deserializeBooking(record.details).id === bookingId (application ID stored in details)
   * Malformed details are skipped gracefully so a single bad record cannot break the lookup.
   */
  async findBookingRecord(bookingId: string): Promise<AddInDataRecord | null> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    for (const record of records || []) {
      if (record.id === bookingId) return record;
      try {
        const booking = deserializeBooking(record.details);
        if (booking && booking.id === bookingId) return record;
      } catch {
        // Skip malformed records
      }
    }
    return null;
  }

  async deleteBooking(id: string): Promise<void> {
    const record = await this.findBookingRecord(id);
    if (!record) throw new Error(`BOOKING_NOT_FOUND: ${id}`);
    await this.apiCall<unknown>("Remove", {
      typeName: "AddInData",
      entity: { id: record.id },
    });
  }

  async resetDemoData(): Promise<void> {
    // AddInData mode does not use local demo data. No-op here.
  }

  /*───────────────────── Notification operations (AddInData) ─────────────────────*/
  async getNotifications(userId: string, opts?: { limit?: number; offset?: number; unreadOnly?: boolean; type?: NotificationType }): Promise<OpexNotification[]> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    return (records || [])
      .map(r => deserializeNotification(r.details))
      .filter(n => n.recipient_user_id === userId)
      .filter(n => (opts?.unreadOnly ? !n.is_read : true))
      .filter(n => (opts?.type ? n.type === opts.type : true))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(opts?.offset ?? 0, opts?.offset ?? 0 + (opts?.limit ?? Infinity));
  }

  async getUnreadCount(userId: string): Promise<number> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    return (records || [])
      .map(r => deserializeNotification(r.details))
      .filter(n => n.recipient_user_id === userId && !n.is_read).length;
  }

  async createNotification(input: {
    eventId: string;
    idempotencyKey: string;
    type: NotificationType;
    recipient_user_id: string;
    related_booking_id: string | null;
    title: string;
    message: string;
  }): Promise<OpexNotification> {
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const now = new Date().toISOString();
    const notification: OpexNotification = {
      id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      type: input.type,
      recipient_user_id: input.recipient_user_id,
      related_booking_id: input.related_booking_id,
      title: input.title,
      message: input.message,
      is_read: false,
      delivery_status: "pending",
      delivered_at: null,
      created_at: now,
      updated_at: now,
    };
    const details = serializeNotification(notification);
    await this.apiCall<{ id?: string }>("Add", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        details,
        groups: [{ id: NOTIFICATION_GROUP_ID }],
      },
    });
    return notification;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<OpexNotification | null> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    for (const record of records || []) {
      try {
        const n = deserializeNotification(record.details);
        if (n.idempotencyKey === idempotencyKey) return n;
      } catch {
        // Skip malformed records
      }
    }
    return null;
  }

  async markAsRead(notificationId: string): Promise<void> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    const record = (records || []).find(r => {
      try {
        return deserializeNotification(r.details).id === notificationId;
      } catch {
        return false;
      }
    });
    if (!record) return;
    const n = deserializeNotification(record.details);
    n.is_read = true;
    n.updated_at = new Date().toISOString();
    await this.apiCall<unknown>("Set", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        id: record.id,
        details: serializeNotification(n),
        groups: [{ id: NOTIFICATION_GROUP_ID }],
      },
    });
  }

  async markAllAsRead(userId: string): Promise<void> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    const now = new Date().toISOString();
    for (const record of records || []) {
      try {
        const n = deserializeNotification(record.details);
        if (n.recipient_user_id === userId && !n.is_read) {
          n.is_read = true;
          n.updated_at = now;
          await this.apiCall<unknown>("Set", {
            typeName: "AddInData",
            entity: {
              addInId: this.addInId,
              id: record.id,
              details: serializeNotification(n),
              groups: [{ id: NOTIFICATION_GROUP_ID }],
            },
          });
        }
      } catch {
        // Skip malformed records
      }
    }
  }

  async markDeliveryStatus(notificationId: string, status: "pending" | "delivered" | "failed"): Promise<void> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    const record = (records || []).find(r => {
      try {
        return deserializeNotification(r.details).id === notificationId;
      } catch {
        return false;
      }
    });
    if (!record) return;
    const n = deserializeNotification(record.details);
    n.delivery_status = status;
    n.delivered_at = status === "delivered" ? new Date().toISOString() : n.delivered_at;
    n.updated_at = new Date().toISOString();
    await this.apiCall<unknown>("Set", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        id: record.id,
        details: serializeNotification(n),
        groups: [{ id: NOTIFICATION_GROUP_ID }],
      },
    });
  }

  /*───────────────────── Audit operations (AddInData) ─────────────────────*/
  async createAuditRecord(input: {
    booking_id: string;
    action: string;
    actor_user_id: string;
    previous_status: string | null;
    new_status: string | null;
    details: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const record: OpexBookingAudit = {
      id: `audit-${generateBookingId()}`,
      booking_id: input.booking_id,
      action: input.action,
      actor_user_id: input.actor_user_id,
      previous_status: input.previous_status,
      new_status: input.new_status,
      details: input.details,
      created_at: now,
    };
    const detailsStr = serializeAudit(record);
    await this.apiCall<{ id?: string }>("Add", {
      typeName: "AddInData",
      entity: {
        addInId: this.addInId,
        details: detailsStr,
        groups: [{ id: AUDIT_GROUP_ID }],
      },
    });
  }

  async getAuditRecords(bookingId: string): Promise<OpexBookingAudit[]> {
    const records = await this.apiCall<AddInDataRecord[]>("Get", {
      typeName: "AddInData",
      search: { addInId: this.addInId },
    });
    return (records || [])
      .map(r => deserializeAudit(r.details))
      .filter(a => a && a.booking_id === bookingId)
      .sort((a, b) => new Date(b!.created_at).getTime() - new Date(a!.created_at).getTime()) as OpexBookingAudit[];
  }

  isLive(): boolean {
    return this.gateway.isConfigured();
  }

  async getApprovers(): Promise<ResolvedUser[]> {
    const approvers = new Map<string, RawMyGeotabUser>();

    // 1. The authenticated principal, if they hold the APPROVER role.
    const principal = await this.ensurePrincipal();
    if (principal && principal.role === "APPROVER") {
      approvers.set(principal.id, principal);
    }

    // 2. Verified approvers taken from actual booking records (distinct approverId values).
    // Never assume the logged-in principal is the only approver. AddInData Get is scoped by
    // addInId; no unrestricted User enumeration is performed.
    if (this.addInId) {
      const records = await this.apiCall<AddInDataRecord[]>("Get", {
        typeName: "AddInData",
        search: { addInId: this.addInId },
      });
      const approverIds = new Set<string>();
      for (const record of records || []) {
        try {
          const b = deserializeBooking(record.details);
          if (b.approverId) approverIds.add(b.approverId);
        } catch {
          // Skip malformed records
        }
      }
      if (approverIds.size > 0) {
        const users = await this.apiCall<RawMyGeotabUser[]>("Get", {
          typeName: "User",
          search: { userIds: Array.from(approverIds) },
          resultsLimit: 1000,
        });
        for (const u of Array.isArray(users) ? users : []) {
          approvers.set(u.id, u);
        }
      }
    }

    return Array.from(approvers.values()).map(mapLiveUser);
  }
}

/*───────────────────── Serialization helpers ─────────────────────*/

function serializeNotification(n: OpexNotification): OpexNotification {
  assertDetailsWithinLimit(n);
  return n;
}

function deserializeNotification(details: AddInDataDetails): OpexNotification {
  if (typeof details === "string") {
    try { return JSON.parse(details) as OpexNotification; } catch { return fallbackNotification(); }
  }
  return details as unknown as OpexNotification;
}

function fallbackNotification(): OpexNotification {
  return {
    id: "",
    eventId: "",
    idempotencyKey: "",
    type: "booking_created",
    recipient_user_id: "",
    related_booking_id: null,
    title: "",
    message: "",
    is_read: false,
    delivery_status: "pending",
    delivered_at: null,
    created_at: "",
    updated_at: "",
  };
}

function serializeAudit(a: OpexBookingAudit): OpexBookingAudit {
  assertDetailsWithinLimit(a);
  return a;
}

function deserializeAudit(details: AddInDataDetails): OpexBookingAudit | null {
  if (typeof details === "string") {
    try { return JSON.parse(details) as OpexBookingAudit; } catch { return null; }
  }
  return details as unknown as OpexBookingAudit | null;
}

/*───────────────────── Resolve helpers ─────────────────────*/

function resolveAddInDataBooking(
  record: AddInDataRecord,
  devices: Map<string, RawMyGeotabDevice>,
  users: Map<string, RawMyGeotabUser>,
): ResolvedBooking {
  let booking: OpexBooking;
  try {
    booking = deserializeBooking(record.details);
  } catch {
    booking = {
      id: record.id,
      deviceId: "",
      requesterUserId: "",
      requestedClass: "PASSENGER",
      startAt: "",
      endAt: "",
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      purpose: "",
      destination: null,
      passengerCount: null,
      status: "PENDING_APPROVAL",
      assignedDriverUserId: null,
      approverId: null,
      approvalRemarks: null,
      createdAt: "",
      updatedAt: "",
      version: 0,
    };
  }
  const device = devices.get(booking.deviceId ?? undefined);
  const requester = users.get(booking.requesterUserId ?? undefined);
  const driver = booking.assignedDriverUserId ? users.get(booking.assignedDriverUserId) : undefined;
  const validation = validateResolvedBooking({
    asset_id: booking.deviceId ?? null,
    requester_id: booking.requesterUserId ?? "",
    status: booking.status ?? "",
    start_at: booking.startAt ?? "",
    end_at: booking.endAt ?? "",
  });
  return {
    id: booking.id ?? record.id,
    requester_id: booking.requesterUserId ?? "",
    requester_name: requester?.name ?? "Unknown User",
    requested_class: booking.requestedClass,
    asset_id: booking.deviceId ?? null,
    asset_code: device ? `VEH-${device.id.slice(-3).toUpperCase()}` : null,
    asset_name: device ? parseVehicleName(device.name ?? "") : null,
    registration_no: device?.licensePlate ?? null,
    start_at: booking.startAt ?? "",
    end_at: booking.endAt ?? "",
    buffer_before_minutes: booking.bufferBeforeMinutes,
    buffer_after_minutes: booking.bufferAfterMinutes,
    purpose: booking.purpose,
    destination: booking.destination,
    passenger_count: booking.passengerCount,
    status: booking.status ?? "",
    approver_id: booking.approverId ?? null,
    approval_remarks: booking.approvalRemarks ?? null,
    version: booking.version,
    created_at: booking.createdAt ?? "",
    updated_at: booking.updatedAt ?? "",
    driver_id: booking.assignedDriverUserId ?? null,
    driver_name: driver?.name ?? null,
    dataQuality: validation.quality,
  };
}

function resolveAddInDataBookingToResolved(
  booking: OpexBooking,
  serverRecordId: string,
  devices: Map<string, RawMyGeotabDevice>,
  users: Map<string, RawMyGeotabUser>,
): ResolvedBooking {
  const device = devices.get(booking.deviceId ?? undefined);
  const requester = users.get(booking.requesterUserId ?? undefined);
  const driver = booking.assignedDriverUserId ? users.get(booking.assignedDriverUserId) : undefined;
  const validation = validateResolvedBooking({
    asset_id: booking.deviceId ?? null,
    requester_id: booking.requesterUserId,
    status: booking.status ?? "",
    start_at: booking.startAt,
    end_at: booking.endAt,
  });
  return {
    id: booking.id,
    requester_id: booking.requesterUserId,
    requester_name: requester?.name ?? "Unknown User",
    requested_class: booking.requestedClass,
    asset_id: booking.deviceId ?? null,
    asset_code: device ? `VEH-${device.id.slice(-3).toUpperCase()}` : null,
    asset_name: device ? parseVehicleName(device.name ?? "") : null,
    registration_no: device?.licensePlate ?? null,
    start_at: booking.startAt,
    end_at: booking.endAt,
    buffer_before_minutes: booking.bufferBeforeMinutes,
    buffer_after_minutes: booking.bufferAfterMinutes,
    purpose: booking.purpose,
    destination: booking.destination,
    passenger_count: booking.passengerCount,
    status: booking.status,
    approver_id: booking.approverId ?? null,
    approval_remarks: booking.approvalRemarks ?? null,
    version: booking.version,
    created_at: booking.createdAt,
    updated_at: booking.updatedAt,
    driver_id: booking.assignedDriverUserId ?? null,
    driver_name: driver?.name ?? null,
    dataQuality: validation.quality,
  };
}

function resolveBookingToResolved(booking: OpexBooking, serverRecordId?: string): ResolvedBooking {
  const validation = validateResolvedBooking({
    asset_id: booking.deviceId ?? null,
    requester_id: booking.requesterUserId,
    status: booking.status ?? "",
    start_at: booking.startAt,
    end_at: booking.endAt,
  });
  return {
    id: booking.id,
    requester_id: booking.requesterUserId,
    requester_name: "Unknown User",
    requested_class: booking.requestedClass,
    asset_id: booking.deviceId ?? null,
    asset_code: null,
    asset_name: null,
    registration_no: null,
    start_at: booking.startAt,
    end_at: booking.endAt,
    buffer_before_minutes: booking.bufferBeforeMinutes,
    buffer_after_minutes: booking.bufferAfterMinutes,
    purpose: booking.purpose,
    destination: booking.destination,
    passenger_count: booking.passengerCount,
    status: booking.status,
    approver_id: booking.approverId ?? null,
    approval_remarks: booking.approvalRemarks ?? null,
    version: booking.version,
    created_at: booking.createdAt,
    updated_at: booking.updatedAt,
    driver_id: booking.assignedDriverUserId ?? null,
    driver_name: null,
    dataQuality: validation.quality,
  };
}

export {
  serializeBooking,
  deserializeBooking,
  serializeNotification,
  deserializeNotification,
  serializeAudit,
  deserializeAudit,
  assertDetailsWithinLimit,
};

export function createAddInDataProvider(api: GeotabApi | null, addInId: string | null): AddInDataBookingDataProvider {
  return new AddInDataBookingDataProvider(api, addInId);
}
