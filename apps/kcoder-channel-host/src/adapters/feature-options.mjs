import definitions from '../channel-platforms.json' with { type: 'json' };
import { requireValue } from '../errors.mjs';
import removeMarkdown from 'remove-markdown';

/** Each connection owns its optional feature document, independently of software versions. */
export function connectionFeatures(platform, value) {
  const fields = definitions[platform]?.featureFields;
  requireValue(fields, 'CHANNEL_PLATFORM_UNSUPPORTED');
  const source = value === undefined ? {} : value;
  requireValue(source && typeof source === 'object' && !Array.isArray(source)
    && Object.keys(source).every(key => key === 'meta' || Object.hasOwn(fields, key)), 'CHANNEL_FEATURES_INVALID');
  if (source.meta !== undefined) requireValue(source.meta && typeof source.meta === 'object'
    && !Array.isArray(source.meta) && Object.keys(source.meta).length === 1 && source.meta.config_version === 1, 'CHANNEL_FEATURES_VERSION_UNSUPPORTED');
  const result = { meta: { config_version: 1 } };
  for (const [name, field] of Object.entries(fields)) {
    const selected = Object.hasOwn(source, name) ? source[name] : field.default;
    requireValue((field.type === 'enum' && field.options.includes(selected))
      || (field.type === 'boolean' && typeof selected === 'boolean')
      || (field.type === 'integer' && Number.isSafeInteger(selected) && selected >= field.minimum && selected <= field.maximum)
      || (field.type === 'string' && typeof selected === 'string' && selected.length <= field.maxLength), 'CHANNEL_FEATURES_INVALID');
    result[name] = selected;
  }
  return result;
}

export function effectiveChannelConfiguration(platform, configuration) {
  const features = connectionFeatures(platform, configuration.features);
  // Existing GitHub connections keep their explicit interval until the nested setting is saved.
  if (platform === 'github' && configuration.features?.pollIntervalSeconds === undefined
    && configuration.pollIntervalSeconds !== undefined) features.pollIntervalSeconds = configuration.pollIntervalSeconds;
  return { ...configuration, features, ...(platform === 'github' ? { pollIntervalSeconds: features.pollIntervalSeconds } : {}) };
}

/** Format once before Outbox persistence; retries keep the original committed content. */
export function channelMessageContent(content, messageFormat) {
  if (messageFormat !== 'plain' || typeof content.text !== 'string') return content;
  return { ...content, text: removeMarkdown(content.text) };
}
