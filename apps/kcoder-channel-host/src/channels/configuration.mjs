import { channelPlatform } from '../adapters/contract.mjs';
import { connectionFeatures } from '../adapters/feature-options.mjs';
import { validateGithubConfigurationDraft } from '../adapters/github.mjs';
import { privatePayload } from '../validation.mjs';

const EVENT_FIELDS = new Set(['platform', 'channelId', 'tenantId', 'botId', 'chatKind', 'conversationId', 'topicId',
  'eventId', 'sourceMessageId', 'senderId', 'senderName', 'chatLabel', 'text', 'occurredAtMs', 'receivedAtMs', 'kind',
  'replyRef', 'replyToMessageId', 'platformRoute', 'streamReplyRef', 'streamId', 'streamFirstReplyDeadlineMs',
  'streamContextExpiresAtMs', 'cardActionRef', 'cardTaskId']);
const MEDIA_FIELDS = new Set(['kind', 'mediaId', 'sourceMessageId', 'filename']);
function shape(platform, value, secret) {
  const definition = channelPlatform(platform);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(secret ? 'CHANNEL_CREDENTIALS_INVALID' : 'CHANNEL_CONFIGURATION_INVALID');
  const keys = secret ? [definition.credentialField] : [...definition.configurationFields, 'features'];
  return Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
}
/** Explicit one-time migration keeps platform configuration and credentials, not old policy artifacts. */
export function migrateChannelConfiguration(platform, value) {
  if (value && Object.keys(value).some(key => /secret|token|password|private.?key/i.test(key))) throw new Error('CHANNEL_CONFIGURATION_INVALID');
  const projected = shape(platform, value, false);
  validateChannelConfiguration(platform, projected);
  return projected;
}
export function migrateChannelCredentials(platform, value) {
  const projected = shape(platform, value, true);
  validateChannelCredentials(platform, projected);
  return projected;
}
export function validateChannelConfiguration(platform, value) {
  if (Object.keys(shape(platform, value, false)).length !== Object.keys(value).length) throw new Error('CHANNEL_CONFIGURATION_INVALID');
  privatePayload(value);
  const definition = channelPlatform(platform);
  for (const key of definition.configurationFields) {
    if (value[key] === undefined || ['repositories', 'pollIntervalSeconds', 'intents'].includes(key)) continue;
    if (typeof value[key] !== 'string' || (key !== 'locale' && !value[key].trim()) || value[key].length > 4096 || /[\u0000-\u001f\u007f]/.test(value[key])) throw new Error('CHANNEL_CONFIGURATION_INVALID');
  }
  if (value.intents !== undefined && (!Number.isSafeInteger(value.intents) || value.intents < 0)) throw new Error('CHANNEL_CONFIGURATION_INVALID');
  if (platform === 'github') validateGithubConfigurationDraft(value);
  connectionFeatures(platform, value.features);
}
export function validateChannelCredentials(platform, value) {
  const projected = shape(platform, value, true), entries = Object.entries(projected);
  if (entries.length !== 1 || Object.keys(value).length !== 1 || typeof entries[0][1] !== 'string' || !entries[0][1].trim()
      || /[\u0000-\u001f\u007f]/.test(entries[0][1])) {
    throw new Error('CHANNEL_CREDENTIALS_INVALID');
  }
}
export function withoutChannelAuthority(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('CHANNEL_EVENT_INVALID');
  // Preserve normalized platform facts and opaque context references, never raw SDK/authority envelopes.
  const value = {};
  for (const [key, item] of Object.entries(event)) {
    if (!EVENT_FIELDS.has(key)) continue;
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new Error('CHANNEL_EVENT_INVALID');
    value[key] = item;
  }
  if (event.attachments !== undefined) {
    if (!Array.isArray(event.attachments) || event.attachments.length > 32) throw new Error('CHANNEL_EVENT_INVALID');
    value.attachments = event.attachments.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('CHANNEL_EVENT_INVALID');
      return Object.fromEntries(Object.entries(item).filter(([key, field]) => MEDIA_FIELDS.has(key) && typeof field === 'string'));
    });
  }
  privatePayload(value);
  return value;
}
