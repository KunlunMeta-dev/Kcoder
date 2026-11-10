import { settingsToolRestrictions } from '../tool-restrictions.mjs';
import { parseVersionedJsonc } from '../../jsonc-file.mjs';
import { migrateSettingsV1 } from './settings/v0001_to_v0002.mjs';

export const STUDIO_SETTINGS_VERSION = 2;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reads convert in memory; the existing owner publishes only on an explicit settings mutation. */
export function decodeStudioSettings(bytes) {
  const { raw, document, version } = parseVersionedJsonc(bytes, 1, STUDIO_SETTINGS_VERSION);
  if (document.channels !== undefined && !object(document.channels)) throw new Error('CHANNEL_SETTINGS_INVALID');
  if (document.channels?.mirror_client_turns !== undefined && typeof document.channels.mirror_client_turns !== 'boolean') {
    throw new Error('CHANNEL_SETTINGS_INVALID');
  }
  settingsToolRestrictions(document.channels);
  return { raw, sourceVersion: version, document: version === 1 ? migrateSettingsV1(document) : document };
}
