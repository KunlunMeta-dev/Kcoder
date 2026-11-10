import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, parse, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { hashAccountPassword, meetsPasswordPolicy, validAdminPasswordHash, verifyAdminPassword } from './admin-auth.mjs';

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 256 * 1024;
const MAX_GATEWAYS = 256;
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RECORD_ID = /^[a-f0-9]{32}$/;
const DAY_MS = 86400000;
const ACCOUNT_SESSION_LIFETIME_MS = 30 * DAY_MS;
const LEGACY_INVITE_MAX_MS = 7 * DAY_MS;
const MAX_DATE_MS = 8_640_000_000_000_000;

function expired(expiresAt, now) {
  return expiresAt !== null && expiresAt <= now;
}

function validExpiry(expiresAt, createdAt) {
  return Number.isSafeInteger(expiresAt) && expiresAt > createdAt && expiresAt <= MAX_DATE_MS;
}

function usesAccountInviteFormat(code) {
  return code.purpose !== undefined || code.signupCapacity !== undefined || code.sessionHash !== undefined ||
    code.expiresAt === null || code.expiresAt - code.createdAt > LEGACY_INVITE_MAX_MS;
}
const MAX_ACTIVATION_CODES = 512;
const MAX_CREDENTIAL_BYTES = 512;
const LOCK_MAX_BYTES = 4096;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;

export const REGISTRATION_STORE_ERROR_CODES = Object.freeze({
  unauthorized: 'REGISTRATION_UNAUTHORIZED',
  passwordPolicy: 'REGISTRATION_PASSWORD_POLICY',
  passwordResetRequired: 'REGISTRATION_PASSWORD_RESET_REQUIRED',
  conflict: 'REGISTRATION_CONFLICT',
  capacity: 'REGISTRATION_CAPACITY',
  storeCapacity: 'REGISTRATION_STORE_CAPACITY',
  invalidOptions: 'REGISTRATION_STORE_INVALID_OPTIONS',
  locked: 'REGISTRATION_STORE_LOCKED',
  unsafe: 'REGISTRATION_STORE_UNSAFE',
  corrupt: 'REGISTRATION_STORE_CORRUPT',
  tooLarge: 'REGISTRATION_STORE_TOO_LARGE',
  persistence: 'REGISTRATION_STORE_PERSISTENCE',
  closed: 'REGISTRATION_STORE_CLOSED',
});

export class RegistrationStoreError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'RegistrationStoreError';
    this.code = code;
  }
}

function fail(code, message, cause = undefined) {
  return new RegistrationStoreError(code, message, cause === undefined ? undefined : { cause });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function validGatewaySecret(value) {
  return typeof value === 'string'
    && value.length >= 32
    && value.length <= MAX_CREDENTIAL_BYTES
    && byteLength(value) <= MAX_CREDENTIAL_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validEnrollmentToken(value) {
  if (typeof value !== 'string' || value.length > MAX_CREDENTIAL_BYTES || byteLength(value) > MAX_CREDENTIAL_BYTES) return false;

  // Accept canonical unpadded base64url or hex encodings of at least 32 bytes.
  // Entropy is generated and protected by the client; this boundary enforces
  // the minimum encoded proof size and avoids accepting human passwords.
  if (/^[A-Za-z0-9_-]+$/.test(value) && value.length >= 43) {
    try {
      const decoded = Buffer.from(value, 'base64url');
      return decoded.length >= 32 && decoded.toString('base64url') === value;
    } catch {
      return false;
    }
  }
  if (/^(?:[0-9a-fA-F]{2}){32,256}$/.test(value)) return true;
  return false;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeStringEqual(left, right) {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function constantTimeHashEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function proofHashMatches(record, hash) {
  return constantTimeHashEqual(record.enrollmentTokenHash, hash);
}

function validateRegistrationInput(input) {
  if (!exactKeys(input, ['enrollmentToken', 'gatewaySecret'])
      || !validEnrollmentToken(input.enrollmentToken)
      || !validGatewaySecret(input.gatewaySecret)) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Registration proof or Gateway internal secret is invalid.');
  }
  if (constantTimeStringEqual(input.enrollmentToken, input.gatewaySecret)) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Registration proof or Gateway internal secret is invalid.');
  }
  return { enrollmentToken: input.enrollmentToken, gatewaySecret: input.gatewaySecret };
}

function validateRegisterOptions(options) {
  if (options === undefined) return {};
  if (!isObject(options) || Object.keys(options).some(key => !['validateGateway', 'existingOnly'].includes(key))) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Registration validation options are invalid.');
  }
  if ((options.validateGateway !== undefined && typeof options.validateGateway !== 'function') ||
      (options.existingOnly !== undefined && typeof options.existingOnly !== 'boolean')) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Registration validation options are invalid.');
  }
  return options;
}

function generatedGateway(record) {
  return {
    id: record.id,
    secret: record.secret,
    gatewaySecret: record.gatewaySecret,
    maxConnections: 128,
    maxBytesPerWindow: 67_108_864,
    trafficWindowMs: 60_000,
  };
}

function cloneGateway(record) {
  return generatedGateway(record);
}

function validateStoreRecord(record, index, seen) {
  const fields = ['id', 'secret', 'gatewaySecret', 'enrollmentTokenHash'];
  if (!exactKeys(record, [...fields, ...['revokedAt', 'accountId'].filter(key => record?.[key] !== undefined)])
      || (record.revokedAt !== undefined && (!Number.isSafeInteger(record.revokedAt) || record.revokedAt < 1))
      || typeof record.id !== 'string' || !/^[a-f0-9]{32}$/.test(record.id)
      || typeof record.secret !== 'string' || !/^[a-f0-9]{64}$/.test(record.secret)
      || !validGatewaySecret(record.gatewaySecret)
      || typeof record.enrollmentTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.enrollmentTokenHash)) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, `Registration store record ${index} is invalid.`);
  }
  if (seen.ids.has(record.id)
      || seen.secrets.has(record.secret)
      || seen.gatewaySecrets.has(record.gatewaySecret)
      || seen.enrollmentHashes.some(hash => constantTimeHashEqual(hash, record.enrollmentTokenHash))
      || seen.secrets.has(record.id)
      || seen.gatewaySecrets.has(record.id)
      || seen.ids.has(record.secret)
      || seen.gatewaySecrets.has(record.secret)
      || seen.ids.has(record.gatewaySecret)
      || seen.secrets.has(record.gatewaySecret)
      || record.id === record.secret
      || record.id === record.gatewaySecret) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, 'Registration store contains duplicate identities or credentials.');
  }
  seen.ids.add(record.id);
  seen.secrets.add(record.secret);
  seen.gatewaySecrets.add(record.gatewaySecret);
  seen.enrollmentHashes.push(record.enrollmentTokenHash);
}

