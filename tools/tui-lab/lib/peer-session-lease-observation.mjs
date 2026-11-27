import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

/** Observe one owned Native lease inode without acquiring, releasing or
 * rewriting it. Unrelated kernel lock records never enter run evidence.
 */
export async function observeOwnedPeerSessionLease(file, ownedRoot) {
  assert.equal(process.platform, 'linux');
  const root = await realpath(ownedRoot);
  const actual = await realpath(file);
  assert.ok(actual.startsWith(root + path.sep), 'lease must remain inside its owned fixture');
  const leaf = await lstat(file, { bigint: true });
  const parent = await lstat(root, { bigint: true });
  assert.ok(leaf.isFile() && !leaf.isSymbolicLink() && leaf.nlink === 1n);
  assert.ok(parent.isDirectory() && parent.uid === BigInt(process.geteuid()));
  assert.equal(leaf.uid, parent.uid);
  const locks = await readFile('/proc/locks', 'utf8');
  assert.ok(locks.length <= 1024 * 1024, 'bounded kernel lock observation');
  const major = ((leaf.dev >> 8n) & 0xfffn) | ((leaf.dev >> 32n) & ~0xfffn);
  const minor = (leaf.dev & 0xffn) | ((leaf.dev >> 12n) & ~0xffn);
  const holders = [];
  for (const line of locks.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const at = fields.findIndex(value => /^[0-9a-f]+:[0-9a-f]+:[0-9]+$/i.test(value));
    if (at < 2) continue;
    const [deviceMajor, deviceMinor, inode] = fields[at].split(':');
    if (BigInt(inode) !== leaf.ino || BigInt('0x' + deviceMajor) !== major || BigInt('0x' + deviceMinor) !== minor) continue;
    const pid = Number(fields[at - 1]);
    assert.ok(Number.isSafeInteger(pid));
    holders.push({ pid, kind: fields[1], mode: fields[at - 2] });
  }
  const after = await lstat(file, { bigint: true });
  assert.equal(after.dev, leaf.dev); assert.equal(after.ino, leaf.ino);
  assert.equal(await realpath(file), actual);
  return { file: actual, dev: String(leaf.dev), ino: String(leaf.ino), holders };
}
