# Phase 9.9.4 — Runtime Dependency Matrix

**Status:** COMPLETE
**Date:** 2026-11-23
**Branch:** `main`
**Repository:** `geotabassetbooking`

---

## 1. Purpose

This document maps every runtime dependency in the Geotab Asset Booking repository,
categorizing each as **Required**, **Redundant**, or **Unused** for production
deployment. The goal is to determine whether the Cloudflare Worker is still
required by any production workflow.

---

## 2. Dependency Matrix — Frontend (`apps/web/`)

### 2.1 Source Code Dependencies

| File/Module | Dependency | Type | Status | Required for Production? |
|-------------|-----------|------|--------|--------------------------|
| `apps/web/src/main.tsx` | React, Vite | Build/runtime | Required | YES |
| `apps/web/src/ui/App.tsx` | React, `geotab.addin.call()` | Runtime | Required | YES |
| `apps/web/src/data/bookingServiceProvider.ts` | `geotab.addin.call()` | Runtime | Required | YES (ADDIN_DATA mode) |
| `apps/web/src/data/addinDataProvider.ts` | `geotab.addin.call()` | Runtime | Required | YES (ADDIN_DATA mode) |
| `apps/web/src/data/mygeotabProvider.ts` | `geotab.addin.call()` + `LocalBookingDataProvider` | Runtime | Required | YES (master data + demo fallback) |
| `apps/web/src/data/dataProvider.ts` | `localStorage` | Runtime | Required | YES (DEMO mode fallback) |
| `apps/web/src/serviceAddin.ts` | `geotab.addin.call()` (Service Add-In context) | Runtime | Required | YES (notification delivery) |
| `apps/web/src/config/lifecycleBridge.ts` | `geotab.initialize()` callback | Runtime | Required | YES (API object recovery) |
| `apps/web/src/auth/identityResolver.ts` | `geotab.addin.call()` (`getSession`) | Runtime | Required | YES (identity resolution) |
| `apps/web/src/data/addinDataService.ts` | `geotab.addin.call()` | Runtime | Required | YES (AddInData gateway) |
| `apps/web/src/geotab/addinData.ts` | `geotab.addin.call()` | Runtime | Required | YES (GeotabAddInDataClient) |

### 2.2 HTTP Client Usage — Frontend

| Pattern | Files | Count | Required? |
|---------|-------|-------|-----------|
| `fetch(` | 0 | 0 | N/A — not used |
| `axios` | 0 | 0 | N/A — not used |
| `XMLHttpRequest` | 0 | 0 | N/A — not used |
| `geotab.addin.call()` | Multiple | ~15 | REQUIRED — MyGeotab JSON-RPC |
| `service.api.call()` | `serviceAddin.ts` | 3 | REQUIRED — Service Add-In API |

### 2.3 Environment Variables — Frontend

| Variable | Referenced in Source? | Purpose | Required? |
|----------|----------------------|---------|-----------|
| `VITE_API_BASE_URL` | NO | API base URL | NO — not used by frontend |
| `VITE_GEOTAB_DATABASE` | NO | DB label | NO — not used by frontend |
| Any `VITE_*` | NO | Runtime config | NO — all config via `geotab.addin.call()` |

---

## 3. Dependency Matrix — Cloudflare Worker (`apps/api/`)

### 3.1 Source Code Dependencies

| File/Module | Dependency | Type | Status | Required for Production? |
|-------------|-----------|------|--------|--------------------------|
| `apps/api/src/index.ts` | Hono, `fetch()` (indirect via gateway) | Runtime | Redundant | NO — not called by frontend |
| `apps/api/src/db.ts` | `fetch()` to `my.geotab.com/apiv1` | Runtime | Redundant | NO — not called by frontend |
| `apps/api/src/auth.ts` | Session verification | Runtime | Redundant | NO — not called by frontend |
| `apps/api/src/services/booking.ts` | AddInData CRUD via gateway | Runtime | Redundant | NO — not called by frontend |
| `apps/api/src/env.ts` | Environment types | Config | Redundant | NO — not called by frontend |
| `apps/api/wrangler.toml` | Worker config | Deploy | Redundant | NO — not called by frontend |

### 3.2 Worker API Calls

| Method | Target | Files | Required? |
|--------|--------|-------|-----------|
| `fetch()` | `my.geotab.com/apiv1` | `db.ts`, `adapter.ts` | NO — redundant parallel backend |
| Hono routes | `/api/*` | `index.ts` | NO — no frontend consumer |

---

## 4. Dependency Matrix — Geotab Configuration

| File | Purpose | Referenced URLs | Required? |
|------|---------|-----------------|-----------|
| `geotab/opex-vbm-config.json` | Add-In ActivityLink + embedded files | `https://heppyh.github.io/opexassetbooking/` | YES — Add-In registration |
| `geotab/opex-vbm-service-config.json` | Service Add-In external source | `https://heppyh.github.io/opexassetbooking/serviceAddin.js` | YES — notification delivery |

---

## 5. Dependency Matrix — GitHub Actions

| Workflow | Trigger | Target | Required? | Reason |
|----------|---------|--------|-----------|--------|
| `.github/workflows/ci.yml` | PR/push to `main` | Validation only | YES | Typecheck, tests, build |
| `.github/workflows/deploy-pages.yml` | Push to `main` | GitHub Pages | YES | Frontend deployment |
| `.github/workflows/deploy-worker.yml` | Push to `main` | Cloudflare Worker | NO — redundant | Worker not called by frontend |

---

## 6. Dependency Matrix — Secrets and Variables

| Secret/Variable | Used By | Required? | Configured? |
|-----------------|---------|-----------|-------------|
| `CLOUDFLARE_API_TOKEN` | Worker deploy | NO — Worker not needed | NO |
| `CLOUDFLARE_ACCOUNT_ID` | Worker deploy | NO — Worker not needed | NO |
| `VITE_API_BASE_URL` | Frontend build | NO — not used by frontend | NO |

---

## 7. Dependency Matrix — Persistence

| Storage Service | Used By | Status | Required? |
|-----------------|---------|--------|-----------|
| MyGeotab AddInData | Frontend (direct), Worker (redundant) | Required | YES — only persistence layer |
| PostgreSQL | None | Prohibited | NO |
| Cloudflare D1 | None | Prohibited | NO |
| Cloudflare KV | None | Prohibited | NO |
| Supabase | None | Prohibited | NO |
| Firebase | None | Prohibited | NO |
| Redis | None | Prohibited | NO |
| MongoDB | None | Prohibited | NO |
| Neon | None | Prohibited | NO |
| localStorage | Frontend demo mode | Fallback only | NO (production) |

---

## 8. Conclusion

**The Cloudflare Worker is NOT required by any production workflow.**

| Component | Required? | Reason |
|-----------|-----------|--------|
| Frontend (GitHub Pages) | YES | Hosts the Add-In SPA |
| Cloudflare Worker | NO | Not called by any frontend code |
| MyGeotab AddInData | YES | Only persistence layer |
| Geotab Service Add-In | YES | Native notification delivery |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | NO | Worker not needed |
| `VITE_API_BASE_URL` | NO | Not referenced in frontend source |

### Recommended Action

Remove Cloudflare Worker deployment from the production path. The Worker source code and `wrangler.toml` should be preserved for rollback reference, but no new deployments should target it. The production deployment path should be:

```
GitHub Pages (frontend) → geotab.addin.call() → MyGeotab AddInData
```
