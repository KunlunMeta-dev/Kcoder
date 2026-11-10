import { isDeepStrictEqual } from 'node:util';
import { allowedFields, isContract, knownValues } from '../shared/generated/validator.mjs';
import { requireCapturedNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';

export const CONTINUOUS_WORK_CAPABILITY = 'continuousWorkV1';
export const CONTINUOUS_WORK_READ_CAPABILITY = 'continuousWorkReadV1';
export const CONTINUOUS_WORK_PARTIAL_LIST_CAPABILITY = 'continuousWorkPartialListV1';
// Target promise: persistent work cannot contain any ephemeral thread binding.
export const CONTINUOUS_WORK_NO_EPHEMERAL_CAPABILITY = 'continuousWorkNoEphemeralV1';
// Independently negotiated mutation names. A host that does not declare them
// keeps the client's page-local queue and offers no control; the Gateway must
// never forward them on the strength of the read-only capability alone.
export const CONTINUOUS_WORK_INPUT_CAPABILITY = 'continuousWorkInputV1';
export const CONTINUOUS_WORK_CONTROL_CAPABILITY = 'continuousWorkControlV1';
const METHODS = new Map([
  ['work/list', 'ContinuousWorkListParams'],
  ['work/read', 'ContinuousWorkReadParams'],
  ['work/input/submit', 'ContinuousWorkInputSubmitParams'],
  ['work/input/read', 'ContinuousWorkInputReadParams'],
  ['work/control', 'ContinuousWorkControlParams'],
]);
const THREAD_METHODS = new Set(['work/input/submit', 'work/input/read', 'work/control']);
const MAX_OBSERVED_WORKS = 512;
const MAX_RETIRED_EPHEMERAL_THREADS = 4096;
const MAX_RESULT_REFERENCES = 256;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const cc = /\p{Cc}/u;
const validAtom = (value, max = 256) => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= max && value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') === value && !cc.test(value);
const validWorkId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const validCursor = value => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= 2048 && !cc.test(value);
const reject = (code, message) => ({ code, message });
// Fixed public labels prevent native paths, payloads or credentials in a
// target's diagnostic from crossing the Gateway boundary. Explicit protocol
// rejections keep their original class; unknown mutation outcomes stay unknown.
const PUBLIC_ERRORS = new Map([
  [-32600, 'The continuous work request was rejected'],
  [-32601, 'The continuous work method is unavailable'],
  [-32602, 'The continuous work request was rejected'],
  [-32001, 'Current target authorization is unavailable'],
  [-32002, 'Initialize is required before continuous work'],
  [-32023, 'The continuous work request is not owned by this client'],
  [-32032, 'Continuous work capacity is unavailable'],
  [-32033, 'The original continuous work request conflicts'],
  [-32034, 'Original continuous work outcome is unknown; reconcile using the original request identity'],
  [-32043, 'Continuous work is temporarily unavailable'],
]);
function projectError(method, id, error) {
  const mutation = ['work/input/submit', 'work/control'].includes(method);
  // Only standard JSON-RPC request/method/parameter rejections are defined as
  // pre-dispatch here. Native capacity/ownership/conflict codes are not yet
  // proven to be pre-commit, so mutation outcomes remain unknown.
  const preDispatch = new Set([-32600, -32601, -32602]);
  const trustedCode = Number.isSafeInteger(error?.code) && PUBLIC_ERRORS.has(error.code);
  const code = mutation && (!trustedCode || (!preDispatch.has(error.code) && error.code !== -32034))
    ? -32034 : trustedCode ? error.code : -32603;
  return { jsonrpc: '2.0', id, error: { code,
    message: PUBLIC_ERRORS.get(code) ?? 'Continuous work could not be read' } };
}
const pick = (name, object) => Object.fromEntries((allowedFields[name] ?? [])
  .filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));

