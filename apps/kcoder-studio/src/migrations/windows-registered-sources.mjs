import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { readWindowsCurrentIdentity, readWindowsProfileSelection } from '../windows-current-identity.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const value = (env, name) => {
  const key = Object.keys(env).find(key => key.toUpperCase() === name);
  return key === undefined ? undefined : env[key] || undefined;
};
const same = (left, right) => win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();

/** Reproduce the retired reader's input fingerprint; it never selects a running Home. */
export function windowsLegacyDataInputKey(selected, env = {}) {
  const data = value(env, 'KCODER_STUDIO_DATA_DIR') || (value(env, 'KCODER_STUDIO_SERVERS_STORE')
    ? win32.dirname(value(env, 'KCODER_STUDIO_SERVERS_STORE')) : selected.paths.gatewayRoot);
  const store = value(env, 'KCODER_STUDIO_SERVERS_STORE') || win32.join(data, 'servers.json');
  return createHash('sha256').update(JSON.stringify([data.toLowerCase(), store.toLowerCase(),
    value(env, 'KCODER_STUDIO_SERVERS_FILE') || null,
    createHash('sha256').update(value(env, 'KCODER_STUDIO_SERVERS') || '').digest('hex')])).digest('hex');
}

/** Known roots for first-launch observation only. Native owns the offline migration. */
export async function readWindowsRegisteredStorageRoots({ selected, env = process.env, platform = process.platform,
  readIdentity = readWindowsCurrentIdentity, readSelection = readWindowsProfileSelection }) {
  if (platform !== 'win32' || selected.context.development || selected.paths.externallyConfigured || selected.context.record) return [];
  const identity = await readIdentity({ env, platform });
  const selection = await readSelection({ env, identity });
  if (!selection || selection.sid !== identity.sid || !same(selection.sourceDirectory, selected.paths.dataRoot)) return [];
  if (selection.version === 2 && selection.sourceDataKey !== windowsLegacyDataInputKey(selected, env))
    fail('STORAGE_LEGACY_REGISTRATION_INPUT_CHANGED');
  return [...new Set([selection.directory, ...(selection.version === 2
    ? [selection.dataDirectory, win32.dirname(selection.serversStore)] : [])].map(path => win32.normalize(path)))];
}