function validateStoreDocument(document, maxGateways) {
  if (!(document?.version === 1 ? exactKeys(document, ['version', 'gateways'])
      : document?.version === 2 ? exactKeys(document, ['version', 'gateways', 'activationCodes'])
      : [3, 4, 5, 6].includes(document?.version) && exactKeys(document, ['version', 'gateways', 'activationCodes', 'accounts']))
      || !Array.isArray(document.gateways)
      || document.gateways.length > MAX_GATEWAYS) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, 'Registration store schema is invalid.');
  }
  if (document.gateways.length > maxGateways) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.storeCapacity, 'Stored Gateway registrations exceed the configured capacity.');
  }

  const seen = {
    ids: new Set(),
    secrets: new Set(),
    gatewaySecrets: new Set(),
    enrollmentHashes: [],
  };
  document.gateways.forEach((record, index) => validateStoreRecord(record, index, seen));
  for (const secret of seen.secrets) {
    if (seen.gatewaySecrets.has(secret)) {
      throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, 'Registration store contains credentials with overlapping roles.');
    }
  }
  const accounts = document.accounts ?? [];
  const accountIds = new Set();
  const usernames = new Set();
  if (!Array.isArray(accounts) || accounts.length > MAX_GATEWAYS) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, 'Invalid Relay accounts.');
  }
  for (const account of accounts) {
    if (!exactKeys(account, ['id', 'username', 'maxGateways', 'passwordHash', 'revokedAt'])
        || typeof account.id !== 'string' || !RECORD_ID.test(account.id)
        || typeof account.username !== 'string' || !ACCOUNT_NAME.test(account.username)
        || !Number.isSafeInteger(account.maxGateways) || account.maxGateways < 1 || account.maxGateways > MAX_GATEWAYS
        || (account.passwordHash !== null && !validAdminPasswordHash(account.passwordHash))
        || (account.revokedAt !== null && (!Number.isSafeInteger(account.revokedAt) || account.revokedAt < 1))
        || accountIds.has(account.id) || usernames.has(account.username)) {
      throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, 'Invalid Relay account.');
    }
    accountIds.add(account.id);
    usernames.add(account.username);
  }
  const gatewayById = new Map(document.gateways.map(record => [record.id, record]));
  if (document.gateways.some(record => record.accountId !== undefined && !accountIds.has(record.accountId))) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, 'Registered Gateway has an unknown account.');
  }
  const activationCodes = document.activationCodes ?? [];
  const codeIds = new Set();
  const codeHashes = new Set();
  if (!Array.isArray(activationCodes) || activationCodes.length > MAX_ACTIVATION_CODES) throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, 'Invalid activation codes.');
  for (const code of activationCodes) {
    if (!exactKeys(code, ['id', 'codeHash', 'label', 'createdAt', 'expiresAt', 'revokedAt', 'gatewayId',
        ...(code?.accountId === undefined ? [] : ['accountId']),
        ...(code?.purpose === undefined ? [] : ['purpose']),
        ...(code?.signupCapacity === undefined ? [] : ['signupCapacity']),
        ...(code?.sessionHash === undefined ? [] : ['sessionHash', 'sessionExpiresAt']),
        ...(code?.sessionPolicyVersion === undefined ? [] : ['sessionPolicyVersion'])]) ||
        (code.purpose !== undefined && (document.version < 5 || !['register', 'studio'].includes(code.purpose))) ||
        (code.sessionPolicyVersion !== undefined && (document.version !== 6 || code.sessionPolicyVersion !== 1 ||
          (code.sessionHash === undefined ? code.purpose !== 'studio' : code.sessionExpiresAt === null))) ||
        (code.purpose === 'studio' && !code.accountId) ||
        (usesAccountInviteFormat(code) && (document.version < 4 || (code.purpose !== 'register' && code.signupCapacity === undefined && !code.accountId))) ||
        (code.signupCapacity !== undefined && (!Number.isInteger(code.signupCapacity) || code.signupCapacity < 1 ||
          code.signupCapacity > MAX_GATEWAYS || code.gatewayId !== null)) ||
        (code.sessionHash !== undefined && (!code.accountId || code.gatewayId !== null ||
          !/^[a-f0-9]{64}$/.test(code.sessionHash) || (code.sessionExpiresAt !== null && !validExpiry(code.sessionExpiresAt, code.createdAt)))) ||
        (code.accountId !== undefined && (!accountIds.has(code.accountId) ||
          (code.gatewayId !== null && gatewayById.get(code.gatewayId)?.accountId !== code.accountId))) ||
        !/^[a-f0-9]{32}$/.test(code.id) || !/^[a-f0-9]{64}$/.test(code.codeHash) ||
        typeof code.label !== 'string' || code.label.length > 100 ||
        !Number.isSafeInteger(code.createdAt) || code.createdAt < 1 || code.createdAt > MAX_DATE_MS ||
        (code.expiresAt !== null && !validExpiry(code.expiresAt, code.createdAt)) ||
        (code.revokedAt !== null && (!Number.isSafeInteger(code.revokedAt) || code.revokedAt < 1)) ||
        (code.gatewayId !== null && !seen.ids.has(code.gatewayId)) || codeIds.has(code.id) || codeHashes.has(code.codeHash))
      throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, 'Invalid activation code record.');
    codeIds.add(code.id); codeHashes.add(code.codeHash);
  }
  return { records: document.gateways.map(record => ({ ...record })), activationCodes: activationCodes.map(code => ({ ...code })), accounts: accounts.map(account => ({ ...account })) };
}

function skipWhitespace(source, state) {
  while (state.offset < source.length && /[\t\n\r ]/.test(source[state.offset])) state.offset += 1;
}

