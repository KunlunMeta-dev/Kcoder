import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function absolutePath(value) {
  assert.ok(typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value), 'Expected a normalized absolute path');
  return value;
}
export async function regularFile(path, { privateFile = false, ownedFile = false, limit = 1024 * 1024 } = {}) {
  absolutePath(path);
  assert.equal(await realpath(path), path, 'Symlink paths are not accepted');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.nlink === 1 && info.size <= limit, 'Expected a bounded regular single-link file');
    if (ownedFile) assert.equal(info.uid, process.getuid(), 'Expected a current-user owned file');
    if (privateFile) assert.ok(info.uid === process.getuid() && (info.mode & 0o077) === 0, 'Expected a private owned file');
    return await handle.readFile();
  } finally { await handle.close(); }
}
export async function directory(path, privateDirectory = false) {
  absolutePath(path);
  const info = await lstat(path);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path, 'Expected a real directory');
  if (privateDirectory) assert.ok(info.uid === process.getuid() && (info.mode & 0o077) === 0, 'Expected a private owned directory');
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
export async function atomicWrite(path, bytes, mode = 0o600) {
  const parent = dirname(path);
  const temporary = join(parent, `.kcoder-update-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try {
    await rename(temporary, path);
    const folder = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { await rm(temporary, { force: true }); }
}
export async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 });
  await directory(path, true);
}
export function systemdQuote(value) {
  assert.ok(typeof value === 'string' && !/[$\x00-\x1f\x7f]/.test(value), 'Invalid unit value');
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
export async function inspectMobile(root, expectedSha256) {
  await directory(root);
  const bytes = await regularFile(join(root, 'kcoder-mobile-web.json'));
  assert.equal(sha256(bytes), expectedSha256, 'Mobile manifest digest mismatch');
  const manifest = JSON.parse(bytes);
  assert.ok(manifest.version === 1 && manifest.baseToken === '/__kcoder_mobile_mount_v1__' && Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 10000, 'Invalid Mobile manifest');
  const paths = new Set(); let total = 0;
  for (const row of manifest.files) {
    assert.ok(typeof row.path === 'string' && row.path.split('/').every(part => part && part !== '.' && part !== '..' && (!part.startsWith('.') || row.path === '_expo/.routes.json')) && !/[\\%?#\x00-\x1f\x7f]/.test(row.path) && !paths.has(row.path), 'Invalid Mobile resource path');
    assert.ok(Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= 32 * 1024 ** 2 && /^[a-f0-9]{64}$/.test(row.sha256) && typeof row.text === 'boolean' && Number.isSafeInteger(row.replacements) && row.replacements >= 0 && !/\.(map|gz|br)$/i.test(row.path), 'Invalid Mobile resource');
    const content = await regularFile(join(root, row.path), { limit: 32 * 1024 ** 2 });
    assert.equal(content.length, row.size); assert.equal(sha256(content), row.sha256);
    total += row.size; assert.ok(total <= 256 * 1024 ** 2, 'Mobile build exceeds bound'); paths.add(row.path);
  }
  assert.ok(paths.has('index.html') && manifest.files.some(row => row.path.endsWith('.js')) && manifest.files.some(row => row.replacements > 0), 'Incomplete Mobile build');
  const physical = [];
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Mobile build symlink');
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), `${name}/`);
      else { assert.ok(entry.isFile(), 'Non-file Mobile resource'); physical.push(name); }
      assert.ok(physical.length <= 10001, 'Mobile build file bound exceeded');
    }
  }
  await walk(root);
  assert.deepEqual(physical.sort(), [...paths, 'kcoder-mobile-web.json'].sort(), 'Mobile file set differs from manifest');
  return manifest;
}
