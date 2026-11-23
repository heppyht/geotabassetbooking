/*───────────────────── MyGeotab Rate-Limit Handling ─────────────────────*/
/* Centralized error classification and retry strategy for MyGeotab REST
   AddInData operations.

   Architecture constraints:
   - MyGeotab AddInData remains the ONLY persistent storage.
   - No PostgreSQL, D1, Neon, Supabase, Firebase, Redis, MongoDB, Cloudflare KV.
   - Cloudflare Worker is API runtime only.

   Live MyGeotab throttling behavior is UNVERIFIED. This implementation is
   designed to be extensible: error classification can be refined once live
   tenant validation is complete.

   Do not claim a retry guarantees successful execution.
   Do not retry authentication failures, permission failures, validation
   errors, version conflicts, or permanent application errors.
   Only retry errors classified as transient (rate limit, network timeout,
   temporary network failure).
   */

import type { AddInDataRestGateway } from "./db.ts";

/*───────────────────── Error Classification ─────────────────────*/

export type ErrorCategory =
  | "rate_limit"
  | "network_timeout"
  | "temporary_network_failure"
  | "authentication_failure"
  | "permission_error"
  | "validation_error"
  | "concurrency_conflict"
  | "permanent_api_error"
  | "unknown";

export interface ClassifiedError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly method?: string;
  readonly statusCode?: number;
}

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
  maxTotalDurationMs: number;
  jitter: boolean;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 500,
  backoffMultiplier: 2,
  maxDelayMs: 5000,
  maxTotalDurationMs: 30000,
  jitter: true,
};

function jitteredDelay(baseMs: number): number {
  const jitter = baseMs * 0.2; // ±20% jitter
  return Math.max(0, baseMs + (Math.random() * 2 - 1) * jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/*───────────────────── Classification ─────────────────────*/

/* Classify an error thrown by the MyGeotab REST AddInData gateway or the
   TenantValidatedMyGeotabAdapter. The exact shape of MyGeotab throttling
   responses is UNVERIFIED against live tenant data; this implementation
   handles the known signals (HTTP 429, Retry-After header, JSON-RPC error
   messages containing "rate" or "limit") and is designed to be extended.

   Errors are classified as retryable only when the failure is transient.
   Authentication, permission, validation, concurrency, and permanent errors
   are never retried.
   */
export function classifyError(error: unknown): ClassifiedError {
  const base: ClassifiedError = error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        category: "unknown",
        retryable: false,
      }
    : {
        name: "UnknownError",
        message: String(error),
        category: "unknown",
        retryable: false,
      };

  const message = base.message;
  const upperMsg = message.toUpperCase();

  /* HTTP 429 from fetch — rate limit / throttling */
  if (upperMsg.includes("MYGEOTAB_HTTP_ERROR: 429")) {
    return {
      ...base,
      category: "rate_limit",
      retryable: true,
      method: undefined,
      statusCode: 429,
    };
  }

  /* Extract Retry-After from JSON-RPC error data or HTTP error message */
  const retryAfterMatch = message.match(/retry.?after.?[:=]\s*(\d+)/i);
  const retryAfterMs = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) * 1000 : undefined;

  /* JSON-RPC error messages suggesting throttling (UNVERIFIED signal) */
  if (
    upperMsg.includes("RATE LIMIT") ||
    upperMsg.includes("THROTTL") ||
    upperMsg.includes("TOO MANY REQUESTS") ||
    upperMsg.includes("RATE_LIMIT_EXCEEDED")
  ) {
    return {
      ...base,
      category: "rate_limit",
      retryable: true,
      retryAfterMs,
      statusCode: 429,
    };
  }

  /* HTTP 5xx or network-level temporary failures */
  const httpMatch = message.match(/MYGEOTAB_HTTP_ERROR:\s*(\d{3})/);
  if (httpMatch) {
    const status = parseInt(httpMatch[1], 10);
    if (status >= 500 && status < 600) {
      return {
        ...base,
        category: "temporary_network_failure",
        retryable: true,
        retryAfterMs,
        statusCode: status,
      };
    }
    if (status === 429) {
      return {
        ...base,
        category: "rate_limit",
        retryable: true,
        retryAfterMs,
        statusCode: 429,
      };
    }
    if (status === 401 || status === 403) {
      return {
        ...base,
        category: status === 401 ? "authentication_failure" : "permission_error",
        retryable: false,
        statusCode: status,
      };
    }
    if (status === 400) {
      return {
        ...base,
        category: "validation_error",
        retryable: false,
        statusCode: status,
      };
    }
    return {
      ...base,
      category: "permanent_api_error",
      retryable: false,
      statusCode: status,
    };
  }

  /* Network timeout / fetch failure */
  if (
    upperMsg.includes("FETCH") ||
    upperMsg.includes("NETWORK") ||
    upperMsg.includes("TIMEOUT") ||
    upperMsg.includes("ECONNREFUSED") ||
    upperMsg.includes("ENOTFOUND")
  ) {
    return {
      ...base,
      category: "temporary_network_failure",
      retryable: true,
      retryAfterMs,
    };
  }

  /* Known non-retryable application errors */
  const nonRetryable = [
    "BOOKING_NOT_FOUND",
    "BOOKING_NOT_APPROVED",
    "VEHICLE_NOT_AVAILABLE",
    "VEHICLE_TIME_CONFLICT",
    "VEHICLE_ON_HOLD",
    "BOOKING_VERSION_CONFLICT",
    "INVALID_TRANSITION",
    "ADDIN_DATA_DETAILS_EXCEEDED",
    "ADDIN_ID_NOT_CONFIGURED",
    "ADDIN_ID_INVALID",
    "GEOTAB_ADAPTER_NOT_IMPLEMENTED",
    "AUTH_ADAPTER_NOT_CONFIGURED",
    "FORBIDDEN",
    "ORIGIN_NOT_ALLOWED",
  ];
  if (nonRetryable.some(code => upperMsg.includes(code))) {
    let category: ErrorCategory = "permanent_api_error";
    if (upperMsg.includes("VERSION_CONFLICT")) category = "concurrency_conflict";
    else if (upperMsg.includes("INVALID_TRANSITION")) category = "concurrency_conflict";
    else if (upperMsg.includes("NOT_FOUND")) category = "permanent_api_error";
    else if (upperMsg.includes("DETAILS_EXCEEDED")) category = "validation_error";
    else if (upperMsg.includes("NOT_CONFIGURED") || upperMsg.includes("INVALID")) category = "validation_error";
    else if (upperMsg.includes("FORBIDDEN")) category = "permission_error";
    else if (upperMsg.includes("NOT_IMPLEMENTED")) category = "permanent_api_error";
    return {
      ...base,
      category,
      retryable: false,
      retryAfterMs,
    };
  }

  return base;
}

