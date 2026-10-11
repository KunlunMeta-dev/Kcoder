import { createHash } from "node:crypto";

export const RELAY_HTTP_DIAGNOSTIC_BASE_SHA256 = "941172ab1e4415d5fdc9d02f2efb787fe144c7032f3853013bbdb13ac2826a5e";
export const RELAY_HTTP_DIAGNOSTIC_OVERLAY_SHA256 = "5f5f4405d76688eb4d408068f8e9c21fe9c156fa61d28d630dc5803be6b6f9cf";

const EVENT_NAMES = new Set([
  "public-http-entry", "route-decision", "request-classification", "gateway-online-check",
  "control-open-dispatch", "pending-created", "pending-finished", "data-upgrade-entry",
  "data-upgrade-rejected", "pending-data-attach-start", "relay-data-ws-accepted",
  "relay-tunnel-attach-returned", "relay-tunnel-attach-threw", "relay-upstream-error",
  "relay-upstream-response", "public-request-aborted", "public-request-error",
  "public-response-error", "public-response-finished", "public-response-closed",
  "data-wss-upgrade-attempt", "data-wss-accepted", "data-wss-closed",
]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "OTHER"]);
const DECISIONS = new Set([
  "matched", "invalid-authority-or-target", "shared-path-rejected", "unknown-gateway",
  "unknown-host", "online", "offline", "session-post", "pending-hit", "pending-miss",
  "pending-state-mismatch", "duplicate-upgrade",
]);
const OUTCOMES = new Set([
  "send-started", "send-callback-ok", "send-callback-error", "send-threw", "timeout",
  "failed", "cancelled", "upgrade-started", "accepted", "attached", "attach-threw",
  "rejected", "finished", "closed", "aborted", "error",
]);
const ERROR_NAMES = new Set(["Error", "TypeError", "TimeoutError", "AbortError", "AggregateError", "ConnectTimeoutError", "SocketError"]);
const ERROR_CODES = new Set([
  "RELAY_TIMEOUT", "RELAY_UNAVAILABLE", "RELAY_TRAFFIC_LIMIT", "RELAY_UPSTREAM_ABORTED",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_ABORTED", "ABORT_ERR", "OTHER",
]);
const ALLOWED_RECORD_KEYS = new Set([
  "event", "requestId", "channelFingerprint", "atUnixMs", "elapsedMs", "method", "decision",
  "outcome", "statusCode", "errorName", "errorCode", "closeCode", "pendingCount", "writableFinished", "headersSent",
]);

