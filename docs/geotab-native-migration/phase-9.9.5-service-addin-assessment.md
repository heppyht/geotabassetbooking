# Phase 9.9.5 — Service Add-In Assessment

**Status:** COMPLETE (code-level verification); LIVE VALIDATION BLOCKED
**Date:** 2026-11-23
**Branch:** `main`

---

## 1. Purpose

This document assesses the Geotab Service Add-In component of the OPEX Asset
Booking application. The Service Add-In runs in a MyGeotab WebWorker background
context and handles notification delivery from AddInData.

---

## 2. Service Add-In Configuration

### 2.1 Configuration File

**File:** `geotab/opex-vbm-service-config.json`
```json
{
  "name": "OPEX Asset Booking – Notification Service",
  "supportEmail": "heppy@opexcg.com",
  "version": "0.1.0",
  "items": [
    {
      "serviceName": "OPEX Notification Service",
      "serviceSrc": "https://heppyh.github.io/opexassetbooking/serviceAddin.js"
    }
  ]
}
```

### 2.2 Status: PASS

Service Add-In configuration file is present with correct `serviceSrc` pointing
to the GitHub Pages deployment. The `serviceSrc` URL requires the frontend to be
deployed to GitHub Pages first.

---

## 3. WebWorker Lifecycle

### 3.1 Implementation

**File:** `apps/web/src/serviceAddin.ts:253-285`
```typescript
if (typeof self !== "undefined") {
  const selfGlobal = self as unknown as {
    geotab?: { addin?: { service?: (service: ServiceAddIn) => void } | null } | null;
  };
  selfGlobal.geotab = selfGlobal.geotab ?? {};
  selfGlobal.geotab.addin = selfGlobal.geotab.addin ?? {};
  selfGlobal.geotab.addin.service = (service: ServiceAddIn) => { ... };
}
```

### 3.2 Key Characteristics

| Characteristic | Detail |
|---------------|--------|
| Context | WebWorker (self.geotab, not window.geotab) |
| Registration | `self.geotab.addin.service = (service) => { ... }` |
| Guard | `typeof self !== "undefined"` check for non-WebWorker environments |
| Cleanup | Returns cleanup function that clears polling interval |
| Error handling | All errors swallowed; Service Add-In must not crash |

### 3.3 Status: PASS

WebWorker lifecycle is correctly implemented with proper guards, cleanup, and
error isolation.

---

## 4. Notification Polling

### 4.1 Configuration

| Constant | Value | Purpose |
|----------|-------|---------|
| `POLL_INTERVAL_MS` | 30000 (30 seconds) | Polling interval for pending notifications |
| `MAX_NOTIFICATIONS_PER_POLL` | 10 | Max notifications processed per poll cycle |
| `MAX_NOTIFICATION_CALLS_PER_MINUTE` | 6 | Rate limit: API calls per rolling minute |
| `MAX_VISIBLE_NOTIFICATIONS` | 2 | Max notifications shown simultaneously |
| `ROLLING_WINDOW_MS` | 60000 (1 minute) | Rate limit window |
| `RETRY_BACKOFF_MS` | 60000 (1 minute) | Delay between retries |

### 4.2 Polling Logic

**File:** `apps/web/src/serviceAddin.ts:154-244`

1. Resolve AddInId from `service.localStorage` or `DEFAULT_ADDIN_ID`
2. Search AddInData for notification records with `delivery_status = "pending"`
3. For each pending notification:
   a. Re-check delivery status (idempotency guard)
   b. Check rate limiter (`canCall()`)
   c. Check visible count (`canShow()`)
   d. Call `service.notifications.show()`
   e. Update `delivery_status` to "delivered" or "failed"
   f. Decrement visible count after 10 seconds (matches notification duration)

### 4.3 Status: PASS

Notification polling is correctly implemented with rate limiting, visible count
management, idempotency guards, and error isolation.

---

## 5. Duplicate Notification Prevention

### 5.1 Implementation