function scanJsonString(source, state) {
  const start = state.offset;
  state.offset += 1;
  while (state.offset < source.length) {
    const character = source[state.offset];
    if (character === '"') {
      state.offset += 1;
      return JSON.parse(source.slice(start, state.offset));
    }
    if (character === '\\') state.offset += 2;
    else state.offset += 1;
  }
  throw new SyntaxError('Unterminated JSON string');
}

function rejectDuplicateJsonKeys(source) {
  const state = { offset: 0 };

  function parseValue(depth) {
    if (depth > 32) throw new SyntaxError('JSON nesting limit exceeded');
    skipWhitespace(source, state);
    const character = source[state.offset];
    if (character === '"') {
      scanJsonString(source, state);
      return;
    }
    if (character === '{') {
      state.offset += 1;
      skipWhitespace(source, state);
      const keys = new Set();
      if (source[state.offset] === '}') { state.offset += 1; return; }
      while (state.offset < source.length) {
        skipWhitespace(source, state);
        if (source[state.offset] !== '"') throw new SyntaxError('Invalid JSON object key');
        const key = scanJsonString(source, state);
        if (keys.has(key)) throw new SyntaxError('Duplicate JSON object key');
        keys.add(key);
        skipWhitespace(source, state);
        if (source[state.offset] !== ':') throw new SyntaxError('Invalid JSON object separator');
        state.offset += 1;
        parseValue(depth + 1);
        skipWhitespace(source, state);
        if (source[state.offset] === '}') { state.offset += 1; return; }
        if (source[state.offset] !== ',') throw new SyntaxError('Invalid JSON object delimiter');
        state.offset += 1;
      }
      throw new SyntaxError('Unterminated JSON object');
    }
    if (character === '[') {
      state.offset += 1;
      skipWhitespace(source, state);
      if (source[state.offset] === ']') { state.offset += 1; return; }
      while (state.offset < source.length) {
        parseValue(depth + 1);
        skipWhitespace(source, state);
        if (source[state.offset] === ']') { state.offset += 1; return; }
        if (source[state.offset] !== ',') throw new SyntaxError('Invalid JSON array delimiter');
        state.offset += 1;
      }
      throw new SyntaxError('Unterminated JSON array');
    }
    const start = state.offset;
    while (state.offset < source.length && !/[\s,\]}]/.test(source[state.offset])) state.offset += 1;
    if (state.offset === start) throw new SyntaxError('Invalid JSON value');
  }

  parseValue(0);
  skipWhitespace(source, state);
  if (state.offset !== source.length) throw new SyntaxError('Trailing JSON data');
}

function parseJsonStrict(text) {
  rejectDuplicateJsonKeys(text);
  return JSON.parse(text);
}

function fileIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameFileIdentity(left, right) {
  return left === null ? right === null : right !== null && left.dev === right.dev && left.ino === right.ino;
}

function assertOwnedRegularFile(stat, label, mode = FILE_MODE) {
  if (!stat.isFile() || stat.nlink !== 1
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || (stat.mode & 0o777) !== mode) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, `${label} must be a private regular file with mode ${mode.toString(8)}.`);
  }
}

async function readBounded(handle, maximumBytes, errorCode, label) {
  const chunks = [];
  let total = 0;
  while (total <= maximumBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximumBytes) {
      throw fail(errorCode, `${label} exceeds its size limit.`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

async function ensurePrivateParent(parentPath) {
  try {
    const root = parse(parentPath).root;
    let currentPath = root;
    let stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store parent path is unsafe.');
    }
    for (const component of parentPath.slice(root.length).split(sep).filter(Boolean)) {
      currentPath = resolve(currentPath, component);
      try {
        stat = await fs.lstat(currentPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { await fs.mkdir(currentPath, { mode: DIRECTORY_MODE }); }
        catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
        stat = await fs.lstat(currentPath);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store parent path must not contain symbolic links.');
      }
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store parent must be owned by this user.');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE) {
      await fs.chmod(parentPath, DIRECTORY_MODE);
      stat = await fs.lstat(parentPath);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || (process.platform !== 'win32' && (stat.mode & 0o777) !== DIRECTORY_MODE)) {
      throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store parent must have mode 0700.');
    }
  } catch (error) {
    if (error instanceof RegistrationStoreError) throw error;
    throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store parent is unavailable or unsafe.', error);
  }
}

async function readStoreFile(path, maxGateways) {
  let handle;
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return { records: [], activationCodes: [], accounts: [], bytes: null, identity: null };
    if (error.code === 'ELOOP') throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store must not be a symbolic link.', error);
    throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store could not be opened safely.', error);
  }

  try {
    const stat = await handle.stat();
    assertOwnedRegularFile(stat, 'Registration store');
    if (stat.size > MAX_STORE_BYTES) {
      throw fail(REGISTRATION_STORE_ERROR_CODES.tooLarge, 'Registration store exceeds the 256 KiB limit.');
    }
    const bytes = await readBounded(handle, MAX_STORE_BYTES, REGISTRATION_STORE_ERROR_CODES.tooLarge, 'Registration store');
    let text;
    let document;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      document = parseJsonStrict(text);
    } catch (error) {
      throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, 'Registration store is not valid strict UTF-8 JSON.', error);
    }
    return { ...validateStoreDocument(document, maxGateways), bytes, identity: fileIdentity(stat) };
  } finally {
    await handle.close();
  }
}