export function createRelayHttpDiagnosticCollector({ maxEvents = 64, maxBytes = 24 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new RangeError("maxEvents must be positive");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be positive");
  const events = [];
  let byteCount = 0;
  let droppedCount = 0;
  let rejectedCount = 0;
  return Object.freeze({
    push(record) {
      const projected = projectRelayHttpDiagnostic(record);
      if (!projected) { rejectedCount += 1; return false; }
      const size = Buffer.byteLength(JSON.stringify(projected));
      if (events.length >= maxEvents || byteCount + size > maxBytes) { droppedCount += 1; return false; }
      events.push(projected);
      byteCount += size;
      return true;
    },
    snapshot() {
      return { events: events.map(event => ({ ...event })), eventCount: events.length, byteCount, droppedCount, rejectedCount };
    },
  });
}

export function applyRelayPublicHttpDiagnosticOverlay(sourceText) {
  if (typeof sourceText !== "string") throw new TypeError("Relay server source must be text");
  const baseSha256 = sha256(sourceText);
  if (baseSha256 !== RELAY_HTTP_DIAGNOSTIC_BASE_SHA256) throw new Error("fixed Relay server source SHA-256 mismatch");
  let source = sourceText;
  const patches = [
    [
      ["const REGISTRATION_CREDENTIAL = /^[A-Za-z0-9._~-]{32,512}$/;"].join("\n"),
      [
        "const REGISTRATION_CREDENTIAL = /^[A-Za-z0-9._~-]{32,512}$/;",
        "",
        "const E2E_RELAY_DIAGNOSTIC_KEY = Symbol.for('kcoder.e2e.relay-public-http-diagnostic');",
        "const E2E_RELAY_DIAGNOSTIC_ERROR_CODES = new Set([",
        "  'RELAY_TIMEOUT', 'RELAY_UNAVAILABLE', 'RELAY_TRAFFIC_LIMIT', 'RELAY_UPSTREAM_ABORTED',",
        "  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',",
        "  'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',",
        "  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED', 'ABORT_ERR',",
        "]);",
        "",
        "function emitE2ERelayDiagnostic(record) {",
        "  try {",
        "    const observer = globalThis[E2E_RELAY_DIAGNOSTIC_KEY];",
        "    if (typeof observer === 'function') observer({ ...record, atUnixMs: Date.now() });",
        "  } catch {}",
        "}",
        "",
        "function e2eRelayErrorFields(error) {",
        "  if (!error || typeof error !== 'object') return {};",
        "  const allowedNames = new Set(['Error', 'TypeError', 'TimeoutError', 'AbortError', 'AggregateError', 'ConnectTimeoutError', 'SocketError']);",
        "  let name;",
        "  let code;",
        "  try { name = error.name; } catch {}",
        "  try { code = error.code; } catch {}",
        "  return {",
        "    errorName: allowedNames.has(name) ? name : 'Other',",
        "    errorCode: E2E_RELAY_DIAGNOSTIC_ERROR_CODES.has(code) ? code : 'OTHER',",
        "  };",
        "}",
        "",
        "function e2eRelayMethod(method) {",
        "  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(method) ? method : 'OTHER';",
        "}",
        "",
        "function e2eRelayChannelFingerprint(value) {",
        "  return typeof value === 'string' && /^[a-f0-9]{48}$/.test(value)",
        "    ? createHash('sha256').update(value).digest('hex')",
        "    : null;",
        "}",
      ].join("\n"),
    ],
    [
      [
        "    if (destroyUpgrade && upgradeSocket && !upgradeSocket.destroyed) upgradeSocket.destroy();",
        "    if (notifyFailure) entry.onFailure(error);",
      ].join("\n"),
      [
        "    if (destroyUpgrade && upgradeSocket && !upgradeSocket.destroyed) upgradeSocket.destroy();",
        "    if (entry.diagnosticRequestId) {",
        "      const errorFields = e2eRelayErrorFields(error);",
        "      emitE2ERelayDiagnostic({",
        "        event: 'pending-finished',",
        "        requestId: entry.diagnosticRequestId,",
        "        channelFingerprint: e2eRelayChannelFingerprint(entry.id),",
        "        outcome: errorFields.errorCode === 'RELAY_TIMEOUT' ? 'timeout' : error ? 'failed' : 'cancelled',",
        "        ...errorFields,",
        "      });",
        "    }",
        "    if (notifyFailure) entry.onFailure(error);",
      ].join("\n"),
    ],
    [
      "  function openPending(gateway, session, onAttach, onFailure) {",
      "  function openPending(gateway, session, onAttach, onFailure, diagnosticRequestId = null) {",
    ],
    [
      [
        "      id: randomBytes(24).toString('hex'),",
        "      gateway,",
      ].join("\n"),
      [
        "      id: randomBytes(24).toString('hex'),",
        "      diagnosticRequestId,",
        "      gateway,",
      ].join("\n"),
    ],
    [
      [
        "    gateway.pending.set(entry.id, entry);",
        "    entry.timer = setTimeout(() => finishPending(entry, Object.assign(new Error('Gateway data connection timed out'), { code: 'RELAY_TIMEOUT' })), connectTimeout);",
      ].join("\n"),
      [
        "    gateway.pending.set(entry.id, entry);",
        "    if (diagnosticRequestId) emitE2ERelayDiagnostic({",
        "      event: 'pending-created',",
        "      requestId: diagnosticRequestId,",
        "      channelFingerprint: e2eRelayChannelFingerprint(entry.id),",
        "      pendingCount: gateway.pending.size,",
        "    });",
        "    entry.timer = setTimeout(() => finishPending(entry, Object.assign(new Error('Gateway data connection timed out'), { code: 'RELAY_TIMEOUT' })), connectTimeout);",
      ].join("\n"),
    ],
    [
      [
        "    try {",
        "      control.ws.send(JSON.stringify({ type: 'open', id: entry.id, gatewayId: gateway.id }), error => {",
        "        if (error) finishPending(entry, Object.assign(new Error('Gateway control connection failed'), { code: 'RELAY_UNAVAILABLE' }));",
        "      });",
        "    } catch {",
        "      finishPending(entry, Object.assign(new Error('Gateway control connection failed'), { code: 'RELAY_UNAVAILABLE' }));",
        "    }",
      ].join("\n"),
      [
        "    try {",
        "      if (diagnosticRequestId) emitE2ERelayDiagnostic({",
        "        event: 'control-open-dispatch', requestId: diagnosticRequestId,",
        "        channelFingerprint: e2eRelayChannelFingerprint(entry.id), outcome: 'send-started',",
        "      });",
        "      control.ws.send(JSON.stringify({ type: 'open', id: entry.id, gatewayId: gateway.id }), error => {",
        "        if (error) {",
        "          if (diagnosticRequestId) emitE2ERelayDiagnostic({",
        "            event: 'control-open-dispatch', requestId: diagnosticRequestId,",
        "            channelFingerprint: e2eRelayChannelFingerprint(entry.id), outcome: 'send-callback-error',",
        "            ...e2eRelayErrorFields(error),",
        "          });",
        "          finishPending(entry, Object.assign(new Error('Gateway control connection failed'), { code: 'RELAY_UNAVAILABLE' }));",
        "        } else if (diagnosticRequestId) {",
        "          emitE2ERelayDiagnostic({",
        "            event: 'control-open-dispatch', requestId: diagnosticRequestId,",
        "            channelFingerprint: e2eRelayChannelFingerprint(entry.id), outcome: 'send-callback-ok',",
        "          });",
        "        }",
        "      });",
        "    } catch (error) {",
        "      if (diagnosticRequestId) emitE2ERelayDiagnostic({",
        "        event: 'control-open-dispatch', requestId: diagnosticRequestId,",
        "        channelFingerprint: e2eRelayChannelFingerprint(entry.id), outcome: 'send-threw',",
        "        ...e2eRelayErrorFields(error),",
        "      });",
        "      finishPending(entry, Object.assign(new Error('Gateway control connection failed'), { code: 'RELAY_UNAVAILABLE' }));",
        "    }",
      ].join("\n"),
    ],
    [
      "    if (!current) { ws.terminate(); return; }",
      [
        "    if (!current) {",
        "      if (entry.diagnosticRequestId) emitE2ERelayDiagnostic({",
        "        event: 'relay-data-ws-accepted', requestId: entry.diagnosticRequestId,",
        "        channelFingerprint: e2eRelayChannelFingerprint(entry.id), outcome: 'rejected',",
        "      });",
        "      ws.terminate();",
        "      return;",
        "    }",
        "    if (entry.diagnosticRequestId) emitE2ERelayDiagnostic({",
        "      event: 'relay-data-ws-accepted', requestId: entry.diagnosticRequestId,",
        "      channelFingerprint: e2eRelayChannelFingerprint(entry.id), outcome: 'accepted',",
        "    });",
      ].join("\n"),
    ],
    [
      [
        "    try { entry.onAttach(stream, close); }",
        "    catch { close(); }",
      ].join("\n"),
      [
        "    try {",
        "      entry.onAttach(stream, close);",
        "      if (entry.diagnosticRequestId) emitE2ERelayDiagnostic({",
        "        event: 'relay-tunnel-attach-returned', requestId: entry.diagnosticRequestId,",
        "        channelFingerprint: e2eRelayChannelFingerprint(entry.id), outcome: 'attached',",
        "      });",
        "    } catch (error) {",
        "      if (entry.diagnosticRequestId) emitE2ERelayDiagnostic({",
        "        event: 'relay-tunnel-attach-threw', requestId: entry.diagnosticRequestId,",
        "        channelFingerprint: e2eRelayChannelFingerprint(entry.id), outcome: 'attach-threw',",
        "        ...e2eRelayErrorFields(error),",
        "      });",
        "      close();",
        "    }",
      ].join("\n"),
    ],
    [
      [
        "    const idValue = url.searchParams.getAll('id');",
        "    const entry = idValue.length === 1 ? gateway.pending.get(idValue[0]) : null;",
        "    if (!entry || entry.gateway !== gateway || entry.generation !== gateway.control?.generation || entry.control !== gateway.control?.ws || !gatewayOnline(gateway)) {",
        "      sendUpgradeError(socket, 404, 'Not Found');",
        "      return;",
        "    }",
        "    if (entry.upgradeSocket) { sendUpgradeError(socket, 409, 'Conflict'); return; }",
        "    entry.upgradeSocket = socket;",
      ].join("\n"),
      [
        "    const idValue = url.searchParams.getAll('id');",
        "    const entry = idValue.length === 1 ? gateway.pending.get(idValue[0]) : null;",
        "    const channelFingerprint = e2eRelayChannelFingerprint(idValue.length === 1 ? idValue[0] : null);",
        "    emitE2ERelayDiagnostic({",
        "      event: 'data-upgrade-entry',",
        "      requestId: entry?.diagnosticRequestId ?? null,",
        "      channelFingerprint,",
        "      decision: entry ? 'pending-hit' : 'pending-miss',",
        "    });",
        "    const current = Boolean(entry && entry.gateway === gateway && entry.generation === gateway.control?.generation && entry.control === gateway.control?.ws && gatewayOnline(gateway));",
        "    if (!current) {",
        "      emitE2ERelayDiagnostic({",
        "        event: 'data-upgrade-rejected', requestId: entry?.diagnosticRequestId ?? null,",
        "        channelFingerprint,",
        "        decision: entry ? 'pending-state-mismatch' : 'pending-miss',",
        "        statusCode: 404,",
        "      });",
        "      sendUpgradeError(socket, 404, 'Not Found');",
        "      return;",
        "    }",
        "    if (entry.upgradeSocket) {",
        "      emitE2ERelayDiagnostic({",
        "        event: 'data-upgrade-rejected', requestId: entry.diagnosticRequestId ?? null,",
        "        channelFingerprint, decision: 'duplicate-upgrade', statusCode: 409,",
        "      });",
        "      sendUpgradeError(socket, 409, 'Conflict');",
        "      return;",
        "    }",
        "    request[Symbol.for('kcoder.e2e.relay-public-http-request')] = {",
        "      requestId: entry.diagnosticRequestId ?? null,",
        "      channelFingerprint,",
        "    };",
        "    if (entry.diagnosticRequestId) emitE2ERelayDiagnostic({",
        "      event: 'pending-data-attach-start', requestId: entry.diagnosticRequestId,",
        "      channelFingerprint, outcome: 'upgrade-started',",
        "    });",
        "    entry.upgradeSocket = socket;",
      ].join("\n"),
    ],
    [
      [
        "  async function handlePublicHttp(request, response) {",
        "    let failureCleanup = () => {",
        "      if (!response.destroyed) response.destroy();",
        "    };",
        "    request.on('aborted', () => failureCleanup());",
        "    request.on('error', error => failureCleanup(error));",
        "    response.on('error', error => failureCleanup(error));",
        "    response.shouldKeepAlive = false;",
      ].join("\n"),
      [
        "  async function handlePublicHttp(request, response) {",
        "    const diagnosticRequestId = randomBytes(8).toString('hex');",
        "    const diagnosticStartedAt = Date.now();",
        "    const diagnostic = (event, fields = {}) => emitE2ERelayDiagnostic({",
        "      event,",
        "      requestId: diagnosticRequestId,",
        "      elapsedMs: Math.max(0, Date.now() - diagnosticStartedAt),",
        "      ...fields,",
        "    });",
        "    diagnostic('public-http-entry', { method: e2eRelayMethod(request.method) });",
        "    let failureCleanup = () => {",
        "      if (!response.destroyed) response.destroy();",
        "    };",
        "    request.on('aborted', () => {",
        "      diagnostic('public-request-aborted', { outcome: 'aborted' });",
        "      failureCleanup();",
        "    });",
        "    request.on('error', error => {",
        "      diagnostic('public-request-error', { outcome: 'error', ...e2eRelayErrorFields(error) });",
        "      failureCleanup(error);",
        "    });",
        "    response.on('error', error => {",
        "      diagnostic('public-response-error', { outcome: 'error', statusCode: response.headersSent ? response.statusCode : null, headersSent: Boolean(response.headersSent), ...e2eRelayErrorFields(error) });",
        "      failureCleanup(error);",
        "    });",
        "    response.once('finish', () => diagnostic('public-response-finished', { outcome: 'finished', statusCode: response.statusCode }));",
        "    response.once('close', () => diagnostic('public-response-closed', { outcome: 'closed', statusCode: response.headersSent ? response.statusCode : null, headersSent: Boolean(response.headersSent), writableFinished: Boolean(response.writableFinished) }));",
        "    response.shouldKeepAlive = false;",
      ].join("\n"),
    ],
    [
      [
        "    const authority = requestAuthority(request);",
        "    const route = resolveGatewayRoute(registry, authority, request.url);",
        "    if (route.error) {",
        "      const [status, message] = routeErrorStatus(route.error);",
        "      sendHttpError(response, status, message);",
      ].join("\n"),
      [
        "    const authority = requestAuthority(request);",
        "    const route = resolveGatewayRoute(registry, authority, request.url);",
        "    if (route.error) {",
        "      const decision = route.error === 'invalid' ? 'invalid-authority-or-target'",
        "        : route.error === 'shared-path' ? 'shared-path-rejected'",
        "          : route.error === 'unknown-gateway' ? 'unknown-gateway' : 'unknown-host';",
        "      diagnostic('route-decision', { decision });",
        "      const [status, message] = routeErrorStatus(route.error);",
        "      sendHttpError(response, status, message);",
      ].join("\n"),
    ],
    [
      [
        "    const gateway = route.gateway;",
        "    if (!gatewayOnline(gateway)) { sendHttpError(response, 503, 'Service Unavailable'); return; }",
        "",
        "    const path = pathnameOf(route.target);",
      ].join("\n"),
      [
        "    const gateway = route.gateway;",
        "    diagnostic('route-decision', { decision: 'matched' });",
        "    if (!gatewayOnline(gateway)) {",
        "      diagnostic('gateway-online-check', { decision: 'offline', statusCode: 503 });",
        "      sendHttpError(response, 503, 'Service Unavailable');",
        "      return;",
        "    }",
        "    diagnostic('gateway-online-check', { decision: 'online' });",
        "",
        "    const path = pathnameOf(route.target);",
      ].join("\n"),
    ],
    [
      [
        "    const isRefreshPost = path === REFRESH_PATH && request.method === 'POST';",
        "    const isDeviceDelete = /^\\/api\\/mobile\\/devices\\/[a-zA-Z0-9-]{16,128}$/.test(path) && request.method === 'DELETE';",
      ].join("\n"),
      [
        "    const isRefreshPost = path === REFRESH_PATH && request.method === 'POST';",
        "    if (isSessionPost) diagnostic('request-classification', { decision: 'session-post' });",
        "    const isDeviceDelete = /^\\/api\\/mobile\\/devices\\/[a-zA-Z0-9-]{16,128}$/.test(path) && request.method === 'DELETE';",
      ].join("\n"),
    ],
    [
      [
        "    upstreamRequest.on('error', error => {",
        "      releaseSessionReservation();",
        "      agent.destroy();",
        "      if (response.headersSent) response.destroy();",
        "      else sendHttpError(response, error.code === 'RELAY_TIMEOUT' ? 504 : error.code === 'RELAY_TRAFFIC_LIMIT' ? 429 : 503,",
        "        error.code === 'RELAY_TIMEOUT' ? 'Gateway Timeout' : error.code === 'RELAY_TRAFFIC_LIMIT' ? 'Too Many Requests' : 'Service Unavailable');",
        "    });",
      ].join("\n"),
      [
        "    upstreamRequest.on('error', error => {",
        "      releaseSessionReservation();",
        "      agent.destroy();",
        "      const statusCode = error.code === 'RELAY_TIMEOUT' ? 504 : error.code === 'RELAY_TRAFFIC_LIMIT' ? 429 : 503;",
        "      diagnostic('relay-upstream-error', { outcome: 'error', ...e2eRelayErrorFields(error) });",
        "      if (response.headersSent) response.destroy();",
        "      else sendHttpError(response, statusCode,",
        "        error.code === 'RELAY_TIMEOUT' ? 'Gateway Timeout' : error.code === 'RELAY_TRAFFIC_LIMIT' ? 'Too Many Requests' : 'Service Unavailable');",
        "    });",
      ].join("\n"),
    ],
    [
      [
        "    const isMobileSession = gateway.pairingToken && (isSessionPost || isRefreshPost);",
        "    upstreamRequest.on('response', upstream => {",
      ].join("\n"),
      [
        "    const isMobileSession = gateway.pairingToken && (isSessionPost || isRefreshPost);",
        "    upstreamRequest.on('response', upstream => {",
        "      diagnostic('relay-upstream-response', { statusCode: Number.isInteger(upstream.statusCode) ? upstream.statusCode : null });",
      ].join("\n"),
    ],
    [
      "    entry = openPending(gateway, session, (stream, close) => tunnel.attach(stream, close), error => tunnel.fail(error));",
      "    entry = openPending(gateway, session, (stream, close) => tunnel.attach(stream, close), error => tunnel.fail(error), diagnosticRequestId);",
    ],
  ];
  for (const [anchor, replacement] of patches) source = replaceUnique(source, anchor, replacement);
  const sourceSha256 = sha256(source);
  return Object.freeze({ baseSha256, source, sourceSha256, patchVersion: "relay-public-http-phase-v1" });
}

export function summarizeFetchFailure(error) {
  const safeName = value => {
    try { return typeof value === "string" && ERROR_NAMES.has(value) ? value : "Other"; }
    catch { return "Other"; }
  };
  const safeCode = value => {
    try { return typeof value === "string" && ERROR_CODES.has(value) ? value : "OTHER"; }
    catch { return "OTHER"; }
  };
  let cause;
  try { cause = error && typeof error === "object" ? error.cause : undefined; } catch { cause = undefined; }
  let name;
  let code;
  try { name = error?.name; } catch { name = undefined; }
  try { code = error?.code; } catch { code = undefined; }
  let causeName;
  let causeCode;
  try { causeName = cause?.name; } catch { causeName = undefined; }
  try { causeCode = cause?.code; } catch { causeCode = undefined; }
  return Object.freeze({
    name: safeName(name),
    code: safeCode(code),
    causeName: cause ? safeName(causeName) : "NONE",
    causeCode: cause ? safeCode(causeCode) : "NONE",
  });
}

export function projectRelayHttpDiagnostic(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (Object.keys(record).some(key => !ALLOWED_RECORD_KEYS.has(key))) return null;
  if (!EVENT_NAMES.has(record.event)) return null;
  const safe = { event: record.event };
  if (record.requestId !== undefined && record.requestId !== null) {
    if (typeof record.requestId !== "string" || !/^[a-f0-9]{16}$/.test(record.requestId)) return null;
    safe.requestId = record.requestId;
  }
  if (record.channelFingerprint !== undefined && record.channelFingerprint !== null) {
    if (typeof record.channelFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.channelFingerprint)) return null;
    safe.channelFingerprint = record.channelFingerprint;
  }
  if (record.atUnixMs !== undefined) {
    if (!Number.isSafeInteger(record.atUnixMs) || record.atUnixMs < 0) return null;
    safe.atUnixMs = record.atUnixMs;
  }
  if (record.elapsedMs !== undefined) {
    if (!Number.isFinite(record.elapsedMs) || record.elapsedMs < 0 || record.elapsedMs > 120_000) return null;
    safe.elapsedMs = Math.round(record.elapsedMs * 10) / 10;
  }
  if (record.method !== undefined) {
    if (!METHODS.has(record.method)) return null;
    safe.method = record.method;
  }
  if (record.decision !== undefined) {
    if (!DECISIONS.has(record.decision)) return null;
    safe.decision = record.decision;
  }
  if (record.outcome !== undefined) {
    if (!OUTCOMES.has(record.outcome)) return null;
    safe.outcome = record.outcome;
  }
  if (record.statusCode !== undefined && record.statusCode !== null) {
    if (!Number.isInteger(record.statusCode) || record.statusCode < 100 || record.statusCode > 599) return null;
    safe.statusCode = record.statusCode;
  }
  if (record.errorName !== undefined) {
    if (!ERROR_NAMES.has(record.errorName) && record.errorName !== "Other") return null;
    safe.errorName = record.errorName;
  }
  if (record.errorCode !== undefined) {
    if (!ERROR_CODES.has(record.errorCode)) return null;
    safe.errorCode = record.errorCode;
  }
  if (record.closeCode !== undefined && record.closeCode !== null) {
    if (!Number.isInteger(record.closeCode) || record.closeCode < 1000 || record.closeCode > 4999) return null;
    safe.closeCode = record.closeCode;
  }
  if (record.pendingCount !== undefined) {
    if (!Number.isSafeInteger(record.pendingCount) || record.pendingCount < 0 || record.pendingCount > 4096) return null;
    safe.pendingCount = record.pendingCount;
  }
  if (record.writableFinished !== undefined) {
    if (typeof record.writableFinished !== "boolean") return null;
    safe.writableFinished = record.writableFinished;
  }
  if (record.headersSent !== undefined) {
    if (typeof record.headersSent !== "boolean") return null;
    safe.headersSent = record.headersSent;
  }
  return safe;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function replaceUnique(source, anchor, replacement) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`Relay diagnostic overlay anchor missing or ambiguous: ${anchor.slice(0, 72)}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}
