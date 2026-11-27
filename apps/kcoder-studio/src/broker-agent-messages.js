import { agentMessageDiagnosticData } from '../shared/agentMessageReadDiagnostic.mjs';
import { AGENT_MESSAGE_CAPABILITIES, AGENT_MESSAGE_METHODS, agentMessageMethod, agentMessageCapability,
  AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY, AGENT_MESSAGE_REPLIES_CAPABILITY, AGENT_MESSAGE_TARGET_FILTER_FIELDS,
  validAgentMessageReceiptList, agentMessageReceiptErrorData,
  agentMessageDiscoveryRequiresSearch, agentMessageTargetQuery,
  validAgentMessageRequest, validAgentMessageReceipt, validAgentMessagePolicy, validAgentMessageTargetSelector } from '../shared/agentMessageMethods.mjs';
import { isContract } from '../shared/generated/validator.mjs';
export { AGENT_MESSAGE_CAPABILITIES };
export const ROUTED_AGENT_MESSAGE_METHODS = new Set([
  AGENT_MESSAGE_METHODS.targets, AGENT_MESSAGE_METHODS.send, AGENT_MESSAGE_METHODS.get, AGENT_MESSAGE_METHODS.listReceipts, AGENT_MESSAGE_METHODS.resolve,
]);
export class AgentMessageAdmissionError extends Error {
  constructor(message, code = -32023) { super(message); this.code = code; }
}
const discoveryQueries = new WeakMap();
function discoveryQueryContext(broker, ticket) {
  let clients = discoveryQueries.get(broker);
  if (!clients) { clients = new WeakMap(); discoveryQueries.set(broker, clients); }
  let cursors = clients.get(ticket.client);
  if (!cursors) { cursors = new Map(); clients.set(ticket.client, cursors); }
  const now = Date.now();
  for (const [key, entry] of cursors) if (entry.expires <= now) cursors.delete(key);
  const requested = agentMessageTargetQuery(ticket.params);
  const key = cursor => JSON.stringify([ticket.authorizationOwner, ticket.source, cursor]);
  const previous = requested.cursor == null ? undefined : cursors.get(key(requested.cursor));
  if (previous && AGENT_MESSAGE_TARGET_FILTER_FIELDS.some(field => requested[field] != null && requested[field] !== previous.query[field]))
    throw new AgentMessageAdmissionError('AGENT_MESSAGES_CURSOR_FILTER_MISMATCH');
  return { query: { ...previous?.query, ...requested }, known: requested.cursor == null || previous?.known === true,
    remember(cursor) {
      // Only query metadata is retained. Source access and allowedModes are
      // rechecked/projected for the actual client on every response.
      if (cursors.size >= 128) cursors.delete(cursors.keys().next().value);
      const { cursor: _old, ...query } = this.query;
      cursors.set(key(cursor), { query, known: this.known, expires: now + 120_000 });
    } };
}
/** The source selector locates an already-owned session; it never supplies an identity grant. */
export function claimAgentMessage(broker, client, message) {
  if (!agentMessageMethod(message.method)) return null;
  const capability = agentMessageCapability(message.method);
  const capabilities = broker.initializeResponse?.result?.capabilities?.experimental;
  if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id)) || !client?.initialized || !broker.clients.has(client) || client.nativeManagementOnly ||
      client[capability] !== true || capabilities?.[capability] !== true ||
      message.method === AGENT_MESSAGE_METHODS.send && (client.peerAgentMessagesV1 !== true || capabilities?.peerAgentMessagesV1 !== true))
    throw new AgentMessageAdmissionError('AGENT_MESSAGES_UNSUPPORTED', -32601);
  if (!validAgentMessageRequest(message.method, message.params))
    throw new AgentMessageAdmissionError('AGENT_MESSAGES_INVALID_REQUEST', -32602);
  if (message.method === AGENT_MESSAGE_METHODS.targets && agentMessageDiscoveryRequiresSearch(message.params) &&
      (client[AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY] !== true || capabilities?.[AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY] !== true))
    throw new AgentMessageAdmissionError('AGENT_MESSAGES_DISCOVERY_SEARCH_UNSUPPORTED', -32601);
  if (message.method === AGENT_MESSAGE_METHODS.send && message.params.message.replyToMessageId != null &&
      (client[AGENT_MESSAGE_REPLIES_CAPABILITY] !== true || capabilities?.[AGENT_MESSAGE_REPLIES_CAPABILITY] !== true))
    throw new AgentMessageAdmissionError('AGENT_MESSAGES_REPLIES_UNSUPPORTED', -32601);
  const source = message.params.sourceThreadId;
  if (broker.ephemeralThreadOwners.has(source) ||
      broker.threadOwners.get(source) !== client && !broker.sharedThreads.has(source, client))
    throw new AgentMessageAdmissionError('AGENT_MESSAGES_SOURCE_OWNER_REQUIRED');
  return { source, client, authorizationOwner: client.authorizationOwner, params: message.params, method: message.method };
}
export function projectAgentMessageResponse(broker, pending, response) {
  const ticket = pending.agentMessageTicket;
  if (!ticket) return response;
  const fail = (message, code = -32034) => ({ jsonrpc: '2.0', id: response.id, error: { code, message } });
  try {
    if (ticket.authorizationOwner !== ticket.client.authorizationOwner) throw new Error();
    claimAgentMessage(broker, ticket.client, { id: pending.clientId, method: ticket.method, params: ticket.params });
  } catch { return fail('AGENT_MESSAGES_SOURCE_CHANGED_OUTCOME_UNKNOWN'); }
  if (response.error) {
    const projected = fail('AGENT_MESSAGES_REQUEST_UNCONFIRMED',
      [-32600, -32601, -32602].includes(response.error.code) ? response.error.code : -32034);
    // Read diagnostics cannot certify a write outcome. Only a fresh authorized
    // policy read carries this closed, payload-free projection.
    if (ticket.method === AGENT_MESSAGE_METHODS.policyRead)
      projected.error.data = agentMessageDiagnosticData(response.error);
    if (ticket.method === AGENT_MESSAGE_METHODS.listReceipts && agentMessageReceiptErrorData(response.error))
      projected.error.data = agentMessageReceiptErrorData(response.error);
    return projected;
  }
  const value = response.result;
  if ([AGENT_MESSAGE_METHODS.policyRead, AGENT_MESSAGE_METHODS.policySave].includes(ticket.method)) {
    if (!validAgentMessagePolicy(value)) return fail('AGENT_MESSAGES_INVALID_POLICY', -32603);
    return { ...response, result: { enabled: value.enabled, wakeIdle: value.wakeIdle, revision: value.revision } };
  }
  if (ticket.method === AGENT_MESSAGE_METHODS.listReceipts) {
    const query = ticket.params;
    if (!validAgentMessageReceiptList(value, ticket.source) || value.items.length > (query.limit ?? 10) ||
        Buffer.byteLength(JSON.stringify(value)) > 112 * 1024 ||
        new Set(value.items.map(row => row.clientMessageId)).size !== value.items.length ||
        value.items.some(row => row.receipt && row.receipt.sourceAddress?.threadId !== ticket.source ||
          query.targetThreadId != null && row.targetAddress.threadId !== query.targetThreadId ||
          (query.status != null || query.createdAfterMs != null || query.createdBeforeMs != null) && row.confirmation !== 'confirmed' ||
          query.status != null && row.receipt?.status !== query.status ||
          query.createdAfterMs != null && !(row.createdAtMs >= query.createdAfterMs) ||
          query.createdBeforeMs != null && !(row.createdAtMs < query.createdBeforeMs))) return fail('AGENT_MESSAGES_INVALID_RESPONSE', -32603);
    return { ...response, result: value };
  }
  if (ticket.method === AGENT_MESSAGE_METHODS.targets) {
    let context;
    try { context = discoveryQueryContext(broker, ticket); }
    catch { return fail('AGENT_MESSAGES_CURSOR_FILTER_MISMATCH'); }
    const limit = context.query.limit ?? (context.known ? 10 : 256);
    const nativeSearchReady = broker.initializeResponse?.result?.capabilities?.experimental?.[AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY] === true;
    const searchReady = ticket.client[AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY] === true && nativeSearchReady;
    if (!isContract('CrossSessionMessageTargetsResult', value) || value.targets.length > limit ||
        value.targets.length > 10 && !searchReady || Buffer.byteLength(JSON.stringify(value)) > 112 * 1024 ||
        new Set(value.targets.map(target => target.threadId)).size !== value.targets.length ||
        value.targets.some(target => target.threadId === ticket.source || !validAgentMessageTargetSelector(target))) return fail('AGENT_MESSAGES_INVALID_RESPONSE', -32603);
    const messaging = ticket.client.crossSessionMessagesV1 === true && ticket.client.peerAgentMessagesV1 === true;
    if (!messaging && nativeSearchReady && !context.known) return fail('AGENT_MESSAGES_CURSOR_INVALID');
    if (context.query.allowedMode != null && !messaging)
      return { ...response, result: { coverage: value.coverage, completeness: 'complete', observedAtMs: value.observedAtMs, targets: [] } };
    if (context.query.allowedMode != null && value.targets.some(target => !target.allowedModes.includes(context.query.allowedMode)))
      return fail('AGENT_MESSAGES_INVALID_RESPONSE', -32603);
    const targets = value.targets.map(target => ({ threadId: target.threadId, status: target.status,
      presence: target.presence, allowedModes: messaging ? target.allowedModes : [],
      ...(target.address == null ? {} : { address: target.address }),
      ...(target.activeTurnId == null ? {} : { activeTurnId: target.activeTurnId }),
      ...(typeof target.title === 'string' ? { title: target.title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) } : {}),
      ...(target.runSummary ? { runSummary: target.runSummary } : {}),
      ...(target.lastTurn ? { lastTurn: target.lastTurn } : {}),
      ...(target.archivedAt ? { archivedAt: target.archivedAt } : {}),
      ...(target.lastHistoryUpdateAtMs == null ? {} : { lastHistoryUpdateAtMs: target.lastHistoryUpdateAtMs }) }));
    if (value.nextCursor) context.remember(value.nextCursor);
    return { ...response, result: { coverage: value.coverage, completeness: value.completeness, observedAtMs: value.observedAtMs, targets,
      ...(value.issueCount === undefined ? {} : { issueCount: value.issueCount }),
      ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}) } };
  }
  const receipt = ticket.method === AGENT_MESSAGE_METHODS.get ? value?.receipt : value;
  if (ticket.method === AGENT_MESSAGE_METHODS.get && receipt === null && value && Object.keys(value).every(key => key === 'receipt'))
    return { ...response, result: { receipt: null } };
  if (!validAgentMessageReceipt(receipt)) return fail('AGENT_MESSAGES_INVALID_RECEIPT');
  const expected = ticket.method === AGENT_MESSAGE_METHODS.send ? ticket.params.message : ticket.params.query;
  if (expected.clientMessageId && receipt.clientMessageId !== expected.clientMessageId ||
      expected.messageId && receipt.messageId !== expected.messageId ||
      expected.targetThreadId && receipt.targetThreadId !== expected.targetThreadId ||
      ticket.method === AGENT_MESSAGE_METHODS.send && (receipt.replyToMessageId ?? null) !== (expected.replyToMessageId ?? null))
    return fail('AGENT_MESSAGES_RECEIPT_MISMATCH');
  return { ...response, result: ticket.method === AGENT_MESSAGE_METHODS.get ? { receipt } : receipt };
}
export function projectAgentMessageCapabilities(experimental, client) {
  const result = { ...experimental };
  for (const capability of AGENT_MESSAGE_CAPABILITIES)
    if (Object.hasOwn(result, capability)) result[capability] = result[capability] === true && client?.[capability] === true;
  return result;
}
