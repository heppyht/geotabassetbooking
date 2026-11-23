# Production Deployment Guide — OPEX Asset Booking

This document describes how to deploy the Geotab Asset Booking application to
a staging or production environment. This is documentation only — do not
execute a production deployment without explicit approval.

## Architecture overview

```text
Browser (GitHub Pages)                          Cloudflare Worker
https://heppyh.github.io/opexassetbooking/       https://opex-vbm-api.<subdomain>.workers.dev
                                                    │
                                                    ▼
                                              MyGeotab REST API
                                              https://my.geotab.com/apiv1
                                              Database: opex_trial
                                              Storage: AddInData only
```

- **Frontend:** React/Vite static site, hosted on GitHub Pages.
- **API:** Cloudflare Worker (Hono), hosted on `workers.dev`.
- **Persistent storage:** MyGeotab AddInData only. No PostgreSQL, Neon,
  Cloudflare D1, Cloudflare KV, Supabase, Firebase, Redis, or MongoDB.
- **Authentication:** MyGeotab session verification via the Worker.
- **CORS:** Single allowlist origin (`ALLOWED_ORIGIN`).

---

## Prerequisites

1. Cloudflare account with a registered `workers.dev` subdomain.
2. GitHub repository with GitHub Actions enabled.
3. MyGeotab tenant (`opex_trial`) with an administrator who can register
   the Add-In.
4. `wrangler` CLI installed locally (`npm install -g wrangler` or
   `npx wrangler`).

No database provisioning is required — AddInData is schema-less.

---

## Environment setup

### 1. Fork/clone the repository

```bash
git clone https://github.com/heppyht/geotabassetbooking.git
cd geotabassetbooking
npm install
```

### 2. Configure the API Worker

Edit `apps/api/wrangler.toml`:

| Variable | Production value |
|----------|------------------|
| `APP_ENV` | `"production"` |
| `ALLOWED_ORIGIN` | `https://heppyh.github.io` (exact origin, lowercase, no path) |
| `GEOTAB_DATABASE` | `opex_trial` |
| `IDENTITY_ADAPTER_CONFIGURED` | Do NOT set until live session verification is validated |

No secrets belong in `wrangler.toml`.

### 3. Configure local development variables

Copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars` (git-ignored) and
set local values:

```
APP_ENV=development
ALLOWED_ORIGIN=http://localhost:5173
GEOTAB_DATABASE=opex_trial
IDENTITY_ADAPTER_CONFIGURED=false
```

### 4. Configure frontend build variables

Copy `apps/web/.env.example` to `apps/web/.env` (git-ignored):

```
VITE_API_BASE_URL=https://opex-vbm-api.<account-subdomain>.workers.dev
VITE_GEOTAB_DATABASE=opex_trial
```

`VITE_API_BASE_URL` is optional — when unset, the UI shows "Backend not
connected".

### 5. GitHub Actions secrets and variables

In the GitHub repository (Settings → Secrets and variables → Actions):

| Name | Type | Value |
|------|------|-------|
| `VITE_API_BASE_URL` | Variable | `https://opex-vbm-api.<account-subdomain>.workers.dev` |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Your Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Secret | Cloudflare API token with Workers:Edit permission |

Never add `CLOUDFLARE_API_TOKEN` as a variable — it must be a secret.

---

## Build and deploy

### Frontend (GitHub Pages)

1. Ensure GitHub Pages source is set to **GitHub Actions**
   (Settings → Pages → Build and deployment → Source: GitHub Actions).
2. Push to `main` or run the "Deploy web to GitHub Pages" workflow
   manually.
3. The workflow builds `apps/web` and deploys `apps/web/dist` to Pages.

### API Worker (Cloudflare)

1. From `apps/api/`, authenticate:
   ```bash
   npx wrangler login
   ```
2. Typecheck:
   ```bash
   npm --workspace apps/api run typecheck
   ```
3. Test:
   ```bash
   npm --workspace apps/api run test
   ```
4. Deploy:
   ```bash
   npm --workspace apps/api run deploy
   ```
   (runs `wrangler deploy`)

5. Note the printed Worker URL and update `VITE_API_BASE_URL` if needed.

---

## MyGeotab Add-In registration

The frontend can run standalone on GitHub Pages without Add-In registration.
To register as a MyGeotab Add-In:

