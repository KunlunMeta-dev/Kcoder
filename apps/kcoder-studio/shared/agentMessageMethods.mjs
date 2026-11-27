export const AGENT_MESSAGE_METHODS = Object.freeze({ targets: 'thread/agentMessage/targets', send: 'thread/agentMessage/send', get: 'thread/agentMessage/get', listReceipts: 'thread/agentMessage/receipts/list', resolve: 'thread/agentMessage/resolve', policyRead: 'thread/agentMessage/policy/read', policySave: 'thread/agentMessage/policy/save' });
export const AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY = 'crossSessionDiscoverySearchV1';
export const AGENT_MESSAGE_RECEIPTS_CAPABILITY = 'crossSessionMessageReceiptsV1';
export const AGENT_MESSAGE_REPLIES_CAPABILITY = 'crossSessionMessageRepliesV1';
export const AGENT_MESSAGE_CAPABILITIES = Object.freeze(['crossSessionDiscoveryV1', 'crossSessionMessagesV1', 'peerAgentMessagesV1', AGENT_MESSAGE_DISCOVERY_SEARCH_CAPABILITY, AGENT_MESSAGE_RECEIPTS_CAPABILITY, AGENT_MESSAGE_REPLIES_CAPABILITY]);
export const agentMessageMethod = method => Object.values(AGENT_MESSAGE_METHODS).includes(method);
export const agentMessageCapability = method => method === AGENT_MESSAGE_METHODS.listReceipts ? AGENT_MESSAGE_RECEIPTS_CAPABILITY : [AGENT_MESSAGE_METHODS.targets, AGENT_MESSAGE_METHODS.resolve].includes(method) ? 'crossSessionDiscoveryV1' : 'crossSessionMessagesV1';
export const agentMessageId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// Match Rust str::trim's Unicode White_Space set; do not normalize the identity.
const blankTurnIdentity = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;
export function validAgentTurnId(value) {
  if (typeof value !== 'string' || blankTurnIdentity.test(value) || agentMessageUtf8Bytes(value) > 256) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const cursor = value => value == null || typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f]/.test(value);
/** Hermes need not expose TextEncoder; count UTF-8 bytes without allocating a buffer. */
export function agentMessageUtf8Bytes(text) {
  let bytes = 0;
  for (const character of text) { const value = character.codePointAt(0); bytes += value <= 0x7f ? 1 : value <= 0x7ff ? 2 : value <= 0xffff ? 3 : 4; }
  return bytes;
}
const scopeSelector = value => typeof value === 'string' && value.trim().length > 0 && agentMessageUtf8Bytes(value) <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
export const AGENT_MESSAGE_TARGET_FILTER_FIELDS = Object.freeze(['title', 'query', 'targetId', 'status', 'presence', 'allowedMode']);
export const AGENT_MESSAGE_TARGET_QUERY_FIELDS = Object.freeze([...AGENT_MESSAGE_TARGET_FILTER_FIELDS, 'limit', 'cursor']);
const discoveryText = value => typeof value === 'string' && !blankTurnIdentity.test(value) &&
  agentMessageUtf8Bytes(value) <= 256 && !/[\p{Cc}]/u.test(value);
