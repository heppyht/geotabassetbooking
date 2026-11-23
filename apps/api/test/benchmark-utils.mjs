/*───────────────────── Phase 9.5: Benchmark Shared Utilities ─────────────────────*/
/* Deterministic synthetic dataset generator and record size statistics.
   Shared by record-size, capacity, query, and rate-limit benchmarks.
   No production tenant access. Reproducible via seeded PRNG. */

export const MAX_DETAILS_CHARS = 10000;

/*───────────────────── Seeded PRNG (deterministic) ─────────────────────*/

export class SeededRNG {
  constructor(seed) {
    this.seed = seed;
  }
  next() {
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return (this.seed >>> 0) / 0x100000000;
  }
  int(min, max) {
    return Math.floor(min + this.next() * (max - min + 1));
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

/*───────────────────── Configuration ─────────────────────*/

export const SCENARIOS = {
  small: { bookings: 1_000 },
  medium: { bookings: 10_000 },
  large: { bookings: 50_000 },
  stress: { bookings: 100_000 },
};

export const STATUS_DISTRIBUTION = {
  PENDING_APPROVAL: 0.10,
  APPROVED: 0.30,
  ASSIGNED: 0.20,
  CHECKED_OUT: 0.15,
  RETURNED: 0.15,
  CANCELLED: 0.05,
  REJECTED: 0.03,
  CLOSED: 0.02,
};

export const VEHICLE_CLASSES = ["PASSENGER", "OPERATIONAL_4X4"];
export const PURPOSES = [
  "Client site visit",
  "Equipment delivery",
  "Team offsite meeting",
  "Maintenance inspection",
  "Training session",
  "Audit support",
  "Stakeholder demo",
];
export const DESTINATIONS = [
  "Head Office - Main Building",
  "Regional Office - North",
  "Regional Office - South",
  "Client Site Alpha",
  "Warehouse B",
  null,
];

export const DELIVERED_AT_BASE = "2026-11-15T09:20:00Z";

/*───────────────────── Date helpers ─────────────────────*/

export function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function formatIso(date) {
  return date.toISOString();
}

export function periodKeyFromIso(isoUtc) {
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/*───────────────────── Statistics ─────────────────────*/

export function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = (p / 100) * (n - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const frac = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * frac;
}

export function stats(sizes) {
  const sorted = [...sizes].sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: total / sorted.length,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    count: sorted.length,
    totalChars: total,
  };
}

export function utf8Bytes(str) {
  return new TextEncoder().encode(str).length;
}

export function utf8BytesEstimate(chars) {
  return Math.ceil(chars * 1.1);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/*───────────────────── Record generators ─────────────────────*/

export function generateBooking(rng, index, startDate, vehicleCount, driverCount, statusDist) {
  const bookingId = `bench-bk-${String(index).padStart(8, "0")}`;
  const vehicleId = `veh-${String(rng.int(1, vehicleCount)).padStart(4, "0")}`;
  const vehicleName = `Vehicle ${vehicleId}`;

  const startOffsetDays = rng.int(0, 30);
  const startDateTime = addDays(startDate, startOffsetDays);
  const startHour = rng.int(7, 16);
  startDateTime.setUTCHours(startHour, 0, 0, 0);

  const durationHours = rng.int(1, 4);
  const endDateTime = new Date(startDateTime.getTime() + durationHours * 3600 * 1000);

  const rand = rng.next();
  let cumulative = 0;
  let status = "PENDING_APPROVAL";
  for (const [s, p] of Object.entries(statusDist)) {
    cumulative += p;
    if (rand < cumulative) { status = s; break; }
  }

  const hasDriver = rng.next() < 0.70;
  const driverCountAvailable = Math.max(1, driverCount);
  const driverId = hasDriver ? `drv-${String(rng.int(1, driverCountAvailable)).padStart(4, "0")}` : null;
  const driverName = hasDriver ? `Driver ${driverId}` : null;

  const createdAt = new Date(startDateTime.getTime() - rng.int(1, 72) * 3600 * 1000);
  const updatedAt = new Date(startDateTime.getTime() + rng.int(0, 24) * 3600 * 1000);

  const booking = {
    bookingId,
    status,
    requesterUserId: `user-${rng.int(1, 100)}`,
    assignedDriverUserId: driverId,
    vehicle: {
      deviceId: vehicleId,
      name: vehicleName,
    },
    ...(driverId ? { driver: { driverId, name: driverName } } : {}),
    schedule: {
      startAtUtc: formatIso(startDateTime),
      endAtUtc: formatIso(endDateTime),
    },
    destination: rng.pick(DESTINATIONS),
    purpose: rng.pick(PURPOSES),
    lifecycle: {
      createdAtUtc: formatIso(createdAt),
      updatedAtUtc: formatIso(updatedAt),
    },
    version: rng.int(1, 5),
  };

  const envelope = { recordType: "booking", schemaVersion: 2, data: booking };
  const serialized = JSON.stringify(envelope);
  if (serialized.length > MAX_DETAILS_CHARS) {
    throw new Error(`Booking ${bookingId} exceeds ${MAX_DETAILS_CHARS} chars: ${serialized.length}`);
  }

  return { booking, envelope, periodKey: periodKeyFromIso(booking.lifecycle.createdAtUtc) };
}

export function generateAuditEvents(rng, booking, auditPerBooking, startIndex) {
  const events = [];
  const statuses = ["PENDING_APPROVAL", "APPROVED", "ASSIGNED", "CHECKED_OUT", "RETURNED", "CANCELLED"];
  const eventTypes = ["BOOKING_CREATED", "BOOKING_SUBMITTED", "BOOKING_APPROVED", "BOOKING_ASSIGNED", "BOOKING_CHECKED_OUT", "BOOKING_RETURNED", "BOOKING_CANCELLED"];

  let prevStatus = "DRAFT";
  for (let i = 0; i < auditPerBooking; i++) {
    const eventId = `bench-audit-${String(startIndex + i).padStart(8, "0")}`;
    const newStatus = rng.pick(statuses);
    const eventType = rng.pick(eventTypes);
    const occurredAt = new Date(booking.lifecycle.createdAtUtc);
    occurredAt.setUTCSeconds(occurredAt.getUTCSeconds() + rng.int(1, 3600));

    const changes = [
      { field: "status", previousValue: prevStatus, newValue: newStatus },
    ];
    if (rng.next() < 0.3) {
      changes.push({ field: "version", previousValue: rng.int(1, 3), newValue: rng.int(2, 6) });
    }

    const audit = {
      eventId,
      bookingId: booking.bookingId,
      eventType,
      occurredAtUtc: formatIso(occurredAt),
      actor: {
        userId: rng.pick(["user-1", "approver-42", "ga-user-7", "driver-99"]),
        name: rng.pick(["Requester", "Approver", "GA", "Driver"]),
      },
      changes,
      metadata: {
        source: "MYGEOTAB_ADDIN",
        idempotencyKey: `idem-${booking.bookingId}-${i}`,
      },
    };

    const envelope = { recordType: "booking_audit", schemaVersion: 2, data: audit };
    const serialized = JSON.stringify(envelope);
    if (serialized.length > MAX_DETAILS_CHARS) {
      throw new Error(`Audit ${eventId} exceeds ${MAX_DETAILS_CHARS} chars: ${serialized.length}`);
    }

    events.push({ audit, envelope, periodKey: periodKeyFromIso(audit.occurredAtUtc) });
    prevStatus = newStatus;
  }
  return events;
}

export function generateNotifications(rng, booking, notifPerBooking, startIndex) {
  const notifications = [];
  const types = ["booking_created", "booking_approved", "booking_rejected", "vehicle_assigned", "booking_cancelled"];

  for (let i = 0; i < notifPerBooking; i++) {
    const notifId = `bench-notif-${String(startIndex + i).padStart(8, "0")}`;
    const type = rng.pick(types);

    const notification = {
      id: notifId,
      eventId: `bench-notif-event-${String(startIndex + i).padStart(8, "0")}`,
      idempotencyKey: `idem-notif-${booking.bookingId}-${i}`,
      type,
      recipient_user_id: `user-${rng.int(1, 100)}`,
      related_booking_id: booking.bookingId,
      title: `Your booking has been ${type.replace("_", " ")}`,
      message: `Your vehicle booking ${booking.bookingId} for ${booking.vehicle.name} on ${booking.schedule.startAtUtc} has been ${type.replace("_", " ")}.`,
      is_read: rng.next() < 0.5,
      delivery_status: rng.pick(["pending", "delivered", "failed"]),
      delivered_at: rng.next() < 0.7 ? DELIVERED_AT_BASE : null,
      created_at: booking.lifecycle.createdAtUtc,
      updated_at: booking.lifecycle.updatedAtUtc,
    };

    const envelope = { recordType: "notification", schemaVersion: 2, data: notification };
    const serialized = JSON.stringify(envelope);
    if (serialized.length > MAX_DETAILS_CHARS) {
      throw new Error(`Notification ${notifId} exceeds ${MAX_DETAILS_CHARS} chars: ${serialized.length}`);
    }

    notifications.push({ notification, envelope, periodKey: periodKeyFromIso(notification.created_at) });
  }
  return notifications;
}

/*───────────────────── Dataset generator ─────────────────────*/

export function generateDataset({
  scenario = "small",
  auditPerBooking = 5,
  notifPerBooking = 1,
  seed = 42,
  startDate = "2026-11-01T00:00:00Z",
  vehicleCount = 50,
  driverCount = 25,
  statusDistribution = STATUS_DISTRIBUTION,
} = {}) {
  if (!SCENARIOS[scenario]) {
    throw new Error(`Unknown scenario: ${scenario}. Available: ${Object.keys(SCENARIOS).join(", ")}`);
  }

  const rng = new SeededRNG(seed);
  const bookingCount = SCENARIOS[scenario].bookings;
  const startDateObj = new Date(startDate);

  const bookings = [];
  const audits = [];
  const notifications = [];
  let auditIndex = 0;
  let notifIndex = 0;

  for (let i = 0; i < bookingCount; i++) {
    const { booking, envelope, periodKey } = generateBooking(
      rng, i, startDateObj, vehicleCount, driverCount, statusDistribution,
    );
    bookings.push({ booking, envelope, periodKey });

    const bookingAudits = generateAuditEvents(rng, booking, auditPerBooking, auditIndex);
    audits.push(...bookingAudits);
    auditIndex += bookingAudits.length;

    const bookingNotifs = generateNotifications(rng, booking, notifPerBooking, notifIndex);
    notifications.push(...bookingNotifs);
    notifIndex += bookingNotifs.length;
  }

  return {
    scenario,
    seed,
    config: { auditPerBooking, notifPerBooking, vehicleCount, driverCount, startDate },
    bookings,
    audits,
    notifications,
    counts: {
      bookings: bookings.length,
      audits: audits.length,
      notifications: notifications.length,
      total: bookings.length + audits.length + notifications.length,
    },
  };
}