async function readProcessStart(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const closeIndex = stat.lastIndexOf(')');
    if (closeIndex < 0) return null;
    const fields = stat.slice(closeIndex + 1).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

async function processIsLockOwnerAlive(metadata) {
  let alive = true;
  try {
    process.kill(metadata.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') alive = false;
    else if (error.code !== 'EPERM') return true;
  }
  if (!alive) return false;
  if (metadata.hostname !== hostname()) return true;
  if (metadata.processStart === null) return true;
  const currentStart = await readProcessStart(metadata.pid);
  return currentStart === null || currentStart === metadata.processStart;
}

function validLockMetadata(value) {
  return exactKeys(value, ['version', 'pid', 'hostname', 'processStart', 'startedAt', 'owner'])
    && value.version === 1
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.hostname === 'string' && value.hostname.length > 0 && value.hostname.length <= 255
    && (value.processStart === null || (typeof value.processStart === 'string' && value.processStart.length <= 64))
    && Number.isSafeInteger(value.startedAt) && value.startedAt > 0
    && typeof value.owner === 'string' && /^[a-f0-9]{48}$/.test(value.owner);
}

async function readLockFile(path) {
  let handle;
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.locked, 'Registration store is locked by another process.', error);
  }
  try {
    const stat = await handle.stat();
    assertOwnedRegularFile(stat, 'Registration lock');
    if (stat.size > LOCK_MAX_BYTES) throw fail(REGISTRATION_STORE_ERROR_CODES.locked, 'Registration store is locked by another process.');
    const bytes = await readBounded(handle, LOCK_MAX_BYTES, REGISTRATION_STORE_ERROR_CODES.locked, 'Registration lock');
    let metadata;
    try {
      metadata = parseJsonStrict(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      throw fail(REGISTRATION_STORE_ERROR_CODES.locked, 'Registration store is locked by another process.', error);
    }
    if (!validLockMetadata(metadata)) throw fail(REGISTRATION_STORE_ERROR_CODES.locked, 'Registration store is locked by another process.');
    return { metadata, identity: fileIdentity(stat) };
  } finally {
    await handle.close();
  }
}

async function releaseOwnedFile(path, expectedIdentity, expectedOwner = undefined) {
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || !sameFileIdentity(expectedIdentity, fileIdentity(stat))) return false;
    if (expectedOwner !== undefined) {
      const { metadata } = await readLockFile(path);
      if (metadata.owner !== expectedOwner) return false;
    }
    await fs.unlink(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function tryAcquireExclusiveLock(path, metadata) {
  let handle;
  try {
    handle = await fs.open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NOFOLLOW, FILE_MODE);
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store lock could not be created.', error);
  }

  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, { encoding: 'utf8' });
    await handle.sync();
    const stat = await handle.stat();
    return { handle, metadata, identity: fileIdentity(stat) };
  } catch (error) {
    const stat = await handle.stat().catch(() => null);
    await handle.close().catch(() => {});
    if (stat) await releaseOwnedFile(path, fileIdentity(stat), metadata.owner).catch(() => {});
    throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store lock could not be initialized.', error);
  }
}

async function acquireLock(path) {
  const lockPath = `${path}.lock`;
  const lockBase = {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    processStart: await readProcessStart(process.pid),
    startedAt: Date.now(),
    owner: randomBytes(24).toString('hex'),
  };
  const first = await tryAcquireExclusiveLock(lockPath, lockBase);
  if (first) return { ...first, path: lockPath };

  let existing;
  try {
    existing = await readLockFile(lockPath);
  } catch {
    throw fail(REGISTRATION_STORE_ERROR_CODES.locked, 'Registration store is locked by another process.');
  }
  if (await processIsLockOwnerAlive(existing.metadata)) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.locked, 'Registration store is locked by another process.');
  }

  // Serialize stale-lock recovery with an O_EXCL guard. If recovery itself is
  // interrupted, a later process fails closed and requires operator inspection.
  const reapPath = `${lockPath}.reap`;
  const reapMetadata = { ...lockBase, owner: randomBytes(24).toString('hex') };
  const reaper = await tryAcquireExclusiveLock(reapPath, reapMetadata);
  if (!reaper) throw fail(REGISTRATION_STORE_ERROR_CODES.locked, 'Registration store lock recovery is already in progress.');
  try {
    const current = await readLockFile(lockPath);
    if (!sameFileIdentity(existing.identity, current.identity)
        || current.metadata.owner !== existing.metadata.owner
        || await processIsLockOwnerAlive(current.metadata)) {
      throw fail(REGISTRATION_STORE_ERROR_CODES.locked, 'Registration store lock changed during recovery.');
    }
    await releaseOwnedFile(lockPath, current.identity, current.metadata.owner);
  } finally {
    await reaper.handle.close().catch(() => {});
    await releaseOwnedFile(reapPath, reaper.identity, reapMetadata.owner).catch(() => {});
  }

  const acquired = await tryAcquireExclusiveLock(lockPath, lockBase);
  if (!acquired) throw fail(REGISTRATION_STORE_ERROR_CODES.locked, 'Registration store was opened by another process.');
  return { ...acquired, path: lockPath };
}

async function releaseLock(lock) {
  let releaseError;
  try {
    await releaseOwnedFile(lock.path, lock.identity, lock.metadata.owner);
  } catch (error) {
    releaseError = error;
  }
  await lock.handle.close().catch(error => { releaseError ??= error; });
  if (releaseError) throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store lock could not be released safely.', releaseError);
}

function documentBytes(records, activationCodes, accounts) {
  const extended = activationCodes.length > 0 || records.some(record => record.revokedAt !== undefined);
  const accountSessions = activationCodes.some(usesAccountInviteFormat);
  const version = activationCodes.some(code => code.sessionPolicyVersion !== undefined) ? 6 :
    activationCodes.some(code => code.purpose !== undefined) ? 5 : accountSessions ? 4 : 3;
  const document = accounts.length || accountSessions ? { version, gateways: records, activationCodes, accounts }
    : { version: extended ? 2 : STORE_VERSION, gateways: records, ...(extended ? { activationCodes } : {}) };
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8');
  if (bytes.length > MAX_STORE_BYTES) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.tooLarge, 'Registration store exceeds the 256 KiB limit.');
  }
  return bytes;
}

