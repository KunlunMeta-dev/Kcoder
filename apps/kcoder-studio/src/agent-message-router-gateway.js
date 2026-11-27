import { randomUUID } from 'node:crypto';
import { createAgentMessageRouter } from './agent-message-router.js';
import { claimAgentMessage, AgentMessageAdmissionError } from './broker-agent-messages.js';
import { AGENT_MESSAGE_METHODS, agentMessageTargetQuery, agentMessageReceiptQuery, agentMessageReceiptErrorData, agentMessageDiscoveryErrorData } from '../shared/agentMessageMethods.mjs';
import { AgentMessageRouterError, requireRouter } from './agent-message-router-private.js';
import { agentMessageDiagnosticData } from '../shared/agentMessageReadDiagnostic.mjs';
import { gatewayRequestTimeoutMs, GATEWAY_EXPIRED_REQUEST_DATA } from '../shared/gatewayRequestDeadline.js';

export { ROUTED_AGENT_MESSAGE_METHODS } from './broker-agent-messages.js';
const MAX_CANDIDATES = 64;
const internalRequest = (broker, method, params) => new Promise((resolve, reject) => {
  broker.sendInternalRequest(method, params, { onResponse: response => {
    if (response?.error || !response || !Object.hasOwn(response, 'result'))
      reject(new AgentMessageRouterError('AGENT_MESSAGES_NATIVE_RESULT_UNCONFIRMED'));
    else resolve(response.result);
  } });
});

/** Initialize only the held backend transport. This does not start/resume a
 * thread or grant any source authority. Public capability projection remains
 * broker-owned, including when another presentation client initializes first.
 */
export async function initializeAgentMessageEndpoint(broker) {
  if (broker.initializeResponse) return;
  const id = 'agent-router-init-' + randomUUID();
  let timer;
  let client;
  const result = new Promise((resolve, reject) => {
    client = { channel: 'control', send(message) {
      if (message.id === id) {
        if (message.error) reject(new AgentMessageRouterError('AGENT_MESSAGES_ROUTER_UNSUPPORTED', -32601));
        else resolve();
      } else if (['server/disconnected', 'server/transportError'].includes(message.method))
        reject(new AgentMessageRouterError('AGENT_MESSAGES_ENDPOINT_UNAVAILABLE'));
      return true;
    }, pause() {}, resume() {}, close() { reject(new AgentMessageRouterError('AGENT_MESSAGES_ENDPOINT_UNAVAILABLE')); } };
    timer = setTimeout(() => reject(new AgentMessageRouterError('AGENT_MESSAGES_ENDPOINT_UNAVAILABLE')), 15_000);
    timer.unref?.();
    broker.attach(client);
    broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: {
      protocolVersion: '2026-07-27', clientInfo: { name: 'kcoder-agent-message-router', version: '1' },
      capabilities: { experimental: {} },
    } }));
  });
  try { await result; }
  finally { clearTimeout(timer); broker.detach(client); }
}

