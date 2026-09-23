/**
 * Connection admission for the Studio Gateway (A3/R131).
 *
 * The global WebSocket limit and the browser-class limit are different
 * constraints, and a runtime without browser sessions is a third, unrelated
 * reason. Refusals must therefore name the limit that actually applied, with the
 * counts that prove it, so an operator never reads a browser-class cap as global
 * connection exhaustion.
 */

export const CONNECTION_REFUSAL = Object.freeze({
  RUNTIME_UNSUPPORTED: 'runtime_unsupported',
  GLOBAL_LIMIT: 'global_limit',
  BROWSER_LIMIT: 'browser_limit',
})

/**
 * Returns the refusal for a capacity-limited connection, or `null` when every
 * limit still has room.
 */
export function connectionCapacityRefusal(input) {
  const {
    channel,
    browserSessionsAvailable,
    activeConnections,
    maxConnections,
    activeBrowserConnections,
    maxBrowserConnections,
  } = input;
  const counts = {
    channel,
    activeConnections,
    maxConnections,
    activeBrowserConnections,
    maxBrowserConnections,
  };
  if (channel === 'browser' && !browserSessionsAvailable) {
    return { reason: CONNECTION_REFUSAL.RUNTIME_UNSUPPORTED, ...counts };
  }
  // True global exhaustion wins: it is accurate, and the browser counts travel
  // with it so the class limit stays visible.
  if (activeConnections >= maxConnections) {
    return { reason: CONNECTION_REFUSAL.GLOBAL_LIMIT, ...counts };
  }
  if (channel === 'browser' && activeBrowserConnections >= maxBrowserConnections) {
    return { reason: CONNECTION_REFUSAL.BROWSER_LIMIT, ...counts };
  }
  return null;
}

/**
 * Structured, token-free diagnostic for one refusal, including the cumulative
 * per-reason counters so the browser class and the global limit are never
 * conflated in an operator's reading of the log.
 */
export function connectionRefusalDiagnostic(refusal, refusals) {
  return {
    event: 'connection-refused',
    reason: refusal.reason,
    channel: refusal.channel,
    activeConnections: refusal.activeConnections,
    maxConnections: refusal.maxConnections,
    activeBrowserConnections: refusal.activeBrowserConnections,
    maxBrowserConnections: refusal.maxBrowserConnections,
    refusals: { ...refusals },
  };
}
