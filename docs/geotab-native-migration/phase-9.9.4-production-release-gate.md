# Phase 9.9.4 — Production Release Gate

**Status:** BLOCKED
**Date:** 2026-11-23
**Branch:** `main`
**Repository:** `geotabassetbooking`

---

## 1. Release Gate Decision

**Overall: BLOCKED**

The application architecture is sound (Geotab-native Add-In accessing MyGeotab AddInData
directly), but production deployment cannot be authorized until live MyGeotab
integration is validated. CI/CD validation passes, but live integration remains
unverified due to missing test tenant credentials.

---

## 2. Production Architecture (Final)

| Component | Technology | Hosting | Required? |
|-----------|-----------|---------|-----------|
| Frontend | React/Vite SPA | GitHub Pages | YES |
| API backend | None (direct `geotab.addin.call()`) | N/A | YES (client-side) |
| Persistence | MyGeotab AddInData | `opex_trial` tenant | YES |
| Notifications | Geotab Service Add-In | MyGeotab WebWorker | YES |
| Cloudflare Worker | Hono API | workers.dev | NO — redundant |
| External database | None | N/A | NO — prohibited |

### Data Flow

```
Browser (GitHub Pages)
  → geotab.addin.call() (MyGeotab iframe)
  → MyGeotab REST API (my.geotab.com/apiv1)
  → AddInData records (opex_trial database)
  → AddInId: addin-booking-app
```

Service Add-In:
```
MyGeotab WebWorker
  → service.api.call() "Get" AddInData (delivery_status = "pending")
  → service.notifications.show() (deliver notification)
  → service.api.call() "Set" AddInData (update delivery_status)
```

---

## 3. Security Release Gate

| Security Area | Status | Evidence | Blocking Items |
|---------------|--------|----------|----------------|
| RBAC | PASS | `PermissionPolicy` default-deny, role-based (`APPROVER_ROLES`, `ASSIGN_ROLES`, `CANCEL_ADMIN_ROLES`) in `apps/web/src/security/policies.ts` and `apps/web/src/domain/booking.ts` | None |
| Driver data isolation | PASS | `driverScopeFilter()` returns driver's own userId for DRIVER role; `validateDriverMapping()` ensures drivers can only map to themselves | None |
| Audit integrity | PASS | Audit records append-only via `repository.createAuditEvent()`, version-based optimistic concurrency via `assertVersion()` | None |
| AddInData access scope | PASS | `addInId` required for all Add/Set/Remove operations; `ADDIN_ID_NOT_CONFIGURED` / `ADDIN_ID_INVALID` errors | None |
| Concurrency | CONDITIONAL | Version-based optimistic concurrency (`applyUpdate()` increments version, `assertVersion()` checks). Best-effort — no atomic transactions in AddInData. | None — documented limitation |
| Notification recipient isolation | PASS | Notifications filtered by `recipient_user_id`; `driverScopeFilter()` scopes drivers to their own records | None |
| AddInData rate limits | CONDITIONAL | `NotificationRateLimiter` enforces 6 calls/min rolling window, 2 visible max. Server-side AddInData rate limits UNVERIFIED against live tenant. | Live tenant verification required |
| Identity resolution | CONDITIONAL | `identityResolver.ts` resolves verified MyGeotab principal. `IDENTITY_ADAPTER_CONFIGURED` not yet validated against live tenant. | Live session verification required |
| Fail-closed behavior | PASS | `canPerformLiveWriteStrict()` requires `ADDIN_DATA` mode + authenticated identity. Demo-only operations blocked in live mode. | None |
| Client-side vs server-side isolation | PASS | All authorization decisions made in domain services (`BookingService`), not only in UI. Client-side filtering never used as sole access control. | None |

---

## 4. Production Blockers

| # | Blocker | Required Action | Owner |
|---|---------|----------------|-------|
| 1 | Live MyGeotab test tenant credentials unavailable | Obtain userName, database, sessionId for `opex_trial` | Geotab Admin |
| 2 | AddInData storage quota UNKNOWN | Contact Geotab Support for quota confirmation | Geotab Support |
| 3 | Server-side rate limits UNVERIFIED | Validate against live API (~100/min claim) | DevOps |
| 4 | Server-side `periodKey` filtering UNVERIFIED | Validate against live API | DevOps |
| 5 | `IDENTITY_ADAPTER_CONFIGURED` not validated | Test session verification against `GEOTAB_DATABASE` | DevOps |
| 6 | Live AddInData CRUD NOT verified | Create/read/update/delete against `opex_trial` | DevOps |

