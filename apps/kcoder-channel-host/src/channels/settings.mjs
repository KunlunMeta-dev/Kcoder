import { settingsToolRestrictions, toolRestrictions } from './tool-restrictions.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { modify, applyEdits } from 'jsonc-parser';
import { readBoundedFileSync, writePrivateFileSync } from '../jsonc-file.mjs';
import { decodeStudioSettings, STUDIO_SETTINGS_VERSION } from './migrations/settings.mjs';
import { removeV1Keys } from './migrations/settings/v0001_to_v0002.mjs';

const MAX_SETTINGS_BYTES = 65536;
const settingsValue = document => ({ mirrorClientTurns: document.channels?.mirror_client_turns === true,
  toolRestrictions: settingsToolRestrictions(document.channels) });
export function settingsPublicationUnconfirmed(cause) {
  return Object.assign(new Error('CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED', { cause }),
    { code: 'CHANNEL_SETTINGS_PUBLICATION_UNCONFIRMED', externalOutcome: 'unknown' });
}
function fileFailure(error) {
  if (error.code === 'CONFIG_FILE_PUBLISH_UNCONFIRMED') return settingsPublicationUnconfirmed(error);
  if (error.code === 'CONFIG_FILE_CHANGED') return new Error('CHANNEL_SETTINGS_CHANGED');
  if (error.code === 'CONFIG_FILE_TOO_LARGE') return new Error('CHANNEL_SETTINGS_FILE_TOO_LARGE');
  if (error.code?.startsWith('CONFIG_FILE_')) return new Error('CHANNEL_SETTINGS_FILE_INVALID');
  return error;
}

function backupVersion(path, original, version) {
  const digest = createHash('sha256').update(original).digest('hex');
  const backup = `${path}.v${version}-${digest}.bak`;
  try {
    if (!readBoundedFileSync(backup, MAX_SETTINGS_BYTES).equals(original)) throw new Error('CHANNEL_SETTINGS_BACKUP_CONFLICT');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('CHANNEL_SETTINGS_BACKUP_CONFLICT');
    try { writePrivateFileSync(backup, original, MAX_SETTINGS_BYTES); }
    catch { throw new Error('CHANNEL_SETTINGS_BACKUP_CONFLICT'); }
  }
}

/** Channels are a domain of the Gateway's Studio settings, not target execution settings. */
export class ChannelSettingsFile {
  constructor(directory) { this.directory = resolve(directory); this.path = join(this.directory, 'settings.json'); this.verifyDirectory(); }

  verifyDirectory() {
    let info;
    try { info = lstatSync(this.directory); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('CHANNEL_SETTINGS_DIRECTORY_MISSING'); throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('CHANNEL_SETTINGS_DIRECTORY_INVALID');
  }

  readDocument() {
    this.verifyDirectory();
    try {
      const original = readBoundedFileSync(this.path, MAX_SETTINGS_BYTES);
      return { ...decodeStudioSettings(original), original };
    } catch (error) {
      if (error.code === 'ENOENT') return { raw: '{}\n', document: {}, original: null, sourceVersion: STUDIO_SETTINGS_VERSION };
      if (error.code === 'CONFIG_VERSION_UNSUPPORTED') throw new Error('CHANNEL_SETTINGS_VERSION_UNSUPPORTED');
      if (error.code === 'CONFIG_JSONC_INVALID') throw new Error('CHANNEL_SETTINGS_INVALID');
      throw fileFailure(error);
    }
  }

  read() {
    return settingsValue(this.readDocument().document);
  }

  readPublication() {
    const { document } = this.readDocument();
    return { enabled: document.channels?.mirror_client_turns === true,
      generation: document.channels?.mirror_generation };
  }

  write(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        !Object.keys(settings).length || Object.keys(settings).some(key => !['mirrorClientTurns', 'toolRestrictions'].includes(key)) ||
        (Object.hasOwn(settings, 'mirrorClientTurns') && typeof settings.mirrorClientTurns !== 'boolean'))
      throw new Error('CHANNEL_SETTINGS_INVALID');
    const policy = Object.hasOwn(settings, 'toolRestrictions') ? toolRestrictions(settings.toolRestrictions) : null;
    const loaded = this.readDocument();
    const previousEnabled = loaded.document.channels?.mirror_client_turns === true;
    const enabled = settings.mirrorClientTurns ?? previousEnabled;
    const oldGeneration = loaded.document.channels?.mirror_generation;
    const generation = enabled !== previousEnabled || (loaded.original !== null && oldGeneration === undefined)
      ? randomUUID() : oldGeneration ?? null;
    let { raw } = loaded;
    const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    if (loaded.sourceVersion === 1) raw = removeV1Keys(raw);
    raw = applyEdits(raw, modify(raw, ['meta', 'config_version'], STUDIO_SETTINGS_VERSION, options));
    raw = applyEdits(raw, modify(raw, ['channels', 'mirror_generation'], generation, options));
    if (Object.hasOwn(settings, 'mirrorClientTurns') || loaded.sourceVersion === 1) {
      raw = applyEdits(raw, modify(raw, ['channels', 'mirror_client_turns'], (settings.mirrorClientTurns ?? loaded.document.channels?.mirror_client_turns ?? false), options));
    }
    if (policy) {
      raw = applyEdits(raw, modify(raw, ['channels', 'tool_restrictions', 'enabled'], policy.enabled, options));
      raw = applyEdits(raw, modify(raw, ['channels', 'tool_restrictions', 'disabled_tools'], policy.disabledTools, options));
    }
    if (Buffer.byteLength(raw) > MAX_SETTINGS_BYTES) throw new Error('CHANNEL_SETTINGS_FILE_TOO_LARGE');
    const prepared = decodeStudioSettings(raw);
    const expected = structuredClone(loaded.document);
    expected.meta = { ...expected.meta, config_version: STUDIO_SETTINGS_VERSION };
    expected.channels = { ...expected.channels };
    expected.channels.mirror_generation = generation;
    if (Object.hasOwn(settings, 'mirrorClientTurns') || loaded.sourceVersion === 1)
      expected.channels.mirror_client_turns = settings.mirrorClientTurns ?? loaded.document.channels?.mirror_client_turns ?? false;
    if (policy) expected.channels.tool_restrictions = { ...expected.channels.tool_restrictions,
      enabled: policy.enabled, disabled_tools: policy.disabledTools };
    if (prepared.sourceVersion !== STUDIO_SETTINGS_VERSION || !isDeepStrictEqual(prepared.document, expected)) {
      throw new Error('CHANNEL_SETTINGS_MIGRATION_CONFLICT');
    }
    let current = null;
    try { current = readBoundedFileSync(this.path, MAX_SETTINGS_BYTES); }
    catch (error) { if (error.code !== 'ENOENT') throw fileFailure(error); }
    if (loaded.original === null ? current !== null : current === null || !current.equals(loaded.original))
      throw new Error('CHANNEL_SETTINGS_CHANGED');
    if (loaded.original && loaded.sourceVersion < STUDIO_SETTINGS_VERSION)
      backupVersion(this.path, loaded.original, loaded.sourceVersion);
    this.verifyDirectory();
    try { writePrivateFileSync(this.path, raw, MAX_SETTINGS_BYTES); }
    catch (error) { throw fileFailure(error); }
    return settingsValue(prepared.document);
  }
}
