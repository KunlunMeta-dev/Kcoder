import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, constants } from 'node:fs';
import { TextDecoder } from 'node:util';
import { basename, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validAdminPasswordHash } from './admin-auth.mjs';

const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_GATEWAYS = 256;
const MAX_SHARED_HOSTS = 256;
const DEFAULT_MAX_CONNECTIONS = 128;
const DEFAULT_MAX_BYTES_PER_WINDOW = 64 * 1024 * 1024;
const DEFAULT_TRAFFIC_WINDOW_MS = 60_000;
const GATEWAY_KEYS = new Set([
  'id', 'secret', 'gatewaySecret', 'maxConnections', 'maxBytesPerWindow', 'trafficWindowMs',
]);

// Existing environment wins; parsing verified bytes never executes shell code.
export function parseRelayEnvironment(bytes, target = {}) {
  let text;
  try { text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Relay environment file must contain valid UTF-8'); }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || target[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    target[match[1]] = value;
  }
  return target;
}
export function loadEnv(path = process.env.KCODER_RELAY_ENV_FILE || resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), target = process.env) {
  // Managed launchers already supply a scoped environment. Standalone entrypoints retain dotenv discovery.
  if (target.KCODER_RELAY_NO_DOTENV === '1') return;
  try { parseRelayEnvironment(readFileSync(path, 'utf8'), target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function port(name, fallback, env = process.env) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`Invalid ${name}`);
  return value;
}

export function relayGatewayId(env = process.env, fallback = 'cyx') {
  const alias = env.KCODER_RELAY_GATEWAY_ID;
  const legacy = env.KCODER_RELAY_DEVICE_ID;
  if (alias !== undefined && legacy !== undefined && alias !== legacy) {
    throw new Error('KCODER_RELAY_GATEWAY_ID conflicts with KCODER_RELAY_DEVICE_ID');
  }
  const id = alias ?? legacy ?? fallback;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid relay Gateway ID');
  return id;
}

export function credentials(env = process.env) {
  const secret = env.KCODER_RELAY_SECRET || '';
  const gatewayId = relayGatewayId(env);
  if (!isCredential(secret)) throw new Error('Relay requires a secret of at least 32 characters');
  // Keep the existing return shape; the device value now also resolves the
  // Gateway ID alias used by the multi-Gateway protocol.
  return { secret, device: gatewayId };
}

/** Selected Relay profiles pass a credential path, never a secret in argv. */
export function clientGatewaySecret(env = process.env) {
  if (!env.KCODER_RELAY_GATEWAY_SECRET_FILE) return env.KCODER_RELAY_GATEWAY_SECRET;
  try {
    const { bytes } = readRelayFile(env.KCODER_RELAY_GATEWAY_SECRET_FILE, { limit: 513, label: 'Relay Gateway credential' });
    const value = bytes.toString('utf8').trim();
    if (!/^[A-Za-z0-9._~-]{32,512}$/.test(value)) throw Error('Invalid Relay Gateway credential');
    return value;
  } catch { throw Error('Invalid Relay Gateway credential'); }
}

function isCredential(value) {
  return typeof value === 'string' && value.length >= 32 && !/[\u0000-\u001f\u007f]/.test(value);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}: expected an object`);
  const actual = Object.keys(value);
  const unknown = actual.filter(key => !keys.has(key));
  const missing = [...keys].filter(key => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    const details = [
      ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
      ...(unknown.length ? [`unknown ${unknown.join(', ')}`] : []),
    ];
    throw new Error(`Invalid ${label}: ${details.join('; ')}`);
  }
  return value;
}

function normalizedAuthority(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value !== value.trim() || /[\s\/?#@,]/.test(value)) {
    throw new Error(`Invalid ${label}: expected an exact host authority`);
  }
  let hostname;
  let port = '';
  if (value.startsWith('[')) {
    const match = value.match(/^\[([0-9A-Fa-f:.]+)\](?::([0-9]{1,5}))?$/);
    if (!match) throw new Error(`Invalid ${label}: expected an exact host authority`);
    hostname = `[${match[1].toLowerCase()}]`;
    port = match[2] === undefined ? '' : `:${match[2]}`;
    try { new URL(`http://${value}`); }
    catch { throw new Error(`Invalid ${label}: expected an exact host authority`); }
  } else {
    const match = value.match(/^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/);
    if (!match || match[1].startsWith('.') || match[1].endsWith('.') || match[1].includes('..')) {
      throw new Error(`Invalid ${label}: expected an exact host authority`);
    }
    hostname = match[1].toLowerCase();
    port = match[2] === undefined ? '' : `:${match[2]}`;
  }
  if (port && Number(port.slice(1)) > 65535) throw new Error(`Invalid ${label}: expected an exact host authority`);
  return `${hostname}${port}`;
}

