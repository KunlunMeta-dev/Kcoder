import { settingsToolRestrictions } from '../tool-restrictions.mjs';
import { parseVersionedJsonc } from '../../jsonc-file.mjs';
import { migrateSettingsV1 } from './settings/v0001_to_v0002.mjs';
import { migrateSettingsV2 } from './settings/v0002_to_v0003.mjs';

export const STUDIO_SETTINGS_VERSION = 3;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const generation = value => value === null || (typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));

/** Reads convert in memory; the existing owner publishes only on an explicit settings mutation. */
export function decodeStudioSettings(bytes) {
  const { raw, document, version } = parseVersionedJsonc(bytes, 1, 2, STUDIO_SETTINGS_VERSION);
  if (document.channels !== undefined && !object(document.channels)) throw new Error('CHANNEL_SETTINGS_INVALID');
  if (document.channels?.mirror_client_turns !== undefined && typeof document.channels.mirror_client_turns !== 'boolean') {
    throw new Error('CHANNEL_SETTINGS_INVALID');
  }
  if ((document.channels?.mirror_generation !== undefined && !generation(document.channels.mirror_generation)) ||
      (version === 3 && document.channels?.mirror_client_turns === true &&
        !Object.hasOwn(document.channels, 'mirror_generation'))) throw new Error('CHANNEL_SETTINGS_INVALID');
  settingsToolRestrictions(document.channels);
  const previous = version === 1 ? migrateSettingsV1(document) : document;
  return { raw, sourceVersion: version, document: version < 3 ? migrateSettingsV2(previous) : previous };
}
