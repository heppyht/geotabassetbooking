# Phase 9.9.4 — Final Architecture Reconciliation & Release Gate

**Status:** COMPLETE (architecture reconciled, release gate defined)
**Date:** 2026-11-23
**Branch:** `main`
**Repository:** `geotabassetbooking`

---

## 1. Executive Summary

Phase 9.9.4 reconciled the production deployment architecture by auditing all
runtime dependencies across the repository. The critical finding is that the
frontend is a **pure Geotab-native Add-In** that accesses MyGeotab AddInData
directly via `geotab.addin.call()` — it does NOT call the Cloudflare Worker.
The Cloudflare Worker (`apps/api/`) is a separate, parallel backend that is NOT
invoked by any frontend code.

**Architecture decision:** The actual implementation matches **Architecture B**
(Embedded Geotab Add-In frontend + Client-side TypeScript business logic +
MyGeotab AddInData + Geotab Service Add-In notifications). The Cloudflare Worker
is NOT required by any production workflow.

**No deployment executed. No code committed, pushed, or merged.**

---

## 2. Runtime Dependency Matrix

### Frontend (`apps/web/`) — GitHub Pages hosted

| Component | Dependency | Type | Required? | Evidence |
|-----------|-----------|------|-----------|----------|
| React/Vite SPA | `apps/web/src/` | Frontend code | YES | `vite.config.ts`, `main.tsx` |
| MyGeotab SDK (`geotab.addin.call()`) | `geotabApi` parameter | Runtime (provided by MyGeotab iframe) | YES (for ADDIN_DATA mode) | `apps/web/src/data/bookingServiceProvider.ts:122` |
| AddInData persistence | MyGeotab AddInData | Storage | YES | `apps/web/src/data/addinDataService.ts` |
| Service Add-In notifications | `serviceAddin.ts` | Background WebWorker | YES | `apps/web/src/serviceAddin.ts` |
| Cloudflare Worker API | `fetch()` to `opex-vbm-api` | External API | NO | Not referenced in any frontend source file |
| `VITE_API_BASE_URL` | Environment variable | Build-time config | NO | Not referenced in frontend source |
| `axios` | HTTP client | Library | NO | Not used anywhere |
| localStorage | Browser storage | Fallback | NO (demo only) | `apps/web/src/data/dataProvider.ts` |

### Cloudflare Worker (`apps/api/`) — NOT called by frontend

| Component | Dependency | Type | Required? | Evidence |
|-----------|-----------|------|-----------|----------|
| Hono API | `apps/api/src/index.ts` | Backend code | NO (redundant) | Not called by frontend |
| MyGeotab REST API | `fetch()` to `my.geotab.com/apiv1` | External API | NO (redundant) | `apps/api/src/db.ts:52` |
| AddInDataRestGateway | `apps/api/src/db.ts` | Gateway class | NO (redundant) | Not imported by frontend |

### Geotab Configuration

| File | Purpose | Referenced URLs |
|------|---------|-----------------|
| `geotab/opex-vbm-config.json` | Add-In configuration | `https://heppyh.github.io/opexassetbooking/` (ActivityLink) |
| `geotab/opex-vbm-service-config.json` | Service Add-In config | `https://heppyh.github.io/opexassetbooking/serviceAddin.js` |

---

## 3. Architecture Reconciliation

### Architecture A (GitHub Pages + Cloudflare Worker + AddInData)

**Status:** NOT the actual implementation

| Component | Status |
|-----------|--------|
| GitHub Pages frontend | YES — hosts the SPA |
| Cloudflare Worker backend | NO — not called by frontend |
| MyGeotab AddInData | YES — accessed directly by frontend |

**Evidence:** Zero `fetch()`, `axios`, or `VITE_API_BASE_URL` references in `apps/web/src/`. All booking transactions use `geotab.addin.call()` → MyGeotab AddInData directly.

### Architecture B (Embedded Geotab Add-In + Service Add-In + AddInData)

**Status:** ACTUAL IMPLEMENTATION

| Component | Status | Evidence |
|-----------|--------|----------|
| Embedded Geotab Add-In frontend | YES | `geotab/opex-vbm-config.json` files block, `embed.supported: true` |
| Client-side TypeScript business logic | YES | `apps/web/src/data/bookingServiceProvider.ts`, `apps/web/src/domain/booking.ts` |
| MyGeotab AddInData | YES | All providers use `geotab.addin.call()` → AddInData |
| Geotab Service Add-In notifications | YES | `apps/web/src/serviceAddin.ts`, `geotab/opex-vbm-service-config.json` |

### Conflicting Configuration