### Conditional (Non-Blocking but Requires Attention)

| # | Item | Status | Mitigation |
|---|------|--------|------------|
| A | Concurrency best-effort | CONDITIONAL | Documented; rollback is recovery mechanism |
| B | No atomic transactions | CONDITIONAL | Audit gap detection (`findAuditGaps()`) identifies inconsistencies |

---

## 5. CI/CD Validation Results (Baseline)

| Check | Command | Result |
|-------|---------|--------|
| API TypeScript check | `npm --workspace apps/api run typecheck` | Clean (exit 0) |
| Web TypeScript check | `npx tsc -p apps/web/tsconfig.json --noEmit` | Clean (exit 0) |
| API tests | `npm --workspace apps/api run test` | 234 pass, 0 fail |
| Web tests | `npm --workspace apps/web run test` | 155 pass, 0 fail |
| Web production build | `npm --workspace apps/web run build` | Successful (~269 KB JS) |
| Deployment config validation | `node test/deployment-config.test.mjs` | 12 pass, 0 fail |

**Test counts match baseline.** No regressions introduced.

---

## 6. Deployment Steps (When Approved)

### Prerequisites (All Must Be Complete)

1. Live MyGeotab test tenant (`opex_trial`) credentials obtained
2. AddInData storage quota confirmed by Geotab Support
3. `IDENTITY_ADAPTER_CONFIGURED` validated against live session verification
4. Explicit production deployment approval from Release Manager, DevOps, and Application Security Engineer

### Deployment Procedure

1. **Build frontend:**
   ```bash
   cd apps/web
   npm run build
   ```
   Output: `apps/web/dist/` (~269 KB JS)

2. **Deploy to GitHub Pages:**
   - Push to `main` branch → triggers `deploy-pages.yml`
   - Or run `deploy-pages.yml` via `workflow_dispatch`
   - Deploys `apps/web/dist/` to GitHub Pages

3. **Verify Add-In registration:**
   - Confirm `geotab/opex-vbm-config.json` ActivityLink and files block are registered in the MyGeotab tenant
   - Confirm `geotab/opex-vbm-service-config.json` Service Add-In is registered
   - Service Add-In URL: `https://heppyh.github.io/opexassetbooking/serviceAddin.js`

4. **Post-deployment verification:**
   - `https://heppyh.github.io/opexassetbooking/` loads without console errors
   - Add-In loads inside MyGeotab (ActivityLink or embedded mode)
   - Service Add-In delivers notifications
   - Booking CRUD operations work against `opex_trial` AddInData
   - Audit records are append-only and linked via `auditId`

### Rollback Procedure

| Component | Method | Command |
|-----------|--------|---------|
| Frontend | Re-run previous successful Pages deployment | GitHub Actions re-run |
| Service Add-In | Re-deploy previous `serviceAddin.js` | GitHub Pages re-runs previous build |
| AddInData records | NOT rolled back | Manual MyGeotab intervention required |

**Critical:** AddInData records are append-only and persistent. Rollback does NOT affect booking or audit records.

---

## 7. Exact Actions Required Before Production Deployment

| # | Action | Owner | Evidence Required |
|---|--------|-------|-------------------|
| 1 | Obtain MyGeotab test tenant (`opex_trial`) credentials | Geotab Admin | UserName, database, sessionId |
| 2 | Confirm AddInData storage quota | Geotab Support | Written confirmation |
| 3 | Validate `IDENTITY_ADAPTER_CONFIGURED` against live session verification | DevOps | Live tenant test results |
| 4 | Verify server-side `periodKey` filtering against live API | DevOps | Live tenant test results |
| 5 | Verify AddInData write throughput against live API | DevOps | Live tenant test results |
| 6 | Explicit production deployment approval | Release Manager, DevOps, AppSec | Signed approval |

---

## 8. Do Not Deploy Without

- [ ] Live MyGeotab test tenant credentials obtained
- [ ] AddInData storage quota confirmed by Geotab Support
- [ ] Live session verification validated against `GEOTAB_DATABASE`
- [ ] Server-side rate limits and `periodKey` filtering verified against live API
- [ ] Explicit production deployment approval (Release Manager + DevOps + AppSec)

CI/CD validation passing alone does NOT constitute production readiness.
