

/** Shared suite helpers; the caller retains resource attribution and configuration. */
export function createPublicRelayDiagnosticHelpers({
  sha256,
}) {
function summarizeSamples(samples) {
  return { samples, ...summarizeLatencyValues(samples.map(sample => sample.elapsedMs)) };
}

function summarizeRpcSamples(samples) {
  return {
    samples,
    websocketHandshake: summarizeLatencyValues(samples.map(sample => sample.websocketHandshakeMs)),
    initializeResponse: summarizeLatencyValues(samples.map(sample => sample.initializeResponseMs)),
    openToInitialize: summarizeLatencyValues(samples.map(sample => sample.openToInitializeMs)),
  };
}

function summarizeLatencyValues(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    sampleCount: ordered.length,
    medianMs: ordered[Math.floor((ordered.length - 1) / 2)],
    p90Ms: ordered[Math.ceil(ordered.length * 0.9) - 1],
    maxMs: ordered.at(-1),
  };
}

function roundMs(value) {
  return Math.round(value * 10) / 10;
}

function dataSocketDelta(before, after) {
  if (before?.status !== "captured" || after?.status !== "captured") return null;
  return after.dataSocketCount - before.dataSocketCount;
}

function summarizeResponseHeaders(headers) {
  const summary = {};
  for (const name of ["content-type", "server", "via", "retry-after"]) {
    const value = headers.get(name);
    if (value !== null) summary[name] = value.slice(0, 160);
  }
  const requestId = headers.get("x-request-id");
  if (requestId) summary.xRequestIdFingerprint = sha256(requestId);
  return summary;
}

function requestFailureCategory(error) {
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === "string" && /^[A-Z0-9_-]{1,64}$/.test(code)) return code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "local-timeout";
  if (error?.name === "TypeError") return "fetch-error";
  return "request-error";
}

function classifySshStderr(stderr) {
  const value = stderr.toLowerCase();
  if (!value.trim()) return "empty";
  if (/mux_client|control socket|master not responding/.test(value)) return "multiplexing";
  if (/host key verification failed|remote host identification/.test(value)) return "host-key";
  if (/permission denied|authentication failed/.test(value)) return "authentication";
  if (/no route to host|network is unreachable|connection refused/.test(value)) return "network-unreachable";
  if (/connection reset|connection closed|broken pipe/.test(value)) return "connection-reset";
  if (/timed out|connection timed out/.test(value)) return "connect-timeout";
  return "other";
}

function parseKeyValues(text) {
  return Object.fromEntries(text.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function basenameSlug(value) {
  return value.split("/").at(-1).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

  return {
    summarizeSamples,
    summarizeRpcSamples,
    summarizeLatencyValues,
    roundMs,
    dataSocketDelta,
    summarizeResponseHeaders,
    requestFailureCategory,
    classifySshStderr,
    parseKeyValues,
    basenameSlug,
  };
}
