import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export function assertPeerUidNative(metadata) {
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.size <= 1024 ** 3, 'Native fixture requires an original single-link regular image');
  assert.equal(metadata.uid, 0, 'Native fixture executable must remain root-owned');
  assert.notEqual(metadata.mode & 0o111, 0, 'Native fixture executable is not executable');
}

/** Evidence/load boundary only. Later authorization never caches this as allow. */
export async function pinPeerUidNative(path, expectedSha256) {
  assert.ok(isAbsolute(path)); assert.match(expectedSha256, /^[a-f0-9]{64}$/);
  const before = await lstat(path); assertPeerUidNative(before);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const same = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
  try {
    const held = await file.stat(); assertPeerUidNative(held); assert.ok(same(before, held));
    const hash = createHash('sha256'); for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
    const after = await file.stat(), named = await lstat(path); assertPeerUidNative(after); assertPeerUidNative(named);
    assert.ok(same(held, after) && same(held, named), 'Original Native image changed during loading');
    const sha256 = hash.digest('hex'); assert.equal(sha256, expectedSha256);
    return { path, sha256, dev: String(held.dev), ino: String(held.ino), bytes: held.size, uid: held.uid };
  } finally { await file.close(); }
}
