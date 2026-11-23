/*───────────────────── MyGeotab-Aligned Types ─────────────────────*/

import type { GeotabDevice, GeotabUser, GeotabTrip, GeotabLocation } from "../../../api/src/integrations/mygeotab/types";

/*───────────────────── Groups ─────────────────────*/
export interface MyGeotabGroup {
  id: string;
  name: string;
  parentId?: string;
}

/*───────────────────── Devices (extended GeotabDevice) ─────────────────────*/
export interface MyGeotabDevice extends GeotabDevice {
  licensePlate?: string;
  make?: string;
  model?: string;
  vehicleClass?: "OPERATIONAL_4X4" | "PASSENGER";
  groupIds: string[];
  status: "AVAILABLE" | "MAINTENANCE" | "OUT_OF_SERVICE";
}

/*───────────────────── Users (extended GeotabUser) ─────────────────────*/
export interface MyGeotabUser extends GeotabUser {
  email: string;
  companyGroups: string[];
  securityClearance?: string[];
  role?: "EMPLOYEE" | "APPROVER" | "GA" | "MANAGEMENT" | "ADMIN";
  siteCode?: string;
}

/*───────────────────── Telemetry ─────────────────────*/
export interface MyGeotabStatusData extends GeotabLocation {
  id: string;
  deviceId: string;
  odometer?: number;
  fuelLevel?: number;
  engineHours?: number;
}

export interface MyGeotabLogRecord extends GeotabLocation {
  id: string;
  deviceId: string;
  speed?: number;
  heading?: number;
}

/*───────────────────── OPEX Booking data quality ─────────────────────*/

export type BookingDataQuality =
  | "VALID"
  | "MISSING_ASSET"
  | "MISSING_REQUESTER"
  | "MISSING_STATUS"
  | "INVALID_DATETIME"
  | "MALFORMED_DETAILS"
  | "MULTIPLE_VALIDATION_ERRORS";

export interface BookingValidationResult {
  quality: BookingDataQuality;
  issues: string[];
}

