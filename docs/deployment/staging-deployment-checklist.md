# Staging Deployment Checklist — OPEX Asset Booking

**Purpose:** Pre-deployment validation for staging environment.
**Status:** CONFIGURATION IMPLEMENTED — Infrastructure not yet provisioned.
**Do not deploy without explicit approval.**

---

## Architecture Summary

| Component | Production | Staging |
|-----------|-----------|---------|
| Worker name | `opex-vbm-api` | `opex-vbm-api-staging` |
| Worker URL | `https://opex-vbm-api.<subdomain>.workers.dev` | `https://opex-vbm-api-staging.<subdomain>.workers.dev` |
| Frontend URL | `https://heppyh.github.io/opexassetbooking/` | Same Pages site (staging branch) |
| Database | `opex_trial` (test tenant) | `opex_trial` (test tenant) |
| AddInId | `addin-booking-app` | `addin-booking-app` (same, logically separated) |
| `APP_ENV` | `"production"` | `"staging"` |
| `IDENTITY_ADAPTER_CONFIGURED` | unset (fail-closed) | unset (fail-closed) |

---

## Pre-Deployment Checklist

### Cloudflare Worker Staging

| # | Check | Status | Owner | Evidence |
|---|-------|--------|-------|----------|
| W1 | Staging Worker `opex-vbm-api-staging` provisioned | BLOCKED | DevOps | `wrangler.toml` has `[environments.staging]` |
| W2 | Staging `APP_ENV = "staging"` configured | BLOCKED | DevOps | wrangler.toml staging env vars |
| W3 | Staging `ALLOWED_ORIGIN` configured | BLOCKED | DevOps | wrangler.toml staging env vars |
| W4 | Staging `GEOTAB_DATABASE = "opex_trial"` configured | BLOCKED | DevOps | wrangler.toml staging env vars |
| W5 | Staging `IDENTITY_ADAPTER_CONFIGURED` unset (fail-closed) | BLOCKED | DevOps | Not defined in staging env |
| W6 | Staging Worker health endpoint reachable | BLOCKED | DevOps | `GET /api/health` on staging Worker |

### Frontend Staging

| # | Check | Status | Owner | Evidence |
|---|-------|--------|-------|----------|
| F1 | Staging frontend deployed from `staging` branch | BLOCKED | DevOps | GitHub Pages from `staging` branch |
| F2 | Staging `VITE_API_BASE_URL` points to staging Worker | BLOCKED | DevOps | GitHub Actions variable |
| F3 | Staging base path `/opexassetbooking/` correct | READY | N/A | `vite.config.ts` verified |
| F4 | Staging frontend loads without console errors | BLOCKED | DevOps | Browser console check |

### MyGeotab Integration

| # | Check | Status | Owner | Evidence |
|---|-------|--------|-------|----------|
| M1 | Dedicated MyGeotab test tenant (`opex_trial`) available | BLOCKED | Geotab Admin | Tenant credentials |
| M2 | Staging AddInId configured | BLOCKED | Geotab Admin | `addin-booking-app` |
| M3 | Staging does not access production tenant data | READY | N/A | Both use `opex_trial` test tenant |
| M4 | MyGeotab user roles configured for staging | BLOCKED | Geotab Admin | Role fields in tenant |

### GitHub Actions

| # | Check | Status | Owner | Evidence |
|---|-------|--------|-------|----------|
| G1 | `staging` GitHub Environment created | BLOCKED | Repo Admin | Settings > Environments |
| G2 | `production` GitHub Environment created | BLOCKED | Repo Admin | Settings > Environments |
| G3 | `CLOUDFLARE_API_TOKEN` secret configured | BLOCKED | Repo Admin | Settings > Secrets |
| G4 | `CLOUDFLARE_ACCOUNT_ID` variable configured | BLOCKED | Repo Admin | Settings > Variables |
| G5 | `VITE_API_BASE_URL` variable configured | BLOCKED | Repo Admin | Settings > Variables |
| G6 | Staging deploy workflow uses staging secrets | READY | N/A | `deploy-worker.yml` verified |
| G7 | Production deploy workflow uses production secrets | READY | N/A | `deploy-worker.yml` verified |
| G8 | Production deployment requires explicit approval | BLOCKED | Repo Admin | Environment protection rules |

### Configuration Validation

| # | Check | Status | Owner | Evidence |
|---|-------|--------|-------|----------|
| C1 | wrangler.toml has `[environments.staging]` | READY | N/A | File verified |
| C2 | Staging Worker name differs from production | READY | N/A | `opex-vbm-api-staging` vs `opex-vbm-api` |
| C3 | Both environments use `opex_trial` database | READY | N/A | File verified |
| C4 | No hardcoded secrets in configuration | READY | N/A | Scan verified |
| C5 | Staging config validation tests pass | READY | N/A | 18 tests pass |

---

## Deployment Steps (When Approved)

### Staging Deployment

1. Push to `staging` branch OR run `deploy-worker.yml` with `environment: staging` input
2. GitHub Actions `deploy-staging` job runs:
   - Typecheck + tests
   - `npx wrangler deploy --env staging`
   - Deploys `opex-vbm-api-staging` Worker
3. GitHub Actions `build-staging` + `deploy-staging` (Pages) job runs:
   - Builds frontend with staging `VITE_API_BASE_URL`
   - Deploys to GitHub Pages

### Staging Validation (After Deployment)

- [ ] `GET https://opex-vbm-api-staging.<subdomain>.workers.dev/api/health` returns `"ok":true`
- [ ] `tenantTarget` matches `opex_trial`
- [ ] `authConfigured` is `false` (fail-closed)
- [ ] CORS rejects disallowed origins with `403`
- [ ] Frontend loads at GitHub Pages URL
- [ ] No console errors in frontend
- [ ] AddInData CRUD operations work against `opex_trial`
- [ ] No production data accessed

### Rollback

- Frontend: Re-run previous successful Pages deployment or revert commit
- API Worker: `npx wrangler rollback <deployment-id>` (staging Worker)
- AddInData records: NOT rolled back — append-only

---

## Blockers

The following items block staging deployment:

1. **Cloudflare staging Worker not provisioned** — Requires `npx wrangler deploy --env staging` with valid `CLOUDFLARE_API_TOKEN`
2. **GitHub Actions secrets not configured** — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VITE_API_BASE_URL`
3. **GitHub Environments not created** — `staging` and `production` environments
4. **MyGeotab test tenant access not obtained** — `opex_trial` credentials
5. **Production approval gates not configured** — Environment protection rules

## Sign-Off

Staging deployment requires explicit sign-off from:

- [ ] Release Manager
- [ ] DevOps Engineer
- [ ] Application Security Engineer

**Current status: BLOCKED** — Infrastructure and credentials not provisioned.