function validateHostList(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_SHARED_HOSTS) {
    throw new Error(`Invalid ${label}: expected 1 to ${MAX_SHARED_HOSTS} authorities`);
  }
  const seen = new Set();
  return values.map((value, index) => {
    const normalized = normalizedAuthority(value, `${label}[${index}]`);
    if (seen.has(normalized)) throw new Error(`Invalid ${label}: duplicate authority`);
    seen.add(normalized);
    return normalized;
  });
}

function boundedInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid Gateway ${label}`);
  return value;
}

function validateRegistry(value) {
  exactKeys(value, new Set(['gateways', 'sharedHosts']), 'relay registry');
  if (!Array.isArray(value.gateways) || value.gateways.length === 0 || value.gateways.length > MAX_GATEWAYS) {
    throw new Error(`Invalid relay registry: expected 1 to ${MAX_GATEWAYS} Gateways`);
  }
  const sharedHosts = validateHostList(value.sharedHosts, 'sharedHosts');
  const ids = new Set();
  const secrets = new Set();
  const gatewaySecrets = new Set();
  const gateways = value.gateways.map((entry, index) => {
    exactKeys(entry, GATEWAY_KEYS, `gateways[${index}]`);
    const { id, secret, gatewaySecret } = entry;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error(`Invalid Gateway ID at gateways[${index}]`);
    const normalizedId = id.toLowerCase();
    if (ids.has(normalizedId)) throw new Error('Duplicate Gateway ID');
    ids.add(normalizedId);
    if (!isCredential(secret)) throw new Error(`Gateway ${id} requires a secret of at least 32 characters`);
    if (!isCredential(gatewaySecret)) throw new Error(`Gateway ${id} requires a pairing token of at least 32 characters`);
    if (secrets.has(secret)) throw new Error('Different Gateways cannot share a relay secret');
    if (gatewaySecrets.has(gatewaySecret)) throw new Error('Different Gateways cannot share a pairing token');
    if (secrets.has(gatewaySecret) || gatewaySecrets.has(secret) || secret === gatewaySecret) {
      throw new Error('Relay secrets and pairing tokens must be distinct');
    }
    secrets.add(secret);
    gatewaySecrets.add(gatewaySecret);
    return {
      id,
      secret,
      gatewaySecret,
      maxConnections: boundedInteger(entry.maxConnections, 1, 100_000, `maxConnections for ${id}`),
      maxBytesPerWindow: boundedInteger(entry.maxBytesPerWindow, 1, Number.MAX_SAFE_INTEGER, `maxBytesPerWindow for ${id}`),
      trafficWindowMs: boundedInteger(entry.trafficWindowMs, 1, 86_400_000, `trafficWindowMs for ${id}`),
    };
  });
  return { gateways, sharedHosts };
}

function inspectRelayParents(path) {
  for (let current = path; ; current = dirname(current)) {
    const info = lstatSync(current);
    if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error('Relay file parent is not a directory');
    if (current === dirname(current)) break;
  }
}
export function resolveRelayFilePath(path) {
  if (typeof path !== 'string' || !path || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('Invalid Relay file path');
  const normalized = resolve(path), parent = dirname(normalized);
  inspectRelayParents(parent);
  const canonical = realpathSync(parent); inspectRelayParents(canonical);
  return join(canonical, basename(normalized));
}
export function readRelayFile(path, { limit = MAX_REGISTRY_BYTES, label = 'Relay file' } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024 * 1024) throw new Error('Invalid Relay file byte budget');
  const selected = resolveRelayFilePath(path);
  const safe = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.size <= BigInt(limit);
  let fd;
  try {
    const before = lstatSync(selected, { bigint: true });
    if (before.size > BigInt(limit)) throw new Error(`${label} exceeds ${limit} bytes`);
    if (!safe(before)) throw new Error(`${label} must be a regular, single-link file within its byte budget`);
    fd = openSync(selected, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const held = fstatSync(fd, { bigint: true });
    const same = (left, right) => safe(right) && left.dev === right.dev && left.ino === right.ino && left.size === right.size
      && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
    if (!same(before, held)) throw new Error(`${label} changed during open`);
    const buffer = Buffer.allocUnsafe(limit + 1); let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw new Error(`${label} exceeds ${limit} bytes`);
    if (BigInt(length) !== held.size || !same(held, fstatSync(fd, { bigint: true }))
        || !same(held, lstatSync(selected, { bigint: true }))) throw new Error(`${label} changed while reading or exceeds its byte budget`);
    return { path: selected, bytes: buffer.subarray(0, length) };
  } finally { if (fd !== undefined) closeSync(fd); }
}
function readRegistryFile(path) {
  try {
    const { bytes } = readRelayFile(path, { label: 'Relay registry' });
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Relay registry is not valid JSON'); }
    return validateRegistry(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Relay registry file not found: ${path}`);
    throw error;
  }
}

