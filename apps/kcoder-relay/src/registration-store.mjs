import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, parse, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 256 * 1024;
const MAX_GATEWAYS = 256;
const MAX_CREDENTIAL_BYTES = 512;
const LOCK_MAX_BYTES = 4096;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;

export const REGISTRATION_STORE_ERROR_CODES = Object.freeze({
  unauthorized: 'REGISTRATION_UNAUTHORIZED',
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

function validPairingToken(value) {
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
  if (!exactKeys(input, ['enrollmentToken', 'pairingToken'])
      || !validEnrollmentToken(input.enrollmentToken)
      || !validPairingToken(input.pairingToken)) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Registration proof or Gateway pairing token is invalid.');
  }
  if (constantTimeStringEqual(input.enrollmentToken, input.pairingToken)) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Registration proof or Gateway pairing token is invalid.');
  }
  return { enrollmentToken: input.enrollmentToken, pairingToken: input.pairingToken };
}

function validateRegisterOptions(options) {
  if (options === undefined) return {};
  if (!isObject(options) || Object.keys(options).some(key => key !== 'validateGateway')) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Registration validation options are invalid.');
  }
  if (options.validateGateway !== undefined && typeof options.validateGateway !== 'function') {
    throw fail(REGISTRATION_STORE_ERROR_CODES.invalidOptions, 'Registration validation options are invalid.');
  }
  return options;
}

function generatedGateway(record) {
  return {
    id: record.id,
    secret: record.secret,
    pairingToken: record.pairingToken,
    maxConnections: 128,
    maxBytesPerWindow: 67_108_864,
    trafficWindowMs: 60_000,
  };
}

function cloneGateway(record) {
  return generatedGateway(record);
}

function validateStoreRecord(record, index, seen) {
  const fields = ['id', 'secret', 'pairingToken', 'enrollmentTokenHash'];
  if (!exactKeys(record, fields)
      || typeof record.id !== 'string' || !/^[a-f0-9]{32}$/.test(record.id)
      || typeof record.secret !== 'string' || !/^[a-f0-9]{64}$/.test(record.secret)
      || !validPairingToken(record.pairingToken)
      || typeof record.enrollmentTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.enrollmentTokenHash)) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, `Registration store record ${index} is invalid.`);
  }
  if (seen.ids.has(record.id)
      || seen.secrets.has(record.secret)
      || seen.pairingTokens.has(record.pairingToken)
      || seen.enrollmentHashes.some(hash => constantTimeHashEqual(hash, record.enrollmentTokenHash))
      || seen.secrets.has(record.id)
      || seen.pairingTokens.has(record.id)
      || seen.ids.has(record.secret)
      || seen.pairingTokens.has(record.secret)
      || seen.ids.has(record.pairingToken)
      || seen.secrets.has(record.pairingToken)
      || record.id === record.secret
      || record.id === record.pairingToken) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, 'Registration store contains duplicate identities or credentials.');
  }
  seen.ids.add(record.id);
  seen.secrets.add(record.secret);
  seen.pairingTokens.add(record.pairingToken);
  seen.enrollmentHashes.push(record.enrollmentTokenHash);
}

function validateStoreDocument(document, maxGateways) {
  if (!exactKeys(document, ['version', 'gateways'])
      || document.version !== STORE_VERSION
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
    pairingTokens: new Set(),
    enrollmentHashes: [],
  };
  document.gateways.forEach((record, index) => validateStoreRecord(record, index, seen));
  for (const secret of seen.secrets) {
    if (seen.pairingTokens.has(secret)) {
      throw fail(REGISTRATION_STORE_ERROR_CODES.corrupt, 'Registration store contains credentials with overlapping roles.');
    }
  }
  return document.gateways.map(record => ({ ...record }));
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
    if (error.code === 'ENOENT') return { records: [], bytes: null, identity: null };
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
    const records = validateStoreDocument(document, maxGateways);
    return { records, bytes, identity: fileIdentity(stat) };
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

function documentBytes(records) {
  const document = { version: STORE_VERSION, gateways: records };
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

async function persistRecords(path, records, previousBytes, expectedIdentity) {
  const bytes = documentBytes(records);
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

function makeRecord(enrollmentToken, pairingToken, existingRecords) {
  const idUsed = new Set(existingRecords.map(record => record.id));
  const secretUsed = new Set(existingRecords.map(record => record.secret));
  const pairingTokens = new Set(existingRecords.map(record => record.pairingToken));
  let id;
  do { id = randomBytes(16).toString('hex'); }
  while (idUsed.has(id) || id === enrollmentToken || id === pairingToken || secretUsed.has(id) || pairingTokens.has(id));

  let secret;
  do { secret = randomBytes(32).toString('hex'); }
  while (idUsed.has(secret) || secretUsed.has(secret) || pairingTokens.has(secret)
    || secret === pairingToken || secret === enrollmentToken || secret === id);

  return {
    id,
    secret,
    pairingToken,
    enrollmentTokenHash: sha256(enrollmentToken),
  };
}

function validateEnrollmentSeparation(enrollmentToken, pairingToken, records) {
  if (constantTimeStringEqual(enrollmentToken, pairingToken)
      || records.some(record => constantTimeStringEqual(enrollmentToken, record.secret)
        || constantTimeStringEqual(enrollmentToken, record.pairingToken))) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Registration proof or Gateway pairing token is invalid.');
  }
}

function verifyPairingUnused(pairingToken, records) {
  if (records.some(record => constantTimeStringEqual(pairingToken, record.pairingToken)
      || constantTimeStringEqual(pairingToken, record.secret)
      || constantTimeStringEqual(pairingToken, record.id))) {
    throw fail(REGISTRATION_STORE_ERROR_CODES.conflict, 'Gateway pairing token is already assigned.');
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

  const store = {
    async register(input, registerOptions = undefined) {
      const normalized = validateRegistrationInput(input);
      const { validateGateway } = validateRegisterOptions(registerOptions);
      return enqueue(async () => {
        ensureUsable();
        validateEnrollmentSeparation(normalized.enrollmentToken, normalized.pairingToken, records);
        const enrollmentTokenHash = sha256(normalized.enrollmentToken);
        const existing = records.find(record => proofHashMatches(record, enrollmentTokenHash));
        if (existing) {
          if (!constantTimeStringEqual(existing.pairingToken, normalized.pairingToken)) {
            throw fail(REGISTRATION_STORE_ERROR_CODES.unauthorized, 'Registration proof or Gateway pairing token is invalid.');
          }
          await runValidateGateway(validateGateway, existing);
          return cloneGateway(existing);
        }

        verifyPairingUnused(normalized.pairingToken, records);
        if (records.length >= maxGateways) {
          throw fail(REGISTRATION_STORE_ERROR_CODES.capacity, 'Registration capacity has been reached.');
        }

        const candidate = makeRecord(normalized.enrollmentToken, normalized.pairingToken, records);
        await runValidateGateway(validateGateway, candidate);
        const nextRecords = [...records, candidate];
        try {
          const persisted = await persistRecords(path, nextRecords, currentBytes, currentIdentity);
          records = nextRecords;
          currentBytes = persisted.bytes;
          currentIdentity = persisted.identity;
        } catch (error) {
          if (error.restoredIdentity !== undefined) currentIdentity = error.restoredIdentity;
          if (error.rollbackFailed) poisoned = true;
          if (error instanceof RegistrationStoreError) throw error;
          throw fail(REGISTRATION_STORE_ERROR_CODES.persistence, 'Registration store could not be saved.', error);
        }
        return cloneGateway(candidate);
      });
    },
    list() {
      ensureUsable();
      return records.map(cloneGateway);
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
