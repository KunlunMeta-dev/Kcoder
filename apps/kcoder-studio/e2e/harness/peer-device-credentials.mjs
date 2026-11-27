import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import path from 'node:path';

/** Only the explicitly selected, owned file backend; never resolve keyring,
 * environment or another profile as a fallback for a missing credential.
 */
export async function readOwnedPeerDeviceCredential(context, profile) {
  const root = await lstat(profile);
  assert.ok(root.isDirectory() && !root.isSymbolicLink(), 'Owned peer profile must be a real directory');
  const file = await open(path.join(profile, 'peer-gateway-session.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw;
  try {
    const metadata = await file.stat();
    assert.ok(metadata.isFile() && metadata.nlink === 1 && metadata.size <= 65536,
      'Owned peer credential must be a bounded regular file');
    if (typeof process.getuid === 'function') assert.ok(metadata.uid === process.getuid() && root.uid === process.getuid(), 'Owned peer credential UID changed');
    const buffer = Buffer.alloc(65537);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assert.ok(offset <= 65536, 'Owned peer credential exceeded its byte budget');
    raw = buffer.subarray(0, offset).toString('utf8');
  } finally { await file.close(); }
  const current = await lstat(profile);
  assert.ok(current.dev === root.dev && current.ino === root.ino && !current.isSymbolicLink(), 'Owned peer profile changed');
  let stored;
  try { stored = JSON.parse(raw); } catch { throw new Error('Owned peer credential file is malformed'); }
  assert.ok(stored?.backend === 'file', 'This fixture explicitly requires the private file credential backend');
  for (const field of ['accessToken', 'refreshToken', 'rpcToken']) {
    assert.ok(typeof stored.secret?.[field] === 'string' && stored.secret[field].length > 0, 'Owned peer file credential is incomplete');
    context.registerSecret(stored.secret[field]);
  }
  assert.ok(typeof stored.secret.deviceId === 'string' && stored.secret.deviceId.length > 0, 'Owned peer device identity is missing');
  return { id: stored.secret.deviceId, token: stored.secret.accessToken };
}