function legacySharedHosts(env) {
  const configured = env.KCODER_RELAY_SHARED_HOSTS;
  if (configured !== undefined) return validateHostList(configured.split(',').map(value => value.trim()), 'sharedHosts');
  if (!env.KCODER_RELAY_PUBLIC_URL) return [];
  let publicUrl;
  try { publicUrl = new URL(env.KCODER_RELAY_PUBLIC_URL); }
  catch { throw new Error('Invalid KCODER_RELAY_PUBLIC_URL'); }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password) throw new Error('KCODER_RELAY_PUBLIC_URL must be an HTTPS URL');
  return [publicUrl.host];
}

function registrationSharedHosts(env) {
  const configured = env.KCODER_RELAY_SHARED_HOSTS;
  if (configured !== undefined && configured !== '') {
    const values = configured.split(',').map(value => value.trim());
    if (values.length !== 1) throw new Error('Registration mode requires exactly one shared host');
    return validateHostList(values, 'sharedHosts');
  }
  if (!env.KCODER_RELAY_PUBLIC_URL) throw new Error('Registration mode requires KCODER_RELAY_PUBLIC_URL or KCODER_RELAY_SHARED_HOSTS');
  let publicUrl;
  try { publicUrl = new URL(env.KCODER_RELAY_PUBLIC_URL); }
  catch { throw new Error('Invalid KCODER_RELAY_PUBLIC_URL'); }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password) {
    throw new Error('KCODER_RELAY_PUBLIC_URL must be an HTTPS URL');
  }
  return validateHostList([publicUrl.host], 'sharedHosts');
}

