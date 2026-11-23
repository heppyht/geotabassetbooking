# Staging Environment Setup — OPEX Asset Booking

**Phase:** 9.9.2
**Status:** CONFIGURATION IMPLEMENTED — Infrastructure not yet provisioned.
**Date:** 2026-11-23

---

## Overview

This document provides step-by-step setup instructions for the staging environment.
Configuration is implemented in the repository but infrastructure is not yet provisioned.

---

## Prerequisites

1. Cloudflare account with `workers.dev` subdomain
2. GitHub repository with Actions enabled
3. MyGeotab test tenant (`opex_trial`) with administrator access
4. `wrangler` CLI installed

---

## Step 1: Configure Cloudflare Secrets and Variables

In GitHub repository Settings → Secrets and variables → Actions:

### Secrets (never exposed in logs)

| Name | Type | Value Source | Purpose |
|------|------|--------------|---------|
| `CLOUDFLARE_API_TOKEN` | Secret | Cloudflare dashboard | Deploy Worker via wrangler |

### Variables (visible in logs, non-sensitive)

| Name | Type | Value | Purpose |
|------|------|-------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Cloudflare account ID | Worker deployment target |
| `VITE_API_BASE_URL` | Variable | `https://opex-vbm-api-staging.<subdomain>.workers.dev` (staging) or `https://opex-vbm-api.<subdomain>.workers.dev` (production) | Frontend API endpoint |

**Never add `CLOUDFLARE_API_TOKEN` as a variable — it must be a secret.**

---

## Step 2: Create GitHub Environments

In GitHub repository Settings → Environments:

| Environment | Protection Rules | Required Reviewers | Deployment Branches |
|-------------|-----------------|-------------------|---------------------|
| `staging` | None (auto-deploy) | None | `staging` |
| `production` | Required reviewers | Release Manager, DevOps | `main` |
| `github-pages` | Required reviewers | Release Manager | `main` |
| `github-pages-staging` | None (auto-deploy) | None | `staging` |

---

## Step 3: Verify wrangler.toml Configuration

`apps/api/wrangler.toml` already contains:

- **Production** (default `[vars]`): `APP_ENV = "personal-test"`, `ALLOWED_ORIGIN`, `GEOTAB_DATABASE = "opex_trial"`
- **Staging** (`[environments.staging]`): `APP_ENV = "staging"`, `ALLOWED_ORIGIN`, `GEOTAB_DATABASE = "opex_trial"`
- **No secrets** in `wrangler.toml`
- **No PostgreSQL/D1/KV bindings**

Deploy staging Worker:
```bash
cd apps/api
npx wrangler login
npx wrangler deploy --env staging
```

Deploy production Worker:
```bash
cd apps/api
npx wrangler login
npx wrangler deploy
```

---

## Step 4: Verify GitHub Actions Workflows

### `.github/workflows/deploy-worker.yml`

- `deploy-staging` job: triggers on push to `staging` branch, targets `staging` environment, runs `npx wrangler deploy --env staging`
- `deploy-production` job: triggers on push to `main` branch, targets `production` environment, runs `npx wrangler deploy`

### `.github/workflows/deploy-pages.yml`

- `build-staging` / `deploy-staging`: triggers on push to `staging` branch, targets `github-pages-staging` environment
- `build-production` / `deploy-production`: triggers on push to `main` branch, targets `github-pages` environment

---

## Step 5: Configure Frontend Staging Variables

`VITE_API_BASE_URL` is set as a GitHub Actions Variable (not a secret) because it's a public URL. It's injected at build time into the frontend bundle.

For staging: `https://opex-vbm-api-staging.<account-subdomain>.workers.dev`
For production: `https://opex-vbm-api.<account-subdomain>.workers.dev`

When unset, the UI shows "Backend not connected" — safe default.

---

## Step 6: Verify MyGeotab Test Tenant

| Item | Value | Status |
|------|-------|--------|
| Database | `opex_trial` | Test tenant |
| AddInId | `addin-booking-app` | Same for both environments |
| User roles | APPROVER, GA, MANAGEMENT, ADMIN | Must be configured in tenant |

Staging uses the same `opex_trial` test tenant as production. This is intentional — `opex_trial` is already a test tenant, not production data.

---

## Step 7: Run Configuration Validation

```bash
cd apps/api
npm run typecheck
npm test
node --experimental-strip-types test/staging-config.test.mjs
```

Expected: All tests pass, including 18 staging configuration tests.

---

## Step 8: Deploy (When Approved)

### Staging

1. Create `staging` branch from `main`
2. Push `staging` branch to trigger `deploy-worker.yml` and `deploy-pages.yml`
3. Verify staging Worker at `https://opex-vbm-api-staging.<subdomain>.workers.dev/api/health`
4. Verify staging frontend at GitHub Pages URL

### Production

1. Create pull request from feature branch to `main`
2. CI runs (`ci.yml`)
3. Code review and approval
4. Merge to `main` triggers production deploy
5. `production` environment requires manual approval
6. Verify production Worker at `https://opex-vbm-api.<subdomain>.workers.dev/api/health`

---

## Rollback Procedure

| Component | Method | Command |
|-----------|--------|---------|
| Frontend | Re-run previous Pages deployment | GitHub Actions re-run |
| API Worker (staging) | Roll back Worker version | `npx wrangler rollback <id> --env staging` |
| API Worker (production) | Roll back Worker version | `npx wrangler rollback <id>` |
| Configuration | Revert wrangler.toml | `git checkout <commit> -- apps/api/wrangler.toml` |
| AddInData records | NOT rolled back | Manual MyGeotab intervention required |

**Critical:** AddInData records are append-only and persistent. Rollback does NOT affect booking or audit records.

---

## Blockers

| # | Blocker | Required Action | Owner |
|---|---------|----------------|-------|
| 1 | Cloudflare staging Worker not provisioned | `npx wrangler deploy --env staging` | DevOps |
| 2 | GitHub Actions secrets not configured | Add `CLOUDFLARE_API_TOKEN` secret | Repo Admin |
| 3 | GitHub Actions variables not configured | Add `CLOUDFLARE_ACCOUNT_ID`, `VITE_API_BASE_URL` | Repo Admin |
| 4 | GitHub Environments not created | Create `staging`, `production`, `github-pages`, `github-pages-staging` | Repo Admin |
| 5 | MyGeotab test tenant credentials not obtained | Get `opex_trial` access | Geotab Admin |
| 6 | Production approval gates not configured | Enable environment protection rules | Repo Admin |

**Current status: BLOCKED** — Infrastructure and credentials not provisioned. Do not deploy without explicit approval.