async function syncParentDirectory(parentPath) {
  if (process.platform === 'win32') return;
  const directoryHandle = await fs.open(parentPath, fsConstants.O_RDONLY | DIRECTORY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function writeAtomicImage(path, bytes, expectedIdentity) {
  const parentPath = dirname(path);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;
  const currentPath = await fs.lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (currentPath && (currentPath.isSymbolicLink() || !currentPath.isFile())) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store path changed to an unsafe file type.');
  }
  const observedIdentity = currentPath ? fileIdentity(currentPath) : null;
  if (!sameFileIdentity(expectedIdentity, observedIdentity)) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store changed outside its owner.');
  }

  let temporaryHandle;
  let renamed = false;
  try {
    temporaryHandle = await fs.open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NOFOLLOW, FILE_MODE);
    await temporaryHandle.chmod(FILE_MODE);
    await temporaryHandle.writeFile(bytes);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    await fs.rename(temporaryPath, path);
    renamed = true;
    const installed = await fs.lstat(path);
    assertOwnedRegularFile(installed, 'Registration store');
    const identity = fileIdentity(installed);
    await syncParentDirectory(parentPath);
    return identity;
  } catch (error) {
    await temporaryHandle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    if (error instanceof RegistrationStoreError) {
      error.renamed = renamed;
      throw error;
    }
    const wrapped = fail(REGISTRATION_STORE_ERROR_CODES.persistence, 'Registration store could not be saved.', error);
    wrapped.renamed = renamed;
    throw wrapped;
  }
}

async function restorePreviousImage(path, previousBytes, currentIdentity) {
  if (previousBytes === null) {
    const current = await fs.lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (current && !sameFileIdentity(currentIdentity, fileIdentity(current))) {
      throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store changed while rolling back a failed save.');
    }
    if (current) await fs.unlink(path);
    await syncParentDirectory(dirname(path));
    return null;
  }
  return writeAtomicImage(path, previousBytes, currentIdentity);
}

async function persistRecords(path, records, previousBytes, expectedIdentity, activationCodes, accounts) {
  const bytes = documentBytes(records, activationCodes, accounts);
  try {
    const identity = await writeAtomicImage(path, bytes, expectedIdentity);
    return { identity, bytes };
  } catch (error) {
    if (!error.renamed) throw error;
    try {
      const installedStat = await fs.lstat(path);
      const installedIdentity = fileIdentity(installedStat);
      error.restoredIdentity = await restorePreviousImage(path, previousBytes, installedIdentity);
      error.rollbackFailed = false;
    } catch (rollbackError) {
      error.rollbackFailed = true;
      error.cause ??= rollbackError;
    }
    throw error;
  }
}

function makeRecord(enrollmentToken, gatewaySecret, existingRecords) {
  const idUsed = new Set(existingRecords.map(record => record.id));
  const secretUsed = new Set(existingRecords.map(record => record.secret));
  const gatewaySecrets = new Set(existingRecords.map(record => record.gatewaySecret));
  let id;
  do { id = randomBytes(16).toString('hex'); }
  while (idUsed.has(id) || id === enrollmentToken || id === gatewaySecret || secretUsed.has(id) || gatewaySecrets.has(id));

  let secret;
  do { secret = randomBytes(32).toString('hex'); }
  while (idUsed.has(secret) || secretUsed.has(secret) || gatewaySecrets.has(secret)
    || secret === gatewaySecret || secret === enrollmentToken || secret === id);

  return {
    id,
    secret,
    gatewaySecret,
    enrollmentTokenHash: sha256(enrollmentToken),
  };
}

function validateEnrollmentSeparation(enrollmentToken, gatewaySecret, records) {
  if (constantTimeStringEqual(enrollmentToken, gatewaySecret)
      || records.some(record => constantTimeStringEqual(enrollmentToken, record.secret)
        || constantTimeStringEqual(enrollmentToken, record.gatewaySecret))) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Registration proof or Gateway internal secret is invalid.');
  }
}

function verifyPairingUnused(gatewaySecret, records) {
  if (records.some(record => constantTimeStringEqual(gatewaySecret, record.gatewaySecret)
      || constantTimeStringEqual(gatewaySecret, record.secret)
      || constantTimeStringEqual(gatewaySecret, record.id))) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.conflict, 'Gateway internal secret is already assigned.');
  }
}

async function runValidateGateway(validateGateway, record) {
  if (!validateGateway) return;
  await validateGateway(Object.freeze(cloneGateway(record)));
}

function validateOpenOptions(options) {
  if (!isObject(options)
      || Object.keys(options).some(key => key !== 'path' && key !== 'maxGateways')
      || typeof options.path !== 'string' || options.path.length === 0) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Registration store path or options are invalid.');
  }
  const maxGateways = options.maxGateways ?? MAX_GATEWAYS;
  if (!Number.isSafeInteger(maxGateways) || maxGateways < 0 || maxGateways > MAX_GATEWAYS) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Registration store capacity must be an integer from 0 to 256.');
  }
  const path = resolve(options.path);
  if (basename(path) === '.' || basename(path).length === 0) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Registration store path must name a file.');
  }
  return { path, maxGateways };
}

