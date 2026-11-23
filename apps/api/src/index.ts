import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env.ts";
import { requirePrincipal, requireRole, extractGeotabCredentials } from "./auth.ts";
import { createGateway, createResilientGateway, type AddInDataRestGateway } from "./db.ts";
import { classifyError, type ClassifiedError } from "./retry.ts";
import {
  assignApprovedBooking,
  approveBooking,
  canApprove,
  canAssign,
  canCancel,
  canCancelBooking,
  canModifyBooking,
  canViewBooking,
  cancelBooking,
  createBooking,
  findBookingRecord,
  generateId,
  getBookingsByDriver,
  isValidTransition,
  rejectBooking,
} from "./services/booking.ts";

const GROUP_ID = "GroupCompanyId";
const WORKER_VERSION = "0.1.0-phase97";

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && origin !== c.env.ALLOWED_ORIGIN) return c.json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
  await next();
});
app.use("/api/*", cors({
  origin: (origin, c) => origin === c.env.ALLOWED_ORIGIN ? origin : "",
  allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Geotab-Session-Id", "X-Geotab-User-Name", "X-Geotab-Database"],
  maxAge: 600
}));

/* Security headers on all API responses. */
app.use("/api/*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
});

/* Request body size limit: 1 MB. AddInData records are capped at 10,000
   serialized characters, so any larger body is rejected before parsing. */
const MAX_BODY_BYTES = 1_000_000;
app.use("*", async (c, next) => {
  if (c.req.method === "POST" || c.req.method === "PATCH") {
    const contentLength = c.req.header("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
      return c.json({ error: "REQUEST_TOO_LARGE" }, 413);
    }
  }
  await next();
});

function gatewayForRequest(c: { env: Env; req: { raw: Request; header: (name: string) => string | null } }) {
  const creds = extractGeotabCredentials(c.req.raw);
  if (!creds) return null;
  /* Tenant isolation: always use the server-configured database.
     Client-supplied x-geotab-database is never trusted. */
  const database = c.env.GEOTAB_DATABASE;
  return createResilientGateway({ userName: creds.userName, database, sessionId: creds.sessionId });
}

function errorResponse(c: any, error: unknown, defaultMessage: string, status = 500) {
  const classified = classifyError(error);
  const userMessage = userFacingError(classified, defaultMessage);
  const msg = error instanceof Error ? error.message : String(error);
  return c.json({ error: userMessage, detail: c.env.APP_ENV === "development" ? msg : undefined }, status);
}

/* Map classified errors to user-facing messages. Never expose credentials,
   session IDs, stack traces, or raw sensitive payloads. */
function userFacingError(classified: ClassifiedError, defaultMessage: string): string {
  switch (classified.category) {
    case "rate_limit":
      return "MyGeotab is temporarily busy. Please try again shortly.";
    case "temporary_network_failure":
      return "Unable to connect to MyGeotab. Please check your connection and retry.";
    case "network_timeout":
      return "The request timed out. Please try again.";
    case "authentication_failure":
      return "Your MyGeotab session has expired. Please sign in again.";
    case "permission_error":
      return "You do not have permission to perform this action.";
    case "validation_error":
      return "Invalid request. Please check your input and try again.";
    case "concurrency_conflict":
      return "The booking was modified by another request. Please refresh and try again.";
    case "permanent_api_error":
      return defaultMessage;
    case "unknown":
    default:
      return defaultMessage;
  }
}

app.get("/api/health", c => c.json({
  ok: true, service: "opex-vbm-api", version: WORKER_VERSION,
  environment: c.env.APP_ENV,
  tenantTarget: c.env.GEOTAB_DATABASE,
  authConfigured: c.env.IDENTITY_ADAPTER_CONFIGURED === "true",
  storage: "mygeotab-addindata",
}));

app.get("/api/me", requirePrincipal, c => c.json(c.get("principal")));

app.get("/api/vehicles", requirePrincipal, async c => {
  const gateway = gatewayForRequest(c as any);
  if (!gateway) return c.json({ error: "AUTH_CREDENTIALS_MISSING" }, 401);
  try {
    const devices = await gateway.getDevices();
    return c.json(devices);
  } catch (e) {
    return errorResponse(c, e, "VEHICLES_LOAD_FAILED", 500);
  }
});

