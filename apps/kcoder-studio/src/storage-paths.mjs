import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export const STORAGE_LOCATION_VERSION = 1;
export const STORAGE_LOCATION_MAX_BYTES = 32 * 1024;
export const STORAGE_STARTUP_ENV = 'KCODER_STORAGE_CONTEXT_V1';
const STORAGE_STARTUP_MAX_BYTES = 256 * 1024;
const overrideNames = ['KCODER_CONFIG_DIR', 'KCODER_HOME', 'KCODER_CACHE_DIR',
  'KCODER_STUDIO_DATA_DIR', 'KCODER_STUDIO_SERVERS_STORE', 'KCODER_STUDIO_DESKTOP_USER_DATA_DIR'];
const fail = (code, cause) => { throw Object.assign(new Error(code, cause ? { cause } : undefined), { code }); };
const pathsFor = platform => platform === 'win32' ? win32 : posix;
const valueOf = (env, name, platform) => Object.entries(env).find(([key, value]) =>
  (platform === 'win32' ? key.toUpperCase() === name : key === name) && value !== '' && value !== undefined)?.[1];
function validateEnvironment(env, platform) {
  if (platform !== 'win32') return;
  for (const name of [...overrideNames, STORAGE_STARTUP_ENV]) {
    const values = Object.entries(env).filter(([key, value]) => key.toUpperCase() === name && value !== undefined)
      .map(([, value]) => value);
    if (new Set(values).size > 1) fail('STORAGE_ENV_CONFLICT');
  }
}
const ignoresSelection = options => options.development ||
  valueOf(options.env || {}, 'KCODER_CONFIG_DIR', options.platform) ||
  valueOf(options.env || {}, 'KCODER_HOME', options.platform);

function absolute(value, paths) {
  if (typeof value !== 'string' || !paths.isAbsolute(value) ||
    paths === win32 && paths.parse(value).root.length === 1 ||
    Buffer.byteLength(value) > 32767 || /[\0\r\n]/.test(value)) fail('STORAGE_PATH_INVALID');
  const normalized = paths.normalize(value);
  return normalized === paths.parse(normalized).root ? normalized
    : normalized.replace(paths === win32 ? /[\\/]+$/ : /\/+$/, '');
}

export function storageLocationFile(home, platform = process.platform) {
  return pathsFor(platform).join(home, '.config', 'kcoder-storage.json');
}

export function validateStorageLocationRecord(record, platform = process.platform) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('STORAGE_RECORD_INVALID');
  if (!Number.isInteger(record.version)) fail('STORAGE_RECORD_INVALID');
  if (record.version !== STORAGE_LOCATION_VERSION) fail('STORAGE_RECORD_VERSION_UNSUPPORTED');
  if (!Number.isSafeInteger(record.revision) || record.revision < 1 || Object.keys(record).some(key =>
    !['version', 'revision', 'dataRoot', 'cacheRoot', 'operationId'].includes(key))) fail('STORAGE_RECORD_INVALID');
  if (record.operationId !== undefined && record.operationId !== null) validateStorageOperationId(record.operationId);
  const paths = pathsFor(platform);
  let data = absolute(record.dataRoot, paths), cache = absolute(record.cacheRoot, paths);
  if (paths === win32) { data = data.toLowerCase(); cache = cache.toLowerCase(); }
  const contains = (parent, child) => {
    const relative = paths.relative(parent, child);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
  };
  if (contains(data, cache) || contains(cache, data)) fail('STORAGE_ROOTS_OVERLAP');
  return record;
}

export function validateStorageOperationId(id) {
  if (typeof id !== 'string' || id.endsWith('.') ||
    !/^(?!(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$))[a-z0-9._-]{1,128}$/i.test(id)) fail('STORAGE_RECORD_INVALID');
}

/** Initial selection only. OS identity/cache discovery stays in the host adapter. */
export function defaultStorageLocation({ home, platformCache, platform = process.platform }) {
  const paths = pathsFor(platform);
  return validateStorageLocationRecord({ version: STORAGE_LOCATION_VERSION, revision: 1,
    dataRoot: paths.join(absolute(home, paths), '.config', 'kcoder'),
    cacheRoot: paths.join(absolute(platformCache, paths), 'kcoder', ...(platform === 'win32' ? ['cache'] : [])) }, platform);
}

