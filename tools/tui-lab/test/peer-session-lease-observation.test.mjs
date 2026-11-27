import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { observeOwnedPeerSessionLease } from '../lib/peer-session-lease-observation.mjs';

test('owned Native lease observation distinguishes an actual holder and keeps the original file unchanged', {
  skip: process.platform !== 'linux' && 'Requires Linux kernel flock observation', timeout: 5000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kcoder-peer-lease-'));
  const file = path.join(root, 'original.lease');
  let owner, exited;
  try {
    await chmod(root, 0o700); await writeFile(file, 'original Native lease fixture', { mode: 0o600 });
    const before = await observeOwnedPeerSessionLease(file, root);
    assert.deepEqual(before.holders, []);
    owner = spawn('python3', ['-c', 'import fcntl,sys; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.readline()', file], { stdio: ['pipe', 'pipe', 'pipe'] });
    exited = once(owner, 'exit');
    assert.match(String((await once(owner.stdout, 'data'))[0]), /ready/);
    const held = await observeOwnedPeerSessionLease(file, root);
    assert.equal(held.ino, before.ino); assert.equal(held.dev, before.dev);
    assert.deepEqual(held.holders.map(value => value.pid), [owner.pid]);
    owner.stdin.end(); await exited; owner = null;
    const after = await observeOwnedPeerSessionLease(file, root);
    assert.equal(after.ino, before.ino); assert.deepEqual(after.holders, []);
    assert.equal(await readFile(file, 'utf8'), 'original Native lease fixture');
    const link = path.join(root, 'linked.lease'); await symlink(file, link);
    await assert.rejects(observeOwnedPeerSessionLease(link, root));
    await assert.rejects(observeOwnedPeerSessionLease(file, path.join(root, 'other')));
  } finally {
    if (owner) { owner.stdin.end(); owner.kill('SIGTERM'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
