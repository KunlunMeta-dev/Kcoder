import { constants } from 'node:fs';
import { chmod, link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_IDENTITY_BYTES = 4096;
const CREDENTIAL = /^[A-Za-z0-9._~-]{32,512}$/;
const GATEWAY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IDENTITY_KEYS = new Set([
  'version', 'relayOrigin', 'pairingTokenHash', 'enrollmentToken', 'id', 'secret',
]);

export const DEFAULT_IDENTITY_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../target/kcoder-relay/client-identity.json',
);

export function resolveIdentityFile(env = process.env) {
  const configured = env.KCODER_RELAY_IDENTITY_FILE;
  return resolve(configured || DEFAULT_IDENTITY_FILE);
}

export function normalizeRelayOrigin(relayUrl) {
  if (typeof relayUrl !== 'string' || relayUrl.length === 0) throw new Error('Configure KCODER_RELAY_PUBLIC_URL');
  let parsed;
  try { parsed = new URL(relayUrl); }
  catch { throw new Error('Invalid relay URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Relay URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
  return parsed.origin;
}

function validCredential(value) {
  return typeof value === 'string' && CREDENTIAL.test(value);
}

function pairingHash(pairingToken) {
  if (!validCredential(pairingToken)) throw new Error('Gateway pairing token must be 32 to 512 URL-safe characters');
  return createHash('sha256').update(pairingToken, 'utf8').digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) throw new Error(`Invalid ${label} schema`);
}

function validateRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Client identity must be a JSON object');
  const keys = Object.keys(value);
  if (keys.some(key => !IDENTITY_KEYS.has(key))) throw new Error('Client identity contains unknown fields');
  const hasEnrollment = Object.hasOwn(value, 'enrollmentToken');
  const hasId = Object.hasOwn(value, 'id');
  const hasSecret = Object.hasOwn(value, 'secret');
  if (hasId !== hasSecret || hasEnrollment === hasId) throw new Error('Client identity has an invalid state');
  const expected = hasEnrollment
    ? new Set(['version', 'relayOrigin', 'pairingTokenHash', 'enrollmentToken'])
    : new Set(['version', 'relayOrigin', 'pairingTokenHash', 'id', 'secret']);
  exactKeys(value, expected, 'client identity');
  if (value.version !== 1) throw new Error('Unsupported client identity version');
  if (typeof value.relayOrigin !== 'string' || normalizeRelayOrigin(value.relayOrigin) !== value.relayOrigin) {
    throw new Error('Invalid client identity relay origin');
  }
  if (typeof value.pairingTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.pairingTokenHash)) {
    throw new Error('Invalid client identity pairing token hash');
  }
  if (hasEnrollment) {
    if (!validCredential(value.enrollmentToken)) throw new Error('Invalid client identity enrollment token');
    return { status: 'pending', ...value };
  }
  if (typeof value.id !== 'string' || !GATEWAY_ID.test(value.id) || !validCredential(value.secret)) {
    throw new Error('Invalid registered client identity');
  }
  return { status: 'registered', ...value };
}

