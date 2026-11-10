import channelPlatforms from './channel-platforms.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { requireValue } from './errors.mjs';

const SECRET_KEY = /^(?:secret|token|(?:app|bot|client)[_-]?secret|(?:access|refresh|bot|tenant[_-]?access|user[_-]?access)[_-]?token|api[_-]?key|password|authorization|cookie|session[_-]?(?:webhook|key)|context[_-]?token|aes[_-]?key|media[_-]?key|product[_-]?grant)$/i;
export const PLATFORMS = Object.freeze(Object.keys(channelPlatforms));
/** Configuration field holding each platform's globally assigned bot identity. */
export const PLATFORM_IDENTITY_FIELD = Object.freeze(Object.fromEntries(Object.entries(channelPlatforms).map(([kind, value]) => [kind, value.identityField])));
export const MAX_JSON_BYTES = 256 * 1024;
export function identifier(value, field = 'identifier') {
  requireValue(typeof value === 'string' && value.length > 0 && [...value].length <= 256, 'INVALID_' + field.toUpperCase());
  return value;
}
export function boundedText(value, max = 64 * 1024) {
  requireValue(typeof value === 'string' && Buffer.byteLength(value) <= max, 'TEXT_TOO_LARGE');
  return value;
}
export function scopeKey(scope) {
  requireValue(scope && typeof scope === 'object' && !Array.isArray(scope), 'INVALID_SCOPE');
  const keys = ['accountId', 'targetId', 'workspaceId', 'identityGeneration', 'targetRevision'];
  requireValue(Object.keys(scope).every(key => [...keys, 'organizationId'].includes(key)), 'INVALID_SCOPE');
  for (const key of keys) requireValue(Object.hasOwn(scope, key), 'INVALID_SCOPE');
  for (const key of ['accountId', 'targetId', 'identityGeneration', 'targetRevision']) identifier(scope[key], 'scope');
  if (scope.workspaceId !== null) identifier(scope.workspaceId, 'scope');
  if (scope.organizationId !== undefined && scope.organizationId !== null) identifier(scope.organizationId, 'scope');
  return canonical({ ...Object.fromEntries(keys.map(k => [k, scope[k]])), organizationId: scope.organizationId ?? null });
}
export function ownerKey(scope) {
  for(const key of ['accountId','targetId'])identifier(scope?.[key], 'owner');
  requireValue(Object.hasOwn(scope,'workspaceId'), 'INVALID_OWNER');
  if(scope.workspaceId!==null)identifier(scope.workspaceId,'owner');
  if(scope.organizationId!==undefined&&scope.organizationId!==null)identifier(scope.organizationId,'owner');
  return canonical({accountId:scope.accountId,targetId:scope.targetId,workspaceId:scope.workspaceId,organizationId:scope.organizationId??null});
}
export function canonical(value, depth = 0) {
  requireValue(depth <= 32, 'JSON_DEPTH_EXCEEDED');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value), 'INVALID_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']';
  requireValue(value && typeof value === 'object' && Object.getPrototypeOf(value) !== null ? Object.getPrototypeOf(value) === Object.prototype : value && typeof value === 'object', 'INVALID_JSON_VALUE');
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
}
export function privatePayload(value) {
  const walk = (obj, depth) => {
    requireValue(depth <= 32, 'JSON_DEPTH_EXCEEDED');
    if (!obj || typeof obj !== 'object') return;
    for (const [key, val] of Object.entries(obj)) {
      requireValue(!SECRET_KEY.test(key), 'SECRET_IN_PUBLIC_PAYLOAD');
      walk(val, depth + 1);
    }
  };
  walk(value, 0);
  const text = canonical(value);
  requireValue(Buffer.byteLength(text) <= MAX_JSON_BYTES, 'PAYLOAD_TOO_LARGE');
  return text;
}
export function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function stableId(domain, values) {
  return domain + '_' + digest(values);
}
export function httpsUrl(raw, { allowedHosts, allowLoopback = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { requireValue(false, 'INVALID_URL'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  requireValue((url.protocol === 'https:' || (allowLoopback && loopback && url.protocol === 'http:')) && !url.username && !url.password && !url.hash, 'UNSAFE_URL');
  if (allowedHosts) requireValue(allowedHosts.includes(url.hostname), 'UNAPPROVED_HOST');
  return url;
}
export function validateEvent(event) {
  requireValue(event && PLATFORMS.includes(event.platform), 'INVALID_PLATFORM');
  for (const field of ['channelId', 'tenantId', 'botId', 'eventId', 'senderId', 'conversationId']) identifier(event[field], field);
  requireValue(['private', 'group', 'channel'].includes(event.chatKind), 'INVALID_CHAT_KIND');
  if(event.topicId!=null)identifier(event.topicId,'topic');
  requireValue(['message', 'control', 'edit', 'delete', 'reaction', 'receipt', 'membership'].includes(event.kind), 'INVALID_EVENT_KIND');
  boundedText(event.text ?? '');
  requireValue(Array.isArray(event.attachments ?? []) && (event.attachments ?? []).length <= 32, 'TOO_MANY_ATTACHMENTS');
  privatePayload(event);
  return event;
}
