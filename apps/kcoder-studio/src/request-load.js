// Counts of requests the Gateway has forwarded but not yet seen answered.
//
// The requirement is to be able to tell "a client is waiting for something" from
// "the Gateway is out of connection capacity", so this tracks only counts per
// channel: no request ids, methods, payloads or account data are retained beyond
// the id needed to pair a request with its answer.

/** Channel names the Gateway classifies load into; anything else is `other`. */
export const REQUEST_LOAD_CHANNELS = Object.freeze([
  "runtime",
  "browser",
  "ssh-terminal",
  "other",
]);

function classify(channel) {
  return REQUEST_LOAD_CHANNELS.includes(channel) ? channel : "other";
}

export class RequestLoadTracker {
  #load = new Map();

  constructor() {
    for (const channel of REQUEST_LOAD_CHANNELS) {
      this.#load.set(channel, { inFlight: 0, highWater: 0, ids: new Set() });
    }
  }

  /** Records that a request with this transport id is outstanding. */
  begin(channel, id) {
    if (id === undefined || id === null || id === "") return;
    const entry = this.#load.get(classify(channel));
    if (entry.ids.has(id)) return;
    entry.ids.add(id);
    entry.inFlight += 1;
    if (entry.inFlight > entry.highWater) entry.highWater = entry.inFlight;
  }

  /** Records that a request was answered (or its connection went away). */
  settle(channel, id) {
    const entry = this.#load.get(classify(channel));
    if (!entry || !entry.ids.delete(id)) return;
    entry.inFlight -= 1;
  }

  /** Counts only: nothing here identifies a client, account or request. */
  snapshot() {
    const perChannel = {};
    let inFlight = 0;
    let highWater = 0;
    for (const [channel, entry] of this.#load) {
      perChannel[channel] = { inFlight: entry.inFlight, highWater: entry.highWater };
      inFlight += entry.inFlight;
      highWater += entry.highWater;
    }
    return { perChannel, total: { inFlight, highWater } };
  }
}

/** The counts-only line the Gateway writes to stderr, next to its other diagnostics. */
export function requestLoadDiagnostic(snapshot) {
  return {
    event: "request-load",
    perChannel: snapshot.perChannel,
    total: snapshot.total,
  };
}

/** Aggregates several trackers (one per broker) into one counts-only snapshot. */
export function mergeRequestLoad(snapshots) {
  const perChannel = {};
  for (const channel of REQUEST_LOAD_CHANNELS) {
    perChannel[channel] = { inFlight: 0, highWater: 0 };
  }
  let inFlight = 0;
  let highWater = 0;
  for (const snapshot of snapshots) {
    for (const channel of REQUEST_LOAD_CHANNELS) {
      const entry = snapshot?.perChannel?.[channel];
      if (!entry) continue;
      perChannel[channel].inFlight += entry.inFlight;
      perChannel[channel].highWater = Math.max(perChannel[channel].highWater, entry.highWater);
    }
    inFlight += snapshot?.total?.inFlight ?? 0;
    highWater += snapshot?.total?.highWater ?? 0;
  }
  return { perChannel, total: { inFlight, highWater } };
}
