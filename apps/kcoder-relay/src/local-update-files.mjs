import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function absolutePath(value) {
  assert.ok(typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value), 'Expected a normalized absolute path');
  return value;
}
export async function regularFile(path, { limit = 1024 * 1024 } = {}) {
  absolutePath(path);
  assert.equal(await realpath(path), path, 'Symlink paths are not accepted');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.nlink === 1 && info.size <= limit, 'Expected a bounded regular single-link file');
    return await handle.readFile();
  } finally { await handle.close(); }
}
export async function directory(path) {
  absolutePath(path);
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path, 'Expected a real directory');
}
export async function binaryDigest(path) {
  absolutePath(path);
  assert.equal(await realpath(path), path, 'Binary must not be a symlink');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.nlink === 1 && info.size <= 1024 ** 3, 'Expected a regular release binary');
    await access(path, constants.X_OK);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(null, { fd: handle.fd, autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export async function atomicWrite(path, bytes) {
  const parent = dirname(path);
  const temporary = join(parent, `.kcoder-update-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try {
    await rename(temporary, path);
    const folder = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { await rm(temporary, { force: true }); }
}
export async function createDirectory(path) {
  await mkdir(path);
  await directory(path);
}
export function systemdQuote(value) {
  assert.ok(typeof value === 'string' && !/[$\x00-\x1f\x7f]/.test(value), 'Invalid unit value');
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