function validInteraction(interaction, threadId) {
  if (interaction == null) return true;
  const selector = interaction.selector;
  return validAtom(interaction.attemptId) && selector?.kind === 'question' && selector.threadId === threadId &&
    ['serverId', 'threadId', 'turnId', 'appServerEpoch', 'questionId'].every(key => validAtom(selector[key], 1024)) &&
    selector.approvalId == null && positive(selector.requestId);
}
function validControlTarget(action, target) {
  const validTarget = (() => {
    switch (target?.kind) {
      case 'work': return true;
      case 'turn': return ['threadId', 'turnId', 'attemptId'].every(key => validAtom(target[key]));
      case 'agent': return ['threadId', 'turnId', 'attemptId', 'agentId', 'runId'].every(key => validAtom(target[key]));
      case 'workflow': return validAtom(target.threadId) && validAtom(target.runId) && positive(target.revision) &&
        Number.isSafeInteger(target.resumeCount) && target.resumeCount >= 0 && target.resumeCount <= 0xffffffff;
      case 'operation': return validAtom(target.operationId);
      default: return false;
    }
  })();
  if (!validTarget) return false;
  if (['pause', 'resume', 'stop'].includes(action)) return target.kind === 'work';
  if (action === 'cancel_run') return ['turn', 'agent', 'workflow'].includes(target.kind);
  if (action === 'retry') return ['turn', 'agent', 'workflow', 'operation'].includes(target.kind);
  return action === 'reconcile' && target.kind === 'operation';
}
function validRequest(method, params) {
  if (!isContract(METHODS.get(method), params)) return false;
  if (method === 'work/list') return (params.cursor == null || validCursor(params.cursor)) &&
    (params.phase == null || knownValues.WorkPhase?.includes(params.phase)) &&
    (params.query == null || (Buffer.byteLength(params.query, 'utf8') <= 1024 && !cc.test(params.query)));
  if (!validWorkId(params.workId)) return false;
  if (method === 'work/read') return true;
  if (!validAtom(params.threadId)) return false;
  if (method === 'work/input/read') return validAtom(params.inputId);
  if (!validAtom(params.requestId) || !positive(params.expectedRevision)) return false;
  if (method === 'work/control') return validControlTarget(params.action, params.target);
  return validAtom(params.inputId) && validInteraction(params.interaction, params.threadId) &&
    (params.text == null || Buffer.byteLength(params.text, 'utf8') <= MAX_TEXT_BYTES) &&
    ((typeof params.text === 'string' && /\P{White_Space}/u.test(params.text)) || params.retention != null);
}
function projectView(value) {
  const view = pick('ContinuousWorkView', value);
  if (view.waiting != null) view.waiting = pick('ContinuousWorkWaitView', view.waiting);
  if (view.result != null) {
    const original = view.result;
    view.result = pick('ContinuousWorkResultView', original);
    // Older generated validators can coexist during an upgrade. Preserve this
    // separately validated optional observation for those clients as well.
    if (Object.hasOwn(original, 'deliveryRequirement')) view.result.deliveryRequirement = original.deliveryRequirement;
  }
  return view;
}
function validWorkView(view) {
  if (!validWorkId(view.workId) || !validAtom(view.threadId) || !positive(view.revision) ||
      !positive(view.requirementsRevision)) return false;
  if (view.title != null && (typeof view.title !== 'string' || Buffer.byteLength(view.title, 'utf8') > 512 ||
      cc.test(view.title))) return false;
  if (view.waiting != null && !validAtom(view.waiting.reference)) return false;
  if (view.result != null) {
    if (!validAtom(view.result.resultId) || view.result.artifactRefs.length > MAX_RESULT_REFERENCES ||
        !view.result.artifactRefs.every(reference => validAtom(reference))) return false;
    const requirement = view.result.deliveryRequirement;
    if (requirement != null && (typeof requirement !== 'string' || Buffer.byteLength(requirement, 'utf8') > 256)) return false;
    if (requirement === 'not_required' && view.result.requiredDeliveryState != null) return false;
  }
  return true;
}
function validWorkList(result) {
  if (!isContract('ContinuousWorkListResult', result) || result.items.length > 10 ||
      (result.nextCursor != null && !validCursor(result.nextCursor))) return false;
  const seen = new Set();
  return result.items.every(item => {
    if (!validWorkView(item) || seen.has(item.workId)) return false;
    seen.add(item.workId);
    return true;
  });
}
function authorityLive(client) {
  try { requireCapturedNativeRemoteSourceClient(client?.nativeRemoteSourceOwner); return true; }
  catch { return false; }
}
function clientCannotReadPartial(client) {
  return client?.[CONTINUOUS_WORK_READ_CAPABILITY] !== true ||
    client?.[CONTINUOUS_WORK_PARTIAL_LIST_CAPABILITY] !== true;
}
function isEphemeral(threadId, ephemeralOwners, retired) {
  return retired.has(threadId) || ephemeralOwners.has(threadId);
}
function consistentPresence(result) {
  switch (result.presence) {
    case undefined: case null: return true; // Legacy: null is only unobserved.
    case 'present': return result.work != null;
    case 'confirmed_absent': case 'unreadable': case 'unknown': return result.work == null;
    default: return true; // A future label stays observable, not an inferred absence.
  }
}