app.get("/api/bookings", requirePrincipal, async c => {
  const gateway = gatewayForRequest(c as any);
  if (!gateway) return c.json({ error: "AUTH_CREDENTIALS_MISSING" }, 401);
  const p = c.get("principal");
  try {
    const records = await gateway.searchAddInData("addin-booking-app", { recordType: "booking" });
    const bookings = records
      .map(r => {
        try {
          const raw = typeof r.details === "string" ? JSON.parse(r.details) : r.details;
          return raw;
        } catch { return null; }
      })
      .filter((b): b is Record<string, unknown> => b !== null && b.requesterUserId === p.appUserId)
      .sort((a, b) => String(b.startAt || "").localeCompare(String(b.startAt || "")))
      .slice(0, 100);
    return c.json(bookings);
  } catch (e) {
    return errorResponse(c, e, "BOOKINGS_LOAD_FAILED", 500);
  }
});

app.get("/api/bookings/driver", requirePrincipal, async c => {
  const gateway = gatewayForRequest(c as any);
  if (!gateway) return c.json({ error: "AUTH_CREDENTIALS_MISSING" }, 401);
  try {
    const bookings = await getBookingsByDriver(gateway, c.get("principal").appUserId);
    return c.json(bookings);
  } catch (e) {
    return errorResponse(c, e, "DRIVER_BOOKINGS_LOAD_FAILED", 500);
  }
});

app.get("/api/bookings/:id", requirePrincipal, async c => {
  const bookingId = c.req.param("id");
  const gateway = gatewayForRequest(c as any);
  if (!gateway) return c.json({ error: "AUTH_CREDENTIALS_MISSING" }, 401);
  const p = c.get("principal");
  try {
    const found = await findBookingRecord(gateway, bookingId);
    if (!found) return c.json({ error: "BOOKING_NOT_FOUND" }, 404);
    if (!canViewBooking(p, found.booking)) {
      return c.json({ error: "FORBIDDEN" }, 403);
    }
    return c.json(found.booking);
  } catch (e) {
    return errorResponse(c, e, "BOOKING_LOAD_FAILED", 500);
  }
});

