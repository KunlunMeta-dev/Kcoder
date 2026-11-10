import { channelPlatform } from '../adapters/contract.mjs';
import { connectionFeatures } from '../adapters/feature-options.mjs';
function shape(platform, value, secret) {
  const definition = channelPlatform(platform);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(secret ? 'CHANNEL_CREDENTIALS_INVALID' : 'CHANNEL_CONFIGURATION_INVALID');
  const keys = secret ? [definition.credentialField] : [...definition.configurationFields, 'features'];
  return Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
}
/** Explicit one-time migration keeps platform configuration and credentials, not old policy artifacts. */
export function migrateChannelConfiguration(platform, value) {
  if (value && Object.keys(value).some(key => /secret|token|password|private.?key/i.test(key))) throw new Error('CHANNEL_CONFIGURATION_INVALID');
  return shape(platform, value, false);
}
export function migrateChannelCredentials(platform, value) { return shape(platform, value, true); }
export function validateChannelConfiguration(platform, value) {
  if (Object.keys(shape(platform, value, false)).length !== Object.keys(value).length) throw new Error('CHANNEL_CONFIGURATION_INVALID');
  connectionFeatures(platform, value.features);
}
export function validateChannelCredentials(platform, value) {
  const projected = shape(platform, value, true), entries = Object.entries(projected);
  if (entries.length !== 1 || Object.keys(value).length !== 1 || typeof entries[0][1] !== 'string' || !entries[0][1].length) {
    throw new Error('CHANNEL_CREDENTIALS_INVALID');
  }
}
export function withoutChannelAuthority(event) {
  const value = { ...event };
  for (const key of ['sourceRevision', 'channelInstanceId', 'bindingRef', 'observedSubjectRef', 'delegationRef',
    'taskBindingRef', 'executionScope', 'scope', 'origin', 'signature', 'authorization', 'grantRef', 'serviceLease']) delete value[key];
  for (const key of Object.keys(value)) if (/^native/i.test(key)) delete value[key];
  return value;
}