export async function openRegistrationStore(options) {
  const { path, maxGateways } = validateOpenOptions(options);
  const parentPath = dirname(path);
  await ensurePrivateParent(parentPath);

  let lock;
  try {
    lock = await acquireLock(path);
  } catch (error) {
    if (error instanceof RegistrationStoreError) throw error;
    throw fail(REGISTRATION_STORE_ERROR_CODES.unsafe, 'Registration store could not be locked safely.', error);
  }

  let loaded;
  try {
    loaded = await readStoreFile(path, maxGateways);
  } catch (error) {
    await releaseLock(lock).catch(() => {});
    throw error;
  }

  let records = loaded.records;
  let activationCodes = loaded.activationCodes;
  let accounts = loaded.accounts;
  let currentBytes = loaded.bytes;
  let currentIdentity = loaded.identity;
  let closed = false;
  let poisoned = false;
  let queue = Promise.resolve();

  const enqueue = operation => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };

  function ensureUsable() {
    if (closed) throw fail(REGISTRATION_STORE_ERROR_CODES.closed, 'Registration store is closed.');
    if (poisoned) throw fail(REGISTRATION_STORE_ERROR_CODES.persistence, 'Registration store requires a restart after a failed rollback.');
  }

  async function commit(nextRecords, nextCodes = activationCodes, nextAccounts = accounts) {
    try {
      const persisted = await persistRecords(path, nextRecords, currentBytes, currentIdentity, nextCodes, nextAccounts);
      records = nextRecords; activationCodes = nextCodes; accounts = nextAccounts;
      currentBytes = persisted.bytes; currentIdentity = persisted.identity;
    } catch (error) {
      if (error.restoredIdentity !== undefined) currentIdentity = error.restoredIdentity;
      if (error.rollbackFailed) poisoned = true;
      if (error instanceof RegistrationStoreError) throw error;
      throw fail(REGISTRATION_STORE_ERROR_CODES.persistence, 'Registration store could not be saved.', error);
    }
  }

  function enabledAccount(id) {
    const account = accounts.find(value => value.id === id && value.revokedAt === null);
    if (!account) throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Relay account is unavailable.');
    return account;
  }

  function accountSession(token) {
    if (!validEnrollmentToken(token)) return null;
    const hash = sha256(token);
    const now = Date.now();
    return activationCodes.find(code => activeAccountSession(code, now) && constantTimeHashEqual(code.sessionHash, hash) &&
      accounts.some(account => account.id === code.accountId && account.revokedAt === null));
  }

  function activeAccountSession(code, now) {
    return code.sessionHash && code.sessionPolicyVersion === 1 && code.revokedAt === null && !expired(code.sessionExpiresAt, now);
  }

  function publicAccount(account, sessionExpiresAt) {
    return { id: account.id, username: account.username, sessionExpiresAt };
  }

  async function registerInside(normalized, validateGateway, activation, accountId = activation?.accountId, existingOnly = false) {
    ensureUsable();
    validateEnrollmentSeparation(normalized.enrollmentToken, normalized.gatewaySecret, records);
    const existing = records.find(record => proofHashMatches(record, sha256(normalized.enrollmentToken)));
    if (activation && (activation.revokedAt !== null ||
        (activation.gatewayId === null ? expired(activation.expiresAt, Date.now()) : activation.gatewayId !== existing?.id)))
      throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Activation code is unavailable.');
    if (accountId !== undefined) enabledAccount(accountId);
    if (existing) {
      if (existing.revokedAt || existing.accountId !== accountId || !constantTimeStringEqual(existing.gatewaySecret, normalized.gatewaySecret))
        throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Registration proof or Gateway internal secret is invalid.');
      await runValidateGateway(validateGateway, existing);
      if (activation && activation.gatewayId === null) throw fail(REGISTRATION_STORE_ERROR_CODES.conflict, 'Gateway is already registered.');
      return cloneGateway(existing);
    }
    if (existingOnly) throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Sign in to a Relay account to enroll a new Gateway.');
    verifyPairingUnused(normalized.gatewaySecret, records);
    if (records.length >= maxGateways) throw fail(REGISTRATION_STORE_ERROR_CODES.capacity, 'Registration capacity has been reached.');
    const candidate = makeRecord(normalized.enrollmentToken, normalized.gatewaySecret, records);
    if (accountId !== undefined) candidate.accountId = accountId;
    await runValidateGateway(validateGateway, candidate);
    const nextCodes = activation ? activationCodes.map(code => code.id === activation.id ? { ...code, gatewayId: candidate.id } : code) : activationCodes;
    // Code consumption and the assigned credentials share this single durable image.
    await commit([...records, candidate], nextCodes);
    return cloneGateway(candidate);
  }

  function availableCodeRecords(now) {
    if (activationCodes.length < MAX_ACTIVATION_CODES) return activationCodes;
    const reusable = activationCodes.find(record => record.gatewayId === null &&
      (record.revokedAt !== null || (record.sessionHash ? !activeAccountSession(record, now) : expired(record.expiresAt, now)) ||
        accounts.some(account => account.id === record.accountId && account.revokedAt !== null)));
    if (!reusable) throw fail(REGISTRATION_STORE_ERROR_CODES.capacity, 'Activation code capacity has been reached.');
    return activationCodes.filter(record => record !== reusable);
  }

  async function authenticateAccount(username, password) {
    ensureUsable();
    const account = accounts.find(value => value.username === username && value.revokedAt === null);
    const hash = account?.passwordHash;
    const valid = await verifyAdminPassword(password, hash ?? `scrypt$${'0'.repeat(32)}$${'0'.repeat(64)}`);
    if (!hash || !valid) throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'KCoder account sign-in failed.');
    if (!meetsPasswordPolicy(password, username))
      throw fail(REGISTRATION_STORE_ERROR_CODES.passwordResetRequired, 'Reset the KCoder account password using an administrator-issued invitation.');
    return account;
  }

  const store = {
    async register(input, registerOptions = undefined) {
      const normalized = validateRegistrationInput(input);
      const { validateGateway, existingOnly } = validateRegisterOptions(registerOptions);
      return enqueue(() => registerInside(normalized, validateGateway, undefined, undefined, existingOnly));
    },
    async createAccount({ username, password, maxGateways } = {}) {
      if (typeof username !== 'string' || !ACCOUNT_NAME.test(username)
          || !Number.isSafeInteger(maxGateways) || maxGateways < 1 || maxGateways > MAX_GATEWAYS) {
        throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Invalid Relay account.');
      }
      if (password !== undefined && !meetsPasswordPolicy(password, username))
        throw fail(REGISTRATION_STORE_ERROR_CODES.passwordPolicy, 'Password does not meet the Relay password policy.');
      return enqueue(async () => {
        ensureUsable();
        if (accounts.length >= MAX_GATEWAYS) throw fail(REGISTRATION_STORE_ERROR_CODES.capacity, 'Relay account capacity has been reached.');
        if (accounts.some(account => account.username === username))
          throw fail(REGISTRATION_STORE_ERROR_CODES.conflict, 'Relay account name is already used.');
        const account = { id: randomBytes(16).toString('hex'), username, maxGateways,
          passwordHash: password === undefined ? null : await hashAccountPassword(password), revokedAt: null };
        await commit(records, activationCodes, [...accounts, account]);
        const { passwordHash, ...summary } = account;
        return summary;
      });
    },
    async revokeAccount(id) {
      return enqueue(async () => {
        ensureUsable();
        const account = accounts.find(value => value.id === id);
        if (!account) throw fail(REGISTRATION_STORE_ERROR_CODES.conflict, 'Unknown Relay account.');
        if (!account.revokedAt) {
          await commit(records, activationCodes, accounts.map(value =>
            value.id === id ? { ...value, revokedAt: Date.now() } : value));
        }
        return records.filter(record => record.accountId === id).map(record => record.id);
      });
    },
    async claimGateway(id, accountId) {
      return enqueue(async () => {
        ensureUsable();
        enabledAccount(accountId);
        const gateway = records.find(record => record.id === id);
        if (!gateway || gateway.revokedAt || (gateway.accountId !== undefined && gateway.accountId !== accountId)) {
          throw fail(REGISTRATION_STORE_ERROR_CODES.conflict, 'Gateway cannot be assigned to this account.');
        }
        if (gateway.accountId === accountId) return;
        await commit(records.map(record => record.id === id ? { ...record, accountId } : record));
      });
    },
    async registerAccount({ username, password }, input, options) {
      const normalized = validateRegistrationInput(input);
      const { validateGateway } = validateRegisterOptions(options);
      const account = await authenticateAccount(username, password);
      return enqueue(() => {
        if (enabledAccount(account.id).passwordHash !== account.passwordHash)
          throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'KCoder account sign-in failed.');
        return registerInside(normalized, validateGateway, undefined, account.id);
      });
    },
    async issueStudioLogin({ username, password }) {
      const account = await authenticateAccount(username, password);
      return store.createActivationCode({ accountId: account.id, ttlMs: 120_000, purpose: 'studio' }, account.passwordHash);
    },
    async createActivationCode({ label = '', ttlMs, accountId, signupCapacity, purpose } = {}, expectedPasswordHash) {
      const forAccount = accountId !== undefined || signupCapacity !== undefined || purpose === 'register';
      if (purpose !== undefined && (!forAccount || !['register', 'studio'].includes(purpose) || (purpose === 'studio' && !accountId)))
        throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Invalid account invitation purpose.');
      const lifetime = ttlMs === undefined ? (forAccount ? null : DAY_MS) : ttlMs;
      if (typeof label !== 'string' || label.length > 100 || (lifetime === null ? !forAccount :
        !Number.isSafeInteger(lifetime) || lifetime < 60000 || (!forAccount && lifetime > LEGACY_INVITE_MAX_MS)))
        throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Invalid activation code label or lifetime.');
      if (signupCapacity !== undefined && (accountId !== undefined || !Number.isInteger(signupCapacity) ||
          signupCapacity < 1 || signupCapacity > MAX_GATEWAYS))
        throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Invalid account Gateway capacity.');
      return enqueue(async () => {
        ensureUsable();
        if (accountId !== undefined) {
          const account = enabledAccount(accountId);
          if (expectedPasswordHash !== undefined && account.passwordHash !== expectedPasswordHash)
            throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'KCoder account sign-in failed.');
        }
        const createdAt = Date.now();
        const expiresAt = lifetime === null ? null : createdAt + lifetime;
        if (expiresAt !== null && !validExpiry(expiresAt, createdAt))
          throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Invalid activation code lifetime.');
        const retained = availableCodeRecords(createdAt);
        const code = randomBytes(32).toString('base64url');
        const record = { id: randomBytes(16).toString('hex'), codeHash: sha256(code), label, createdAt,
          expiresAt, revokedAt: null, gatewayId: null, ...(accountId === undefined ? {} : { accountId }),
          ...(signupCapacity === undefined ? {} : { signupCapacity }), ...(purpose === undefined ? {} : { purpose }),
          ...(purpose === 'studio' ? { sessionPolicyVersion: 1 } : {}) };
        await commit(records, [...retained, record]);
        return { id: record.id, code, expiresAt: record.expiresAt };
      });
    },
    async redeemAccountInvitation(invitation, token, credentials) {
      if (credentials && (typeof credentials.username !== 'string' || !ACCOUNT_NAME.test(credentials.username)))
        throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Invalid KCoder credentials.');
      if (credentials && !meetsPasswordPolicy(credentials.password, credentials.username))
        throw fail(REGISTRATION_STORE_ERROR_CODES.passwordPolicy, 'Password does not meet the Relay password policy.');
      const passwordHash = credentials ? await hashAccountPassword(credentials.password) : undefined;
      if (!validEnrollmentToken(token) || typeof invitation !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(invitation) || constantTimeStringEqual(invitation, token))
        throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Account invitation is unavailable.');
      return enqueue(async () => {
        ensureUsable();
        const hash = sha256(token), inviteHash = sha256(invitation);
        const code = activationCodes.find(value => constantTimeHashEqual(value.codeHash, inviteHash));
        if (!code || code.revokedAt !== null || code.gatewayId !== null || (!code.accountId && code.signupCapacity === undefined && code.purpose !== 'register') ||
            (code.purpose === 'register') !== Boolean(credentials) ||
            (code.purpose === 'studio' && code.sessionPolicyVersion !== 1))
          throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Account invitation is unavailable.');
        if (code.sessionHash) {
          const now = Date.now();
          if (activeAccountSession(code, now) && constantTimeHashEqual(code.sessionHash, hash))
            return publicAccount(enabledAccount(code.accountId), code.sessionExpiresAt);
          throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Account invitation has already been used.');
        }
        const now = Date.now();
        if (expired(code.expiresAt, now)) throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Account invitation has expired.');
        if (accountSession(token)) throw fail(REGISTRATION_STORE_ERROR_CODES.conflict, 'Sign out before activating another account.');
        let account;
        let nextAccounts = accounts;
        if (credentials && accounts.some(value => value.username === credentials.username && value.id !== code.accountId))
          throw fail(REGISTRATION_STORE_ERROR_CODES.conflict, 'KCoder account name is already used.');
        if (code.accountId) {
          account = enabledAccount(code.accountId);
          if (!credentials && !code.purpose && account.passwordHash !== null)
            throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Sign in with the KCoder account password.');
          if (credentials) {
            account = { ...account, username: credentials.username, passwordHash };
            nextAccounts = accounts.map(value => value.id === account.id ? account : value);
          }
        } else {
          if (accounts.length >= MAX_GATEWAYS) throw fail(REGISTRATION_STORE_ERROR_CODES.capacity, 'KCoder account capacity has been reached.');
          const id = randomBytes(16).toString('hex');
          account = { id, username: credentials?.username ?? `kcoder-${id}`, maxGateways: code.signupCapacity ?? MAX_GATEWAYS, passwordHash: passwordHash ?? null, revokedAt: null };
          nextAccounts = [...accounts, account];
        }
        const lifetime = code.expiresAt === null || code.purpose === 'studio' ? ACCOUNT_SESSION_LIFETIME_MS :
          Math.min(ACCOUNT_SESSION_LIFETIME_MS, code.expiresAt - code.createdAt);
        const sessionExpiresAt = now + lifetime;
        const claimed = { ...code, accountId: account.id, sessionHash: hash, sessionExpiresAt, sessionPolicyVersion: 1 };
        const nextCodes = activationCodes.map(value => {
          if (value === code) return claimed;
          if (credentials && code.accountId && value.accountId === code.accountId && value.gatewayId === null)
            return { ...value, revokedAt: value.revokedAt ?? now };
          return value;
        });
        await commit(records, nextCodes, nextAccounts);
        return publicAccount(account, sessionExpiresAt);
      });
    },
    async signInAccount({ username, password }, token) {
      if (!validEnrollmentToken(token)) throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Invalid account session.');
      const account = await authenticateAccount(username, password);
      return enqueue(async () => {
        const current = enabledAccount(account.id);
        if (current.passwordHash !== account.passwordHash)
          throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'KCoder account sign-in failed.');
        const now = Date.now();
        const record = { id: randomBytes(16).toString('hex'), codeHash: randomBytes(32).toString('hex'),
          label: '', createdAt: now, expiresAt: null, revokedAt: null, gatewayId: null, accountId: current.id,
          sessionHash: sha256(token), sessionExpiresAt: now + ACCOUNT_SESSION_LIFETIME_MS, sessionPolicyVersion: 1 };
        await commit(records, [...availableCodeRecords(now), record]);
        return publicAccount(current, record.sessionExpiresAt);
      });
    },
    accountGateways(accountId) {
      ensureUsable();
      enabledAccount(accountId);
      return records.filter(record => record.accountId === accountId && record.revokedAt === undefined)
        .map(({ id }) => ({ id, label: activationCodes.find(code => code.gatewayId === id)?.label || '' }));
    },
    getAccountSession(token) {
      ensureUsable();
      const code = accountSession(token);
      return code ? publicAccount(enabledAccount(code.accountId), code.sessionExpiresAt) : null;
    },
    async revokeAccountSession(token) {
      return enqueue(async () => {
        ensureUsable();
        const code = accountSession(token);
        if (code) await commit(records, activationCodes.map(value => value === code ? { ...code, revokedAt: Date.now() } : value));
      });
    },
    async revokeOtherAccountSessions(token) {
      return enqueue(async () => {
        ensureUsable();
        const current = accountSession(token);
        if (!current) return false;
        const now = Date.now();
        const others = activationCodes.filter(code => code !== current && code.accountId === current.accountId &&
          code.revokedAt === null && (code.sessionHash || code.purpose === 'studio'));
        if (others.length) {
          const revoked = new Set(others);
          await commit(records, activationCodes.map(code => revoked.has(code) ? { ...code, revokedAt: now } : code));
        }
        return true;
      });
    },
    async registerAccountSession(token, input, options) {
      const normalized = validateRegistrationInput(input);
      const { validateGateway } = validateRegisterOptions(options);
      return enqueue(() => {
        const code = accountSession(token);
        if (!code) throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Sign in to KCoder.');
        return registerInside(normalized, validateGateway, undefined, code.accountId);
      });
    },
    async redeemActivationCode(code, input, options, { forAccount = false } = {}) {
      const normalized = validateRegistrationInput(input);
      const { validateGateway, existingOnly } = validateRegisterOptions(options);
      return enqueue(async () => {
        ensureUsable();
        const activation = typeof code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(code)
          ? activationCodes.find(record => constantTimeHashEqual(record.codeHash, sha256(code))) : undefined;
        if (!activation || activation.purpose || activation.sessionHash || activation.signupCapacity !== undefined || (activation.accountId !== undefined) !== forAccount)
          throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Activation code is unavailable.');
        return registerInside(normalized, validateGateway, activation, activation.accountId, existingOnly);
      });
    },
    managementSnapshot() {
      ensureUsable();
      return { accounts: accounts.map(({ passwordHash, ...account }) => ({ ...account, passwordLogin: passwordHash !== null })),
      gateways: records.map(record => ({ id: record.id, accountId: record.accountId ?? null, revokedAt: record.revokedAt ?? null,
        label: activationCodes.find(code => code.gatewayId === record.id)?.label ?? '' })),
      activationCodes: activationCodes.map(({ codeHash, sessionHash, sessionPolicyVersion, ...record }) => ({
        ...record, ...(sessionHash ? { activated: true, legacySession: sessionPolicyVersion === undefined } : {}),
      })) };
    },
    async revokeActivationCode(id) {
      return enqueue(async () => {
        ensureUsable();
        if (!activationCodes.some(code => code.id === id)) throw fail(REGISTRATION_STORE_ERROR_CODES.conflict, 'Unknown activation code.');
        await commit(records, activationCodes.map(code => code.id === id ? { ...code, revokedAt: code.revokedAt ?? Date.now() } : code));
      });
    },
    async revokeGateway(id, secret) {
      return enqueue(async () => {
        ensureUsable();
        const record = records.find(record => record.id === id);
        if (secret !== undefined && (!record || !/^[a-f0-9]{64}$/.test(secret) || !constantTimeStringEqual(record.secret, secret)))
          throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Invalid Gateway registration credential.');
        if (!record) throw fail(REGISTRATION_STORE_ERROR_CODES.conflict, 'Unknown registered Gateway.');
        if (record.revokedAt) return;
        await commit(records.map(record => record.id === id ? { ...record, revokedAt: record.revokedAt ?? Date.now() } : record));
      });
    },
    list() {
      ensureUsable();
      const enabled = new Set(accounts.filter(account => account.revokedAt === null).map(account => account.id));
      return records.filter(record => !record.revokedAt && (record.accountId === undefined || enabled.has(record.accountId))).map(cloneGateway);
    },
    async close() {
      return enqueue(async () => {
        if (closed) return;
        closed = true;
        await releaseLock(lock);
      });
    },
  };

  return store;
}
