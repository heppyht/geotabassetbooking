# Production Deployment Checklist — OPEX Asset Booking

**Purpose:** Pre-deployment validation for direct production deployment.
**Status:** CONFIGURATION IMPLEMENTED — Infrastructure not yet provisioned.
**Do not deploy without explicit approval.**

---

## Architecture Summary (Production Only)

| Component | Value |
|-----------|-------|
| Cloudflare Worker | `opex-vbm-api` |
| Worker URL | `https://opex-vbm-api.<account-subdomain>.workers.dev` |
| Frontend | GitHub Pages: `https://heppyh.github.io/opexassetbooking/` |
| MyGeotab tenant | `opex_trial` |
| AddInId | `addin-booking-app` |
| Persistence | MyGeotab AddInData ONLY |
| `APP_ENV` | `"production"` |
| `IDENTITY_ADAPTER_CONFIGURED` | unset (fail-closed) |

---

## Pre-Deployment Checklist

### Cloudflare Worker Production

| # | Check | Status | Owner | Evidence |
|---|-------|--------|-------|----------|
| W1 | Production Worker `opex-vbm-api` provisioned | BLOCKED | DevOps | `wrangler.toml` configured, not deployed |
| W2 | `APP_ENV = "production"` configured | READY | N/A | `wrangler.toml` verified |
| W3 | `ALLOWED_ORIGIN` configured | READY | N/A | `wrangler.toml` verified |
| W4 | `GEOTAB_DATABASE = "opex_trial"` configured | READY | N/A | `wrangler.toml` verified |
| W5 | `IDENTITY_ADAPTER_CONFIGURED` unset (fail-closed) | READY | N/A | Not defined in wrangler.toml |
| W6 | No PostgreSQL/D1/KV bindings | READY | N/A | `wrangler.toml` verified |
| W7 | Worker health endpoint reachable | BLOCKED | DevOps | `GET /api/health` on production Worker |
| W8 | Security headers present | READY | N/A | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` |
| W9 | Request body size limit (1 MB) | READY | N/A | `index.ts` verified |

### Frontend Production (GitHub Pages)

| # | Check | Status | Owner | Evidence |
|---|-------|--------|-------|----------|
| F1 | Frontend deployed from `main` branch | BLOCKED | DevOps | GitHub Pages from `main` |
| F2 | `VITE_API_BASE_URL` points to production Worker | BLOCKED | DevOps | GitHub Actions variable |
| F3 | Base path `/opexassetbooking/` correct | READY | N/A | `vite.config.ts` verified |
| F4 | Frontend loads without console errors | BLOCKED | DevOps | Browser console check |
| F5 | No secrets in frontend bundle | READY | N/A | Build verified clean |

### MyGeotab Production Safety

| # | Check | Status | Owner | Evidence |
|---|-------|--------|-------|----------|
| M1 | MyGeotab tenant `opex_trial` confirmed | BLOCKED | Geotab Admin | Tenant credentials required |
| M2 | AddInId `addin-booking-app` configured | BLOCKED | Geotab Admin | Same as staging |
| M3 | Authentication verified against tenant | BLOCKED | Geotab Admin | Session verification not live-tested |
| M4 | User roles configured (APPROVER, GA, etc.) | BLOCKED | Geotab Admin | Role fields in tenant |
| M5 | AddInData serialization verified | READY | N/A | Single `JSON.stringify`, 10K char limit |
| M6 | Booking/audit record isolation | READY | N/A | Version checks, driver isolation |
| M7 | Existing production data safety | BLOCKED | Geotab Admin | No destructive tests run |

### GitHub Actions

| # | Check | Status | Owner | Evidence |
|---|-------|--------|-------|----------|
| G1 | `production` GitHub Environment created | BLOCKED | Repo Admin | Settings > Environments |
| G2 | `github-pages` GitHub Environment created | BLOCKED | Repo Admin | Settings > Environments |
| G3 | `CLOUDFLARE_API_TOKEN` secret configured | BLOCKED | Repo Admin | Settings > Secrets |
| G4 | `CLOUDFLARE_ACCOUNT_ID` variable configured | BLOCKED | Repo Admin | Settings > Variables |
| G5 | `VITE_API_BASE_URL` variable configured | BLOCKED | Repo Admin | Settings > Variables |
| G6 | Worker deploy requires `production` env approval | READY | N/A | `deploy-worker.yml` verified |
| G7 | Frontend deploy requires `github-pages` env approval | READY | N/A | `deploy-pages.yml` verified |
| G8 | CI runs on PRs and pushes to `main` | READY | N/A | `ci.yml` verified |

### Regression Validation

| # | Check | Status | Result |
|---|-------|--------|--------|
| R1 | API TypeScript check | READY | Clean (exit 0) |
| R2 | Web TypeScript check | READY | Clean (exit 0) |
| R3 | API tests (234) | READY | 234 pass, 0 fail |
| R4 | Web tests (155) | READY | 155 pass, 0 fail |
| R5 | Web production build | READY | Successful |

---

## Deployment Steps (When Approved)

### Production Deployment

1. **Merge approved PR to `main`** → CI runs automatically (`ci.yml`)
2. **Worker deployment** via `deploy-worker.yml`:
   - Triggers on push to `main` or `workflow_dispatch`
   - Requires `production` environment approval
   - Runs `npx wrangler deploy` from `apps/api/`
   - Record deployment ID for rollback
3. **Frontend deployment** via `deploy-pages.yml`:
   - Triggers on push to `main`
   - Requires `github-pages` environment approval
   - Builds frontend with `VITE_API_BASE_URL`
   - Deploys to GitHub Pages
4. **Post-deployment verification**:
   - `GET /api/health` returns `"ok":true`
   - CORS rejects disallowed origins with `403`
   - Protected routes return `503` when identity disabled
   - Frontend loads without console errors

### Rollback Procedure

| Component | Method | Command |
|-----------|--------|---------|
| Frontend | Re-run previous Pages deployment | GitHub Actions re-run |
| API Worker | Roll back Worker version | `npx wrangler rollback <deployment-id>` |
| Configuration | Revert `wrangler.toml` | `git checkout <commit> -- apps/api/wrangler.toml` |
| AddInData records | NOT rolled back | Manual MyGeotab intervention required |

**Critical:** AddInData records are append-only and persistent. Rollback does NOT affect booking or audit records.

---

## Required Secrets and Variables

| Name | Type | Purpose | Configured? |
|------|------|---------|-------------|
| `CLOUDFLARE_API_TOKEN` | Secret | Worker deployment auth | NO |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare account ID | NO |
| `VITE_API_BASE_URL` | Variable | Frontend API endpoint | NO |

**Never add `CLOUDFLARE_API_TOKEN` as a variable — it must be a secret.**
**Never put secrets in `wrangler.toml` or frontend `VITE_*` variables.**

---

## Remaining Risks

| Risk | Status | Impact |
|------|--------|--------|
| AddInData storage quota | UNKNOWN | Requires Geotab Support |
| Live MyGeotab throttling | UNVERIFIED | Requires test tenant |
| Non-atomic booking/audit writes | MITIGATED | Version checks + idempotency |
| Version-based concurrency | MITIGATED | Best-effort conflict detection |
| Full collection scan | UNVERIFIED | Server-side filtering untested |
| No live integration validation | BLOCKED | No credentials |

---

## Sign-Off

Production deployment requires explicit sign-off from:

- [ ] Release Manager
- [ ] DevOps Engineer
- [ ] Application Security Engineer

**Current status: BLOCKED** — Infrastructure and credentials not provisioned.
