const METHODS = new Set(['identity', 'sourcePrepare', 'sourceRead', 'sourceFind', 'sourceMarkDispatch',
  'sourceRecordReceipt', 'sourceCheckOriginal', 'targets', 'acceptForwarded', 'queryOriginal'].map(name => 'agentMessage/router/' + name));
const INTERESTING = new Set(['sourcePrepare', 'sourceMarkDispatch', 'sourceCheckOriginal', 'acceptForwarded'].map(name => 'agentMessage/router/' + name));
const PHASES = new Set(['begin', 'result', 'rejected', 'threw']);
const STAGES = new Set(['prepared', 'dispatching', 'receipted']);
const STATUSES = new Set(['queued', 'delivering', 'applied', 'rejected', 'expired', 'unknown']);
export function closedPeerRouteReason(error) {
  const value = error?.message;
  return typeof value === 'string' && /^(?:(?:AGENT_MESSAGES|REMOTE_HOST)_[A-Z0-9_]{1,100}|peer_[a-z0-9_]{1,100})$/.test(value)
    ? value : 'OTHER_FAILURE';
}
/** Fixture-only projection: no params/proof/body/environment or raw exceptions. */
export function createPeerRouteDiagnostics(context, limit = 2000) {
  const events = [], counters = new Map(), receiptStates = new Map();
  let sequence = 0, dropped = 0;
  const observe = input => {
    if (!['private', 'verifyOriginal'].includes(input.lane) || !PHASES.has(input.phase)) return;
    const event = { lane: input.lane, phase: input.phase };
    if (input.lane === 'private') {
      if (!['a', 'b'].includes(input.alias) || !METHODS.has(input.method)) return;
      event.alias = input.alias; event.method = input.method;
    } else {
      if (Number.isSafeInteger(input.check) && input.check > 0) event.check = input.check;
      if (['observe', 'append', 'wake'].includes(input.access)) event.access = input.access;
    }
    if (Number.isSafeInteger(input.code)) event.code = input.code;
    if (input.reason !== undefined) event.reason = closedPeerRouteReason({ message: input.reason });
    if (input.nativeReason !== undefined) event.nativeReason = closedPeerRouteReason({ message: input.nativeReason });
    if (STAGES.has(input.stage)) event.stage = input.stage;
    if (STATUSES.has(input.receiptStatus)) event.receiptStatus = input.receiptStatus;
    const counter = JSON.stringify([event.lane, event.alias ?? null, event.method ?? null, event.phase, event.reason ?? null, event.nativeReason ?? null]);
    counters.set(counter, (counters.get(counter) ?? 0) + 1);
    const key = event.alias + ':' + event.method;
    const state = event.stage + ':' + event.receiptStatus;
    const receiptChanged = event.method?.endsWith('/sourceRecordReceipt') && event.phase === 'result' && receiptStates.get(key) !== state;
    if (receiptChanged) receiptStates.set(key, state);
    if (event.lane === 'private' && !INTERESTING.has(event.method) && !['rejected', 'threw'].includes(event.phase) && !receiptChanged) return;
    if (events.length >= limit) { dropped++; return; }
    events.push({ sequence: ++sequence, ...event });
  };
  const snapshot = () => ({ boundary: 'Controlled Native fixture only; closed codes/stages; no body, credentials, environment or permission allow cache.',
    droppedDiagnostics: dropped, counters: [...counters].map(([key, count]) => ({ key: JSON.parse(key), count })), events: structuredClone(events) });
  return Object.freeze({ observe, snapshot,
    async withDiagnostics(execute) {
      try { return await execute(); }
      finally { await context.writeArtifactJson('peer-route-diagnostics.json', snapshot()); }
    } });
}