async function readRecord(identityFile) {
  const path = resolve(identityFile || DEFAULT_IDENTITY_FILE);
  let handle;
  try {
    const noFollow = constants.O_NOFOLLOW || 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Client identity must be a regular file');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Client identity file must be private (mode 0600 or stricter)');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Client identity file must be owned by the current user');
    if (stat.size > MAX_IDENTITY_BYTES) throw new Error(`Client identity exceeds ${MAX_IDENTITY_BYTES} bytes`);
    const buffer = Buffer.alloc(MAX_IDENTITY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_IDENTITY_BYTES) throw new Error(`Client identity exceeds ${MAX_IDENTITY_BYTES} bytes`);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { throw new Error('Client identity is not valid UTF-8 JSON'); }
    return validateRecord(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeAtomic(identityFile, record, { exclusive = false } = {}) {
  const path = resolve(identityFile || DEFAULT_IDENTITY_FILE);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (exclusive) {
      await link(temporary, path);
      await unlink(temporary);
    } else {
      await rename(temporary, path);
    }
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function validateBinding(record, origin, configuredPairingHash) {
  if (record.relayOrigin !== origin) throw new Error('Client identity belongs to a different relay origin');
  if (configuredPairingHash && record.pairingTokenHash !== configuredPairingHash) {
    throw new Error('Client identity belongs to a different Gateway pairing token');
  }
}

/** Load a registered identity, requiring an exact relay and optional pairing-token match. */
export async function readRegisteredClientIdentity({ identityFile = DEFAULT_IDENTITY_FILE, relayUrl, pairingToken } = {}) {
  const record = await readRecord(identityFile);
  if (!record) throw new Error('Client identity file does not exist');
  if (record.status !== 'registered') throw new Error('Client identity is not registered; connect the relay client first');
  const origin = normalizeRelayOrigin(relayUrl);
  const tokenHash = pairingToken === undefined ? undefined : pairingHash(pairingToken);
  validateBinding(record, origin, tokenHash);
  return { id: record.id, secret: record.secret };
}

/** Read only the assigned Gateway ID for routing and QR generation. */
export async function readRegisteredClientId(options = {}) {
  return (await readRegisteredClientIdentity(options)).id;
}

/** Load the cached identity or atomically create a durable enrollment proof. */
export async function prepareClientIdentity({ identityFile = DEFAULT_IDENTITY_FILE, relayUrl, pairingToken } = {}) {
  const path = resolve(identityFile);
  const origin = normalizeRelayOrigin(relayUrl);
  let tokenHash;
  if (pairingToken !== undefined) tokenHash = pairingHash(pairingToken);
  const existing = await readRecord(path);
  if (existing) {
    validateBinding(existing, origin, tokenHash);
    if (existing.status === 'registered') return { status: 'registered', id: existing.id, secret: existing.secret };
    if (!tokenHash) throw new Error('Configure KCODER_RELAY_GATEWAY_TOKEN to resume client registration');
    return { status: 'pending', enrollmentToken: existing.enrollmentToken };
  }
  if (!tokenHash) throw new Error('Configure KCODER_RELAY_GATEWAY_TOKEN before client registration');
  const enrollmentToken = randomBytes(32).toString('base64url');
  const pending = {
    version: 1,
    relayOrigin: origin,
    pairingTokenHash: tokenHash,
    enrollmentToken,
  };
  try {
    await writeAtomic(path, pending, { exclusive: true });
    return { status: 'pending', enrollmentToken };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const winner = await readRecord(path);
    if (!winner) throw new Error('Client identity initialization raced with another process');
    validateBinding(winner, origin, tokenHash);
    if (winner.status === 'registered') return { status: 'registered', id: winner.id, secret: winner.secret };
    return { status: 'pending', enrollmentToken: winner.enrollmentToken };
  }
}

/** Replace a pending proof with the assigned identity after successful registration. */
export async function saveRegisteredClientIdentity({ identityFile = DEFAULT_IDENTITY_FILE, relayUrl, pairingToken, enrollmentToken, id, secret } = {}) {
  if (!validCredential(enrollmentToken)) throw new Error('Invalid client enrollment token');
  if (typeof id !== 'string' || !GATEWAY_ID.test(id) || !validCredential(secret)) throw new Error('Invalid registered client credentials');
  const origin = normalizeRelayOrigin(relayUrl);
  const tokenHash = pairingHash(pairingToken);
  const existing = await readRecord(identityFile);
  if (!existing) throw new Error('Pending client identity disappeared during registration');
  validateBinding(existing, origin, tokenHash);
  if (existing.status === 'registered') {
    if (existing.id !== id || existing.secret !== secret) throw new Error('Registered client identity changed unexpectedly');
    return { id, secret };
  }
  if (existing.enrollmentToken !== enrollmentToken) throw new Error('Client enrollment proof changed during registration');
  await writeAtomic(identityFile, {
    version: 1,
    relayOrigin: origin,
    pairingTokenHash: tokenHash,
    id,
    secret,
  });
  return { id, secret };
}
