import { nativeRemoteSourceClientForAttempt } from './remotes/source-client-owner.mjs';
import { AGENT_MESSAGE_METHODS, agentMessageId, validAgentMessageRequest, validAgentMessageTargetQuery, validAgentMessageReceiptQuery,
  agentMessageDiscoveryErrorData, agentMessageReceiptErrorData } from '../shared/agentMessageMethods.mjs';
import { AgentMessageRouterError, WAKE_READ_CAPABILITY, requireRouter } from './agent-message-router-private.js';
import { validSessionReadRequest } from './agent-message-router-session-read.js';

export const PEER_ROUTER_HOST_METHOD = 'kcoder/peerRouter/requestV1';
export const isPeerRouterHostMethod = method => typeof method === 'string' && method.startsWith('kcoder/peerRouter/');
export const isPeerRouterHostRequestId = id => typeof id === 'string' && id.startsWith('peer-router-');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
const attemptComponent = value => typeof value === 'string' && value.trim().length > 0 &&
  Buffer.byteLength(value) <= 256 && !/[\p{Cc}]/u.test(value);
const defaultDeadline = callback => { const timer = setTimeout(callback, 30_000); timer.unref?.(); return () => clearTimeout(timer); };

/** Consume only frames from the held real Native child. This is a separate
 * purpose from Native Remote grants; the old helper only selects the actual
 * active attempt's authenticated socket owner and cannot authorize a route.
 */