/** Read at most one bounded ordinary file. Never create a profile or alter permissions. */
export async function readStorageJson(file, { limit = STORAGE_LOCATION_MAX_BYTES,
  invalid = 'STORAGE_RECORD_INVALID', unavailable = 'STORAGE_RECORD_UNAVAILABLE' } = {}) {
  let named;
  try { named = await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return undefined; fail(unavailable, error); }
  if (!named.isFile() || named.isSymbolicLink()) fail(invalid);
  let handle;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
    const sameOpened = (left, right) => left.dev === right.dev && left.ino === right.ino;
    // Windows path stat may report dev=0 while handle stat supplies the volume
    // serial. File indices also exceed Number's exact integer range.
    const sameNamed = (path, opened) => path.isFile() && !path.isSymbolicLink()
      && path.ino === opened.ino && (path.dev === opened.dev || process.platform === 'win32' && path.dev === 0n);
    handle = await open(file, flags);
    const held = await handle.stat({ bigint: true });
    if (!held.isFile() || held.size > BigInt(limit) || !sameNamed(named, held)) {
      fail(invalid);
    }
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) fail(invalid);
    const after = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (!sameOpened(held, after) || after.size !== held.size || after.mtimeNs !== held.mtimeNs ||
      after.ctimeNs !== held.ctimeNs || !sameNamed(current, after)) fail(invalid);
    if (process.platform === 'win32') {
      // Obtain the named object's real volume from another handle, rather than
      // treating the unavailable path dev as a wildcard volume identity.
      const namedHandle = await open(file, flags);
      try {
        const reopened = await namedHandle.stat({ bigint: true });
        if (!reopened.isFile() || !sameOpened(after, reopened)) fail(invalid);
      } finally { await namedHandle.close(); }
    }
    let record;
    try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { fail(invalid); }
    return record;
  } catch (error) {
    if (error.code?.startsWith('STORAGE_')) throw error;
    fail(unavailable, error);
  } finally { await handle?.close(); }
}

export async function readStorageLocationRecord(file, { platform = process.platform } = {}) {
  const record = await readStorageJson(file);
  return record === undefined ? null : validateStorageLocationRecord(record, platform);
}

/** Pure counterpart of kcoder_config::storage::resolve_storage_paths. */
export function resolveStoragePaths({ home, platformConfig, env = {}, record = null,
  platform = process.platform, consumer = 'cli', development = false } = {}) {
  validateEnvironment(env, platform);
  const paths = pathsFor(platform);
  const get = name => valueOf(env, name, platform);
  const userHome = () => home ? absolute(home, paths) : fail('STORAGE_HOME_UNAVAILABLE');
  if (ignoresSelection({ env, platform, development })) record = null;
  if (record) validateStorageLocationRecord(record, platform);
  const data = get('KCODER_CONFIG_DIR') ? [absolute(get('KCODER_CONFIG_DIR'), paths), 'configOverride']
    : get('KCODER_HOME') ? [absolute(get('KCODER_HOME'), paths), 'homeOverride']
      : development ? [paths.join(userHome(), '.config', 'kcoder-dev'), 'development']
        : record ? [absolute(record.dataRoot, paths), 'selection']
          : [paths.join(userHome(), '.config', 'kcoder'), 'default'];
  const cache = get('KCODER_CACHE_DIR') ? [absolute(get('KCODER_CACHE_DIR'), paths), 'cacheOverride']
    : record ? [absolute(record.cacheRoot, paths), 'selection'] : [paths.join(data[0], 'tmp'), data[1]];
  const desktop = get('KCODER_STUDIO_DESKTOP_USER_DATA_DIR')
    ? [absolute(get('KCODER_STUDIO_DESKTOP_USER_DATA_DIR'), paths), 'desktopOverride']
    : record ? [paths.join(data[0], 'studio', 'desktop'), 'selection']
      : [paths.join(platformConfig ? absolute(platformConfig, paths) : paths.join(userHome(), '.config'), 'kcoder-studio'), 'default'];
  const gateway = get('KCODER_STUDIO_DATA_DIR') ? [absolute(get('KCODER_STUDIO_DATA_DIR'), paths), 'dataOverride']
    : get('KCODER_STUDIO_SERVERS_STORE') ? [paths.dirname(absolute(get('KCODER_STUDIO_SERVERS_STORE'), paths)), 'serversStoreOverride']
      : record ? [paths.join(data[0], 'studio', 'gateway'), 'selection']
        : consumer === 'desktop' ? desktop : [paths.join(userHome(), '.config', 'kcoder-studio'), 'default'];
  const externallyConfigured = development || overrideNames.some(name => get(name) !== undefined);
  return {
    dataRoot: data[0], cacheRoot: cache[0], gatewayRoot: gateway[0], desktopRoot: desktop[0],
    temporaryRoot: record || get('KCODER_CACHE_DIR') ? paths.join(cache[0], 'tmp') : cache[0],
    locationFile: home ? storageLocationFile(home, platform) : null,
    layout: externallyConfigured ? 'custom' : record ? 'unified' : 'legacy',
    sources: { dataRoot: data[1], cacheRoot: cache[1], gatewayRoot: gateway[1], desktopRoot: desktop[1] },
    externallyConfigured, selectionRevision: record?.revision ?? null, operationId: record?.operationId ?? null,
  };
}