export function validAgentMessageTargetQuery(value) {
  return keys(value, AGENT_MESSAGE_TARGET_QUERY_FIELDS) && cursor(value.cursor) &&
    ['title', 'query', 'targetId'].every(key => value[key] == null || discoveryText(value[key])) &&
    (value.status == null || ['idle', 'running', 'waiting_for_approval', 'waiting_for_answer', 'failed', 'background', 'aggregating', 'unknown'].includes(value.status)) &&
    (value.presence == null || ['resident', 'not_resident', 'unknown'].includes(value.presence)) &&
    (value.allowedMode == null || ['enqueue_only', 'wake_if_idle'].includes(value.allowedMode)) &&
    (value.limit == null || Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 256);
}
export function agentMessageTargetQuery(value) {
  return Object.fromEntries(AGENT_MESSAGE_TARGET_QUERY_FIELDS.filter(key => value?.[key] != null).map(key => [key, value[key]]));
}
export function agentMessageDiscoveryRequiresSearch(value) {
  return AGENT_MESSAGE_TARGET_FILTER_FIELDS.some(key => value?.[key] != null) || value?.limit != null && value.limit !== 10;
}
const discoveryErrorReasons = Object.freeze({
  AGENT_MESSAGES_CURSOR_INVALID: 'cursor_invalid',
  AGENT_MESSAGES_CURSOR_FILTER_MISMATCH: 'cursor_filter_mismatch',
  AGENT_MESSAGES_DISCOVERY_SEARCH_UNSUPPORTED: 'search_unsupported',
});
export function agentMessageDiscoveryErrorData(error) {
  if (Object.hasOwn(discoveryErrorReasons, error?.message)) return { reason: discoveryErrorReasons[error.message] };
  return Object.values(discoveryErrorReasons).includes(error?.data?.reason) ? { reason: error.data.reason } : undefined;
}
const receiptErrorReasons = Object.freeze({
  AGENT_MESSAGES_CURSOR_INVALID: 'cursor_invalid',
  AGENT_MESSAGES_CURSOR_FILTER_MISMATCH: 'cursor_filter_mismatch',
  AGENT_MESSAGES_RECEIPTS_UNSUPPORTED: 'receipts_unsupported',
  AGENT_MESSAGES_UNSUPPORTED: 'receipts_unsupported',
});
export function agentMessageReceiptErrorData(error) {
  if (Object.hasOwn(receiptErrorReasons, error?.message)) return { reason: receiptErrorReasons[error.message] };
  return Object.values(receiptErrorReasons).includes(error?.data?.reason) ? { reason: error.data.reason } : undefined;
}
export function validAgentMessageAddress(value) {
  return keys(value, ['targetId', 'workspaceId', 'threadId']) && scopeSelector(value.targetId) && scopeSelector(value.workspaceId) && agentMessageId(value.threadId);
}
export function validAgentMessageTargetSelector(value) {
  return object(value) && agentMessageId(value.threadId) &&
    (value.address == null || validAgentMessageAddress(value.address) && value.address.threadId === value.threadId) &&
    (value.activeTurnId == null || validAgentTurnId(value.activeTurnId));
}
export function validAgentMessagePolicy(value) {
  return keys(value, ['enabled', 'wakeIdle', 'revision']) && typeof value.enabled === 'boolean' &&
    typeof value.wakeIdle === 'boolean' && scopeSelector(value.revision);
}
export function validAgentMessageResolvedAddress(value) {
  return keys(value, ['serverId', 'workspacePath', 'threadId', 'address']) && scopeSelector(value.serverId) &&
    typeof value.workspacePath === 'string' && value.workspacePath.length <= 32768 && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value.workspacePath) &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value.workspacePath) && validAgentMessageAddress(value.address) && value.threadId === value.address.threadId;
}
export const AGENT_MESSAGE_RECEIPT_FILTER_FIELDS = Object.freeze(['targetThreadId', 'status', 'createdAfterMs', 'createdBeforeMs']);
export const AGENT_MESSAGE_RECEIPT_QUERY_FIELDS = Object.freeze([...AGENT_MESSAGE_RECEIPT_FILTER_FIELDS, 'limit', 'cursor']);
const receiptStatuses = Object.freeze(['queued', 'delivering', 'applied', 'rejected', 'expired', 'unknown']);
const milliseconds = value => Number.isSafeInteger(value) && value >= 0;
export function agentMessageReceiptQuery(value) {
  return Object.fromEntries(AGENT_MESSAGE_RECEIPT_QUERY_FIELDS.filter(key => value?.[key] != null).map(key => [key, value[key]]));
}
export function validAgentMessageReceiptQuery(value) {
  return keys(value, AGENT_MESSAGE_RECEIPT_QUERY_FIELDS) && cursor(value.cursor) &&
    (value.targetThreadId == null || agentMessageId(value.targetThreadId)) &&
    (value.status == null || receiptStatuses.includes(value.status)) &&
    ['createdAfterMs', 'createdBeforeMs'].every(key => value[key] == null || milliseconds(value[key])) &&
    (value.createdAfterMs == null || value.createdBeforeMs == null || value.createdAfterMs < value.createdBeforeMs) &&
    (value.limit == null || Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 256);
}
export function validAgentMessageReceiptList(value, sourceThreadId) {
  if (sourceThreadId !== undefined && !agentMessageId(sourceThreadId)) return false;
  if (!keys(value, ['items', 'nextCursor', 'unconfirmedCount']) || !Array.isArray(value.items) || value.items.length > 256 ||
      !cursor(value.nextCursor) || !Number.isSafeInteger(value.unconfirmedCount) || value.unconfirmedCount < 0 || value.unconfirmedCount > 0xffffffff) return false;
  return value.items.every(row => keys(row, ['clientMessageId', 'targetAddress', 'mode', 'confirmation', 'receipt', 'createdAtMs', 'expiresAtMs', 'reasonCode']) &&
    agentMessageId(row.clientMessageId) && validAgentMessageAddress(row.targetAddress) &&
    ['enqueue_only', 'wake_if_idle'].includes(row.mode) && ['confirmed', 'missing', 'unconfirmed'].includes(row.confirmation) &&
    (row.confirmation === 'confirmed' ? validAgentMessageReceipt(row.receipt) && row.receipt.clientMessageId === row.clientMessageId &&
      (sourceThreadId === undefined || row.receipt.sourceAddress?.threadId === sourceThreadId) &&
      ['targetId', 'workspaceId', 'threadId'].every(key => row.receipt.targetAddress?.[key] === row.targetAddress[key]) : !Object.hasOwn(row, 'receipt')) &&
    (row.confirmation !== 'missing' || ['createdAtMs', 'expiresAtMs'].every(key => !Object.hasOwn(row, key))) &&
    ['createdAtMs', 'expiresAtMs'].every(key => row[key] == null || milliseconds(row[key])) &&
    (row.createdAtMs == null || row.expiresAtMs == null || row.expiresAtMs >= row.createdAtMs) &&
    (row.reasonCode == null || typeof row.reasonCode === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.reasonCode)));
}
export function validAgentMessageRequest(method, value) {
  if (!object(value) || !agentMessageId(value.sourceThreadId)) return false;
  if (method === AGENT_MESSAGE_METHODS.policyRead) return keys(value, ['sourceThreadId']);
  if (method === AGENT_MESSAGE_METHODS.resolve) return keys(value, ['sourceThreadId', 'address']) && validAgentMessageAddress(value.address);
  if (method === AGENT_MESSAGE_METHODS.policySave) return keys(value, ['sourceThreadId', 'expectedRevision', 'enabled', 'wakeIdle']) &&
    scopeSelector(value.expectedRevision) && typeof value.enabled === 'boolean' && typeof value.wakeIdle === 'boolean';
  if (method === AGENT_MESSAGE_METHODS.targets) return keys(value, ['sourceThreadId', ...AGENT_MESSAGE_TARGET_QUERY_FIELDS]) &&
    validAgentMessageTargetQuery(agentMessageTargetQuery(value));
  if (method === AGENT_MESSAGE_METHODS.listReceipts) return keys(value, ['sourceThreadId', ...AGENT_MESSAGE_RECEIPT_QUERY_FIELDS]) &&
    validAgentMessageReceiptQuery(agentMessageReceiptQuery(value));
  if (method === AGENT_MESSAGE_METHODS.get) {
    if (!keys(value, ['sourceThreadId', 'query']) || !keys(value.query, ['messageId', 'clientMessageId'])) return false;
    const query = value.query;
    return agentMessageId(query.messageId) && query.clientMessageId == null || agentMessageId(query.clientMessageId) && query.messageId == null;
  }
  if (method !== AGENT_MESSAGE_METHODS.send || !keys(value, ['sourceThreadId', 'message']) ||
      !keys(value.message, ['targetThreadId', 'targetAddress', 'clientMessageId', 'mode', 'expectedTurnId', 'replyToMessageId', 'text'])) return false;
  const message = value.message;
  return agentMessageId(message.targetThreadId) && (message.targetAddress == null ? message.targetThreadId !== value.sourceThreadId :
    validAgentMessageAddress(message.targetAddress) && message.targetAddress.threadId === message.targetThreadId) &&
    agentMessageId(message.clientMessageId) && ['enqueue_only', 'wake_if_idle'].includes(message.mode) &&
    (message.expectedTurnId == null || validAgentTurnId(message.expectedTurnId) && message.mode === 'enqueue_only') &&
    (message.replyToMessageId == null || agentMessageId(message.replyToMessageId)) &&
    typeof message.text === 'string' && message.text.trim().length > 0 && agentMessageUtf8Bytes(message.text) <= 16 * 1024;
}
export function validAgentMessageReceipt(value) {
  return keys(value, ['messageId', 'clientMessageId', 'targetThreadId', 'status', 'revision', 'reasonCode', 'sourceAddress', 'targetAddress', 'replyToMessageId']) &&
    [value.messageId, value.clientMessageId, value.targetThreadId].every(agentMessageId) &&
    ['queued', 'delivering', 'applied', 'rejected', 'expired', 'unknown'].includes(value.status) &&
    (value.replyToMessageId == null || agentMessageId(value.replyToMessageId)) &&
    Number.isSafeInteger(value.revision) && value.revision > 0 &&
    (value.reasonCode == null || typeof value.reasonCode === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.reasonCode)) &&
    (value.sourceAddress == null && value.targetAddress == null || validAgentMessageAddress(value.sourceAddress) &&
      validAgentMessageAddress(value.targetAddress) && value.targetAddress.threadId === value.targetThreadId &&
      JSON.stringify([value.sourceAddress.targetId, value.sourceAddress.workspaceId, value.sourceAddress.threadId]) !==
      JSON.stringify([value.targetAddress.targetId, value.targetAddress.workspaceId, value.targetAddress.threadId]));
}