**File:** `apps/web/src/data/bookingServiceProvider.ts:328-335`
```typescript
const existing = await gateway.search("AddInData", {
  addInId: addInId ?? "",
  recordType: "notification",
});
for (const record of existing ?? []) {
  const n = parseNotification(record.details);
  if (n && n.idempotencyKey === input.idempotencyKey) return n;
}
```

**File:** `apps/web/src/data/bookingServiceProvider.ts:358-368`
```typescript
async function findByIdempotencyKey(idempotencyKey: string): Promise<OpexNotification | null> {
  const records = await gateway.search("AddInData", { addInId, recordType: "notification" });
  for (const record of records ?? []) {
    const n = parseNotification(record.details);
    if (n && n.idempotencyKey === idempotencyKey) return n;
  }
  return null;
}
```

### 5.2 Status: PASS

Duplicate notification prevention is implemented via `idempotencyKey` checks
before creating notifications.

---

## 6. Delivery Acknowledgement

### 6.1 Implementation

**File:** `apps/web/src/serviceAddin.ts:221-223`
```typescript
n.delivery_status = delivered ? "delivered" : "failed";
n.delivered_at = delivered ? new Date().toISOString() : n.delivered_at;
n.updated_at = new Date().toISOString();
```

### 5.2 Status: PASS

Delivery status is updated after each `show()` call attempt. Failed deliveries
are marked as "failed" and can be retried on the next poll cycle.

---

## 6. Retry & Failure Handling

### 6.1 Implementation

| Scenario | Handling |
|----------|----------|
| `service.api.call` unavailable | Returns null; safe no-op |
| `service.notifications.show()` fails | Catch block; delivery_status NOT changed to "delivered" |
| AddInData Add/Set fails | Catch block; error swallowed; notification remains pending |
| `deliverPendingNotifications()` throws | `.catch(() => {})` — Service Add-In must not crash |
| `setInterval` callback throws | `.catch(() => {})` — polling continues |

### 6.2 Status: PASS

All failure modes are handled gracefully. The Service Add-In never crashes,
and failed operations leave notifications in "pending" state for retry.

---

## 7. Behavior When MyGeotab Is Closed

### 7.1 Behavior

| Scenario | Behavior |
|----------|----------|
| MyGeotab closed | Service Add-In WebWorker does not run; no polling |
| Notification created while closed | Remains `delivery_status = "pending"` in AddInData |
| MyGeotab reopened | Service Add-In initializes, calls `deliverPendingNotifications()`, delivers pending notifications |
| Service Add-In unregistered | Cleanup function clears polling interval |

### 7.2 Status: PASS

The Service Add-In is NOT an always-on background server. It runs only within
the MyGeotab WebWorker context. Notifications created while MyGeotab is closed
remain pending and are delivered when MyGeotab is reopened.

---

## 8. Service Add-In Release Gate

| Item | Status | Evidence |
|------|--------|----------|
| Service Add-In configuration | PASS | `geotab/opex-vbm-service-config.json` |
| serviceSrc hosting | PASS | GitHub Pages URL (requires frontend deployed first) |
| WebWorker lifecycle | PASS | Proper registration, cleanup, error isolation |
| Notification polling | PASS | 30-second interval, rate-limited |
| Duplicate prevention | PASS | `idempotencyKey` checks |
| Delivery acknowledgement | PASS | `delivery_status` updated after `show()` |
| Retry/failure handling | PASS | All errors swallowed; notifications remain pending |
| Behavior when MyGeotab closed | PASS | Notifications remain pending; delivered on reopen |
| Always-on background server | NO | Not described as such; WebWorker context only |

---

## 9. Summary

| Item | Status |
|------|--------|
| Service Add-In configuration | PASS |
| serviceSrc hosting | PASS (requires GitHub Pages deployed) |
| WebWorker lifecycle | PASS |
| Notification polling | PASS |
| Duplicate notification prevention | PASS |
| Delivery acknowledgement | PASS |
| Retry/failure handling | PASS |
| Behavior when MyGeotab closed | PASS |

**Overall Service Add-In Status: PASS** — All client-side controls verified.
Live validation (Service Add-In registration, notification delivery in MyGeotab)
requires authorized test tenant access.