| Item | Conflict | Resolution |
|------|----------|------------|
| Cloudflare Worker deploy workflow | Worker deployed but never called by frontend | Worker is redundant; keep for rollback but do not promote |
| `deploy-worker.yml` production job | Deploys Worker that nothing uses | Keep as rollback target; do not remove without evidence |
| `wrangler.toml` `APP_ENV = "production"` | Worker configured for production | Harmless but unused; preserve for rollback |

---

## 4. Security Release Gate

| Security Area | Status | Evidence |
|---------------|--------|----------|
| RBAC | PASS | `PermissionPolicy` default-deny, role-based (`APPROVER_ROLES`, `ASSIGN_ROLES`, `CANCEL_ADMIN_ROLES`) in `apps/web/src/security/policies.ts` and `apps/web/src/domain/booking.ts` |
| Driver data isolation | PASS | `driverScopeFilter()` returns driver's own userId for DRIVER role; `validateDriverMapping()` ensures drivers can only map to themselves (`apps/web/src/security/policies.ts:69-79`) |
| Audit integrity | PASS | Audit records append-only via `repository.createAuditEvent()`, version-based optimistic concurrency via `assertVersion()` (`apps/web/src/domain/booking.ts:168`) |
| AddInData access scope | PASS | `addInId` required for all Add/Set/Remove operations; `ADDIN_ID_NOT_CONFIGURED` / `ADDIN_ID_INVALID` errors (`apps/web/src/data/addinDataService.ts:203-209`) |
| Concurrency | CONDITIONAL | Version-based optimistic concurrency implemented (`applyUpdate()` increments version, `assertVersion()` checks). Best-effort — no atomic transactions in AddInData. | 
| Notification recipient isolation | PASS | Notifications filtered by `recipient_user_id`; `driverScopeFilter()` scopes drivers to their own records (`apps/web/src/data/bookingServiceProvider.ts:300-304`) |
| AddInData rate limits | CONDITIONAL | `NotificationRateLimiter` enforces 6 calls/min rolling window, 2 visible max (`apps/web/src/serviceAddin.ts:99-129`). Server-side AddInData rate limits UNVERIFIED against live tenant. |
| Client-side vs server-side isolation | PASS | All authorization decisions made in domain services (`BookingService`), not only in UI. Client-side filtering never used as sole access control. |
| Identity resolution | CONDITIONAL | `identityResolver.ts` resolves verified MyGeotab principal. `IDENTITY_ADAPTER_CONFIGURED` not yet validated against live tenant. |
| Fail-closed behavior | PASS | `canPerformLiveWriteStrict()` requires `ADDIN_DATA` mode + authenticated identity (`apps/web/src/safety/modeGuards.ts:51`). Demo-only operations blocked in live mode (`canRunDemoOnlyOperation()`). |

---

## 5. Deployment Architecture Recommendation

### Recommended: Architecture B (Embedded Geotab Add-In + Service Add-In)

### Decision Matrix

| Criterion | Architecture B (Embedded Add-In) | Architecture B+C (Embedded Add-In + Worker) |
|-----------|----------------------------------|---------------------------------------------|
| Frontend hosting | GitHub Pages | GitHub Pages |
| API backend | None (direct AddInData access) | Cloudflare Worker (unused by frontend) |
| Persistence | MyGeotab AddInData | MyGeotab AddInData |
| Notifications | Service Add-In (native) | Service Add-In (native) |
| Deployment targets | 1 (GitHub Pages) | 2 (GitHub Pages + Cloudflare Worker) |
| Secrets required | None | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Rollback complexity | Low | Medium (two targets to roll back) |
| Operational cost | Low | Medium |
| Attack surface | Minimal | Worker is additional surface |
| Redundancy | None (by design) | Worker is redundant — not called |

### Why Architecture B

1. **The frontend does not call the Worker.** Zero `fetch()`, `axios`, or `VITE_API_BASE_URL` references in frontend source code. All booking transactions go directly from browser to MyGeotab AddInData via `geotab.addin.call()`.

2. **The Worker is a redundant parallel backend.** It was built during Phases 9.3-9.9.3 as an alternative API implementation, but the frontend never invokes it. Maintaining two deployment targets for the same data store adds operational cost with no functional benefit.

3. **Architecture B is simpler and more secure.** One deployment target (GitHub Pages), no Cloudflare secrets to manage, no Worker to secure, smaller attack surface.

4. **The Service Add-In handles notifications natively.** `serviceAddin.ts` runs inside MyGeotab WebWorker context, polls AddInData via `service.api.call()`, and delivers notifications via `service.notifications.show()` — no external backend needed.

### Rollback Strategy (Architecture B)

