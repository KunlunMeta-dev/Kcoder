import channelPlatforms from './channel-platforms.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { requireValue } from './errors.mjs';

const SECRET_KEY = /^(?:secret|token|(?:app|bot|client)[_-]?secret|(?:access|refresh|bot|tenant[_-]?access|user[_-]?access)[_-]?token|api[_-]?key|password|authorization|cookie|session[_-]?(?:webhook|key)|context[_-]?token|aes[_-]?key|media[_-]?key|product[_-]?grant)$/i;
const SECRET_ALIAS = /^(?:(?:auth|id|bot[_-]?access)[_-]?token|(?:api|webhook|sign)[_-]?secret|(?:secret|private|signing)[_-]?key|secret[_-]?value|x[_-]?api[_-]?key)$/i;
export const PLATFORMS = Object.freeze(Object.keys(channelPlatforms));
/** Configuration field holding each platform's globally assigned bot identity. */
export const PLATFORM_IDENTITY_FIELD = Object.freeze(Object.fromEntries(Object.entries(channelPlatforms).map(([kind, value]) => [kind, value.identityField])));
export const MAX_JSON_BYTES = 256 * 1024;
export function identifier(value, field = 'identifier') {
  requireValue(typeof value === 'string' && value.length > 0 && [...value].length <= 256, 'INVALID_' + field.toUpperCase());
  return value;
}
export function boundedText(value, max = 64 * 1024) {
  requireValue(typeof value === 'string', 'INVALID_TEXT');
  requireValue(Buffer.byteLength(value) <= max, 'TEXT_TOO_LARGE');
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
  requireValue(value && typeof value === 'object', 'INVALID_JSON_VALUE');
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === null || prototype === Object.prototype, 'INVALID_JSON_VALUE');
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
}
export function privatePayload(value) {
  let bytes = 0;
  const add = count => { bytes += count; requireValue(bytes <= MAX_JSON_BYTES, 'PAYLOAD_TOO_LARGE'); };
  const string = value => {
    // UTF-16 length is a cheap lower bound before creating any escaped copy.
    requireValue(value.length <= MAX_JSON_BYTES - bytes, 'PAYLOAD_TOO_LARGE');
    add(Buffer.byteLength(JSON.stringify(value)));
  };
  const walk = (obj, depth) => {
    requireValue(depth <= 32, 'JSON_DEPTH_EXCEEDED');
    if (typeof obj === 'string') { string(obj); return; }
    if (obj === null) { add(4); return; }
    if (typeof obj === 'boolean' || typeof obj === 'number') { add(String(obj).length); return; }
    if (typeof obj !== 'object') return;
    add(2);
    let count = 0;
    if (Array.isArray(obj)) {
      for (const val of obj) { if (count++) add(1); walk(val, depth + 1); }
    } else for (const key in obj) {
      if (!Object.hasOwn(obj, key)) continue;
      requireValue(!SECRET_KEY.test(key) && !SECRET_ALIAS.test(key), 'SECRET_IN_PUBLIC_PAYLOAD');
      if (count++) add(1); string(key); add(1); walk(obj[key], depth + 1);
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
  // Explicit hosts own HTTPS destinations; allowLoopback only permits local HTTP.
  requireValue((url.protocol === 'https:' || (allowLoopback && loopback && url.protocol === 'http:')) && !url.username && !url.password && !url.hash, 'UNSAFE_URL');
  requireValue(Array.isArray(allowedHosts) && allowedHosts.length > 0
    && allowedHosts.every(host => typeof host === 'string' && host.length > 0)
    && allowedHosts.some(host => host.toLowerCase() === url.hostname), 'UNAPPROVED_HOST');
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
