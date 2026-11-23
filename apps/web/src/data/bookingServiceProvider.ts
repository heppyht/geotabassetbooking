/*───────────────────── Booking Service Provider ─────────────────────*/
/* BookingDataProvider implementation backed by the new Geotab-native
   domain/service/repository layer:
     - AddInDataGateway  -> low-level geotab.addin.call() wrapper
     - AddInDataRepository -> single consistent repository (envelope format)
     - BookingService    -> business logic (conflict detection, versioning, RBAC)

   Implements the same BookingDataProvider interface as AddInDataBookingDataProvider,
   so it can be used as a drop-in replacement in App.tsx for ADDIN_DATA mode.

   No Hono API dependency. All persistence goes through MyGeotab AddInData only.
   No external database. */

import type {
  BookingDataProvider,
  ResolvedAsset,
  ResolvedBooking,
  ResolvedUser,
  MyGeotabGroup,
  MyGeotabStatusData,
  MyGeotabLogRecord,
  OpexNotification,
  NotificationType,
  NotificationDataProvider,
} from "./types.ts";
import { AddInDataGateway } from "./addinDataService.ts";
import { AddInDataRepository } from "../repositories/addinData/index.ts";
import { BookingService } from "../services/index.ts";
import type { Principal, OpexBooking, BookingCreateInput } from "../domain/index.ts";
import { isValidAddInId } from "../config/addinId.ts";
import { generateId } from "../domain/index.ts";
import { validateResolvedBooking } from "./bookingValidation.ts";
import { findConflict, type Interval } from "../domain/index.ts";

const GROUP_ID = "GroupCompanyId";

type RawMyGeotabDevice = { id: string; name?: string; serialNumber?: string; licensePlate?: string; [key: string]: unknown };
type RawMyGeotabUser = { id: string; name?: string; role?: string; [key: string]: unknown };
type RawMyGeotabGroup = { id: string; name?: string; [key: string]: unknown };

function mapLiveAsset(d: RawMyGeotabDevice): ResolvedAsset {
  return {
    id: d.id,
    asset_code: `VEH-${d.id.slice(-3).toUpperCase()}`,
    asset_name: d.name ?? "",
    serial_number: d.serialNumber ?? null,
    make_model: "",
    asset_class: "OPERATIONAL_4X4",
    registration_no: d.licensePlate ?? null,
    status: "AVAILABLE",
    geotab_device_id: d.id,
  };
}

function mapLiveUser(u: RawMyGeotabUser): ResolvedUser {
  return {
    id: u.id,
    name: u.name ?? "Unknown User",
    roles: u.role ? [u.role] : ["EMPLOYEE"],
  };
}

function mapLiveGroup(g: RawMyGeotabGroup): MyGeotabGroup {
  return { id: g.id, name: g.name ?? "" };
}

function toPrincipal(actorId: string | null, roles: string[]): Principal {
  return {
    appUserId: actorId ?? "",
    geotabUserId: actorId ?? "",
    roles: (roles ?? ["EMPLOYEE"]) as any,
    siteIds: [],
  };
}