1. Obtain tenant administrator access to `opex_trial`.
2. Review `geotab/opex-vbm-config.json` — confirm `supportEmail` and URL.
3. The Add-In URL `https://heppyh.github.io/opexassetbooking/` contains
   hyphens in its path. Geotab documentation indicates externally hosted
   Add-In URLs must not contain hyphens, `@`, or `#`. This may prevent
   the Add-In from loading inside MyGeotab. Consider serving from a
   hyphen-free path or embedding files in the Add-In configuration.
4. Register the Add-In in the tenant's System Settings → Add-Ins.
5. Validate in the target tenant before production use.

---

## CI/CD workflow

### CI (`.github/workflows/ci.yml`)

Runs on pull requests and pushes to `main`:

1. Checkout repository
2. Install dependencies (`npm install`)
3. API TypeScript validation (`npm --workspace apps/api run typecheck`)
4. API tests (`npm --workspace apps/api run test`)
5. Web TypeScript validation (`tsc -p apps/web/tsconfig.json --noEmit`)
6. Web tests (`npm --workspace apps/web run test`)
7. Web production build (`npm --workspace apps/web run build`)
8. Deployment configuration validation (`deployment-config.test.mjs`)
9. Upload web build artifact

### Worker deployment (`.github/workflows/deploy-worker.yml`)

Runs on push to `main` or manual dispatch, targeting the `production`
environment:

1. Checkout repository
2. Install dependencies
3. API TypeScript validation
4. API tests
5. Deploy Cloudflare Worker (`wrangler deploy`)

Production deployment requires the `production` environment protection
rules in GitHub (manual approval if configured).

---

## Staging validation

Before production:

1. Deploy the Worker to the `personal-test` environment (`APP_ENV =
   "personal-test"`).
2. Verify `GET /api/health` returns `"ok":true`.
3. Verify protected routes return `503 AUTH_ADAPTER_NOT_CONFIGURED`
   while `IDENTITY_ADAPTER_CONFIGURED` is not `"true"`.
4. Verify CORS rejects non-allowed origins with `403 ORIGIN_NOT_ALLOWED`.
5. Verify frontend loads and shows correct backend connection state.
6. Verify no secrets appear in git diff, Pages bundle, or Action logs.

---

## Production approval

Production deployment requires:

1. All CI checks pass on the target commit.
2. Code review and approval via pull request.
3. Merge to `main`.
4. Staging validation passed.
5. Explicit production approval (GitHub environment protection or manual
   workflow dispatch).
6. `IDENTITY_ADAPTER_CONFIGURED` set to `"true"` ONLY after live MyGeotab
   session verification is validated against `GEOTAB_DATABASE`.

---

## Rollback procedure

See `docs/deployment/rollback-and-recovery.md`.

Key points:
- Frontend: re-run a previous successful Pages deployment or revert the
  commit and push.
- API Worker: `npx wrangler rollback <deployment-id>`.
- AddInData records are NOT rolled back — they are append-only and
  persistent in MyGeotab.
- Never delete or overwrite production booking or audit records.

---

## Post-deployment checklist

- [ ] `GET /api/health` returns `"ok":true` with expected `version`.
- [ ] `tenantTarget` matches the production MyGeotab database.
- [ ] `authConfigured` reflects the expected identity state.
- [ ] Protected routes return `503` when identity is disabled.
- [ ] CORS rejects disallowed origins with `403`.
- [ ] Security headers present: `X-Content-Type-Options`, `X-Frame-Options`,
      `Referrer-Policy`.
- [ ] Frontend loads without console errors.
- [ ] No secrets in git diff, Pages bundle, or Action logs.
- [ ] Worker deployment ID recorded for rollback reference.

---

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|-------------|--------|
| `/api/health` returns 503 | `IDENTITY_ADAPTER_CONFIGURED` not set correctly | Check `wrangler.toml` |
| CORS 403 | `ALLOWED_ORIGIN` mismatch | Verify exact origin (lowercase, no path) |
| Worker deploy fails | Missing `CLOUDFLARE_API_TOKEN` secret | Add to GitHub Actions secrets |
| Frontend shows "Backend not connected" | `VITE_API_BASE_URL` unset | Set as GitHub Actions variable |
| Build fails | TypeScript errors | Run `npm --workspace apps/api run typecheck` locally |

---

## Production blockers

Do not deploy to production until:

1. Live MyGeotab session verification is validated against `GEOTAB_DATABASE`
   (requires live tenant credentials — currently unavailable).
2. `IDENTITY_ADAPTER_CONFIGURED` is set to `"true"` only after validation.
3. Geotab Support confirms AddInData storage quotas and rate limits.
4. Client-side rate-limit handling (exponential backoff, Retry-After) is
   implemented.
5. Live AddInData CRUD operations are verified against the production tenant.
