export function createPublicRouteProbeRequestLedger(context, { prefix = "route-probe-public-api-request" } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(prefix)) {
    throw new Error("invalid public route-probe artifact prefix");
  }
  if (typeof context?.writeArtifactJsonInternal !== "function" || typeof context?.addCleanup !== "function") {
    throw new TypeError("a RunContext is required to record public route-probe requests");
  }

  const requests = [];
  let finalized = false;

  function snapshot() {
    const methodCounts = {};
    for (const request of requests) methodCounts[request.method] = (methodCounts[request.method] ?? 0) + 1;
    return {
      requestCount: requests.length,
      methodCounts,
      order: requests.map(({ gateway, method, status }) => ({ gateway, method, status })),
    };
  }

  async function record({ gateway, routeFingerprint, method, path, requestStartedAt, elapsedMs, status, errorCategory = null }) {
    if (finalized) throw new Error("public route-probe request ledger is already finalized");
    const sequence = requests.length + 1;
    const request = {
      sequence,
      gateway,
      routeFingerprint,
      transport: "public-exact-g-route",
      method,
      path,
      requestStartedAt,
      elapsedMs,
      status,
      errorCategory,
      requestPayloadValuesStored: false,
      automaticRequestRetry: false,
    };
    requests.push(request);
    await context.writeArtifactJsonInternal(`${prefix}-${String(sequence).padStart(3, "0")}.json`, request);
    return request;
  }

  async function finalize() {
    if (finalized) return;
    finalized = true;
    await context.writeArtifactJsonInternal(`${prefix}-ledger-final.json`, {
      scope: "route-probe /g API requests only; excludes control WebSockets and root-readiness checks",
      ...snapshot(),
      automaticRequestRetry: false,
      requests,
    });
  }

  // Registered before the route's session cleanup callbacks so LIFO finalization
  // captures their DELETE result as the final immutable ledger entry.
  context.addCleanup(`${prefix}-finalize`, finalize);
  return Object.freeze({ record, snapshot, finalize });
}
