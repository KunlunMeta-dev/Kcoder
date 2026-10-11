export function inspectGatewayChannelMessage(channel, raw, { browserStarted = false } = {}) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return { request: null, method: "", allowed: true, startsBrowser: false };
  }
  const method = typeof request?.method === "string" ? request.method : "";
  const methodAllowed = channel === "browser"
    ? method === "initialize" || method === "initialized" || method.startsWith("browser/")
    : !method.startsWith("browser/");
  const startsBrowser = channel === "browser" && method === "browser/start";
  return {
    request,
    method,
    allowed: methodAllowed && !(startsBrowser && browserStarted),
    startsBrowser,
  };
}