function resolveContext(context, platform) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).some(key =>
    !['version', 'home', 'platformConfig', 'overrides', 'record', 'consumer', 'development'].includes(key))) fail('STORAGE_CONTEXT_INVALID');
  if (context.version !== 1) fail('STORAGE_CONTEXT_VERSION_UNSUPPORTED');
  if (!['cli', 'gateway', 'desktop'].includes(context.consumer) || typeof context.development !== 'boolean' ||
    !context.overrides || typeof context.overrides !== 'object' || Array.isArray(context.overrides) ||
    !Object.hasOwn(context, 'record') || !Object.hasOwn(context, 'home') || !Object.hasOwn(context, 'platformConfig')) fail('STORAGE_CONTEXT_INVALID');
  for (const [name, value] of Object.entries(context.overrides)) {
    if (!overrideNames.includes(name)) fail('STORAGE_CONTEXT_INVALID');
    if (absolute(value, pathsFor(platform)) !== value) fail('STORAGE_CONTEXT_INVALID');
  }
  if (ignoresSelection({ env: context.overrides, platform, development: context.development }) && context.record !== null) fail('STORAGE_CONTEXT_INVALID');
  return resolveStoragePaths({ ...context, env: context.overrides, platform });
}

/** Capture only non-secret resolution inputs; owned children keep their original provenance. */
export async function loadStorageContext(options = {}) {
  const platform = options.platform || process.platform, suppliedEnv = options.env || process.env;
  validateEnvironment(suppliedEnv, platform);
  const home = options.home ?? homedir();
  const paths = pathsFor(platform);
  const env = { ...suppliedEnv };
  // Legacy relative overrides are captured once, before a host changes workspace.
  for (const key of Object.keys(env)) {
    const name = platform === 'win32' ? key.toUpperCase() : key;
    const value = env[key];
    if (!['KCODER_CONFIG_DIR', 'KCODER_HOME', 'KCODER_STUDIO_SERVERS_STORE',
      'KCODER_STUDIO_DESKTOP_USER_DATA_DIR'].includes(name) || !value) continue;
    const root = paths.parse(value).root;
    if (paths.isAbsolute(value) && (paths !== win32 || root.length > 1)) continue;
    if (paths === win32 && root.length > 1) fail('STORAGE_PATH_INVALID');
    env[key] = paths.resolve(absolute(options.cwd ?? process.cwd(), paths), value);
  }
  const platformConfig = options.platformConfig ?? (platform === 'win32'
    ? valueOf(env, 'APPDATA', platform) || paths.join(home, 'AppData', 'Roaming')
    : platform === 'darwin' ? paths.join(home, 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME || paths.join(home, '.config'));
  const input = { ...options, home, env, platform, platformConfig };
  const inherited = valueOf(env, STORAGE_STARTUP_ENV, platform);
  if (inherited !== undefined) {
    if (typeof inherited !== 'string' || Buffer.byteLength(inherited) > STORAGE_STARTUP_MAX_BYTES) fail('STORAGE_CONTEXT_INVALID');
    let context;
    try { context = JSON.parse(inherited); } catch { fail('STORAGE_CONTEXT_INVALID'); }
    const resolved = resolveContext(context, platform);
    if (context.home !== home) fail('STORAGE_CONTEXT_HOME_CHANGED');
    const derived = { KCODER_CONFIG_DIR: resolved.dataRoot, KCODER_HOME: resolved.dataRoot,
      KCODER_CACHE_DIR: resolved.cacheRoot, KCODER_STUDIO_DATA_DIR: resolved.gatewayRoot,
      KCODER_STUDIO_SERVERS_STORE: paths.join(resolved.gatewayRoot, 'servers.json'),
      KCODER_STUDIO_DESKTOP_USER_DATA_DIR: resolved.desktopRoot };
    for (const name of overrideNames) {
      const value = valueOf(env, name, platform);
      if (value !== undefined && absolute(value, paths) !== (context.overrides[name] ?? derived[name])) fail('STORAGE_CONTEXT_CONFLICT');
    }
    return { context, paths: resolved };
  }
  const record = ignoresSelection(input) ? null
    : await readStorageLocationRecord(storageLocationFile(home, platform), { platform });
  const overrides = Object.fromEntries(overrideNames.flatMap(name => {
    const value = valueOf(env, name, platform);
    return value === undefined ? [] : [[name, absolute(value, paths)]];
  }));
  const context = { version: 1, home, platformConfig, overrides, record,
    consumer: options.consumer ?? 'cli', development: options.development ?? false };
  return { context, paths: resolveContext(context, platform) };
}

export async function loadStoragePaths(options = {}) { return (await loadStorageContext(options)).paths; }
