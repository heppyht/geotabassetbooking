# Production Release Checklist — OPEX Asset Booking

**Purpose:** Final gate before production deployment.
**Status:** BLOCKED — Critical prerequisites not met.
**Do not deploy to production until all items are READY.**

---

## Mandatory Prerequisites

| # | Check | Status | Owner | Evidence |
|---|-------|--------|-------|----------|
| P1 | Live MyGeotab tenant credentials obtained | BLOCKED | Geotab Admin | userName, database, sessionId for `opex_trial` |
| P2 | AddInData storage quota confirmed | BLOCKED | Geotab Support | Written confirmation of quota limits |
| P3 | `CLOUDFLARE_API_TOKEN` configured in GitHub Secrets | BLOCKED | Repo Admin | Secret exists in Settings > Secrets > Actions |
| P4 | `CLOUDFLARE_ACCOUNT_ID` configured in GitHub Variables | BLOCKED | Repo Admin | Variable exists in Settings > Secrets > Actions > Variables |
| P5 | GitHub environment protection rules enabled for `production` | BLOCKED | Repo Admin | Manual approval required for production deployment |
| P6 | `IDENTITY_ADAPTER_CONFIGURED` set to `"true"` only after live validation | BLOCKED | DevOps | wrangler.toml updated after MyGeotab verification |
| P7 | MyGeotab user roles configured for APPROVER/GA/MANAGEMENT/ADMIN | BLOCKED | Geotab Admin | Role fields populated in tenant user records |

---

## CI/CD Validation

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| C1 | API TypeScript check passes | READY | `tsc --noEmit` clean |
| C2 | Web TypeScript check passes | READY | `tsc -p apps/web/tsconfig.json --noEmit` clean |
| C3 | API tests pass (206) | READY | All 206 tests pass, 0 fail |
| C4 | Web tests pass (155) | READY | All 155 tests pass, 0 fail |
| C5 | Web production build succeeds | READY | Build outputs to `apps/web/dist` |
| C6 | Deployment config validation passes | READY | 12 tests pass, 0 fail |
| C7 | CI workflow triggers correctly | READY | PR and push to `main` |
| C8 | Worker deploy workflow targets `production` environment | READY | `environment: production` in deploy-worker.yml |
| C9 | No secrets hardcoded in source | READY | Scan confirmed no secrets in source files |

---

## Security Validation

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| S1 | CORS single-origin allowlist | READY | `ALLOWED_ORIGIN` enforced |
| S2 | Security headers present | READY | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` |
| S3 | Request body size limit (1 MB) | READY | 413 `REQUEST_TOO_LARGE` for oversized bodies |
| S4 | Fail-closed authentication | READY | `503 AUTH_ADAPTER_NOT_CONFIGURED` when identity off |
| S5 | Server-side role resolution | READY | Roles from MyGeotab user record only |
| S6 | Tenant isolation | READY | `GEOTAB_DATABASE` server-configured, client header ignored |
| S7 | IDOR prevention | READY | `canViewBooking`, `canCancelBooking` enforced |
| S8 | Driver data isolation | READY | Relationship-based (assignedDriverUserId) |
| S9 | No secrets in frontend bundle | READY | Build verified clean |
| S10 | Audit append-only | READY | Audit records never modified/deleted |

---

## Architecture Constraints

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| A1 | MyGeotab AddInData is only persistent storage | READY | No PostgreSQL, D1, KV, etc. |
| A2 | Cloudflare Worker is API runtime only | READY | wrangler.toml has no database bindings |
| A3 | Schema v2 preserved | READY | `schemaVersion: 2` on all records |
| A4 | Legacy schema v1 compatibility | READY | normalize functions handle v1 records |
| A5 | Single JSON serialization boundary | READY | No double-serialization |
| A6 | 10,000-character record limit | READY | Enforced before AddInData write |
| A7 | Idempotency keys | READY | `Idempotency-Key` header supported |
| A8 | Version-based concurrency | READY | `BOOKING_VERSION_CONFLICT` on conflict |

---

## Deployment Steps (Production)

When all prerequisites are READY:

1. **Merge approved feature branch to `main`**
   - CI runs automatically (ci.yml)
   - All checks must pass

2. **Worker deployment**
   - GitHub Actions `deploy-worker.yml` triggers on push to `main`
   - Requires `production` environment approval
   - `npx wrangler deploy` from `apps/api/`
   - Record deployment ID for rollback

3. **Frontend deployment**
   - GitHub Actions `deploy-pages.yml` triggers on push to `main`
   - Deploys to GitHub Pages
   - Set `VITE_API_BASE_URL` variable if Worker URL changed

4. **Post-deployment verification**
   - `GET /api/health` returns `"ok":true`
   - CORS rejects disallowed origins
   - Protected routes return `503` when identity disabled
   - Frontend loads without console errors

---

## Rollback Procedure

| Component | Method | Command |
|-----------|--------|---------|
| Frontend | Re-run previous Pages deployment | GitHub Actions re-run or revert commit |
| API Worker | Roll back Worker version | `npx wrangler rollback <deployment-id>` |
| Configuration | Revert wrangler.toml | `git checkout <commit> -- apps/api/wrangler.toml` |
| AddInData records | NOT rolled back | Manual MyGeotab intervention required |

**Critical:** AddInData records (bookings, audits) are append-only and persistent. Rollback does NOT affect them.

---

## Sign-Off

Production deployment requires explicit sign-off from:

- [ ] Release Manager
- [ ] DevOps Engineer
- [ ] Application Security Engineer
- [ ] Geotab Tenant Administrator

**Current status: BLOCKED** — P1–P7 prerequisites not met. Do not deploy to production.