/** Per-client observations are hints, never task authority or subscriptions on the target. */
export class BrokerContinuousWork {
  #observed = new WeakMap();
  #retiredEphemeralThreads = new Map();
  #ephemeralOverflow = false;
  attach(client) { this.#observed.set(client, new Map()); }
  detach(client) { this.#observed.delete(client); }
  retireEphemeral(threadId) {
    if (!this.#retiredEphemeralThreads.has(threadId) && this.#retiredEphemeralThreads.size >= MAX_RETIRED_EPHEMERAL_THREADS) {
      // Do not evict an old privacy fence while target cleanup is unconfirmed.
      this.#ephemeralOverflow = true;
      return null;
    }
    const retirement = Symbol('ephemeral-retirement');
    this.#retiredEphemeralThreads.set(threadId, retirement);
    return retirement;
  }
  noteEphemeralOwner(threadId) {
    // A reused ID invalidates a late dispose acknowledgement from its old owner.
    if (this.#retiredEphemeralThreads.has(threadId))
      this.#retiredEphemeralThreads.set(threadId, Symbol('ephemeral-new-owner'));
  }
  settleEphemeral(threadId, retirement, response, backendCaps, ephemeralOwners) {
    if (!retirement || this.#retiredEphemeralThreads.get(threadId) !== retirement ||
        ephemeralOwners.has(threadId) || backendCaps?.[CONTINUOUS_WORK_NO_EPHEMERAL_CAPABILITY] !== true ||
        response?.error || response?.result?.threadId !== threadId || response.result.disposed !== true) return;
    this.#retiredEphemeralThreads.delete(threadId);
  }

  projectCapabilities(experimental, client) {
    const projected = { ...experimental };
    delete projected[CONTINUOUS_WORK_NO_EPHEMERAL_CAPABILITY];
    if (Object.hasOwn(experimental, CONTINUOUS_WORK_CAPABILITY)) projected[CONTINUOUS_WORK_CAPABILITY] =
      experimental[CONTINUOUS_WORK_CAPABILITY] === true && experimental[CONTINUOUS_WORK_NO_EPHEMERAL_CAPABILITY] === true &&
      client?.[CONTINUOUS_WORK_CAPABILITY] === true && authorityLive(client);
    if (Object.hasOwn(experimental, CONTINUOUS_WORK_READ_CAPABILITY)) projected[CONTINUOUS_WORK_READ_CAPABILITY] =
      experimental[CONTINUOUS_WORK_READ_CAPABILITY] === true &&
      client?.[CONTINUOUS_WORK_READ_CAPABILITY] === true && authorityLive(client);
    if (Object.hasOwn(experimental, CONTINUOUS_WORK_PARTIAL_LIST_CAPABILITY)) projected[CONTINUOUS_WORK_PARTIAL_LIST_CAPABILITY] =
      experimental[CONTINUOUS_WORK_PARTIAL_LIST_CAPABILITY] === true &&
      projected[CONTINUOUS_WORK_READ_CAPABILITY] === true &&
      client?.[CONTINUOUS_WORK_PARTIAL_LIST_CAPABILITY] === true && authorityLive(client);
    // Mutations submit a work revision the client can only learn from the read
    // projection, so both sides must negotiate read before input or control.
    const mutation = name => experimental[name] === true &&
      projected[CONTINUOUS_WORK_READ_CAPABILITY] === true && client?.[name] === true && authorityLive(client);
    if (Object.hasOwn(experimental, CONTINUOUS_WORK_INPUT_CAPABILITY)) projected[CONTINUOUS_WORK_INPUT_CAPABILITY] =
      mutation(CONTINUOUS_WORK_INPUT_CAPABILITY);
    if (Object.hasOwn(experimental, CONTINUOUS_WORK_CONTROL_CAPABILITY)) projected[CONTINUOUS_WORK_CONTROL_CAPABILITY] =
      mutation(CONTINUOUS_WORK_CONTROL_CAPABILITY);
    return projected;
  }

  admit(client, message, backendCaps, threadOwners, ephemeralOwners) {
    if (typeof message?.method !== 'string' || !message.method.startsWith('work/')) return null;
    if (!METHODS.has(message.method)) return reject(-32601, 'Unknown continuous work method');
    const full = client?.[CONTINUOUS_WORK_CAPABILITY] === true && backendCaps?.[CONTINUOUS_WORK_CAPABILITY] === true &&
      backendCaps?.[CONTINUOUS_WORK_NO_EPHEMERAL_CAPABILITY] === true;
    const readOnly = ['work/list', 'work/read'].includes(message.method) &&
      client?.[CONTINUOUS_WORK_READ_CAPABILITY] === true && backendCaps?.[CONTINUOUS_WORK_READ_CAPABILITY] === true;
    // Mutations need their own negotiated name on both sides; the read-only
    // capability alone must never authorize a write.
    const readNegotiated = client?.[CONTINUOUS_WORK_READ_CAPABILITY] === true &&
      backendCaps?.[CONTINUOUS_WORK_READ_CAPABILITY] === true;
    const input = ['work/input/submit', 'work/input/read'].includes(message.method) && readNegotiated &&
      client?.[CONTINUOUS_WORK_INPUT_CAPABILITY] === true && backendCaps?.[CONTINUOUS_WORK_INPUT_CAPABILITY] === true;
    const control = message.method === 'work/control' && readNegotiated &&
      client?.[CONTINUOUS_WORK_CONTROL_CAPABILITY] === true && backendCaps?.[CONTINUOUS_WORK_CONTROL_CAPABILITY] === true;
    if (client?.channel !== 'runtime' || client.initialized !== true || !(full || readOnly || input || control))
      return reject(-32601, `${CONTINUOUS_WORK_CAPABILITY} is unsupported or was not negotiated`);
    if (!authorityLive(client)) return reject(-32001, 'Current target authorization is unavailable');
    if (this.#ephemeralOverflow) return reject(-32023, 'Temporary work cleanup must be reconciled');
    if (!validRequest(message.method, message.params)) return reject(-32602, 'Invalid continuous work request');
    if (message.method === 'work/list' && message.params.allowPartial === true && clientCannotReadPartial(client))
      return reject(-32602, 'Partial continuous work list was not negotiated');
    if (THREAD_METHODS.has(message.method) &&
        isEphemeral(message.params.threadId, ephemeralOwners, this.#retiredEphemeralThreads))
      return reject(-32023, 'Continuous work cannot bind a temporary thread');
    if (THREAD_METHODS.has(message.method) && threadOwners.get(message.params.threadId) !== client)
      return reject(-32023, 'Continuous work mutation requires the current thread owner');
    const controlThread = message.method === 'work/control' ? message.params.target?.threadId : null;
    // This is a temporary conservative Gateway fence, not a Work membership
    // proof. A future native host must verify the original Work and authority.
    if (controlThread && (threadOwners.get(controlThread) !== client ||
        isEphemeral(controlThread, ephemeralOwners, this.#retiredEphemeralThreads)))
      return reject(-32023, 'Continuous work control requires the current non-temporary target owner');
    // The existing parent envelope authenticates retained turn/start only.
    // Keep work attachments closed until the host implements an equivalent path.
    if (message.method === 'work/input/submit' && message.params.retention != null)
      return reject(-32601, 'Retained attachments are not yet supported for continuous work input');
    return null;
  }

  projectResponse(message, pending, threadOwners, ephemeralOwners) {
    if (!METHODS.has(pending.method)) return message;
    const result = message.result;
    const mutation = ['work/input/submit', 'work/control'].includes(pending.method);
    const invalid = () => ({ jsonrpc: '2.0', id: message.id, error: mutation ? {
      code: -32034, message: 'Original continuous work outcome is unknown; reconcile using the original request identity',
    } : { code: -32603, message: 'Continuous work response could not be verified' } });
    const controlThread = pending.method === 'work/control' ? pending.params.target?.threadId : null;
    if (this.#ephemeralOverflow || !authorityLive(pending.client) || (THREAD_METHODS.has(pending.method) &&
        (threadOwners.get(pending.params.threadId) !== pending.client ||
          isEphemeral(pending.params.threadId, ephemeralOwners, this.#retiredEphemeralThreads))) ||
        (controlThread && (threadOwners.get(controlThread) !== pending.client ||
          isEphemeral(controlThread, ephemeralOwners, this.#retiredEphemeralThreads)))) return invalid();
    if (message.error) return projectError(pending.method, message.id, message.error);
    switch (pending.method) {
      case 'work/list':
        if (!validWorkList(result) || (result.partial === true &&
            (pending.params.allowPartial !== true || clientCannotReadPartial(pending.client)))) return invalid();
        return { ...message, result: { ...pick('ContinuousWorkListResult', result), items: result.items
          .filter(item => !isEphemeral(item.threadId, ephemeralOwners, this.#retiredEphemeralThreads)).map(projectView) } };
      case 'work/read':
        if (!isContract('ContinuousWorkReadResult', result) || !consistentPresence(result) ||
            (result.work != null && (result.work.workId !== pending.params.workId || !validWorkView(result.work)))) return invalid();
        if (result.work != null && isEphemeral(result.work.threadId, ephemeralOwners, this.#retiredEphemeralThreads))
          return { jsonrpc: '2.0', id: message.id, result: { work: null } };
        return { ...message, result: { ...pick('ContinuousWorkReadResult', result),
          ...(result.work == null ? {} : { work: projectView(result.work) }) } };
      case 'work/input/submit':
      case 'work/input/read': {
        if (!isContract('ContinuousWorkInputResult', result)) return invalid();
        const receipt = result.receipt;
        if (pending.method === 'work/input/submit' && receipt == null) return invalid();
        if (receipt != null && (receipt.workId !== pending.params.workId || receipt.threadId !== pending.params.threadId ||
            receipt.inputId !== pending.params.inputId ||
            (pending.method === 'work/input/submit' && receipt.requestId !== pending.params.requestId) ||
            (pending.method === 'work/input/submit' &&
              !isDeepStrictEqual(receipt.interaction ?? null, pending.params.interaction ?? null)))) return invalid();
        return { ...message, result: { ...pick('ContinuousWorkInputResult', result),
          ...(receipt == null ? {} : { receipt: pick('ContinuousWorkInputReceiptView', receipt) }) } };
      }
      case 'work/control':
        if (!isContract('ContinuousWorkControlResult', result) || result.workId !== pending.params.workId ||
            result.requestId !== pending.params.requestId || result.action !== pending.params.action ||
            !isDeepStrictEqual(result.target, pending.params.target)) return invalid();
        return { ...message, result: pick('ContinuousWorkControlResult', result) };
      default: return invalid();
    }
  }

  observe(client, pending, response) {
    if (response.error) return;
    const seen = this.#observed.get(client);
    if (!seen) return;
    const values = pending.method === 'work/list' ? response.result?.items :
      pending.method === 'work/read' ? [response.result?.work] :
      ['work/input/submit', 'work/input/read'].includes(pending.method) ? [response.result?.receipt] :
      pending.method === 'work/control' ? [response.result] : [];
    for (const item of values ?? []) {
      if (!validWorkId(item?.workId)) continue;
      const threadId = item.threadId ?? pending.params?.threadId;
      if (!validAtom(threadId)) continue;
      seen.delete(item.workId); seen.set(item.workId, threadId);
      while (seen.size > MAX_OBSERVED_WORKS) seen.delete(seen.keys().next().value);
    }
  }

  notification(client, message, backendCaps, ephemeralOwners) {
    if (message?.method !== 'work/changed') return message;
    if (this.#ephemeralOverflow || client?.channel !== 'runtime' || client.initialized !== true ||
        client[CONTINUOUS_WORK_CAPABILITY] !== true || backendCaps?.[CONTINUOUS_WORK_CAPABILITY] !== true ||
        backendCaps?.[CONTINUOUS_WORK_NO_EPHEMERAL_CAPABILITY] !== true ||
        !authorityLive(client) || !isContract('ContinuousWorkChanged', message.params)) return null;
    const threadId = this.#observed.get(client)?.get(message.params.workId);
    if (!threadId || isEphemeral(threadId, ephemeralOwners, this.#retiredEphemeralThreads)) return null;
    return { ...message, params: pick('ContinuousWorkChanged', message.params) };
  }
}