| Component | Rollback Method | Command |
|-----------|----------------|---------|
| Frontend (GitHub Pages) | Re-run previous successful Pages deployment | GitHub Actions re-run or revert commit |
| Service Add-In | Re-deploy previous `serviceAddin.js` | GitHub Pages re-runs previous build |
| AddInData records | NOT rolled back | Manual MyGeotab intervention required (append-only) |

**Critical:** AddInData records are append-only and persistent. Rollback does NOT affect booking or audit records.

---

## 6. Files Created

| File | Purpose |
|------|---------|
| `docs/geotab-native-migration/phase-9.9.4-final-architecture-review.md` | This report |
| `docs/geotab-native-migration/phase-9.9.4-runtime-dependency-matrix.md` | Dependency matrix |
| `docs/geotab-native-migration/phase-9.9.4-production-release-gate.md` | Release gate checklist |

---

## 7. Files Modified

None. Phase 9.9.4 is analysis and documentation only. No source code, configuration, or workflow files were changed.

---

## 8. Files Preserved (Historical Reference)

| File | Status |
|------|--------|
| `apps/api/wrangler.toml` | Preserved — Worker config kept for rollback reference |
| `.github/workflows/deploy-worker.yml` | Preserved — Worker deploy workflow kept for rollback |
| `.github/workflows/deploy-pages.yml` | Preserved — Frontend deploy workflow is the production path |
| `apps/api/src/` | Preserved — Worker source kept for rollback reference |

---

## 9. Production Release Gate

### PASS / CONDITIONAL / BLOCKED Assessment

| Area | Status | Blocking Items |
|------|--------|----------------|
| RBAC | PASS | None |
| Driver data isolation | PASS | None |
| Audit integrity | PASS | None |
| AddInData access scope | PASS | None |
| Concurrency | CONDITIONAL | Best-effort optimistic concurrency; no atomic transactions |
| Notification recipient isolation | PASS | None |
| AddInData rate limits | CONDITIONAL | Server-side rate limits UNVERIFIED against live tenant |
| Identity resolution | CONDITIONAL | `IDENTITY_ADAPTER_CONFIGURED` not validated against live tenant |
| Live MyGeotab integration | BLOCKED | No test tenant credentials obtained |
| AddInData storage quota | BLOCKED | UNKNOWN — requires Geotab Support confirmation |

### Overall Release Gate: BLOCKED

Production deployment cannot be authorized until:
1. Live MyGeotab test tenant credentials are obtained
2. AddInData storage quota is confirmed by Geotab Support
3. Server-side rate limits and filtering are verified against live API
4. `IDENTITY_ADAPTER_CONFIGURED` is validated against live session verification

---

## 10. Exact Actions Required Before Production Deployment

### Infrastructure (No Code Changes Required)

| # | Action | Owner | Evidence |
|---|--------|-------|----------|
| 1 | Obtain MyGeotab test tenant (`opex_trial`) credentials | Geotab Admin | UserName, database, sessionId |
| 2 | Confirm AddInData storage quota with Geotab Support | Geotab Support | Written confirmation |
| 3 | Validate `IDENTITY_ADAPTER_CONFIGURED` against live session verification | DevOps | Live tenant test |
| 4 | Verify server-side `periodKey` filtering against live API | DevOps | Live tenant test |
| 5 | Verify AddInData write throughput (~100/min claim) | DevOps | Live tenant test |
| 6 | Configure `IDENTITY_ADAPTER_CONFIGURED = "true"` in `wrangler.toml` only after live validation | DevOps | `wrangler.toml` update |
| 7 | Configure GitHub Pages as the sole deployment target | DevOps | `deploy-pages.yml` already correct |

### Deployment Steps (When Approved)

1. Build frontend: `npm --workspace apps/web run build` → `apps/web/dist/`
2. Deploy to GitHub Pages via `deploy-pages.yml` (push to `main`)
3. Verify Add-In loads at `https://heppyh.github.io/opexassetbooking/`
4. Verify `geotab/opex-vbm-config.json` ActivityLink and files block are registered in tenant
5. Verify Service Add-In loads from `serviceAddin.js`
6. Verify booking CRUD operations work against `opex_trial` AddInData
7. Verify audit records are append-only and linked via `auditId`

### Rollback (When Needed)

| Component | Method |
|-----------|--------|
| Frontend | Re-run previous GitHub Pages deployment |
| Service Add-In | Re-deploy previous `serviceAddin.js` from GitHub Pages |
| AddInData records | NOT rolled back — manual MyGeotab intervention required |

---

## 11. Do Not Deploy Without

- [ ] Live MyGeotab test tenant credentials obtained
- [ ] AddInData storage quota confirmed by Geotab Support
- [ ] `IDENTITY_ADAPTER_CONFIGURED` validated against live session verification
- [ ] Explicit production deployment approval from Release Manager, DevOps, and Application Security Engineer