/** Real Gateway composition adapter for local/HTTP/SSH saved target factories. */
export function createGatewayAgentMessageRouter({ getTarget, getTargets, targetSignature, loginContexts,
  getBrokers, reusableWorkspaceBroker, scheduleIdle, authenticatePeer }) {
  const open = async ({ target, serverId, workspacePath, authorizationOwner, verify }) => {
    verify();
    const selected = await reusableWorkspaceBroker(target, workspacePath, authorizationOwner, false, () => {
      try { verify(); return false; } catch { return true; }
    });
    if (!selected?.broker) { verify(); throw new AgentMessageRouterError('AGENT_MESSAGES_ENDPOINT_UNAVAILABLE'); }
    try {
      verify();
      await initializeAgentMessageEndpoint(selected.broker); verify();
      requireRouter(selected.broker.supportsAgentMessageRouter(),
        'AGENT_MESSAGES_ROUTER_UNSUPPORTED');
      // This path is reported by the authenticated target, not interpreted on
      // the Gateway machine. It is used only for authorized UI navigation.
      const actualWorkspace = selected.broker.initializeResponse.result.cwd;
      requireRouter(typeof actualWorkspace === 'string', 'AGENT_MESSAGES_WORKSPACE_UNKNOWN');
      return { broker: selected.broker, serverId, workspacePath: actualWorkspace, authorizationOwner };
    } finally { scheduleIdle?.(selected.key, selected.broker); }
  };
  const listEndpointCandidates = async ({ authorizationOwner, allowedServerIds, isTargetAllowed, verify }) => {
    const entries = [];
    const seen = new Set();
    let complete = true;
    const add = entry => {
      const key = JSON.stringify([entry.serverId, entry.workspacePath]);
      if (seen.has(key)) return;
      if (entries.length >= MAX_CANDIDATES) { complete = false; return; }
      entries.push(entry); seen.add(key);
    };
    for (const broker of getBrokers()) {
      const target = getTarget(broker.serverId);
      if (!target || !allowedServerIds.has(target.id) || broker.closed || broker.idleShutdown?.closing || broker.nativeManagementOnly ||
          target.security && broker.loginOwner !== authorizationOwner) continue;
      const workspacePath = broker.initializeResponse?.result?.cwd;
      if (typeof workspacePath === 'string') add({ broker, serverId: target.id, workspacePath });
    }
    for (const original of getTargets()) {
      verify();
      if (!allowedServerIds.has(original.id) || original.runtime !== 'kcoder') continue;
      if (entries.length >= MAX_CANDIDATES) { complete = false; break; }
      if (original.security && !loginContexts.identity(authorizationOwner, original.id)) { complete = false; continue; }
      const signature = targetSignature(original);
      const generation = loginContexts.generation(authorizationOwner, original.id);
      const check = () => {
        verify();
        const current = getTarget(original.id);
        requireRouter(isTargetAllowed(original.id) && current && targetSignature(current) === signature &&
          loginContexts.generation(authorizationOwner, original.id) === generation,
        'AGENT_MESSAGES_ENDPOINT_CHANGED');
      };
      try {
        const existing = entries.find(entry => entry.serverId === original.id);
        const base = existing ?? await open({ target: original, serverId: original.id,
          workspacePath: original.transport === 'local' ? original.cwd : original.remoteCwd,
          authorizationOwner, verify: check });
        check(); add(base);
        const listed = await internalRequest(base.broker, 'runtime.workspaces.list', {});
        check();
        requireRouter(listed?.success === true && Array.isArray(listed.items), 'AGENT_MESSAGES_WORKSPACE_ENUMERATION_UNKNOWN');
        for (const item of listed.items) {
          if (typeof item?.workspacePath !== 'string') { complete = false; continue; }
          if (item.available === false) { complete = false; continue; }
          add({ serverId: original.id, workspacePath: item.workspacePath });
        }
        if (listed.partial === true || listed.nextCursor != null) complete = false;
      } catch { verify(); complete = false; }
    }
    verify();
    return { entries, completeness: complete ? 'complete' : 'partial' };
  };
  return createAgentMessageRouter({ getTarget, targetSignature, loginContexts, openEndpoint: open,
    listEndpointCandidates, authenticatePeer });
}

