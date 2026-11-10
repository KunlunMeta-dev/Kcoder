import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { repoRoot } from './run-context.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const uid = () => {
  if (typeof process.getuid !== 'function') throw Error('keyring_recovery_requires_posix_owner');
  return String(process.getuid());
};
export const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid) });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
export async function verifyDirectory(path, expected) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.uid) !== uid() || (stat.mode & 0o7777n) !== 0o700n ||
      await realpath(path) !== path || (expected && !same(identity(stat), expected))) throw Error('keyring_recovery_directory_changed');
  return identity(stat);
}
export async function writePrivate(path, value, limit) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > limit) { bytes.fill(0); throw Error('keyring_recovery_record_budget'); }
  let file;
  try {
    file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(bytes); await file.sync();
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || String(stat.uid) !== uid() || (stat.mode & 0o7777n) !== 0o600n)
      throw Error('keyring_recovery_file_permissions');
    return { identity: identity(stat), sha256: digest(bytes) };
  } finally { try { await file?.close(); } finally { bytes.fill(0); } }
}
export async function readPrivate(path, expected, limit) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || String(before.uid) !== uid() ||
      (before.mode & 0o7777n) !== 0o600n || before.size > BigInt(limit) || (expected && !same(identity(before), expected)))
    throw Error('keyring_recovery_file_changed');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat({ bigint: true });
    if (!same(identity(stat), identity(before))) throw Error('keyring_recovery_file_changed');
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    try {
      while (used < bytes.length) {
        const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      const after = await lstat(path, { bigint: true }), held = await file.stat({ bigint: true });
      if (used > limit || !same(identity(after), identity(stat)) || !same(identity(held), identity(stat)) ||
          after.nlink !== 1n || held.nlink !== 1n || (after.mode & 0o7777n) !== 0o600n ||
          (held.mode & 0o7777n) !== 0o600n || held.size !== BigInt(used)) throw Error('keyring_recovery_file_changed');
      let value;
      try { value = JSON.parse(bytes.subarray(0, used).toString('utf8')); } catch { throw Error('keyring_recovery_record_invalid'); }
      return { value, sha256: digest(bytes.subarray(0, used)), identity: identity(stat) };
    } finally { bytes.fill(0); }
  } finally { await file.close(); }
}
export async function syncDirectory(path) {
  const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); }
}
export async function removePrivate(path, expected) {
  await readPrivate(path, expected, 4096); await unlink(path);
}
export async function privateRecoveryBase(selected) {
  const temp = await realpath(tmpdir());
  const path = selected ? resolve(selected) : join(temp, `.kcoder-keyring-recovery-v1-${uid()}`);
  const child = relative(temp, path);
  if (!child || child.startsWith('..' + sep) || child === '..' || path.startsWith(repoRoot + sep) ||
      /(?:^|\/)(?:target|artifacts)(?:\/|$)/.test(path)) throw Error('keyring_recovery_requires_external_private_temp');
  let fresh = false;
  try { await mkdir(path, { mode: 0o700 }); fresh = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const native = await verifyDirectory(path);
  if (fresh) {
    await writePrivate(join(path, 'namespace.json'), { version: 1, kind: 'keyring-recovery', ...native }, 512);
    await syncDirectory(path);
  }
  const marker = await readPrivate(join(path, 'namespace.json'), undefined, 512);
  if (JSON.stringify(marker.value) !== JSON.stringify({ version: 1, kind: 'keyring-recovery', ...native })) throw Error('keyring_recovery_namespace_changed');
  return { path, identity: native };
}