app.post("/api/bookings", requirePrincipal, async c => {
  const gateway = gatewayForRequest(c as any);
  if (!gateway) return c.json({ error: "AUTH_CREDENTIALS_MISSING" }, 401);
  const body = await c.req.json().catch(() => null) as null | {
    startAt?: string; endAt?: string; purpose?: string; requestedClass?: string;
    deviceId?: string;
  };
  if (!body?.startAt || !body?.endAt || !body?.purpose || !body?.deviceId) return c.json({ error: "INVALID_REQUEST" }, 400);
  const start = new Date(body.startAt), end = new Date(body.endAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return c.json({ error: "INVALID_INTERVAL" }, 400);

  const p = c.get("principal");
  const idempotencyKey = c.req.header("Idempotency-Key") ?? `booking-create-${p.appUserId}-${body.startAt}-${body.endAt}-${body.deviceId}`;

  const allBookings = await gateway.searchAddInData("addin-booking-app", { recordType: "booking" });
  const conflictStatuses = ["PENDING_APPROVAL", "APPROVED", "ASSIGNED"];
  const newStart = start, newEnd = end;
  const conflict = allBookings.some(r => {
    try {
      const raw = typeof r.details === "string" ? JSON.parse(r.details) : r.details;
      if (!raw || raw.deviceId !== body.deviceId) return false;
      if (!conflictStatuses.includes(raw.status)) return false;
      return overlaps(newStart, newEnd, new Date(raw.startAt), new Date(raw.endAt));
    } catch { return false; }
  });
  if (conflict) {
    return c.json({ error: "ASSET_CONFLICT", message: "Vehicle already has a booking overlapping the requested time." }, 409);
  }

  const bookingId = generateId();
  const now = new Date().toISOString();
  try {
    const result = await createBooking(gateway, {
      bookingId,
      idempotencyKey,
      deviceId: body.deviceId,
      requesterUserId: p.appUserId,
      requestedClass: body.requestedClass || "PASSENGER",
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      purpose: body.purpose,
      destination: null,
      passengerCount: null,
      assignedDriverUserId: null,
      createdAt: now,
    });

    const bookingRecord: Record<string, unknown> = {
      id: result.booking.id,
      recordType: "booking",
      deviceId: body.deviceId,
      requesterUserId: p.appUserId,
      requestedClass: body.requestedClass || "PASSENGER",
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 30,
      purpose: body.purpose,
      destination: null,
      passengerCount: null,
      status: "PENDING_APPROVAL",
      assignedDriverUserId: null,
      approverId: null,
      approvalRemarks: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
      idempotencyKey,
    };

    return c.json({ booking: bookingRecord, created: result.created, idempotencyKey }, result.created ? 201 : 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg === "ADDIN_DATA_ADD_FAILED") return c.json({ error: "BOOKING_CREATE_FAILED", detail: msg }, 500);
    return errorResponse(c, e, "BOOKING_CREATE_FAILED", 500);
  }
});

app.post("/api/bookings/:id/submit-for-approval", requirePrincipal, async c => {
  const bookingId = c.req.param("id");
  const gateway = gatewayForRequest(c as any);
  if (!gateway) return c.json({ error: "AUTH_CREDENTIALS_MISSING" }, 401);
  const p = c.get("principal");
  try {
    const records = await gateway.searchAddInData("addin-booking-app", { recordType: "booking" });
    let found: Record<string, unknown> | null = null;
    let foundRecordId: string | null = null;
    for (const r of records) {
      try {
        const raw = typeof r.details === "string" ? JSON.parse(r.details) : r.details;
        if ((raw.id === bookingId || r.id === bookingId) && raw.requesterUserId === p.appUserId) {
          found = raw; foundRecordId = r.id; break;
        }
      } catch { /* skip */ }
    }
    if (!found || !foundRecordId) return c.json({ error: "BOOKING_NOT_FOUND" }, 404);
    if (!isValidTransition(found.status as string, "PENDING_APPROVAL")) {
      return c.json({ error: "INVALID_TRANSITION", from: found.status, to: "PENDING_APPROVAL" }, 409);
    }
    const updated = { ...found, status: "PENDING_APPROVAL", version: ((found.version as number) || 0) + 1, updatedAt: new Date().toISOString() };
    await gateway.setAddInData("addin-booking-app", foundRecordId, updated, GROUP_ID);
    return c.json({ bookingId, status: "PENDING_APPROVAL" });
  } catch (e) {
    return errorResponse(c, e, "SUBMIT_FOR_APPROVAL_FAILED", 500);
  }
});

app.post("/api/bookings/:id/approve", requirePrincipal, requireRole("APPROVER", "MANAGEMENT", "ADMIN"), async c => {
  const bookingId = c.req.param("id");
  const gateway = gatewayForRequest(c as any);
  if (!gateway) return c.json({ error: "AUTH_CREDENTIALS_MISSING" }, 401);
  const p = c.get("principal");
  const body = await c.req.json().catch(() => null) as null | { comments?: string; stepNo?: number };
  try {
    const result = await approveBooking(gateway, {
      bookingId,
      approverId: p.appUserId,
      comments: body?.comments,
      stepNo: body?.stepNo,
    });
    if (!result.auditPersisted) {
      return c.json({ error: "AUDIT_WRITE_FAILED", detail: "Booking approved but audit event was not persisted", bookingId }, 500);
    }
    return c.json(result, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg === "BOOKING_NOT_FOUND") return c.json({ error: "BOOKING_NOT_FOUND" }, 404);
    if (msg.startsWith("INVALID_TRANSITION")) return c.json({ error: "INVALID_TRANSITION", detail: msg }, 409);
    if (msg.startsWith("BOOKING_VERSION_CONFLICT")) return c.json({ error: "BOOKING_VERSION_CONFLICT", detail: msg }, 409);
    return errorResponse(c, e, "APPROVAL_FAILED", 500);
  }
});

app.post("/api/bookings/:id/reject", requirePrincipal, requireRole("APPROVER", "MANAGEMENT", "ADMIN"), async c => {
  const bookingId = c.req.param("id");
  const gateway = gatewayForRequest(c as any);
  if (!gateway) return c.json({ error: "AUTH_CREDENTIALS_MISSING" }, 401);
  const p = c.get("principal");
  const body = await c.req.json().catch(() => null) as null | { reason?: string; comments?: string; stepNo?: number };
  try {
    const result = await rejectBooking(gateway, {
      bookingId,
      rejecterId: p.appUserId,
      reason: body?.reason,
      comments: body?.comments,
      stepNo: body?.stepNo,
    });
    if (!result.auditPersisted) {
      return c.json({ error: "AUDIT_WRITE_FAILED", detail: "Booking rejected but audit event was not persisted", bookingId }, 500);
    }
    return c.json(result, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg === "BOOKING_NOT_FOUND") return c.json({ error: "BOOKING_NOT_FOUND" }, 404);
    if (msg.startsWith("INVALID_TRANSITION")) return c.json({ error: "INVALID_TRANSITION", detail: msg }, 409);
    if (msg.startsWith("BOOKING_VERSION_CONFLICT")) return c.json({ error: "BOOKING_VERSION_CONFLICT", detail: msg }, 409);
    return errorResponse(c, e, "REJECTION_FAILED", 500);
  }
});

app.post("/api/bookings/:id/assign", requirePrincipal, requireRole("GA", "ADMIN"), async c => {
  const bookingId = c.req.param("id");
  const gateway = gatewayForRequest(c as any);
  if (!gateway) return c.json({ error: "AUTH_CREDENTIALS_MISSING" }, 401);
  const p = c.get("principal");
  const body = await c.req.json().catch(() => null) as null | { vehicleId?: string };
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!body?.vehicleId) return c.json({ error: "INVALID_REQUEST", reason: "MISSING_VEHICLE_ID" }, 400);
  if (!idempotencyKey) return c.json({ error: "INVALID_REQUEST", reason: "MISSING_IDEMPOTENCY_KEY" }, 400);
  try {
    const result = await assignApprovedBooking(gateway, {
      bookingId,
      vehicleId: body.vehicleId,
      assignedBy: p.appUserId,
      idempotencyKey,
    });
    if (!result.auditPersisted) {
      return c.json({ error: "AUDIT_WRITE_FAILED", detail: "Booking assigned but audit event was not persisted", bookingId }, 500);
    }
    return c.json(result, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg === "VEHICLE_NOT_AVAILABLE") return c.json({ error: "VEHICLE_NOT_AVAILABLE" }, 409);
    if (msg === "BOOKING_NOT_APPROVED") return c.json({ error: "BOOKING_NOT_APPROVED" }, 409);
    if (msg === "VEHICLE_TIME_CONFLICT") return c.json({ error: "VEHICLE_TIME_CONFLICT" }, 409);
    if (msg === "VEHICLE_ON_HOLD") return c.json({ error: "VEHICLE_ON_HOLD" }, 409);
    if (msg === "BOOKING_NOT_FOUND") return c.json({ error: "BOOKING_NOT_FOUND" }, 404);
    if (msg.startsWith("BOOKING_VERSION_CONFLICT")) return c.json({ error: "BOOKING_VERSION_CONFLICT", detail: msg }, 409);
    return errorResponse(c, e, "ASSIGNMENT_FAILED", 500);
  }
});