/** Called only by the existing authenticated socket attachment. */
export function createAgentMessageClientDispatcher({ router, broker, client, session, verifySession, workspacePath,
  deadline = (method, callback) => { const timer = setTimeout(callback, gatewayRequestTimeoutMs(method)); timer.unref?.(); return () => clearTimeout(timer); } }) {
  const sources = new Map();
  const pending = new Set();
  const captureSource = sourceThreadId => {
    let captured = sources.get(sourceThreadId);
    if (!captured) {
      requireRouter(sources.size < 32, 'AGENT_MESSAGES_SOURCE_CAPACITY');
      captured = router.captureClient({ broker, client, session, verifySession, sourceThreadId,
        workspacePath: broker.initializeResponse?.result?.cwd ?? workspacePath });
      sources.set(sourceThreadId, captured);
      captured.catch(() => { if (sources.get(sourceThreadId) === captured) sources.delete(sourceThreadId); });
    }
    return captured;
  };
  const dispatch = async request => {
    const id = request.id;
    const validId = typeof id === 'string' && id.trim().length > 0 && Buffer.byteLength(id) <= 256 && !/[\p{Cc}]/u.test(id) || Number.isSafeInteger(id);
    let admitted = false;
    let settled = false;
    let cancelDeadline = () => {};
    const finish = response => {
      if (settled) return;
      settled = true; cancelDeadline();
      if (admitted) pending.delete(id);
      if (broker.clients.has(client)) client.send({ jsonrpc: '2.0', id: validId ? id : null, ...response });
    };
    try {
      if (request.jsonrpc !== '2.0' || !validId) throw new AgentMessageRouterError('AGENT_MESSAGES_INVALID_REQUEST', -32600);
      claimAgentMessage(broker, client, request);
      requireRouter(!pending.has(id) && pending.size < 8, 'AGENT_MESSAGES_REQUEST_CAPACITY');
      pending.add(id);
      admitted = true;
      cancelDeadline = deadline(request.method, () => finish({ error: { code: -32000,
        message: 'AGENT_MESSAGES_REQUEST_OUTCOME_UNKNOWN', data: GATEWAY_EXPIRED_REQUEST_DATA } }));
      const verify = () => {
        requireRouter(!settled && pending.has(id), 'AGENT_MESSAGES_REQUEST_CANCELLED');
        claimAgentMessage(broker, client, request);
      };
      const sourceThreadId = request.params.sourceThreadId;
      const source = await captureSource(sourceThreadId);
      verify();
      const handle = router.guardSource(source, verify);
      let result;
      if (request.method === AGENT_MESSAGE_METHODS.targets) {
        result = await router.targets(handle, agentMessageTargetQuery(request.params));
        if (client.crossSessionMessagesV1 !== true || client.peerAgentMessagesV1 !== true)
          result = { ...result, targets: result.targets.map(target => ({ ...target, allowedModes: [] })) };
      }
      else if (request.method === AGENT_MESSAGE_METHODS.send) result = await router.send(handle, request.params.message);
      else if (request.method === AGENT_MESSAGE_METHODS.get) result = await router.get(handle, request.params.query);
      else if (request.method === AGENT_MESSAGE_METHODS.listReceipts) result = await router.listReceipts(handle, agentMessageReceiptQuery(request.params));
      else if (request.method === AGENT_MESSAGE_METHODS.resolve) result = await router.resolveAddress(handle, request.params.address);
      else throw new AgentMessageRouterError('AGENT_MESSAGES_ROUTER_UNSUPPORTED', -32601);
      verify(); finish({ result });
    } catch (error) {
      const admission = error instanceof AgentMessageAdmissionError &&
        (request.method === AGENT_MESSAGE_METHODS.listReceipts || error.message === 'AGENT_MESSAGES_REPLIES_UNSUPPORTED') &&
        ['AGENT_MESSAGES_UNSUPPORTED', 'AGENT_MESSAGES_INVALID_REQUEST', 'AGENT_MESSAGES_SOURCE_OWNER_REQUIRED', 'AGENT_MESSAGES_REPLIES_UNSUPPORTED'].includes(error.message);
      const readData = request.method === AGENT_MESSAGE_METHODS.listReceipts ? agentMessageReceiptErrorData(error) :
        request.method === AGENT_MESSAGE_METHODS.targets ? agentMessageDiscoveryErrorData(error) : undefined;
      const readMessage = readData && { cursor_invalid: 'AGENT_MESSAGES_CURSOR_INVALID',
        cursor_filter_mismatch: 'AGENT_MESSAGES_CURSOR_FILTER_MISMATCH', search_unsupported: 'AGENT_MESSAGES_DISCOVERY_SEARCH_UNSUPPORTED',
        receipts_unsupported: 'AGENT_MESSAGES_RECEIPTS_UNSUPPORTED' }[readData.reason];
      finish({ error: {
        code: Number.isInteger(error?.code) ? error.code : -32034,
        message: readMessage ?? (error instanceof AgentMessageRouterError || admission
          ? error.message : 'AGENT_MESSAGES_REQUEST_UNCONFIRMED'),
        ...(readData ? { data: readData } : request.method === AGENT_MESSAGE_METHODS.targets && error instanceof AgentMessageRouterError && error.data
          ? { data: agentMessageDiagnosticData(error) } : {}),
      } });
    } finally { cancelDeadline(); if (admitted) pending.delete(id); settled = true; }
  };
  // A real Native attempt can select this existing attachment through the
  // owned backchannel. No session or authorization object enters public JSON.
  Object.defineProperty(dispatch, 'captureSource', { value: captureSource });
  return Object.freeze(dispatch);
}
