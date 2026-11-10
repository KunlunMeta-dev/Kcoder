import { settingsToolRestrictions, toolRestrictions } from './tool-restrictions.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { modify, applyEdits } from 'jsonc-parser';
import { readBoundedFileSync, writePrivateFileSync } from '../jsonc-file.mjs';
import { decodeStudioSettings, STUDIO_SETTINGS_VERSION } from './migrations/settings.mjs';
import { removeV1Keys } from './migrations/settings/v0001_to_v0002.mjs';

function backupV1(path, original) {
  const digest = createHash('sha256').update(original).digest('hex');
  const backup = `${path}.v1-${digest}.bak`;
  try {
    if (!readBoundedFileSync(backup, 65536).equals(original)) throw new Error('CHANNEL_SETTINGS_BACKUP_CONFLICT');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    writePrivateFileSync(backup, original, 65536);
  }
}

/** Channels are a domain of the Gateway's Studio settings, not target execution settings. */
export class ChannelSettingsFile {
  constructor(directory) { this.path = join(directory, 'settings.json'); }

  readDocument() {
    try {
      const original = readBoundedFileSync(this.path, 65536);
      return { ...decodeStudioSettings(original), original };
    } catch (error) {
      if (error.code === 'ENOENT') return { raw: '{}\n', document: {}, original: null, sourceVersion: STUDIO_SETTINGS_VERSION };
      if (error.code === 'CONFIG_VERSION_UNSUPPORTED') throw new Error('CHANNEL_SETTINGS_VERSION_UNSUPPORTED');
      if (error.code === 'CONFIG_JSONC_INVALID') throw new Error('CHANNEL_SETTINGS_INVALID');
      if (error.code?.startsWith('CONFIG_FILE_')) throw new Error('CHANNEL_SETTINGS_FILE_INVALID');
      throw error;
    }
  }

  read() {
    const { channels } = this.readDocument().document;
    return { mirrorClientTurns: channels?.mirror_client_turns === true, toolRestrictions: settingsToolRestrictions(channels) };
  }

  write(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        !Object.keys(settings).length || Object.keys(settings).some(key => !['mirrorClientTurns', 'toolRestrictions'].includes(key)) ||
        (Object.hasOwn(settings, 'mirrorClientTurns') && typeof settings.mirrorClientTurns !== 'boolean'))
      throw new Error('CHANNEL_SETTINGS_INVALID');
    const policy = Object.hasOwn(settings, 'toolRestrictions') ? toolRestrictions(settings.toolRestrictions) : null;
    const loaded = this.readDocument();
    let { raw } = loaded;
    const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
    if (loaded.sourceVersion === 1) raw = removeV1Keys(raw);
    raw = applyEdits(raw, modify(raw, ['meta', 'config_version'], STUDIO_SETTINGS_VERSION, options));
    if (Object.hasOwn(settings, 'mirrorClientTurns') || loaded.sourceVersion === 1) {
      raw = applyEdits(raw, modify(raw, ['channels', 'mirror_client_turns'], (settings.mirrorClientTurns ?? loaded.document.channels?.mirror_client_turns ?? false), options));
    }
    if (policy) {
      raw = applyEdits(raw, modify(raw, ['channels', 'tool_restrictions', 'enabled'], policy.enabled, options));
      raw = applyEdits(raw, modify(raw, ['channels', 'tool_restrictions', 'disabled_tools'], policy.disabledTools, options));
    }
    if (Buffer.byteLength(raw) > 65536) throw new Error('CONFIG_FILE_TOO_LARGE');
    const prepared = decodeStudioSettings(raw);
    if (prepared.sourceVersion !== STUDIO_SETTINGS_VERSION || (Object.hasOwn(settings, 'mirrorClientTurns') && prepared.document.channels?.mirror_client_turns !== settings.mirrorClientTurns)) {
      throw new Error('CHANNEL_SETTINGS_MIGRATION_CONFLICT');
    }
    if (loaded.original) {
      if (loaded.sourceVersion === 1) backupV1(this.path, loaded.original);
      if (!readBoundedFileSync(this.path, 65536).equals(loaded.original)) throw new Error('CHANNEL_SETTINGS_CHANGED');
    }
    writePrivateFileSync(this.path, raw, 65536);
    return this.read();
  }
}
