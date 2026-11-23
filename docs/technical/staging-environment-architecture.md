# Staging Environment Architecture — OPEX Asset Booking

**Phase:** 9.9.2
**Status:** CONFIGURATION IMPLEMENTED — Infrastructure not yet provisioned.
**Date:** 2026-11-23

---

## Overview

This document describes the staging environment architecture for Geotab Asset Booking.
Staging is logically and operationally separated from production. No production
tenant data is accessed from staging.

## Architecture Diagram

```text
┌─────────────────┐                  ┌─────────────────────────────────┐
│   Production    │                  │         Staging                 │
│                 │                  │                                 │
│ Frontend:       │                  │ Frontend:                       │
│ GitHub Pages    │                  │ GitHub Pages (staging branch)   │
│ https://hyp...  │                  │ Same Pages site URL             │
│   ppyh.github.  │                  │                                 │
│   io/opex...    │                  │                                 │
└─────────┬───────┘                  └─────────────┬───────────────────┘
          │                                        │
          ▼                                        ▼
┌─────────────────┐                  ┌─────────────────────────────────┐
│   API Worker    │                  │      API Worker (staging)       │
│ opex-vbm-api    │                  │   opex-vbm-api-staging          │
│ workers.dev     │                  │   workers.dev                   │
└─────────┬───────┘                  └─────────────┬───────────────────┘
          │                                        │
          └───────────────┬────────────────────────┘
                          ▼
                  ┌─────────────────┐
                  │   MyGeotab      │
                  │   opex_trial    │
                  │  (test tenant)  │
                  │ AddInData only  │
                  └─────────────────┘
```

## Component Details

### Cloudflare Workers

| Component | Name | Environment | wrangler.toml |
|-----------|------|-------------|---------------|
| Production API | `opex-vbm-api` | production | Default (no `[environments]`) |
| Staging API | `opex-vbm-api-staging` | staging | `[environments.staging]` |

**Production variables** (in `[vars]`):
- `APP_ENV = "personal-test"`
- `ALLOWED_ORIGIN = "https://heppyh.github.io"`
- `GEOTAB_DATABASE = "opex_trial"`
- `IDENTITY_ADAPTER_CONFIGURED` — unset (fail-closed)

**Staging variables** (in `[environments.staging.vars]`):
- `APP_ENV = "staging"`
- `ALLOWED_ORIGIN = "https://heppyh.github.io"`
- `GEOTAB_DATABASE = "opex_trial"`
- `IDENTITY_ADAPTER_CONFIGURED` — unset (fail-closed)

### Frontend (GitHub Pages)

| Component | Source Branch | Build Output | Base Path | API Base URL |
|-----------|--------------|--------------|-----------|--------------|
| Production | `main` | `apps/web/dist` | `/opexassetbooking/` | `VITE_API_BASE_URL` (production Worker) |
| Staging | `staging` | `apps/web/dist` | `/opexassetbooking/` | `VITE_API_BASE_URL` (staging Worker) |

Both frontends use the same base path. The API endpoint differs via `VITE_API_BASE_URL` environment variable set at build time in GitHub Actions.

### MyGeotab Integration

| Component | Value | Notes |
|-----------|-------|-------|
| Database | `opex_trial` | Test tenant — same for production and staging |
| AddInId | `addin-booking-app` | Same AddInId for both environments |
| Storage | AddInData only | No external database |

Both environments share the same MyGeotab test tenant. Data is logically separated by deployment context — staging writes to `opex_trial` just as production does. Staging must NOT access production tenant data because `opex_trial` IS the test tenant.

### GitHub Actions Environments

| Environment | Purpose | Secrets | Approval Required |
|-------------|---------|---------|-------------------|
| `staging` | Staging deployments | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | No (auto-deploy on push to `staging`) |
| `production` | Production deployments | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Yes (environment protection rules) |
| `github-pages` | Frontend production | None (id-token) | Yes |
| `github-pages-staging` | Frontend staging | None (id-token) | No |

### Data Flow

1. Frontend (GitHub Pages) → API Worker (workers.dev)
2. API Worker → MyGeotab REST API (`my.geotab.com/apiv1`)
3. MyGeotab → AddInData records in `opex_trial` database

No data flows between staging and production environments.

---

## Security Constraints

- **No PostgreSQL, D1, Neon, Supabase, Firebase, Redis, MongoDB, or Cloudflare KV** — AddInData only
- **Cloudflare Worker is API runtime only** — no persistent storage in Worker
- **No secrets in `wrangler.toml`** — all values are plain `[vars]`
- **No secrets in frontend bundle** — `VITE_*` variables are public; no tokens or session IDs
- **Tenant isolation** — `GEOTAB_DATABASE` is server-configured, client header ignored
- **Fail-closed authentication** — `IDENTITY_ADAPTER_CONFIGURED` unset blocks all protected endpoints

---

## File References

| File | Purpose |
|------|---------|
| `apps/api/wrangler.toml` | Worker configuration with `[environments.staging]` |
| `.github/workflows/deploy-worker.yml` | Worker deploy: staging + production jobs |
| `.github/workflows/deploy-pages.yml` | Frontend deploy: staging + production jobs |
| `apps/web/vite.config.ts` | Vite config: base path `/opexassetbooking/` |
| `docs/deployment/staging-deployment-checklist.md` | Pre-deployment checklist |
| `docs/deployment/staging-environment-setup.md` | Setup instructions |