export function createAgentMessageRouterBackchannel({ child, serverId, getBroker, getRouter, assertSourceOwner,
  reply, deadline = defaultDeadline }) {
  if (!child || typeof serverId !== 'string' || [getBroker, getRouter, assertSourceOwner, reply, deadline].some(value => typeof value !== 'function'))
    throw new TypeError('Peer router requires the actual Native child owner');
  const pending = new Map();
  const namespaces = new Map();
  let closed = false;
  const reject = (id, message = 'AGENT_MESSAGES_NATIVE_SOURCE_UNAVAILABLE') => {
    if (!closed) reply({ jsonrpc: '2.0', id: typeof id === 'string' && id.length <= 256 ? id : null,
      error: { code: -32034, message } });
  };
  const claimId = id => {
    if (typeof id !== 'string' || id.length > 256) return false;
    const match = /^(peer-router-[A-Za-z0-9_-]+)-(0|[1-9][0-9]{0,19})$/.exec(id);
    if (!match) return false;
    const sequence = BigInt(match[2]);
    let namespace = namespaces.get(match[1]);
    if (!namespace) {
      if (namespaces.size >= 128) return false;
      namespace = { maximum: sequence, seen: new Set() }; namespaces.set(match[1], namespace);
    }
    if (namespace.seen.has(match[2]) || sequence + 1024n <= namespace.maximum) return false;
    if (sequence > namespace.maximum) namespace.maximum = sequence;
    namespace.seen.add(match[2]);
    for (const old of namespace.seen) if (BigInt(old) + 1024n <= namespace.maximum) namespace.seen.delete(old);
    return true;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const record of pending.values()) { record.cancelDeadline(); record.abort.abort(); }
    pending.clear(); namespaces.clear();
  };
  child.once('close', close);
  function receiveBackend(request) {
    if (!isPeerRouterHostMethod(request?.method)) return false;
    if (closed) return true;
    if (request.method !== PEER_ROUTER_HOST_METHOD || !keys(request, ['jsonrpc', 'id', 'method', 'params']) ||
        request.jsonrpc !== '2.0' || !claimId(request.id) || pending.size >= 8) {
      reject(request.id, 'AGENT_MESSAGES_NATIVE_REQUEST_INVALID'); return true;
    }
    const params = request.params;
    const attempt = params?.sourceAttempt;
    const kind = params?.kind;
    const originalCheck = kind === 'verifyOriginal';
    const sessionRead = kind === 'read';
    const method = { targets: AGENT_MESSAGE_METHODS.targets, send: AGENT_MESSAGE_METHODS.send, sendReply: AGENT_MESSAGE_METHODS.send, get: AGENT_MESSAGE_METHODS.get, listReceipts: AGENT_MESSAGE_METHODS.listReceipts }[kind];
    const wrapped = { ...(['send', 'sendReply'].includes(kind) ? { message: params?.payload } : kind === 'get' ? { query: params?.payload } : params?.payload),
      sourceThreadId: attempt?.threadId };
    const validAttempt = keys(attempt, ['threadId', 'turnId', 'attemptId']) && agentMessageId(attempt.threadId) && Object.values(attempt).every(attemptComponent);
    const validPayload = originalCheck ? object(params?.payload) && Object.hasOwn(params.payload, 'attestation') &&
      Object.hasOwn(params.payload, 'access') && Object.keys(params.payload).every(key => ['attestation', 'access', 'message'].includes(key)) &&
      ['observe', 'append', 'wake'].includes(params.payload.access) && (attempt === null || validAttempt &&
        attempt.threadId === params.payload.attestation?.claims?.destination?.threadId) :
      sessionRead ? validAttempt && validSessionReadRequest(attempt.threadId, params.payload) :
      validAttempt && method && validAgentMessageRequest(method, wrapped) &&
      (kind !== 'sendReply' || params.payload?.replyToMessageId != null && params.payload?.targetAddress != null) &&
      (kind !== 'targets' || validAgentMessageTargetQuery(params.payload)) &&
      (kind !== 'listReceipts' || validAgentMessageReceiptQuery(params.payload));
    if (!keys(params, ['kind', 'sourceAttempt', 'payload']) || !validPayload) {
      reject(request.id, 'AGENT_MESSAGES_NATIVE_REQUEST_INVALID'); return true;
    }
    const record = { abort: new AbortController(), cancelDeadline: () => {} };
    pending.set(request.id, record);
    const finish = response => {
      if (closed || pending.get(request.id) !== record) return;
      pending.delete(request.id); record.cancelDeadline(); record.abort.abort();
      reply({ jsonrpc: '2.0', id: request.id, ...response });
    };
    record.cancelDeadline = deadline(() => finish({ error: { code: -32034, message: 'AGENT_MESSAGES_NATIVE_REQUEST_OUTCOME_UNKNOWN' } }));
    void Promise.resolve().then(async () => {
      assertSourceOwner({ child, serverId });
      const broker = getBroker();
      requireRouter(broker?.child === child && broker.supportsAgentMessageRouter(),
      'AGENT_MESSAGES_ROUTER_UNSUPPORTED');
      if (originalCheck) {
        const verify = () => {
          requireRouter(!closed && !record.abort.signal.aborted && pending.get(request.id) === record,
            'AGENT_MESSAGES_NATIVE_REQUEST_CANCELLED');
          assertSourceOwner({ child, serverId });
          requireRouter(getBroker() === broker && broker.child === child && broker.supportsAgentMessageRouter(),
          'AGENT_MESSAGES_DESTINATION_HOLDER_UNAVAILABLE');
        };
        verify();
        const router = getRouter();
        requireRouter(typeof router?.verifyOriginalOperation === 'function', 'AGENT_MESSAGES_ROUTER_UNSUPPORTED');
        const result = await router.verifyOriginalOperation({ destinationBroker: broker,
          attestation: params.payload.attestation, access: params.payload.access, message: params.payload.message, verifyCaller: verify });
        verify(); finish({ result }); return;
      }
      const active = broker.activeTurns.get(attempt.threadId);
      const wakeRead = ['read', 'targets', 'get', 'listReceipts'].includes(kind) &&
        broker.initializeResponse?.result?.capabilities?.experimental?.[WAKE_READ_CAPABILITY] === true;
      if ((kind === 'sendReply' || wakeRead) && (!active || !active.owner || !broker.clients.has(active.owner))) {
        const verify = () => {
          requireRouter(!closed && !record.abort.signal.aborted && pending.get(request.id) === record,
            'AGENT_MESSAGES_NATIVE_REQUEST_CANCELLED');
          assertSourceOwner({ child, serverId });
          requireRouter(getBroker() === broker && broker.child === child && broker.supportsAgentMessageRouter(),
            'AGENT_MESSAGES_NATIVE_SOURCE_UNAVAILABLE');
        };
        verify();
        const router = getRouter();
        if (wakeRead) {
          requireRouter(typeof router?.readForWake === 'function', 'AGENT_MESSAGES_ROUTER_UNSUPPORTED');
          const result = await router.readForWake({ broker, requestId: request.id, attempt, kind, payload: params.payload, verifyCaller: verify });
          verify(); finish({ result }); return;
        }
        requireRouter(typeof router?.sendBackgroundReply === 'function', 'AGENT_MESSAGES_ROUTER_UNSUPPORTED');
        const result = await router.sendBackgroundReply({ broker, attempt, message: params.payload, verifyCaller: verify });
        verify(); finish({ result }); return;
      }
      requireRouter(active && active.turnId === attempt.turnId && active.attemptId === attempt.attemptId,
        'AGENT_MESSAGES_NATIVE_ATTEMPT_CHANGED');
      const owner = nativeRemoteSourceClientForAttempt(broker, attempt);
      const client = active.owner;
      requireRouter(client && broker.clients.has(client) && client.nativeRemoteSourceOwner === owner &&
        typeof client.routeAgentMessage?.captureSource === 'function', 'AGENT_MESSAGES_NATIVE_SOURCE_UNAVAILABLE');
      const verify = () => {
        requireRouter(!closed && !record.abort.signal.aborted && pending.get(request.id) === record,
          'AGENT_MESSAGES_NATIVE_REQUEST_CANCELLED');
        assertSourceOwner({ child, serverId }); owner.verify();
        requireRouter(getBroker() === broker && broker.child === child && broker.supportsAgentMessageRouter() &&
          broker.activeTurns.get(attempt.threadId) === active && active.turnId === attempt.turnId && active.attemptId === attempt.attemptId &&
          active.owner === client && client.nativeRemoteSourceOwner === owner && broker.clients.has(client),
        'AGENT_MESSAGES_NATIVE_ATTEMPT_CHANGED');
      };
      verify();
      const router = getRouter();
      requireRouter(router && typeof router.guardSource === 'function', 'AGENT_MESSAGES_ROUTER_UNSUPPORTED');
      const source = await client.routeAgentMessage.captureSource(attempt.threadId); verify();
      const guarded = router.guardSource(source, verify);
      let result;
      if (kind === 'targets') result = await router.targets(guarded, params.payload);
      else if (sessionRead) {
        requireRouter(typeof router.read === 'function', 'AGENT_MESSAGES_SESSION_READ_UNSUPPORTED');
        result = await router.read(guarded, params.payload);
      }
      else if (kind === 'send' || kind === 'sendReply') result = await router.send(guarded, params.payload);
      else if (kind === 'listReceipts') result = await router.listReceipts(guarded, params.payload);
      else result = await router.get(guarded, params.payload);
      verify(); finish({ result });
    }).catch(error => finish({ error: { code: error instanceof AgentMessageRouterError && [-32601, -32602].includes(error.code) ? error.code : -32034,
      message: error instanceof AgentMessageRouterError && /^AGENT_MESSAGES_[A-Z0-9_]{1,100}$/.test(error.message) ?
        error.message : 'AGENT_MESSAGES_NATIVE_SOURCE_UNAVAILABLE',
      ...(kind === 'targets' && error instanceof AgentMessageRouterError && agentMessageDiscoveryErrorData(error)
        ? { data: agentMessageDiscoveryErrorData(error) } : kind === 'listReceipts' && agentMessageReceiptErrorData(error)
          ? { data: agentMessageReceiptErrorData(error) } : {}) } }));
    return true;
  }
  return Object.freeze({ receiveBackend, close });
}