/*───────────────────── OPEX Booking (MyGeotab-aligned) ─────────────────────*/
export interface OpexBooking {
  id: string;
  deviceId: string;
  requesterUserId: string;
  requestedClass: "OPERATIONAL_4X4" | "PASSENGER";
  startAt: string;
  endAt: string;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  purpose: string;
  destination: string | null;
  passengerCount: number | null;
  status:
    | "DRAFT"
    | "SUBMITTED"
    | "PENDING_APPROVAL"
    | "APPROVED"
    | "ASSIGNED"
    | "CHECKED_OUT"
    | "OVERDUE"
    | "RETURNED"
    | "CLOSED"
    | "COMPLETED"
    | "REJECTED"
    | "CANCELLED"
    | "EXPIRED";
  assignedDriverUserId: string | null;
  approverId: string | null;
  approvalRemarks: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/*───────────────────── Frontend-view types (resolved through master data) ─────────────────────*/
export interface ResolvedAsset {
  id: string;
  asset_code: string;
  asset_name: string;
  serial_number: string | null;
  make_model: string;
  asset_class: string;
  registration_no: string | null;
  status: string;
  geotab_device_id: string | null;
}

export interface ResolvedBooking {
  id: string;
  requester_id: string;
  requester_name: string;
  requested_class: string;
  asset_id: string | null;
  asset_code: string | null;
  asset_name: string | null;
  registration_no: string | null;
  start_at: string;
  end_at: string;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  purpose: string;
  destination: string | null;
  passenger_count: number | null;
  status: string;
  approver_id: string | null;
  approval_remarks: string | null;
  version: number;
  created_at: string;
  updated_at: string;
    driver_id: string | null;
    driver_name: string | null;
    dataQuality: BookingDataQuality;
}

export interface ResolvedUser {
  id: string;
  name: string;
  roles: string[];
  companyGroups?: string[];
}

/*───────────────────── Data Provider Interface ─────────────────────*/
export interface BookingDataProvider {
  getAssets(): Promise<ResolvedAsset[]>;
  getUsers(): Promise<ResolvedUser[]>;
  getGroups(): Promise<MyGeotabGroup[]>;
  getStatusData(): Promise<MyGeotabStatusData[]>;
  getLogRecords(): Promise<MyGeotabLogRecord[]>;
  getBookings(): Promise<ResolvedBooking[]>;
  createBooking(input: {
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
  }): Promise<ResolvedBooking>;
  updateBookingStatus(id: string, status: string, approverId?: string, approvalRemarks?: string): Promise<void>;
  deleteBooking(id: string): Promise<void>;
  resetDemoData(): Promise<void>;
  isLive(): boolean;
  getApprovers(): Promise<ResolvedUser[]>;
}

/*───────────────────── Notification Types ─────────────────────*/

export type NotificationType =
  | "booking_created"
  | "booking_approved"
  | "booking_rejected"
  | "vehicle_assigned"
  | "booking_cancelled";

export interface OpexNotification {
  id: string;
  eventId: string;
  idempotencyKey: string;
  type: NotificationType;
  recipient_user_id: string;
  related_booking_id: string | null;
  title: string;
  message: string;
  is_read: boolean;
  delivery_status: "pending" | "delivered" | "failed";
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpexBookingAudit {
  id: string;
  booking_id: string;
  action: string;
  actor_user_id: string;
  previous_status: string | null;
  new_status: string | null;
  details: string | null;
  created_at: string;
}

/*───────────────────── AddInData Record Schemas (schemaVersion 2) ─────────────────────*/

export type AddInDataRecordType = "booking" | "booking_audit" | "notification";

export interface AddInDataRecordEnvelope<T> {
  recordType: AddInDataRecordType;
  schemaVersion: number;
  entityId?: string;          // AddInData server record id (record.id from Add API response)
  data: T;
}

/* Booking Master record — one AddInData record per booking. */
export interface AddInDataBookingData {
  bookingId: string;          // application-level booking id (distinct from AddInData entityId)
  status: OpexBooking["status"];
  vehicle: {
    deviceId: string;
    name: string | null;
  };
  driver?: {
    driverId: string;
    name: string | null;
  };
  schedule: {
    startAtUtc: string;
    endAtUtc: string;
  };
  destination: string | null;
  purpose: string;
  lifecycle: {
    createdAtUtc: string;
    updatedAtUtc: string;
  };
  version: number;
}

/* Booking Audit History record — one AddInData record per audit event (append-only). */
export interface AddInDataAuditData {
  eventId: string;
  bookingId: string;
  eventType: AuditAction;
  occurredAtUtc: string;
  actor: {
    userId: string;
    name: string | null;
  };
  changes: Array<{
    field: string;
    previousValue: unknown;
    newValue: unknown;
  }>;
  metadata: {
    source: "MYGEOTAB_ADDIN";
    idempotencyKey: string;
  };
}

/* Partition key for bounded AddInData queries. Format: YYYY-MM */
export type PeriodKey = string;

export function makePeriodKey(isoUtc: string): PeriodKey {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/* Booking status transitions — shared between frontend and API. */
export type AuditAction =
  | "BOOKING_CREATED"
  | "BOOKING_UPDATED"
  | "BOOKING_SUBMITTED"
  | "BOOKING_APPROVED"
  | "BOOKING_REJECTED"
  | "BOOKING_CANCELLED"
  | "BOOKING_COMPLETED"
  | "BOOKING_RESCHEDULED";

export const BOOKING_VALID_TRANSITIONS: Record<string, string[]> = {
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

export function isValidBookingTransition(from: string, to: string): boolean {
  return BOOKING_VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/*───────────────────── Notification Provider Interface ─────────────────────*/

export interface NotificationDataProvider {
  getNotifications(userId: string, opts?: { limit?: number; offset?: number; unreadOnly?: boolean; type?: NotificationType }): Promise<OpexNotification[]>;
  getUnreadCount(userId: string): Promise<number>;
  createNotification(input: {
    eventId: string;
    idempotencyKey: string;
    type: NotificationType;
    recipient_user_id: string;
    related_booking_id: string | null;
    title: string;
    message: string;
  }): Promise<OpexNotification>;
  findByIdempotencyKey(idempotencyKey: string): Promise<OpexNotification | null>;
  markAsRead(notificationId: string): Promise<void>;
  markAllAsRead(userId: string): Promise<void>;
  markDeliveryStatus(notificationId: string, status: "pending" | "delivered" | "failed"): Promise<void>;
  createAuditRecord(input: {
    booking_id: string;
    action: string;
    actor_user_id: string;
    previous_status: string | null;
    new_status: string | null;
    details: string | null;
  }): Promise<void>;
  getAuditRecords(bookingId: string): Promise<OpexBookingAudit[]>;
  isLive(): boolean;
}
