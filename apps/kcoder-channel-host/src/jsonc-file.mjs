import { randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { parse } from 'jsonc-parser';

const failure = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);
const regular = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
const unchanged = (before, after) => regular(after) && before.dev === after.dev && before.ino === after.ino &&
  before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;

/** Each caller supplies its supported format versions; omitted metadata always denotes the v1 baseline. */
export function parseVersionedJsonc(raw, ...versions) {
  if (typeof raw !== 'string') {
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
    catch { throw failure('CONFIG_JSONC_INVALID'); }
  }
  const errors = [], document = parse(raw, errors, { allowTrailingComma: true });
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
  const fd = openSync(path, flags);
  try {
    const held = fstatSync(fd);
    if (!unchanged(named, held)) throw failure('CONFIG_FILE_CHANGED');
    if (held.size > limit) throw failure('CONFIG_FILE_TOO_LARGE');
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) throw failure('CONFIG_FILE_TOO_LARGE');
    if (!unchanged(held, fstatSync(fd)) || !unchanged(held, lstatSync(path))) throw failure('CONFIG_FILE_CHANGED');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}

export async function readBoundedFile(path, limit) {
  const named = await lstat(path);
  if (!regular(named)) throw failure('CONFIG_FILE_INVALID');
  const file = await open(path, flags);
  try {
    const held = await file.stat();
    if (!unchanged(named, held)) throw failure('CONFIG_FILE_CHANGED');
    if (held.size > limit) throw failure('CONFIG_FILE_TOO_LARGE');
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw failure('CONFIG_FILE_TOO_LARGE');
    if (!unchanged(held, await file.stat()) || !unchanged(held, await lstat(path))) throw failure('CONFIG_FILE_CHANGED');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

/** Publishers keep their domain's mutation queue/transaction; this helper only publishes bytes. */
export function writePrivateFileSync(path, content, limit = Infinity) {
  if (Buffer.byteLength(content) > limit) throw failure('CONFIG_FILE_TOO_LARGE');
  const temporary = `${path}.${randomUUID()}.tmp`; let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function writePrivateFile(path, content, limit = Infinity) {
  if (Buffer.byteLength(content) > limit) throw failure('CONFIG_FILE_TOO_LARGE');
  const temporary = `${path}.${randomUUID()}.tmp`; let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(content); await file.sync(); await file.close(); file = undefined;
    await rename(temporary, path);
  } finally {
    if (file) await file.close();
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
