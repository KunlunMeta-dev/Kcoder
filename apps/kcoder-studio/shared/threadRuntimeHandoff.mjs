import { isContract } from './generated/validator.mjs';

export const THREAD_RUNTIME_HANDOFF_CAPABILITY = 'threadRuntimeHandoffV1';
export const THREAD_RUNTIME_HANDOFF_READ = 'thread/runtime/handoff/read';
export const THREAD_RUNTIME_HANDOFF_RELEASE = 'thread/runtime/handoff/release';
export const isThreadRuntimeHandoffMethod = method =>
  method === THREAD_RUNTIME_HANDOFF_READ || method === THREAD_RUNTIME_HANDOFF_RELEASE;
const reference = value => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  let bytes = 0;
  for (const char of value) {
    const n = char.codePointAt(0);
    if (n >= 0xd800 && n <= 0xdfff) return false;
    bytes += n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4;
  }
  return bytes <= 256;
};

export function validThreadRuntimeHandoffRequest(method, params) {
  if (!isThreadRuntimeHandoffMethod(method) || !isContract(method === THREAD_RUNTIME_HANDOFF_READ
    ? 'ThreadRuntimeHandoffReadParams' : 'ThreadRuntimeHandoffReleaseParams', params)) return false;
  if (!reference(params.threadId) || (params.operationId !== undefined && !reference(params.operationId))) return false;
  return method === THREAD_RUNTIME_HANDOFF_READ || (reference(params.operationId)
    && reference(params.expectedServerId) && reference(params.expectedOwnerRef)
    && Number.isSafeInteger(params.expectedClientTurnCount) && params.expectedClientTurnCount >= 0);
}

export function validThreadRuntimeHandoffResult(method, params, result) {
  if (!isThreadRuntimeHandoffMethod(method)) return false;
  if (!isContract(method === THREAD_RUNTIME_HANDOFF_READ
    ? 'ThreadRuntimeHandoffReadResult' : 'ThreadRuntimeHandoffReleaseResult', result)) return false;
  const s = result.snapshot;
  if (!reference(s.serverId) || s.threadId !== params.threadId
    || !(s.ownerRef === null || reference(s.ownerRef))
    || !(s.clientTurnCount === null || (Number.isSafeInteger(s.clientTurnCount) && s.clientTurnCount >= 0))
    || (s.ownerRef === null && (s.clientTurnCount !== null || s.releasable))
    || (s.releasable && s.clientTurnCount === null)) return false;
  const r = method === THREAD_RUNTIME_HANDOFF_READ ? result.operation : result.receipt;
  if (r === null) return method === THREAD_RUNTIME_HANDOFF_READ;
  if (!r || r.threadId !== params.threadId || r.operationId !== params.operationId
    || !reference(r.serverId) || !reference(r.ownerRef)) return false;
  if (r.status === 'released' && s.ownerRef === r.ownerRef) return false;
  if (method === THREAD_RUNTIME_HANDOFF_READ) return r.serverId === s.serverId;
  return r.ownerRef === params.expectedOwnerRef && r.serverId === params.expectedServerId
    && (r.status === 'unknown' || s.serverId === params.expectedServerId);
}

/** Clear only an observed absent original resident, never a later resumed one. */
export function confirmsReleasedThreadRuntime(params, result) {
  return validThreadRuntimeHandoffResult(THREAD_RUNTIME_HANDOFF_RELEASE, params, result)
    && result.receipt.status === 'released' && result.snapshot.ownerRef === null;
}

export class ThreadRuntimeHandoffError extends Error {
  constructor(message, outcome) { super(message); this.name = 'ThreadRuntimeHandoffError'; this.outcome = outcome; }
}

/** No automatic release, resume, retry, task creation, or transcript persistence. */
export class ThreadRuntimeHandoffClient {
  constructor(transport) { this.transport = transport; }
  async call(method, params) {
    const t = this.transport, stamp = t.ownerStamp();
    const intent = {...params};
    if (!t.supported()) throw new ThreadRuntimeHandoffError('THREAD_HANDOFF_UNSUPPORTED','not_sent');
    if (!validThreadRuntimeHandoffRequest(method, intent)) throw new ThreadRuntimeHandoffError('THREAD_HANDOFF_REQUEST_INVALID','not_sent');
    let result;
    try { result = await t.request(method, intent); }
    catch { throw new ThreadRuntimeHandoffError('THREAD_HANDOFF_RESULT_UNCONFIRMED','unknown'); }
    if (stamp !== t.ownerStamp() || !t.supported()) throw new ThreadRuntimeHandoffError('THREAD_HANDOFF_OWNER_CHANGED','unknown');
    if (!validThreadRuntimeHandoffResult(method, intent, result)) throw new ThreadRuntimeHandoffError('THREAD_HANDOFF_RESULT_UNCONFIRMED','unknown');
    return result;
  }
  observe(threadId, operationId) {
    return this.call(THREAD_RUNTIME_HANDOFF_READ, {threadId, ...(operationId === undefined ? {} : {operationId})});
  }
  release(params) { return this.call(THREAD_RUNTIME_HANDOFF_RELEASE, params); }
}
