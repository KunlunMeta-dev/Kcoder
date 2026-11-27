import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { observePeerCredentialLock } from './peer-credential-lock-observer.mjs';

test('the read-only diagnostic records only the actual kernel owner of its supplied inode', { skip: process.platform !== 'linux' }, async t => {
  const profile = await mkdtemp(path.join(tmpdir(), 'peer-lock-observer-'));
  const file = path.join(profile, 'peer-gateway-credentials.lock');
  await writeFile(file, 'owned-lock-content', { mode: 0o600 });
  const owner = spawn('python3', ['-c', 'import fcntl,sys; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.readline()', file], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(owner, 'exit');
  t.after(async () => { owner.stdin.end('\n'); if (owner.exitCode === null) owner.kill('SIGTERM'); await exited; await rm(profile, { recursive: true, force: true }); });
  await once(owner.stdout, 'data');
  const observer = observePeerCredentialLock(profile);
  await new Promise(resolve => setTimeout(resolve, 100));
  const events = await observer.stop();
  assert.ok(events.some(event => event.holders.some(holder => holder.pid === owner.pid && holder.kind === 'FLOCK')));
  assert.ok(events.every(event => event.holders.every(holder => holder.pid === owner.pid)));
  assert.equal(await readFile(file, 'utf8'), 'owned-lock-content');
  assert.ok(!JSON.stringify(events).includes(profile));
});
