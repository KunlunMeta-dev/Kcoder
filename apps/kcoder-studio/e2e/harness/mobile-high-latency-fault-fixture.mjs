import { createHash } from "node:crypto";

const sha256 = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

/** Sum explicitly configured HTTP/WSS response-path delay terms without NaN coercion. */
export function sumResponseDelayMs(...terms) {
  let total = 0;
  for (const [index, term] of terms.entries()) {
    if (term === undefined) continue;
    if (!Number.isFinite(term) || term < 0)
      throw new RangeError(`response delay term ${index} must be a finite non-negative number`);
    total += term;
  }
  if (!Number.isFinite(total)) throw new RangeError("combined response delay must be finite");
  return total;
}

/** Deterministic application-response jitter; values are added to the base delay, not RTT. */
export function createResponseJitter(sequences = {}) {
  const cursors = new Map();
  return {
    next(layer, key) {
      const sequence = sequences?.[layer]?.[key];
      if (!Array.isArray(sequence) || sequence.length === 0) return { sampleIndex: null, delayMs: 0 };
      const cursorKey = `${layer}:${key}`;
      const sampleIndex = cursors.get(cursorKey) ?? 0;
      cursors.set(cursorKey, sampleIndex + 1);
      const delayMs = sequence[sampleIndex % sequence.length];
      if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error(`invalid response jitter value for ${cursorKey}`);
      return { sampleIndex, delayMs };
    },
    counts() {
      return Object.fromEntries([...cursors.entries()].sort(([left], [right]) => left.localeCompare(right)));
    },
  };
}

/**
 * Test-only receipt ledger. It records acceptance only after observing the
 * isolated mock Gateway's actual successful turn/start response, then serves
 * readback only for that exact thread/clientMessageId pair.
 */
export function createAcceptedTurnReceiptFixture() {
  const accepted = new WeakMap();
  const requestCounts = new WeakMap();
  const scopeFingerprints = new WeakMap();
  let acceptedCount = 0;
  let readCount = 0;
  let mismatchCount = 0;
  let turnStartRequestCount = 0;
  let duplicatePairRequestCount = 0;
  let invalidScopeCount = 0;
  let nextScopeFingerprint = 0;
  const acceptedRows = [];

  const requireScope = scope => {
    if (!scope || typeof scope !== "object") {
      invalidScopeCount += 1;
      return null;
    }
    let fingerprint = scopeFingerprints.get(scope);
    if (!fingerprint) {
      fingerprint = sha256(`fault-scope-${++nextScopeFingerprint}`);
      scopeFingerprints.set(scope, fingerprint);
    }
    return fingerprint;
  };

  const scopeMap = (weakMap, scope) => {
    let value = weakMap.get(scope);
    if (!value) {
      value = new Map();
      weakMap.set(scope, value);
    }
    return value;
  };

  return {
    observeTurnStartRequest(params, scope, routeSocketId) {
      const scopeFingerprint = requireScope(scope);
      if (!scopeFingerprint || typeof params?.threadId !== "string" || !params.threadId.trim()
        || typeof params?.clientMessageId !== "string" || !params.clientMessageId.trim()) return null;
      const pairKey = receiptKey(params.threadId, params.clientMessageId);
      const counts = scopeMap(requestCounts, scope);
      const requestCount = (counts.get(pairKey) ?? 0) + 1;
      counts.set(pairKey, requestCount);
      turnStartRequestCount += 1;
      if (requestCount > 1) duplicatePairRequestCount += 1;
      return {
        threadId: params.threadId,
        clientMessageId: params.clientMessageId,
        scope,
        scopeFingerprint,
        routeSocketId,
        requestCount,
      };
    },
    observeTurnStartResponse(requestIdentity, response, responseRouteSocketId) {
      const turn = response?.result?.turn;
      if (!requestIdentity || !requireScope(requestIdentity.scope)
        || requestIdentity.requestCount !== 1
        || responseRouteSocketId !== requestIdentity.routeSocketId
        || typeof turn?.id !== "string" || !turn.id.trim() || response?.error) return false;
      const counts = scopeMap(requestCounts, requestIdentity.scope);
      const pairKey = receiptKey(requestIdentity.threadId, requestIdentity.clientMessageId);
      if (counts.get(pairKey) !== 1) return false;
      const byScope = scopeMap(accepted, requestIdentity.scope);
      if (byScope.has(pairKey)) return false;
      const receipt = {
        threadId: requestIdentity.threadId,
        clientMessageId: requestIdentity.clientMessageId,
        scope: requestIdentity.scope,
        scopeFingerprint: requestIdentity.scopeFingerprint,
        routeSocketId: requestIdentity.routeSocketId,
        responseRouteSocketId,
        requestCount: requestIdentity.requestCount,
        turnId: turn.id,
        status: typeof turn.status === "string" ? turn.status : "running",
      };
      byScope.set(pairKey, receipt);
      acceptedRows.push(receipt);
      acceptedCount += 1;
      return true;
    },
    read({ threadId, clientMessageId } = {}, scope, routeSocketId) {
      readCount += 1;
      if (!requireScope(scope)) {
        mismatchCount += 1;
        return null;
      }
      const receipt = accepted.get(scope)?.get(receiptKey(threadId, clientMessageId));
      if (!receipt || receipt.scope !== scope || receipt.threadId !== threadId || receipt.clientMessageId !== clientMessageId) {
        mismatchCount += 1;
        return null;
      }
      receipt.lastReadRouteSocketId = routeSocketId;
      return { threadId: receipt.threadId, turnId: receipt.turnId, status: receipt.status };
    },
    hasExactReceipt({ threadId, clientMessageId } = {}, scope) {
      const receipt = scope && accepted.get(scope)?.get(receiptKey(threadId, clientMessageId));
      return Boolean(receipt && receipt.scope === scope && receipt.threadId === threadId && receipt.clientMessageId === clientMessageId);
    },
    summary() {
      return {
        fixtureKind: "in-memory isolated mock only; not a durable Rust app-server receipt",
        turnStartRequestCount,
        acceptedResponseCount: acceptedCount,
        receiptReadCount: readCount,
        receiptMismatchCount: mismatchCount,
        duplicatePairRequestCount,
        invalidScopeCount,
        acceptedIdentityFingerprints: acceptedRows.map(receipt => ({
          scopeFingerprint: receipt.scopeFingerprint,
          threadIdFingerprint: sha256(receipt.threadId),
          clientMessageIdFingerprint: sha256(receipt.clientMessageId),
          turnIdFingerprint: sha256(receipt.turnId),
          requestCountForPair: receipt.requestCount,
          responseObservedOnRouteSocketId: receipt.routeSocketId,
          responseMatchedRequestSocket: receipt.responseRouteSocketId === receipt.routeSocketId,
          receiptReadOnDifferentRouteSocket: Number.isInteger(receipt.lastReadRouteSocketId)
            && receipt.lastReadRouteSocketId !== receipt.routeSocketId,
          status: receipt.status,
        })),
      };
    },
  };
}

export function sanitizeGatewayPath(pathname) {
  return String(pathname).replace(/(^|\/)g\/[^/]+(?=\/|$)/g, "$1g/<private-route>");
}

export function mobileApiPath(pathname) {
  const safe = sanitizeGatewayPath(pathname);
  const apiIndex = safe.lastIndexOf("/api/");
  return apiIndex >= 0 ? safe.slice(apiIndex) : safe;
}

function receiptKey(threadId, clientMessageId) {
  return `${String(threadId)}\0${String(clientMessageId)}`;
}