app.post("/api/bookings/:id/cancel", requirePrincipal, async c => {
  const bookingId = c.req.param("id");
  const gateway = gatewayForRequest(c as any);
  if (!gateway) return c.json({ error: "AUTH_CREDENTIALS_MISSING" }, 401);
  const p = c.get("principal");
  const body = await c.req.json().catch(() => null) as null | { reason?: string };
  try {
    const found = await findBookingRecord(gateway, bookingId);
    if (!found) return c.json({ error: "BOOKING_NOT_FOUND" }, 404);
    if (!canCancelBooking(p, found.booking)) {
      return c.json({ error: "FORBIDDEN" }, 403);
    }
    const result = await cancelBooking(gateway, {
      bookingId,
      cancelerId: p.appUserId,
      reason: body?.reason,
    });
    if (!result.auditPersisted) {
      return c.json({ error: "AUDIT_WRITE_FAILED", detail: "Booking cancelled but audit event was not persisted", bookingId }, 500);
    }
    return c.json(result, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (msg === "BOOKING_NOT_FOUND") return c.json({ error: "BOOKING_NOT_FOUND" }, 404);
    if (msg.startsWith("INVALID_TRANSITION")) return c.json({ error: "INVALID_TRANSITION", detail: msg }, 409);
    if (msg.startsWith("BOOKING_VERSION_CONFLICT")) return c.json({ error: "BOOKING_VERSION_CONFLICT", detail: msg }, 409);
    return errorResponse(c, e, "CANCELLATION_FAILED", 500);
  }
});

app.notFound(c => c.json({ error: "NOT_FOUND" }, 404));
app.onError((err, c) => {
  return c.json({ error: "INTERNAL_ERROR", message: c.env.APP_ENV === "development" ? err.message : "Unexpected error" }, 500);
});

export default app;
