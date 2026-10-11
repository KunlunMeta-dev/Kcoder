const ALLOWED_DIAGNOSTIC_EVENTS = new Set([
  "control_connecting",
  "control_open",
  "control_error",
  "control_close",
  "reconnect_scheduled",
  "open_received",
  "open_rejected",
  "data_connecting",
  "data_open",
  "data_error",
  "data_close",
  "local_connecting",
  "local_connect",
  "local_error",
  "local_timeout",
  "local_close",
  "bridge_closed",
  "client_stopped",
]);
const ALLOWED_ERROR_KINDS = new Set(["timeout", "refused", "reset", "unreachable", "protocol", "handshake_status", "transport"]);
const ALLOWED_REJECT_REASONS = new Set(["invalid_frame", "invalid_open", "gateway_mismatch", "socket_capacity"]);
const ALLOWED_RECORD_KEYS = new Set([
  "event",
  "generation",
  "atUnixMs",
  "monotonicMs",
  "correlation",
  "errorKind",
  "handshakeStatus",
  "closeCode",
  "hadError",
  "rejectReason",
]);

export async function readBoundedErrorResponseBody(response, redactText, { maxBytes = 4096, deadlineMs = 3000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new RangeError("deadlineMs must be a positive safe integer");

  if (response.status >= 200 && response.status < 300) {
    return {
      status: "omitted-sensitive-success-body",
      reason: "session responses can contain newly issued credentials",
      capturePolicy: { body: "not-consumed" },
    };
  }
  const capturePolicy = {
    maxBytes,
    deadlineMs,
    wait: "bounded",
    cancellation: "best-effort nonblocking when needed",
    underlyingResourceRelease: "unverified",
  };
  const withCapturePolicy = result => ({ ...result, capturePolicy });
  if (!response.body) return withCapturePolicy({ status: "empty", text: "", truncated: false });
  if (typeof redactText !== "function") return withCapturePolicy({ status: "UNAVAILABLE", reason: "redactor-unavailable" });

  let reader;
  try {
    reader = response.body.getReader();
  } catch {
    return withCapturePolicy({ status: "UNAVAILABLE", reason: "response-reader-unavailable" });
  }

  let cancelRequested = false;
  let bodyReadComplete = false;
  const cancelWithoutWaiting = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {}
  };
  const releaseReader = () => {
    try { reader.releaseLock(); } catch {}
  };

  const work = (async () => {
    const chunks = [];
    let byteCount = 0;
    let truncated = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        bodyReadComplete = true;
        break;
      }
      const remaining = maxBytes + 1 - byteCount;
      const chunk = value.subarray(0, Math.max(0, remaining));
      chunks.push(Buffer.from(chunk));
      byteCount += chunk.byteLength;
      if (byteCount > maxBytes) {
        truncated = true;
        cancelWithoutWaiting();
        break;
      }
    }
    const raw = Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
    let redacted;
    try {
      redacted = redactText(raw);
    } catch {
      return withCapturePolicy({ status: "UNAVAILABLE", reason: "redaction-failed" });
    }
    if (typeof redacted !== "string") return withCapturePolicy({ status: "UNAVAILABLE", reason: "redaction-failed" });
    return withCapturePolicy({ status: "captured", text: redacted.slice(0, maxBytes), truncated: truncated || redacted.length > maxBytes });
  })().then(
    result => ({ completed: true, result }),
    () => ({ completed: true, result: withCapturePolicy({ status: "UNAVAILABLE", reason: "read-failed" }) }),
  ).then(record => {
    releaseReader();
    return record;
  });

  let deadlineTimer;
  const deadline = new Promise(resolve => {
    deadlineTimer = setTimeout(() => resolve({ completed: false }), deadlineMs);
  });
  try {
    const result = await Promise.race([work, deadline]);
    if (!result.completed) {
      cancelWithoutWaiting();
      return withCapturePolicy({ status: "UNAVAILABLE", reason: "read-deadline-exceeded" });
    }
    return result.result;
  } finally {
    clearTimeout(deadlineTimer);
    if (!bodyReadComplete) cancelWithoutWaiting();
    releaseReader();
  }
}

export function createBoundedRelayDiagnosticCollector({ redactText, maxEvents = 256, maxBytes = 64 * 1024 } = {}) {
  if (typeof redactText !== "function") throw new TypeError("redactText must be a function");
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new RangeError("maxEvents must be a positive safe integer");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");

  const events = [];
  let byteCount = 0;
  let droppedCount = 0;
  let rejectedCount = 0;

  return Object.freeze({
    push(record) {
      const safe = projectRelayDiagnostic(record);
      if (!safe) {
        rejectedCount += 1;
        return false;
      }
      let redacted;
      try { redacted = redactText(JSON.stringify(safe)); }
      catch {
        rejectedCount += 1;
        return false;
      }
      if (typeof redacted !== "string") {
        rejectedCount += 1;
        return false;
      }
      let projected;
      try { projected = projectRelayDiagnostic(JSON.parse(redacted)); }
      catch { projected = null; }
      if (!projected) {
        rejectedCount += 1;
        return false;
      }
      const size = Buffer.byteLength(JSON.stringify(projected));
      if (events.length >= maxEvents || byteCount + size > maxBytes) {
        droppedCount += 1;
        return false;
      }
      events.push(projected);
      byteCount += size;
      return true;
    },
    snapshot() {
      return {
        events: events.map(event => ({ ...event })),
        eventCount: events.length,
        byteCount,
        droppedCount,
        rejectedCount,
      };
    },
  });
}

function projectRelayDiagnostic(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (Object.keys(record).some(key => !ALLOWED_RECORD_KEYS.has(key))) return null;
  if (!ALLOWED_DIAGNOSTIC_EVENTS.has(record.event)) return null;
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) return null;
  if (!Number.isFinite(record.atUnixMs) || !Number.isFinite(record.monotonicMs)) return null;

  const safe = {
    event: record.event,
    generation: record.generation,
    atUnixMs: Math.round(record.atUnixMs),
    monotonicMs: Math.round(record.monotonicMs * 10) / 10,
  };
  if (record.correlation !== undefined) {
    if (typeof record.correlation !== "string" || !/^[a-f0-9]{64}$/.test(record.correlation)) return null;
    safe.correlation = record.correlation;
  }
  if (record.errorKind !== undefined) {
    if (!ALLOWED_ERROR_KINDS.has(record.errorKind)) return null;
    safe.errorKind = record.errorKind;
  }
  if (record.handshakeStatus !== undefined) {
    if (!Number.isInteger(record.handshakeStatus) || record.handshakeStatus < 100 || record.handshakeStatus > 599) return null;
    safe.handshakeStatus = record.handshakeStatus;
  }
  if (record.closeCode !== undefined) {
    if (!Number.isInteger(record.closeCode) || record.closeCode < 1000 || record.closeCode > 4999) return null;
    safe.closeCode = record.closeCode;
  }
  if (record.hadError !== undefined) {
    if (typeof record.hadError !== "boolean") return null;
    safe.hadError = record.hadError;
  }
  if (record.rejectReason !== undefined) {
    if (!ALLOWED_REJECT_REASONS.has(record.rejectReason)) return null;
    safe.rejectReason = record.rejectReason;
  }
  return safe;
}