/*───────────────────── Retry Utility ─────────────────────*/

export interface RetryResult<T> {
  value: T;
  attempts: number;
  retried: boolean;
  totalDelayMs: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  onClassifiedError?: (error: ClassifiedError, attempt: number) => void,
): Promise<RetryResult<T>> {
  let attempts = 0;
  let retried = false;
  let totalDelayMs = 0;
  const startTime = Date.now();

  while (true) {
    attempts += 1;
    try {
      const value = await fn();
      return { value, attempts, retried, totalDelayMs };
    } catch (rawError) {
      const classified = classifyError(rawError);

      /* Non-retryable: throw immediately */
      if (!classified.retryable) {
        throw classified;
      }

      /* Check attempt limit */
      if (attempts >= config.maxAttempts) {
        throw classified;
      }

      /* Check total duration limit */
      const elapsed = Date.now() - startTime;
      if (elapsed >= config.maxTotalDurationMs) {
        throw classified;
      }

      /* Compute delay: server-provided Retry-After takes precedence */
      let delayMs: number;
      if (classified.retryAfterMs !== undefined) {
        delayMs = classified.retryAfterMs;
      } else {
        const exponential = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempts - 1);
        delayMs = Math.min(exponential, config.maxDelayMs);
        if (config.jitter) {
          delayMs = jitteredDelay(delayMs);
        }
      }

      totalDelayMs += delayMs;
      retried = true;

      onClassifiedError?.(classified, attempts);

      await sleep(delayMs);
    }
  }
}

/*───────────────────── Gateway Retry Wrapper ─────────────────────*/

/* Wraps an AddInDataRestGateway method with retry logic. Read operations
   (search, get) are safe to retry. Write operations (add, set, remove) must
   only be retried when the caller has confirmed write safety — see
   idempotency analysis in docs/technical/rate-limit-handling-design.md.

   This wrapper does NOT retry write operations by default. Callers that need
   retryable writes must use withIdempotentWrite() instead.
   */
export function withGatewayRetry<T>(
  gateway: AddInDataRestGateway,
  methodName: "searchAddInData" | "getDevices" | "getUsers" | "verifySession",
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): (args: unknown[]) => Promise<T> {
  return async (args: unknown[]): Promise<T> => {
    const fn = () => {
      const method = gateway[methodName as keyof AddInDataRestGateway] as (...a: unknown[]) => Promise<T>;
      return method(...args);
    };
    const result = await withRetry(fn, config);
    return result.value;
  };
}

export { sleep };
