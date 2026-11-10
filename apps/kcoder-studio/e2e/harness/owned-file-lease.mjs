import assert from 'node:assert/strict';
import { relative, resolve, sep } from 'node:path';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { waitFor } from './run-context.mjs';

/** A deliberate contention fault on an existing file inside this run; no new owner/receipt is fabricated. */
export async function holdOwnedExistingFileLease(context, file, label) {
  assert.equal(process.platform, 'linux', 'this owned contention scenario requires Linux flock');
  const root = resolve(context.pathInState(''));
  assert.ok(resolve(file).startsWith(root + sep), 'only this run’s synthetic file can be held');
  const identity = await lstat(root, { bigint: true });
  assert.ok(identity.isDirectory() && !identity.isSymbolicLink());
  const child = context.spawnOwned(label, 'python3', [fileURLToPath(new URL('./hold-owned-file-lease.py', import.meta.url)), root,
    relative(root, resolve(file)), String(identity.dev), String(identity.ino)], { stdin: 'pipe' });
  let held = false, closed = false, failure = null;
  child.stdout.on('data', chunk => { if (chunk.toString().includes('OWNED_LEASE_HELD')) held = true; });
  child.once('error', error => { failure = error; }); child.once('close', () => { closed = true; });
  await waitFor(() => held || closed || failure, 5000, 'owned existing private file lease');
  if (failure) throw failure;
  assert.ok(held && !closed, 'owned fixture must acquire the original private lease');
  return async () => {
    child.stdin.end(); await waitFor(() => closed, 5000, 'release owned private fixture lease');
    assert.equal(child.exitCode, 0); await context.stopOwned(label);
  };
}
