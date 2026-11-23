/*───────────────────── MyGeotab Session Auth (no SQL) ─────────────────────*/
/* Replaces the PostgreSQL-backed identity mapping layer. Principal resolution
   now verifies the MyGeotab session via the REST API and derives the principal
   from the verified user. No identity_mappings, no role_assignments tables.
   All authenticated users default to EMPLOYEE role. Elevated roles
   (APPROVER, GA, MANAGEMENT, ADMIN) are resolved from the verified MyGeotab
   user record's `role` field and require administrator-managed configuration
   in MyGeotab. There is no application-side role store.
   DRIVER is an application-level role determined by data relationship
   (assignedDriverUserId on bookings), not assigned at authentication time.
   No postgres, no external database. */

import type { MiddlewareHandler } from "hono";
import type { Env } from "./env.ts";
import { createGateway, type GeotabCredentials } from "./db.ts";
import type { GeotabSessionVerification } from "./integrations/mygeotab/types.ts";

export type AppRole = "EMPLOYEE" | "APPROVER" | "GA" | "MANAGEMENT" | "ADMIN" | "DRIVER";
export type Principal = { appUserId: string; geotabUserId: string; roles: AppRole[]; siteIds: string[] };

declare module "hono" {
  interface ContextVariableMap { principal: Principal }
}

const HEADER_SESSION_ID = "x-geotab-session-id";
const HEADER_USER_NAME = "x-geotab-user-name";

/* MyGeotab user role -> AppRole mapping. Only known roles are mapped;
   anything else defaults to EMPLOYEE (fail closed, no elevation). */
const MYGEOTAB_ROLE_MAP: Record<string, AppRole> = {
  EMPLOYEE: "EMPLOYEE",
  APPROVER: "APPROVER",
  GA: "GA",
  MANAGEMENT: "MANAGEMENT",
  ADMIN: "ADMIN",
};

export function extractGeotabCredentials(request: Request): GeotabCredentials | null {
  const sessionId = request.headers.get(HEADER_SESSION_ID) ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const userName = request.headers.get(HEADER_USER_NAME);
  const database = request.headers.get("x-geotab-database") ?? "";

  if (!sessionId || !userName) return null;

  return { userName, database, sessionId };
}

export async function resolveVerifiedPrincipal(
  request: Request,
  env: Env,
): Promise<Principal | null> {
  // Fail closed: identity adapter not configured.
  if (env.IDENTITY_ADAPTER_CONFIGURED !== "true") return null;

  const credentials = extractGeotabCredentials(request);
  if (!credentials) return null;

  /* Tenant isolation: never accept a client-supplied database override.
     The gateway always uses the server-configured GEOTAB_DATABASE. */
  const database = env.GEOTAB_DATABASE;
  const gateway = createGateway({ userName: credentials.userName, database, sessionId: credentials.sessionId });

  let verification: { valid: boolean; database: string; userName: string; role?: string };
  try {
    verification = await gateway.verifySession({ userName: credentials.userName, database, sessionId: credentials.sessionId });
  } catch {
    return null;
  }

  if (!verification?.valid) return null;
  if (verification.database !== env.GEOTAB_DATABASE) return null;

  /* Resolve role from the verified MyGeotab user record. Fail closed to
     EMPLOYEE when the role is unknown or absent — never elevate silently. */
  const resolvedRole = verification.role ? MYGEOTAB_ROLE_MAP[verification.role] : undefined;
  const roles = resolvedRole ? [resolvedRole] : (["EMPLOYEE"] as AppRole[]);

  return {
    appUserId: verification.userName,
    geotabUserId: verification.userName,
    roles,
    siteIds: [],
  };
}

export const requirePrincipal: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const principal = await resolveVerifiedPrincipal(c.req.raw, c.env);
  if (!principal) return c.json({
    error: "AUTH_ADAPTER_NOT_CONFIGURED",
    message: "Protected endpoints are disabled until verified identity is implemented."
  }, 503);
  c.set("principal", principal);
  await next();
};

export function requireRole(...allowed: AppRole[]): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const p = c.get("principal");
    if (!p || !p.roles.some(r => allowed.includes(r))) {
      return c.json({ error: "FORBIDDEN" }, 403);
    }
    await next();
  };
}
