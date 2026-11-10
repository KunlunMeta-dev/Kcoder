import assert from 'node:assert/strict';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

/** Inspect only bounded metadata under this run's Native-confirmed workspace; never open file bodies. */
export async function inspectOwnedKcoder({ runRoot, workspace, maxEntries = 64, maxDepth = 3 }) {
  assert.ok(Number.isInteger(maxEntries) && maxEntries > 0 && maxEntries <= 64);
  assert.ok(Number.isInteger(maxDepth) && maxDepth >= 0 && maxDepth <= 3);
  const root = await realpath(runRoot); const requested = resolve(workspace); const base = await realpath(requested);
  const comparable = path => process.platform === 'win32' ? win32.normalize(path.replace(/^\\\\\?\\/, '')).toLowerCase() : path;
  assert.equal(comparable(base), comparable(requested), 'metadata workspace must not traverse symlinks');
  const rel = relative(root, base);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'metadata workspace must belong to this run');
  const result = { workspace: base, observedAtMs: Date.now(), exists: false, entries: [], truncated: false };
  const queue = [{ path: join(base, '.kcoder'), name: '.kcoder', depth: 0 }];
  while (queue.length) {
    if (result.entries.length >= maxEntries) { result.truncated = true; break; }
    const current = queue.shift(); let info;
    try { info = await lstat(current.path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    result.exists = true;
    const kind = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'special';
    result.entries.push({ path: current.name, kind, size: info.size, modifiedAtMs: info.mtimeMs });
    if (kind !== 'directory') continue;
    if (current.depth === maxDepth) { result.truncated = true; continue; }
    const directory = await opendir(current.path);
    for await (const child of directory) {
      if (result.entries.length + queue.length >= maxEntries) { result.truncated = true; break; }
      queue.push({ path: join(current.path, child.name), name: `${current.name}/${child.name}`, depth: current.depth + 1 });
    }
  }
  return result;
}
