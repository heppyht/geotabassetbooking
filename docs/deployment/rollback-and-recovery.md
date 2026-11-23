# Rollback and Recovery — OPEX Asset Booking

This document describes how to roll back the Geotab Asset Booking application
to a previous known-good state. It covers frontend, API Worker, and
configuration rollback.

## Architecture constraint

MyGeotab AddInData is the ONLY persistent application storage. Application
rollback must NOT assume that AddInData records can be rolled back
automatically. Do not delete or overwrite production booking or audit records
during rollback. Audit records are append-only and must remain intact.

---

## Frontend rollback (GitHub Pages)

The frontend is hosted on GitHub Pages via the `deploy-pages.yml` workflow.
Each successful deployment is tied to a specific GitHub commit.

### Procedure

1. Identify the last known-good commit (e.g., from the GitHub Actions run
   history or `git log`).
2. Re-run the "Deploy web to GitHub Pages" workflow for that commit, or
   revert the offending commit and push to `main` (which triggers the
   workflow automatically).
3. Verify the site at `https://heppyh.github.io/opexassetbooking/`.

### Validation after rollback

- Assets load with no 404s in the browser console.
- The UI renders without errors.
- The status card shows the expected backend connection state.
- No fabricated vehicle or booking data appears.

---

## API Worker rollback (Cloudflare Workers)

The API is deployed as a Cloudflare Worker named `opex-vbm-api`.
Cloudflare Workers keeps a deployment history that can be rolled back.

### Procedure

1. List available deployments:
   ```bash
   npx wrangler deployments list
   ```
   Run from `apps/api/` after `wrangler login`.

2. Roll back to the previous deployment:
   ```bash
   npx wrangler rollback <deployment-id>
   ```
   Replace `<deployment-id>` with the ID of the known-good deployment.

3. Verify the rollback:
   ```bash
   curl -s https://opex-vbm-api.<account-subdomain>.workers.dev/api/health
   ```
   Expected response includes `"ok":true` and the expected `version`.

4. Verify critical operations:
   - `GET /api/me` with a valid session returns the principal (or `503`
     if `IDENTITY_ADAPTER_CONFIGURED` is not `"true"`).
   - AddInData read operations work (`GET /api/bookings`).
   - No errors in Worker logs.

### What rollback does NOT affect

- AddInData records in MyGeotab are untouched by Worker rollback.
- Booking and audit records remain append-only.
- No data is deleted or overwritten.

---

## Configuration rollback

### Worker environment variables (`wrangler.toml`)

`wrangler.toml` is version-controlled. To roll back configuration:

1. Revert the `wrangler.toml` change in git:
   ```bash
   git checkout <previous-commit> -- apps/api/wrangler.toml
   ```
2. Redeploy the Worker:
   ```bash
   npx wrangler deploy
   ```

### `.dev.vars` (local only)

`.dev.vars` is git-ignored and never committed. If local configuration is
corrupted, restore from `apps/api/.dev.vars.example` and set only local
values.

### Secrets

Cloudflare secrets (e.g., `CLOUDFLARE_API_TOKEN` in GitHub Actions) are
managed in the GitHub repository settings or Cloudflare dashboard. They are
never printed in logs or committed to the repository. If a secret is
suspected to be compromised, rotate it in the Cloudflare dashboard and
update GitHub Actions secrets accordingly.

---

## AddInData records (MyGeotab)

AddInData records are stored in the customer's MyGeotab database
(`opex_trial`). They are NOT part of the application deployment and cannot
be rolled back by reverting code.

- Booking records: current state only. Reverting the Worker code does not
  revert booking states.
- Audit records: append-only. Never delete or modify audit records.
- If a bad deployment corrupts booking data, recovery requires manual
  intervention in the MyGeotab tenant, not a code rollback.

---

## Recovery checklist

After any rollback:

- [ ] `GET /api/health` returns `"ok":true`.
- [ ] Protected routes return `503 AUTH_ADAPTER_NOT_CONFIGURED` when
      `IDENTITY_ADAPTER_CONFIGURED` is not `"true"`.
- [ ] CORS rejects origins other than `ALLOWED_ORIGIN` with `403`.
- [ ] AddInData read operations succeed.
- [ ] No secret values appear in Worker logs or git diff.
- [ ] Frontend loads without console errors.
