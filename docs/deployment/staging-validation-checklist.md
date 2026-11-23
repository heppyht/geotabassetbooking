# Staging Validation Checklist — OPEX Asset Booking

**Purpose:** Validate the application in a staging environment before production approval.
**Status:** BLOCKED — No staging infrastructure or credentials available.
**Tenant:** `opex_trial` (test tenant)
**Worker:** `opex-vbm-api`
**Frontend:** `https://heppyh.github.io/opexassetbooking/`

---

## Pre-Deployment Confirmation

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | Target is staging (not production) | BLOCKED | No staging environment configured |
| 2 | Worker name confirmed | READY | `opex-vbm-api` (wrangler.toml) |
| 3 | Frontend URL confirmed | READY | `https://heppyh.github.io/opexassetbooking/` |
| 4 | Staging credentials available | BLOCKED | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` not configured |
| 5 | Staging does not point to production tenant data | N/A | Tenant `opex_trial` is the test tenant |
| 6 | Rollback and recovery procedures documented | READY | `docs/deployment/rollback-and-recovery.md` |
| 7 | CI validation passes | READY | 206 API + 155 Web tests, all pass |

---

## API Validation (Staging)

| # | Check | Status | Method | Expected Result |
|---|-------|--------|--------|-----------------|
| A1 | Health endpoint `GET /api/health` | NOT TESTED | curl | `{"ok":true,"version":"0.1.0-phase97",...}` |
| A2 | Worker version header | NOT TESTED | curl health | `"version":"0.1.0-phase97"` |
| A3 | Security headers present | NOT TESTED | curl -I | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` |
| A4 | Request body limit (1 MB) | NOT TESTED | POST with oversized body | `413 REQUEST_TOO_LARGE` |
| A5 | Error handling (no stack traces) | NOT TESTED | Invalid request | No internal error details in response |
| A6 | Authentication fail-closed | NOT TESTED | Request without session | `503 AUTH_ADAPTER_NOT_CONFIGURED` |
| A7 | CORS allowed origin | NOT TESTED | Request with different Origin | `403 ORIGIN_NOT_ALLOWED` |
| A8 | CORS rejected origin | NOT TESTED | Request with `Origin: https://evil.com` | `403 ORIGIN_NOT_ALLOWED` |
| A9 | Session expiration handling | NOT TESTED | Expired session | `503 AUTH_ADAPTER_NOT_CONFIGURED` |

---

## MyGeotab Integration Validation (Staging)

| # | Check | Status | Method | Expected Result |
|---|-------|--------|--------|-----------------|
| M1 | AddInData Add (booking creation) | NOT TESTED | POST /api/bookings | `201 Created` with booking record |
| M2 | AddInData Get (booking retrieval) | NOT TESTED | GET /api/bookings | Returns booking list |
| M3 | AddInData Set (booking update) | NOT TESTED | POST /api/bookings/:id/approve | `200 OK` with updated booking |
| M4 | AddInData Remove (disposable test only) | NOT TESTED | DELETE with auth | `200 OK` |
| M5 | Booking approval | NOT TESTED | POST /api/bookings/:id/approve | Status `APPROVED`, audit persisted |
| M6 | Booking rejection | NOT TESTED | POST /api/bookings/:id/reject | Status `REJECTED`, audit persisted |
| M7 | Booking cancellation | NOT TESTED | POST /api/bookings/:id/cancel | Status `CANCELLED`, audit persisted |
| M8 | Driver assignment | NOT TESTED | POST /api/bookings/:id/assign | Status `ASSIGNED`, vehicleId set |
| M9 | Audit persistence | NOT TESTED | GET audit records | Audit events present and linked |
| M10 | Idempotency | NOT TESTED | Duplicate Idempotency-Key | Returns existing booking, no duplicate |
| M11 | Version conflict | NOT TESTED | Concurrent update | `409 BOOKING_VERSION_CONFLICT` |
| M12 | Tenant isolation | NOT TESTED | Cross-database request | Rejected, `GEOTAB_DATABASE` enforced |
| M13 | Legacy schema v1 compatibility | NOT TESTED | Read legacy record | Record parsed without error |

---

## AddInData Performance Validation (Staging)

| # | Check | Status | Method | Expected Result |
|---|-------|--------|--------|-----------------|
| P1 | Actual storage quota | NOT TESTED | Query AddInData metadata | Quota value confirmed |
| P2 | AddInData write throughput | NOT TESTED | Sequential Add operations | Operations/minute measured |
| P3 | Rate-limit behavior | NOT TESTED | Burst Add operations | HTTP 429 on limit exceeded |
| P4 | `periodKey` filtering syntax | NOT TESTED | Search with periodKey | Correct subset returned |
| P5 | Query performance | NOT TESTED | Query with representative data | Latency within acceptable range |

---

## Frontend Validation (Staging)

| # | Check | Status | Method | Expected Result |
|---|-------|--------|--------|-----------------|
| F1 | Frontend loads without console errors | NOT TESTED | Browser console | No JavaScript errors |
| F2 | Asset paths correct (`/opexassetbooking/`) | NOT TESTED | Browser dev tools | Assets load from correct path |
| F3 | API connection status | NOT TESTED | UI status indicator | Shows connected or "Backend not connected" |
| F4 | SPA fallback (404.html) | NOT TESTED | Refresh on deep route | Page loads correctly |
| F5 | No secrets in bundle | NOT TESTED | Bundle inspection | No API tokens, session IDs, credentials |

---

## Sign-Off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Release Manager | | | |
| DevOps Engineer | | | |
| Application Security Engineer | | | |

**Blocking items:** Staging infrastructure and credentials not available. All staging validation items are NOT TESTED until staging is provisioned.
