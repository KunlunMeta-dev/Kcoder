import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { visit } from 'jsonc-parser';

const failure = (code, cause) => Object.assign(new Error(code, cause ? { cause } : undefined),
  { code, ...(code === 'CONFIG_FILE_PUBLISH_UNCONFIRMED' ? { externalOutcome: 'unknown' } : {}) });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
const regular = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
const unchanged = (before, after) => regular(after) && before.dev === after.dev && before.ino === after.ino &&
  before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
const directoryFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
const sameDirectory = (before, after) => before.isDirectory() && !before.isSymbolicLink() &&
  after.isDirectory() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino;
const sameTemporary = (before, after) => before && after.isFile() && !after.isSymbolicLink() && after.nlink === 1n &&
  before.dev === after.dev && before.ino === after.ino;
function ownsTemporarySync(path, identity) {
  try { return sameTemporary(identity, lstatSync(path, { bigint: true })); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function ownsTemporary(path, identity) {
  try { return sameTemporary(identity, await lstat(path, { bigint: true })); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function parseData(raw, errors) {
  let document;
  const parents = [];
  const value = entry => {
    const parent = parents.at(-1);
    if (!parent) document = entry;
    else if (Array.isArray(parent.value)) parent.value.push(entry);
    else Object.defineProperty(parent.value, parent.key, { value: entry, enumerable: true, writable: true, configurable: true });
  };
  const begin = entry => { value(entry); parents.push({ value: entry }); };
  // Own data properties preserve unknown domains without interpreting __proto__ as a setter.
  visit(raw, {
    onObjectBegin: () => begin({}), onObjectEnd: () => parents.pop(),
    onObjectProperty: name => { parents.at(-1).key = name; },
    onArrayBegin: () => begin([]), onArrayEnd: () => parents.pop(),
    onLiteralValue: value, onError: error => errors.push(error),
  }, { allowTrailingComma: true });
  return document;
}

/** Each caller supplies its supported format versions; omitted metadata always denotes the v1 baseline. */
export function parseVersionedJsonc(raw, ...versions) {
  if (typeof raw !== 'string') {
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
    catch { throw failure('CONFIG_JSONC_INVALID'); }
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const errors = []; let document;
  try { document = parseData(raw, errors); }
  catch { throw failure('CONFIG_JSONC_INVALID'); }
  if (errors.length || !object(document) || (document.meta !== undefined && !object(document.meta)) ||
      (document.$schema !== undefined && typeof document.$schema !== 'string')) throw failure('CONFIG_JSONC_INVALID');
  const storedVersion = document.meta?.config_version;
  const version = storedVersion === undefined ? 1 : storedVersion;
  if (!versions.includes(version)) throw failure('CONFIG_VERSION_UNSUPPORTED');
  return { raw, document, version };
}

export function readBoundedFileSync(path, limit) {
  const named = lstatSync(path);
  if (!regular(named)) throw failure('CONFIG_FILE_INVALID');
  let fd;
  try {
    fd = openSync(path, flags);
    const held = fstatSync(fd);
    if (!unchanged(named, held)) throw failure('CONFIG_FILE_CHANGED');
    if (held.size > limit) throw failure('CONFIG_FILE_TOO_LARGE');
    const bytes = Buffer.alloc(held.size + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw failure('CONFIG_FILE_TOO_LARGE');
    if (!unchanged(held, fstatSync(fd)) || !unchanged(held, lstatSync(path))) throw failure('CONFIG_FILE_CHANGED');
    return bytes.subarray(0, length);
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('CONFIG_FILE_CHANGED');
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export async function readBoundedFile(path, limit) {
  const named = await lstat(path);
  if (!regular(named)) throw failure('CONFIG_FILE_INVALID');
  let file;
  try {
    file = await open(path, flags);
    const held = await file.stat();
    if (!unchanged(named, held)) throw failure('CONFIG_FILE_CHANGED');
    if (held.size > limit) throw failure('CONFIG_FILE_TOO_LARGE');
    const bytes = Buffer.alloc(held.size + 1); let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw failure('CONFIG_FILE_TOO_LARGE');
    if (!unchanged(held, await file.stat()) || !unchanged(held, await lstat(path))) throw failure('CONFIG_FILE_CHANGED');
    return bytes.subarray(0, length);
  } catch (error) {
    if (error.code === 'ENOENT') throw failure('CONFIG_FILE_CHANGED');
    throw error;
  } finally { await file?.close(); }
}

/** Publishers keep their domain's mutation queue/transaction; this helper only publishes bytes. */
export function writePrivateFileSync(path, content, limit = Infinity) {
  if (Buffer.byteLength(content) > limit) throw failure('CONFIG_FILE_TOO_LARGE');
  const temporary = `${path}.${randomUUID()}.tmp`, parent = dirname(path);
  let fd, directory, identity, temporaryIdentity, originalError, created = false, published = false;
  try {
    // Windows has no equivalent directory-fsync guarantee through Node's filesystem API.
    if (process.platform !== 'win32') {
      const named = lstatSync(parent); directory = openSync(parent, directoryFlags); identity = fstatSync(directory);
      if (!sameDirectory(named, identity) || !sameDirectory(identity, lstatSync(parent))) throw failure('CONFIG_FILE_CHANGED');
    }
    fd = openSync(temporary, 'wx'); created = true;
    temporaryIdentity = fstatSync(fd, { bigint: true });
    writeFileSync(fd, content); fsyncSync(fd);
    const closing = fd; fd = undefined; closeSync(closing);
    if (directory !== undefined && !sameDirectory(identity, lstatSync(parent))) throw failure('CONFIG_FILE_CHANGED');
    if (!ownsTemporarySync(temporary, temporaryIdentity)) throw failure('CONFIG_FILE_CHANGED');
    renameSync(temporary, path); published = true;
    if (!ownsTemporarySync(path, temporaryIdentity)) throw failure('CONFIG_FILE_CHANGED');
    if (directory !== undefined) {
      if (!sameDirectory(identity, lstatSync(parent))) throw failure('CONFIG_FILE_CHANGED');
      fsyncSync(directory);
      if (!sameDirectory(identity, lstatSync(parent))) throw failure('CONFIG_FILE_CHANGED');
      if (!ownsTemporarySync(path, temporaryIdentity)) throw failure('CONFIG_FILE_CHANGED');
    }
  } catch (error) {
    originalError = published ? failure('CONFIG_FILE_PUBLISH_UNCONFIRMED', error) : error; throw originalError;
  } finally {
    let cleanupError;
    if (fd !== undefined) try { closeSync(fd); } catch (error) { cleanupError = error; }
    if (created && !published) try {
      if ((directory === undefined || sameDirectory(identity, lstatSync(parent))) && ownsTemporarySync(temporary, temporaryIdentity)) unlinkSync(temporary);
    } catch (error) { if (error.code !== 'ENOENT') cleanupError ??= error; }
    if (directory !== undefined) try { closeSync(directory); } catch (error) { cleanupError ??= error; }
    if (!originalError && cleanupError) throw published ? failure('CONFIG_FILE_PUBLISH_UNCONFIRMED', cleanupError) : cleanupError;
  }
}

export async function writePrivateFile(path, content, limit = Infinity) {
  if (Buffer.byteLength(content) > limit) throw failure('CONFIG_FILE_TOO_LARGE');
  const temporary = `${path}.${randomUUID()}.tmp`, parent = dirname(path);
  let file, directory, identity, temporaryIdentity, originalError, created = false, published = false;
  try {
    if (process.platform !== 'win32') {
      const named = await lstat(parent); directory = await open(parent, directoryFlags); identity = await directory.stat();
      if (!sameDirectory(named, identity) || !sameDirectory(identity, await lstat(parent))) throw failure('CONFIG_FILE_CHANGED');
    }
    file = await open(temporary, 'wx'); created = true;
    temporaryIdentity = await file.stat({ bigint: true });
    await file.writeFile(content); await file.sync();
    const closing = file; file = undefined; await closing.close();
    if (directory && !sameDirectory(identity, await lstat(parent))) throw failure('CONFIG_FILE_CHANGED');
    if (!await ownsTemporary(temporary, temporaryIdentity)) throw failure('CONFIG_FILE_CHANGED');
    await rename(temporary, path); published = true;
    if (!await ownsTemporary(path, temporaryIdentity)) throw failure('CONFIG_FILE_CHANGED');
    if (directory) {
      if (!sameDirectory(identity, await lstat(parent))) throw failure('CONFIG_FILE_CHANGED');
      await directory.sync();
      if (!sameDirectory(identity, await lstat(parent))) throw failure('CONFIG_FILE_CHANGED');
      if (!await ownsTemporary(path, temporaryIdentity)) throw failure('CONFIG_FILE_CHANGED');
    }
  } catch (error) {
    originalError = published ? failure('CONFIG_FILE_PUBLISH_UNCONFIRMED', error) : error; throw originalError;
  } finally {
    let cleanupError;
    if (file) try { await file.close(); } catch (error) { cleanupError = error; }
    if (created && !published) try {
      if ((!directory || sameDirectory(identity, await lstat(parent))) && await ownsTemporary(temporary, temporaryIdentity)) await unlink(temporary);
    } catch (error) { if (error.code !== 'ENOENT') cleanupError ??= error; }
    if (directory) try { await directory.close(); } catch (error) { cleanupError ??= error; }
    if (!originalError && cleanupError) throw published ? failure('CONFIG_FILE_PUBLISH_UNCONFIRMED', cleanupError) : cleanupError;
  }
}
