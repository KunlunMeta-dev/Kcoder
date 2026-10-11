const METHOD = "thread/history/refresh";

/** Business rejection: return JSON-RPC without closing the multiplexed transport. */
export class HistoryRefreshRequestError extends Error {
  constructor(message, code = -32602) {
    super(message);
    this.code = code;
  }
}

function validate(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)
    || Object.keys(params).some(key => !["cursor", "cancel", "acknowledgeExternalWriters"].includes(key))
    || (params.cancel !== undefined && typeof params.cancel !== "boolean")
    || (params.acknowledgeExternalWriters !== undefined && typeof params.acknowledgeExternalWriters !== "boolean")) {
    throw new HistoryRefreshRequestError("Invalid history refresh parameters");
  }
  const cursor = params.cursor ?? null;
  if (cursor !== null && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4096)) {
    throw new HistoryRefreshRequestError("Invalid history refresh cursor");
  }
  if (params.cancel && cursor === null) throw new HistoryRefreshRequestError("History refresh cancellation requires a cursor");
  if (cursor === null && params.acknowledgeExternalWriters !== true) {
    throw new HistoryRefreshRequestError("History refresh requires acknowledgeExternalWriters");
  }
  return cursor;
}

/** Per-WebSocket ownership above the shared app-server connection's one rebuild processor. */
export class BrokerHistoryRefresh {
  state = null;

  claim(owner, params = {}) {
    if (owner.initialized !== true) throw new HistoryRefreshRequestError("Initialize is required before history refresh", -32002);
    const cursor = validate(params);
    const previous = this.state;
    if (previous && previous.owner !== owner) throw new HistoryRefreshRequestError("History refresh belongs to another client", -32020);
    if (previous?.inflight) throw new HistoryRefreshRequestError("History refresh request is already in flight", -32020);
    if (cursor !== null && (!previous || previous.cursor !== cursor)) throw new HistoryRefreshRequestError("Invalid or expired history refresh cursor", -32020);
    const state = { owner, detached: false, cursor: null, inflight: null };
    const ticket = { state, previous, params, cleanup: false };
    state.inflight = ticket;
    this.state = state;
    return ticket;
  }

  abortWrite(ticket) {
    if (this.state === ticket.state) this.state = ticket.previous;
  }

  complete(ticket, response) {
    if (this.state !== ticket.state || this.state.inflight !== ticket) return null;
    if (ticket.cleanup || ticket.params.cancel || response.error) {
      this.state = null;
      return null;
    }
    const result = response.result;
    if (result?.status !== "building" || typeof result.nextCursor !== "string" || !result.nextCursor.length) {
      this.state = null;
      return null;
    }
    this.state.cursor = result.nextCursor;
    this.state.inflight = null;
    return this.cleanup();
  }

  detach(owner) {
    if (this.state?.owner !== owner) return null;
    this.state.detached = true;
    return this.cleanup();
  }

  cleanup() {
    const state = this.state;
    if (!state?.detached || state.inflight || !state.cursor) return null;
    const ticket = { state, previous: null, cleanup: true, params: { cursor: state.cursor, cancel: true } };
    state.cursor = null;
    state.inflight = ticket;
    return ticket;
  }

  reset() { this.state = null; }
}

export const HISTORY_REFRESH_METHOD = METHOD;
