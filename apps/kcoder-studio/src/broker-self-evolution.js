// Self-evolution (`evolution/*`, `settings/evolution/*`) admission on the
// shared app-server broker. The methods are target-scoped like other
// settings domains; only `evolution/rate` and `evolution/ratings/list` name a
// thread, and that thread must belong to the requesting client so a rating
// never lands on (and ratable turns are never read from) another client's
// conversation. `evolution/changed` is a threadless notification
// delivered to initialized clients of a backend that advertised the
// capability.

export const SELF_EVOLUTION_CAPABILITY = 'selfEvolutionV1';
export const SELF_EVOLUTION_CHANGED = 'evolution/changed';
export const SELF_EVOLUTION_RATE = 'evolution/rate';
export const SELF_EVOLUTION_RATINGS_LIST = 'evolution/ratings/list';
const THREAD_SCOPED_METHODS = new Set([SELF_EVOLUTION_RATE, SELF_EVOLUTION_RATINGS_LIST]);
export const SELF_EVOLUTION_METHODS = new Set([
  'evolution/status',
  'evolution/targets/list',
  'evolution/target/read',
  'evolution/proposal/decide',
  'evolution/overlay/update',
  'evolution/preference/list',
  'evolution/preference/update',
  SELF_EVOLUTION_RATE,
  SELF_EVOLUTION_RATINGS_LIST,
  'evolution/data/clear',
  'evolution/target/distill',
  'settings/evolution/read',
  'settings/evolution/save',
]);

function backendSupports(experimental) {
  return experimental?.[SELF_EVOLUTION_CAPABILITY] === true;
}

/**
 * Returns `{ code, message, kind }` when the request must not be forwarded,
 * or null. `ownsThread(threadId)` reports whether the client owns (or shares)
 * the resumed thread.
 */
export function selfEvolutionAdmissionError(request, client, experimental, ownsThread) {
  if (!SELF_EVOLUTION_METHODS.has(request?.method)) return null;
  if (client?.initialized !== true || client.nativeManagementOnly === true)
    return { code: -32600, kind: 'evolution_unsupported', message: 'Self-evolution requires an initialized task client' };
  if (!backendSupports(experimental))
    return { code: -32601, kind: 'evolution_unsupported', message: `${SELF_EVOLUTION_CAPABILITY} is not available on this target` };
  if (request.params != null && (typeof request.params !== 'object' || Array.isArray(request.params)))
    return { code: -32602, kind: 'evolution_invalid_params', message: 'Self-evolution parameters must be an object' };
  if (THREAD_SCOPED_METHODS.has(request.method)) {
    const threadId = request.params?.threadId;
    if (typeof threadId !== 'string' || !threadId || threadId.length > 512 || /[\x00-\x1f\x7f]/.test(threadId))
      return { code: -32602, kind: 'evolution_invalid_params', message: `${request.method} requires an explicit threadId` };
    if (!ownsThread(threadId))
      return { code: -32023, kind: 'evolution_target_not_found', message: `${request.method} requires a task resumed by this Gateway client` };
  }
  return null;
}

export function selfEvolutionRejection(request, failure) {
  return { jsonrpc: '2.0', id: request?.id ?? null,
    error: { code: failure.code, message: failure.message, data: { kind: failure.kind } } };
}

/** Whether a server notification may reach this client. */
export function allowsSelfEvolutionNotification(message, client, experimental) {
  if (message?.method !== SELF_EVOLUTION_CHANGED) return true;
  return client?.initialized === true && client.nativeManagementOnly !== true && backendSupports(experimental);
}
