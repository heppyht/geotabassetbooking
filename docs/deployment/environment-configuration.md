# Environment Configuration — OPEX Asset Booking

This document defines every environment variable used by the Geotab Asset Booking
application, where each value is configured, and how secrets are handled.

## Architecture constraint

MyGeotab AddInData is the ONLY persistent application storage. No PostgreSQL,
Neon, Cloudflare D1, Cloudflare KV, Supabase, Firebase, Redis, MongoDB, or any
other persistent database/storage service may be introduced.

Cloudflare Workers may remain as the API runtime only.

---

## Variable reference

### API (Cloudflare Worker) — `apps/api/wrangler.toml` / `.dev.vars`

| Variable | Scope | Value (example) | Secret? | Purpose |
|----------|-------|-----------------|---------|---------|
| `APP_ENV` | `[vars]` | `"personal-test"` or `"development"` | No | Controls whether internal error messages are exposed. Any value other than `"development"` hides internal error text. |
| `ALLOWED_ORIGIN` | `[vars]` | `"https://heppyh.github.io"` | No | Exact browser origin (scheme + lowercase host, no path, no trailing slash). CORS allows only this origin. |
| `GEOTAB_DATABASE` | `[vars]` | `"opex_trial"` | No | MyGeotab database sessions are accepted for this database only. Never taken from the client. |
| `IDENTITY_ADAPTER_CONFIGURED` | `[vars]` | unset / `"false"` | No | Fail-closed switch. Must remain unset or `"false"` until MyGeotab session verification has been validated against `GEOTAB_DATABASE`. When not `"true"`, all protected endpoints return `503 AUTH_ADAPTER_NOT_CONFIGURED`. |

### Local API development — `apps/api/.dev.vars` (git-ignored)

Copy from `apps/api/.dev.vars.example`. Values are placeholders; never commit the real file.

| Variable | Example local value |
|----------|---------------------|
| `APP_ENV` | `development` |
| `ALLOWED_ORIGIN` | `http://localhost:5173` |
| `GEOTAB_DATABASE` | `opex_trial` |
| `IDENTITY_ADAPTER_CONFIGURED` | `false` |

### Frontend (Vite build) — `apps/web/.env` (git-ignored)

Copy from `apps/web/.env.example`. Everything prefixed `VITE_` is embedded in the public bundle: never put secrets here.

| Variable | Example value | Secret? | Purpose |
|----------|---------------|---------|---------|
| `VITE_API_BASE_URL` | `https://opex-vbm-api.<account-subdomain>.workers.dev` | No | API base URL for frontend calls. Optional; when unset the UI shows "Backend not connected". |
| `VITE_GEOTAB_DATABASE` | `opex_trial` | No | UI label only. The API enforces the tenant independently. |

### GitHub Actions

| Variable/Secret | Where configured | Type | Purpose |
|-----------------|------------------|------|---------|
| `VITE_API_BASE_URL` | Settings → Secrets and variables → Actions → Variables | Variable (public) | Frontend build-time API URL. Set only after the Worker exists. |
| `CLOUDFLARE_API_TOKEN` | Settings → Secrets and variables → Actions → Secrets | Secret | Used by `wrangler deploy` in the Worker deployment workflow. Never exposed to PRs from forks. |
| `CLOUDFLARE_ACCOUNT_ID` | Settings → Secrets and variables → Actions → Variables | Variable | Cloudflare account ID for Worker deployment. |

---

## Validation at startup

The API Worker validates required configuration implicitly:

- `APP_ENV` — if missing, Hono/Cloudflare runtime will use a default. Error messages are hidden unless `APP_ENV === "development"`.
- `ALLOWED_ORIGIN` — CORS middleware rejects any request whose `Origin` does not match exactly.
- `GEOTAB_DATABASE` — used by `AddInDataRestGateway` for every MyGeotab API call. Client-supplied `x-geotab-database` is ignored.
- `IDENTITY_ADAPTER_CONFIGURED` — when not `"true"`, all protected endpoints fail closed with `503`.

No hardcoded credentials exist in the repository. `.gitignore` excludes `.dev.vars`, `.env`, and `.env.*` (except `.env.example`).

---

## Environment promotion

| Environment | `APP_ENV` | `ALLOWED_ORIGIN` | `GEOTAB_DATABASE` | `IDENTITY_ADAPTER_CONFIGURED` |
|-------------|-----------|------------------|-------------------|-------------------------------|
| Local development | `development` | `http://localhost:5173` | `opex_trial` | `false` |
| Staging (personal-test) | `personal-test` | `https://heppyh.github.io` | `opex_trial` | `false` (until live validation) |
| Production | `"production"` | Production origin | Production database | `true` (only after live validation) |

Never use development credentials in production. Never commit real secrets.
