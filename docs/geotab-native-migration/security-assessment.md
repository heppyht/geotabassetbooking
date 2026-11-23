# Security Assessment — OPEX Asset Booking Geotab-Native Migration

## Scope
- Authentication: MyGeotab session verification via REST API
- Authorization: Default-deny PermissionPolicy with role-based access control
- Data isolation: Driver-scoped booking visibility, client-side filtering
- Audit: Append-only audit events with actor attribution
- Concurrency: Version-based optimistic concurrency (best-effort, not atomic)

## Roles Supported
| Role | Permissions |
|---|---|
| Admin | Full access: view all, modify any, cancel any, approve, assign |
| Management | View all, modify any, cancel any, approve |
| Approver | View all, modify any, approve (not self), cannot assign/cancel another's |
| GA (Booking Coordinator) | View all, modify any, assign, cannot approve/cancel another's |
| Employee | View own bookings, create bookings, cancel own |
| Driver | View own assigned bookings only |

## Default Deny
Every permission check in `PermissionPolicy` starts with `allowed: false`. Access is granted only when an explicit rule matches. UI-hidden buttons are NOT sufficient — all checks are validated in domain services.

## Identity Resolution
- Authenticated identity resolved from MyGeotab session context (`geotab.addin.getSession()` + `api.call("Get", { typeName: "User", ... })`)
- Fail-closed: unresolved identity blocks all writes in LIVE mode
- Unknown MyGeotab roles default to EMPLOYEE (no silent elevation)
- Session database must match configured `GEOTAB_DATABASE` (tenant isolation)
- Client-supplied `x-geotab-database` header is never trusted

## Driver Isolation
- `driverScopeFilter()` returns the driver's userId when role is "DRIVER", null otherwise
- `validateDriverMapping(driverId)` returns false if driverId doesn't match authenticated principal
- Driver can only view bookings where `assignedDriverUserId === principal.appUserId` OR `requesterUserId === principal.appUserId`
- Driver assignment is optional; `assignedDriverUserId` may be null
- If asset has no default driver, `driverId` is left empty

## Audit
- Append-only audit events: one AddInData record per audit event (never modified)
- Audit fields: id, booking_id, eventId, eventType, actor_user_id, previous_status, new_status, changes, details, created_at, schemaVersion
- Unique eventId per action (deterministic hash of bookingId + action + actor + statuses + minute bucket)
- Idempotent audit writes: skip if eventId already exists
- `findAuditGaps()` reconciliation detects bookings missing audit events

## Concurrency Limitations (Documented)
- AddInData check-then-Set is **not atomic**
- No atomic locking, exactly-once writes, or guaranteed prevention of concurrent double bookings
- Version-based optimistic concurrency detects stale updates (`BOOKING_VERSION_CONFLICT`)
- Residual race conditions remain possible for concurrent writes
- Concurrency tests verify version conflict detection but cannot prevent all races

## Blocking Security Findings
1. **AddInData cannot enforce server-side data isolation**: All filtering is client-side after full-collection scan. A compromised or malicious client could bypass client-side filters. If AddInData access cannot enforce required isolation, this is a blocking security finding.

2. **No server-side enforcement of driver-to-user mapping**: `validateDriverMapping()` is client-side only. Server-side enforcement would require AddInData query capabilities that are not verified.

## Test Coverage (Security)
| Test File | Tests | Result |
|---|---|---|
| `apps/web/test/security-rbac.test.mjs` | 44 | Passed |
| `apps/api/test/security.test.mjs` | Included in 234 API tests | Passed |

Security tests cover: unauthorized access, cross-driver access, role escalation, invalid driver mapping, self-approval prohibition, default deny, role-based access boundaries.
