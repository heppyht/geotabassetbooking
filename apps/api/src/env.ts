/**
 * Worker environment. Where each value comes from:
 *
 *  APP_ENV, ALLOWED_ORIGIN, GEOTAB_DATABASE
 *      Plain, non-secret [vars] in wrangler.toml (override locally in .dev.vars).
 *  IDENTITY_ADAPTER_CONFIGURED
 *      Fail-closed switch. Leave unset or "false" until MyGeotab session
 *      verification has been validated against GEOTAB_DATABASE.
 *
 * No PostgreSQL, no Hyperdrive, no DATABASE_URL. All persistent data lives
 * in MyGeotab AddInData and is accessed via the MyGeotab REST API.
 */
export type Env = {
  /** "personal-test" when deployed; "development" locally (exposes error messages). */
  APP_ENV: string;
  /** Exact frontend origin (scheme + lowercase host, no path), e.g. https://heppyh.github.io */
  ALLOWED_ORIGIN: string;
  /** MyGeotab database sessions are accepted for: opex_trial. Never taken from the client. */
  GEOTAB_DATABASE: string;
  /** Must remain unset or "false" until identity verification is validated. */
  IDENTITY_ADAPTER_CONFIGURED?: string;
};