function registrationOptions(env) {
  const adminPasswordHash = env.KCODER_RELAY_ADMIN_PASSWORD_HASH;
  const adminUsername = env.KCODER_RELAY_ADMIN_USERNAME || 'admin';
  if (adminPasswordHash !== undefined && !validAdminPasswordHash(adminPasswordHash)) throw new Error('Invalid KCODER_RELAY_ADMIN_PASSWORD_HASH');
  if (typeof adminUsername !== 'string' || adminUsername.length > 100 || /[\r\n\0]/.test(adminUsername)) throw new Error('Invalid KCODER_RELAY_ADMIN_USERNAME');
  const requireAccount = env.KCODER_RELAY_REQUIRE_ACCOUNT;
  if (requireAccount !== undefined && !['0', '1'].includes(requireAccount)) throw new Error('Invalid KCODER_RELAY_REQUIRE_ACCOUNT');
  if (requireAccount === '1' && !adminPasswordHash) throw new Error('KCODER_RELAY_REQUIRE_ACCOUNT requires an enabled administrator panel');
  const rawKey = env.KCODER_RELAY_REGISTRATION_KEY;
  const registrationKey = rawKey === undefined || rawKey === '' ? undefined : rawKey;
  if (registrationKey !== undefined &&
      (typeof registrationKey !== 'string' || !/^[A-Za-z0-9._~-]{32,512}$/.test(registrationKey))) {
    throw new Error('KCODER_RELAY_REGISTRATION_KEY must be a 32 to 512 character Bearer token');
  }

  const rawStorePath = env.KCODER_RELAY_REGISTRATION_STORE_FILE;
  if (rawStorePath !== undefined && rawStorePath !== '' &&
      (typeof rawStorePath !== 'string' || rawStorePath !== rawStorePath.trim())) {
    throw new Error('Invalid KCODER_RELAY_REGISTRATION_STORE_FILE');
  }
  const configuredStorePath = rawStorePath === undefined || rawStorePath === '' ? undefined : resolve(rawStorePath);
  const registrationStoreFile = configuredStorePath ?? (registrationKey || adminPasswordHash
    ? resolve(dirname(fileURLToPath(import.meta.url)), '../../../target/kcoder-relay/registered-gateways.json')
    : undefined);
  return {
    ...(adminPasswordHash ? { adminPasswordHash, adminUsername } : {}),
    ...(requireAccount === undefined ? {} : { requireAccount: requireAccount === '1' }),
    ...(registrationKey === undefined ? {} : { registrationKey }),
    ...(registrationStoreFile === undefined ? {} : { registrationStoreFile }),
  };
}

/**
 * Load the static registry, optional persisted registrations, and legacy
 * single-Gateway configuration. A registration key without an explicit store
 * uses a private local target path; deployments should set the store path to a
 * durable service-owned directory.
 */
export function relayServerConfig(env = process.env) {
  const common = {
    controlPort: port('KCODER_RELAY_CONTROL_PORT', 18452, env),
    proxyPort: port('KCODER_RELAY_PROXY_PORT', 18451, env),
  };
  const registration = registrationOptions(env);
  if (env.KCODER_RELAY_REGISTRY_FILE) {
    return {
      ...readRegistryFile(env.KCODER_RELAY_REGISTRY_FILE),
      ...registration,
      ...common,
    };
  }

  if (registration.registrationStoreFile) {
    return {
      gateways: [],
      sharedHosts: registrationSharedHosts(env),
      ...registration,
      ...common,
    };
  }

  const { secret, device: gatewayId } = credentials(env);
  const gatewaySecret = env.KCODER_RELAY_GATEWAY_SECRET || '';
  if (gatewaySecret && !isCredential(gatewaySecret)) throw new Error('Gateway internal secret must be at least 32 characters');
  if (gatewaySecret && gatewaySecret === secret) throw new Error('Relay secret and Gateway internal secret must be distinct');
  const gateway = {
    id: gatewayId,
    secret,
    gatewaySecret,
    maxConnections: legacyInteger(env.KCODER_RELAY_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS, 'KCODER_RELAY_MAX_CONNECTIONS', 1, 100_000),
    maxBytesPerWindow: legacyInteger(env.KCODER_RELAY_MAX_BYTES_PER_WINDOW, DEFAULT_MAX_BYTES_PER_WINDOW, 'KCODER_RELAY_MAX_BYTES_PER_WINDOW', 1, Number.MAX_SAFE_INTEGER),
    trafficWindowMs: legacyInteger(env.KCODER_RELAY_TRAFFIC_WINDOW_MS, DEFAULT_TRAFFIC_WINDOW_MS, 'KCODER_RELAY_TRAFFIC_WINDOW_MS', 1, 86_400_000),
  };
  return { legacy: true, gateways: [gateway], sharedHosts: legacySharedHosts(env), ...common };
}

function legacyInteger(raw, fallback, name, min, max) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