function toResolvedBooking(
  booking: OpexBooking,
  deviceMap: Map<string, { id: string; name?: string; licensePlate?: string }>,
  userMap: Map<string, { id: string; name?: string }>,
): ResolvedBooking {
  const device = deviceMap.get(booking.deviceId);
  const requester = userMap.get(booking.requesterUserId);
  const driver = booking.assignedDriverUserId ? userMap.get(booking.assignedDriverUserId) : undefined;
  const validation = validateResolvedBooking({
    asset_id: booking.deviceId ?? null,
    requester_id: booking.requesterUserId,
    status: booking.status,
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
    asset_name: device?.name ?? null,
    registration_no: device?.licensePlate ?? null,
    start_at: booking.startAt,
    end_at: booking.endAt,
    buffer_before_minutes: booking.bufferBeforeMinutes,
    buffer_after_minutes: booking.bufferAfterMinutes,
    purpose: booking.purpose,
    destination: booking.destination,
    passenger_count: booking.passengerCount,
    status: booking.status,
    approver_id: booking.approverId,
    approval_remarks: booking.approvalRemarks,
    version: booking.version,
    created_at: booking.createdAt,
    updated_at: booking.updatedAt,
    driver_id: booking.assignedDriverUserId ?? null,
    driver_name: driver?.name ?? null,
    dataQuality: validation.quality,
  };
}

export function createBookingServiceProvider(
  api: { call?: (method: string, params: Record<string, unknown>, success: (result: unknown) => void, error?: (error: unknown) => void) => void } | null,
  addInId: string | null,
): BookingDataProvider & NotificationDataProvider {
  const gateway = new AddInDataGateway(api, addInId);
  const repository = new AddInDataRepository({ api: gateway, addInId: addInId ?? "" });
  const bookingService = new BookingService(repository);

  async function getRaw<T>(method: string, params: Record<string, unknown>): Promise<T | null> {
    return new Promise((resolve, reject) => {
      if (!api?.call) {
        reject(new Error("GEOTAB_API_NOT_AVAILABLE"));
        return;
      }
      api.call(method, params, (result: unknown) => resolve(result as T), (error: unknown) => reject(error ?? new Error("GEOTAB_API_ERROR")));
    });
  }

  async function loadMasterData(): Promise<{
    deviceMap: Map<string, { id: string; name?: string; licensePlate?: string }>;
    userMap: Map<string, { id: string; name?: string }>;
  }> {
    const [devices, users] = await Promise.all([
      getRaw<RawMyGeotabDevice[]>("Get", { typeName: "Device", resultsLimit: 1000 }),
      getRaw<RawMyGeotabUser[]>("Get", { typeName: "User", resultsLimit: 1000 }),
    ]);
    const deviceMap = new Map<string, { id: string; name?: string; licensePlate?: string }>();
    for (const d of devices ?? []) {
      deviceMap.set(d.id, { id: d.id, name: d.name, licensePlate: d.licensePlate });
    }
    const userMap = new Map<string, { id: string; name?: string }>();
    for (const u of users ?? []) {
      userMap.set(u.id, { id: u.id, name: u.name });
    }
    return { deviceMap, userMap };
  }

  async function resolveBookings(
    bookings: OpexBooking[],
    deviceMap: Map<string, { id: string; name?: string; licensePlate?: string }>,
    userMap: Map<string, { id: string; name?: string }>,
  ): Promise<ResolvedBooking[]> {
    return bookings.map(b => toResolvedBooking(b, deviceMap, userMap));
  }

  function parseNotification(details: unknown): OpexNotification | null {
    try {
      const n = typeof details === "string" ? JSON.parse(details) : details;
      if (n && typeof n === "object" && typeof (n as any).id === "string") {
        return n as OpexNotification;
      }
      return null;
    } catch {
      return null;
    }
  }

  return {
    /*───────────────────── Master data ─────────────────────*/
    async getAssets(): Promise<ResolvedAsset[]> {
      const devices = await getRaw<RawMyGeotabDevice[]>("Get", { typeName: "Device", resultsLimit: 1000 });
      return (devices ?? []).map(mapLiveAsset);
    },
    async getUsers(): Promise<ResolvedUser[]> {
      const users = await getRaw<RawMyGeotabUser[]>("Get", { typeName: "User", resultsLimit: 1000 });
      return (users ?? []).map(mapLiveUser);
    },
    async getGroups(): Promise<MyGeotabGroup[]> {
      const groups = await getRaw<RawMyGeotabGroup[]>("Get", { typeName: "Group", resultsLimit: 1000 });
      return (groups ?? []).map(mapLiveGroup);
    },
    async getStatusData(): Promise<MyGeotabStatusData[]> {
      return [];
    },
    async getLogRecords(): Promise<MyGeotabLogRecord[]> {
      return [];
    },

    /*───────────────────── Booking transactions ─────────────────────*/
    async getBookings(): Promise<ResolvedBooking[]> {
      const { deviceMap, userMap } = await loadMasterData();
      const bookings = await bookingService.listBookings(toPrincipal("", []));
      return resolveBookings(bookings, deviceMap, userMap);
    },

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
      const { deviceMap, userMap } = await loadMasterData();

      /* Conflict check via BookingService domain logic. */
      const existing = await repository.listAllBookings();
      const candidate: Interval = { start: new Date(input.startAt), end: new Date(input.endAt) };
      const conflict = findConflict(
        candidate,
        existing as Array<{ id: string; startAt: string; endAt: string; status: string; deviceId: string }>,
        input.deviceId,
        ["PENDING_APPROVAL", "APPROVED", "ASSIGNED"],
      );
      if (conflict.hasConflict) {
        throw new Error(`ASSET_CONFLICT: Asset ${input.deviceId} already has a ${conflict.conflictingStatus} booking overlapping the requested time.`);
      }

      const now = new Date().toISOString();
      const bookingId = `addin-${generateId()}`;
      const idempotencyKey = `booking-create-${input.requesterUserId}-${input.startAt}-${input.endAt}-${input.deviceId}`;

      const createInput: BookingCreateInput = {
        bookingId,
        idempotencyKey,
        deviceId: input.deviceId,
        requesterUserId: input.requesterUserId,
        requestedClass: input.requestedClass,
        startAt: input.startAt,
        endAt: input.endAt,
        purpose: input.purpose,
        destination: input.destination,
        passengerCount: input.passengerCount,
        assignedDriverUserId: input.driverId ?? null,
        createdAt: now,
      };

      const result = await bookingService.createBooking(createInput, toPrincipal(input.requesterUserId, []));
      if (!result.created && result.conflict?.hasConflict) {
        throw new Error(`ASSET_CONFLICT: ${result.conflict.conflictingBookingId}`);
      }

      const master = await loadMasterData();
      const resolved = await resolveBookings([result.booking], master.deviceMap, master.userMap);
      return resolved[0];
    },

    async updateBookingStatus(id: string, status: string, approverId?: string, approvalRemarks?: string): Promise<void> {
      const booking = await repository.getBooking(id);
      if (!booking) throw new Error(`BOOKING_NOT_FOUND: ${id}`);

      const expectedVersion = booking.version || 0;
      const updates: { status?: string; approverId?: string | null; approvalRemarks?: string | null; assignedDriverUserId?: string | null } = { status };

      if (approverId !== undefined) updates.approverId = approverId;
      if (approvalRemarks !== undefined) updates.approvalRemarks = approvalRemarks;

      await bookingService.updateBookingStatus(id, updates, toPrincipal("", []), expectedVersion);
    },

    async deleteBooking(id: string): Promise<void> {
      const records = await gateway.search("AddInData", {
        addInId: addInId ?? "",
        recordType: "booking",
      });
      const raw = records.find(r => r.id === id);
      if (!raw) throw new Error(`BOOKING_NOT_FOUND: ${id}`);
      await gateway.remove("AddInData", { id: raw.id });
    },

    async resetDemoData(): Promise<void> {
      /* AddInData mode does not use local demo data. No-op. */
    },

    async getApprovers(): Promise<ResolvedUser[]> {
      const users = await getRaw<RawMyGeotabUser[]>("Get", { typeName: "User", resultsLimit: 1000 });
      return (users ?? [])
        .filter(u => u.role === "APPROVER")
        .map(mapLiveUser);
    },

    /*───────────────────── Notification operations ─────────────────────*/
    async getNotifications(userId: string, opts?: { limit?: number; offset?: number; unreadOnly?: boolean; type?: NotificationType }): Promise<OpexNotification[]> {
      const records = await gateway.search("AddInData", {
        addInId: addInId ?? "",
        recordType: "notification",
      });
      return (records ?? [])
        .map(r => parseNotification(r.details))
        .filter((n): n is OpexNotification => !!n && n.recipient_user_id === userId)
        .filter(n => (opts?.unreadOnly ? !n.is_read : true))
        .filter(n => (opts?.type ? n.type === opts.type : true))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(opts?.offset ?? 0, opts?.offset ?? 0 + (opts?.limit ?? Infinity));
    },

    async getUnreadCount(userId: string): Promise<number> {
      const records = await gateway.search("AddInData", {
        addInId: addInId ?? "",
        recordType: "notification",
      });
      return (records ?? [])
        .map(r => parseNotification(r.details))
        .filter((n): n is OpexNotification => !!n && n.recipient_user_id === userId && !n.is_read).length;
    },

    async createNotification(input: {
      eventId: string;
      idempotencyKey: string;
      type: NotificationType;
      recipient_user_id: string;
      related_booking_id: string | null;
      title: string;
      message: string;
    }): Promise<OpexNotification> {
      const existing = await gateway.search("AddInData", {
        addInId: addInId ?? "",
        recordType: "notification",
      });
      for (const record of existing ?? []) {
        const n = parseNotification(record.details);
        if (n && n.idempotencyKey === input.idempotencyKey) return n;
      }

      const now = new Date().toISOString();
      const notification: OpexNotification = {
        id: `n-${generateId()}`,
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

      await repository.createNotification(notification as any);
      return notification;
    },

    async findByIdempotencyKey(idempotencyKey: string): Promise<OpexNotification | null> {
      const records = await gateway.search("AddInData", {
        addInId: addInId ?? "",
        recordType: "notification",
      });
      for (const record of records ?? []) {
        const n = parseNotification(record.details);
        if (n && n.idempotencyKey === idempotencyKey) return n;
      }
      return null;
    },

    async markAsRead(notificationId: string): Promise<void> {
      const records = await gateway.search("AddInData", {
        addInId: addInId ?? "",
        recordType: "notification",
      });
      const record = (records ?? []).find(r => {
        const n = parseNotification(r.details);
        return !!n && n.id === notificationId;
      });
      if (!record) return;
      const n = parseNotification(record.details)!;
      n.is_read = true;
      n.updated_at = new Date().toISOString();
      await repository.updateNotificationDeliveryStatus(record.id, n.delivery_status);
    },

    async markAllAsRead(userId: string): Promise<void> {
      const records = await gateway.search("AddInData", {
        addInId: addInId ?? "",
        recordType: "notification",
      });
      const now = new Date().toISOString();
      for (const record of records ?? []) {
        try {
          const n = parseNotification(record.details);
          if (n && n.recipient_user_id === userId && !n.is_read) {
            n.is_read = true;
            n.updated_at = now;
            await repository.updateNotificationDeliveryStatus(record.id, n.delivery_status);
          }
        } catch { /* skip */ }
      }
    },

    async markDeliveryStatus(notificationId: string, status: "pending" | "delivered" | "failed"): Promise<void> {
      const records = await gateway.search("AddInData", {
        addInId: addInId ?? "",
        recordType: "notification",
      });
      const record = (records ?? []).find(r => {
        const n = parseNotification(r.details);
        return !!n && n.id === notificationId;
      });
      if (!record) return;
      await repository.updateNotificationDeliveryStatus(record.id, status);
    },

    /*───────────────────── Audit operations ─────────────────────*/
    async createAuditRecord(input: {
      booking_id: string;
      action: string;
      actor_user_id: string;
      previous_status: string | null;
      new_status: string | null;
      details: string | null;
    }): Promise<void> {
      const now = new Date().toISOString();
      const auditId = `audit-${generateId()}`;
      await repository.createAuditEvent({
        id: auditId,
        booking_id: input.booking_id,
        eventId: auditId,
        eventType: input.action,
        actor_user_id: input.actor_user_id,
        previous_status: input.previous_status,
        new_status: input.new_status,
        changes: [{ field: "status", previousValue: input.previous_status, newValue: input.new_status }],
        details: input.details ? JSON.parse(input.details) : null,
        created_at: now,
        schemaVersion: 2,
      });
    },

    async getAuditRecords(bookingId: string): Promise<any[]> {
      const history = await repository.readAuditHistory(bookingId);
      return history.map(a => ({
        id: a.id,
        booking_id: a.booking_id,
        action: a.eventType,
        actor_user_id: a.actor_user_id,
        previous_status: a.previous_status,
        new_status: a.new_status,
        details: a.details ? JSON.stringify(a.details) : null,
        created_at: a.created_at,
      }));
    },

    /*───────────────────── Capability ─────────────────────*/
    isLive(): boolean {
      return gateway.isConfigured() && isValidAddInId(addInId);
    },
  };
}
