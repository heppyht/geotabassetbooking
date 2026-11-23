# Rollback Plan — OPEX Asset Booking Geotab-Native Migration

## Rollback Trigger
Any of the following conditions warrants rollback:
- Client-side parity not demonstrated after frontend migration to domain/service/repository layer
- Security assessment identifies unmitigable blocking findings
- AddInData cannot enforce required data isolation
- Production tenant data integrity at risk
- Geotab Add-In registration fails validation

## Rollback Path

### 1. Hono API Remains Available
The existing Hono API implementation (`apps/api/src/index.ts`) is **unchanged**. No endpoints were removed, modified, or deprecated. The Hono backend remains fully operational and can handle all booking workflows.

### 2. Frontend Rollback
If the frontend migration to client-side AddInData access causes issues:
- Revert `apps/web/src/data/dataProvider.ts` to use `LocalBookingDataProvider` (demo mode) or Hono API calls
- Revert `apps/web/src/ui/App.tsx` to use the previous data provider
- The `LocalBookingDataProvider` (localStorage demo mode) remains intact as a fallback

### 3. Domain/Service/Repository Rollback
New files created during this migration can be removed without affecting existing functionality:
- `apps/web/src/domain/` — new directory (safe to remove)
- `apps/web/src/security/` — new directory (safe to remove)
- `apps/web/src/geotab/` — new directory (safe to remove)
- `apps/web/src/repositories/` — new directory (safe to remove)
- `apps/web/src/services/` — new directory (safe to remove)
- `apps/web/test/security-rbac.test.mjs` — new test file (safe to remove)
- `apps/web/test/audit-concurrency.test.mjs` — new test file (safe to remove)

No existing files were modified. All existing code paths remain intact.

### 4. Configuration Rollback
`geotab/opex-vbm-config.json` was updated with `files` and `embed` blocks. These are additive — the original `items` array with the external URL is preserved. Rollback by removing the `files` and `embed` blocks.

### 5. Data Safety
- No production tenant data was modified
- No database migrations were run
- AddInData records created during testing are test-only and do not affect production
- Existing AddInData records (schema v1 and v2) remain readable and unchanged

## Rollback Decision Authority
Rollback requires:
1. Verified test failure in client-side domain/service/repository layer
2. OR confirmed security blocking finding
3. OR confirmed AddInData data isolation limitation

No rollback is required at this time — all tests pass and the Hono implementation remains available.

## Post-Rollback Verification
After rollback:
1. Re-run `npm test` in `apps/api/` — expect 234/234 pass
2. Re-run `npm test` in `apps/web/` — expect 155/155 pass (pre-migration count)
3. Re-run `npx tsc --noEmit` in both `apps/api/` and `apps/web/` — expect 0 errors
4. Verify Hono API endpoints respond correctly
