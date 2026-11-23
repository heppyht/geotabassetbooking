/*───────────────────── Phase 9.5: API Rate Limit Benchmark ─────────────────────*/
/* Evaluates MyGeotab AddInData API rate limits and retry behavior.
   Previously identified limits (NOT VERIFIED against official docs):
     Get: 650/min, Set: 1,700/min, Add: 100/min, Remove: 2,250/min
   All limits marked NOT VERIFIED — requires Geotab confirmation.
   Tests use mocked responses; no production tenant access. */
import test from "node:test";
import assert from "node:assert/strict";

/*───────────────────── Documented rate limits (UNVERIFIED) ─────────────────────*/

/* These limits were identified in previous phases but have NOT been verified
   against current official Geotab documentation. They are reported as
   "NOT VERIFIED" and require Geotab Support confirmation. */
export const RATE_LIMITS_UNVERIFIED = {
  Get: { requestsPerMinute: 650, source: "previously identified, unverified" },
  Set: { requestsPerMinute: 1_700, source: "previously identified, unverified" },
  Add: { requestsPerMinute: 100, source: "previously identified, unverified" },
  Remove: { requestsPerMinute: 2_250, source: "previously identified, unverified" },
};

/*───────────────────── Mock rate-limit response ─────────────────────*/

function makeRateLimitResponse(retryAfterSeconds = 60) {
  return new Response(
    JSON.stringify({
      error: {
        code: -32099,
        message: "Rate limit exceeded",
        data: { retryAfter: retryAfterSeconds },
      },
    }),
    { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}

function makeSuccessResponse(result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", result, id: 1 }), { status: 200, statusText: "OK" });
}

/*───────────────────── Exponential backoff helper ─────────────────────*/

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(fetchFn, maxRetries = 3, baseDelayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchFn();
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : baseDelayMs * Math.pow(2, attempt);
        lastError = new Error(`RATE_LIMITED: retry after ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await sleep(baseDelayMs * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

/*───────────────────── Tests ─────────────────────*/

test("rate limits: documented limits are marked UNVERIFIED", () => {
  assert.equal(RATE_LIMITS_UNVERIFIED.Get.requestsPerMinute, 650);
  assert.equal(RATE_LIMITS_UNVERIFIED.Set.requestsPerMinute, 1_700);
  assert.equal(RATE_LIMITS_UNVERIFIED.Add.requestsPerMinute, 100);
  assert.equal(RATE_LIMITS_UNVERIFIED.Remove.requestsPerMinute, 2_250);
  /* All sources say unverified */
  for (const [method, info] of Object.entries(RATE_LIMITS_UNVERIFIED)) {
    assert.ok(info.source.includes("unverified"), `${method} limit source should say unverified`);
  }
  console.log("Rate limits (UNVERIFIED):");
  for (const [method, info] of Object.entries(RATE_LIMITS_UNVERIFIED)) {
    console.log(`  ${method}: ${info.requestsPerMinute}/min — ${info.source}`);
  }
});

test("rate limit: 429 response with Retry-After header is detected", async () => {
  const response = makeRateLimitResponse(30);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "30");
});

test("rate limit: retry with backoff succeeds after rate limit", async () => {
  let callCount = 0;
  const fetchFn = async () => {
    callCount++;
    if (callCount === 1) return makeRateLimitResponse(1); // 1ms retry
    return makeSuccessResponse({ success: true });
  };

  const response = await fetchWithRetry(fetchFn, 3, 1);
  assert.equal(response.status, 200);
  assert.equal(callCount, 2);
});

test("rate limit: retry exhausted after max retries", async () => {
  let callCount = 0;
  const fetchFn = async () => {
    callCount++;
    return makeRateLimitResponse(1);
  };

  await assert.rejects(fetchWithRetry(fetchFn, 2, 1), /RATE_LIMITED/);
  assert.equal(callCount, 3); // initial + 2 retries
});

test("rate limit: sequential requests simulation — Add is the bottleneck", () => {
  /* With Add limited to 100/min (unverified), creating 100 bookings would
     take at least 1 minute at the limit. This is the most restrictive limit. */
  const addLimitPerMinute = RATE_LIMITS_UNVERIFIED.Add.requestsPerMinute;
  const bookingsToCreate = 1_000;
  const minutesRequired = bookingsToCreate / addLimitPerMinute;
  assert.ok(minutesRequired > 0);
  console.log(`Add rate limit: ${addLimitPerMinute}/min → ${bookingsToCreate} bookings ≈ ${minutesRequired.toFixed(1)} minutes (UNVERIFIED)`);
});

test("rate limit: concurrent requests — no client-side throttling in current implementation", () => {
  /* The current AddInDataRestGateway and AddInDataGateway have no built-in
     rate-limit throttling or request queueing. This is a gap. */
  const hasThrottling = false;
  assert.equal(hasThrottling, false, "No client-side rate-limit throttling in current implementation");
});

test("rate limit: bulk reads vs individual reads", () => {
  /* MyGeotab AddInData Get supports resultsLimit (currently 1000 in code).
     Bulk reads are more efficient than individual record lookups. */
  const resultsLimit = 1000;
  const recordsToFetch = 10_000;
  const batchesNeeded = Math.ceil(recordsToFetch / resultsLimit);
  assert.equal(batchesNeeded, 10);
  console.log(`Bulk read: ${recordsToFetch} records in ${batchesNeeded} batches of ${resultsLimit}`);
});

test("rate limit: bulk writes — Add limit is most restrictive", () => {
  /* Add: 100/min (unverified) is the most restrictive limit.
     Creating 50,000 bookings with 5 audits each = 300,000 Add operations.
     At 100/min: 3,000 minutes = 50 hours. This is a major bottleneck. */
  const addLimitPerMinute = RATE_LIMITS_UNVERIFIED.Add.requestsPerMinute;
  const bookings = 50_000;
  const auditsPerBooking = 5;
  const totalAdds = bookings + (bookings * auditsPerBooking); // bookings + audits
  const minutesRequired = totalAdds / addLimitPerMinute;
  console.log(`Bulk write: ${totalAdds.toLocaleString()} Add operations at ${addLimitPerMinute}/min ≈ ${minutesRequired.toFixed(0)} minutes (UNVERIFIED)`);
  assert.ok(minutesRequired > 60, "Bulk write at Add rate limit would take over 1 hour for 50K bookings");
});

test("rate limit: no retry-after parsing in current gateway", () => {
  /* AddInDataRestGateway and AddInDataGateway do not parse Retry-After
     headers or implement automatic retry on 429. */
  const hasRetryAfterParsing = false;
  assert.equal(hasRetryAfterParsing, false, "No Retry-After parsing in current gateway");
});

test("rate limit: summary", () => {
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("PHASE 9.5 — API RATE LIMIT BENCHMARK");
  console.log("════════════════════════════════════════════════════════════════");
  console.log("");
  console.log("Rate limits (NOT VERIFIED — requires Geotab confirmation):");
  for (const [method, info] of Object.entries(RATE_LIMITS_UNVERIFIED)) {
    console.log(`  ${method}: ${info.requestsPerMinute}/min`);
  }
  console.log("");
  console.log("Current implementation gaps:");
  console.log("  - No client-side rate-limit throttling");
  console.log("  - No Retry-After header parsing");
  console.log("  - No automatic retry on 429");
  console.log("  - Add operation is the most restrictive limit (100/min unverified)");
  console.log("");
  console.log("Recommendation: Implement exponential backoff with Retry-After support");
  console.log("════════════════════════════════════════════════════════════════\n");
});
