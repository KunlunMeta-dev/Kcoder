import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildManagedSshArgs } from './owned-ssh-control-master.mjs';

const execFileAsync = promisify(execFile);

test('the actual managed SSH guard blocks a fresh transport while the owned TCP control is observable', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kc-ssh-mux-failclosed-'));
  await chmod(root, 0o700);
  const connections = [];
  const server = createServer(socket => { connections.push(true); socket.destroy(); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const configPath = join(root, 'config'), knownHostsPath = join(root, 'known_hosts'), controlPath = join(root, 'missing-control');
    await writeFile(knownHostsPath, '', { mode: 0o600 });
    await writeFile(configPath, `Host owned-fixture\n  HostName 127.0.0.1\n  User fixture\n  Port ${server.address().port}\n  IdentityAgent none\n  IdentityFile /dev/null\n  IdentitiesOnly yes\n  GlobalKnownHostsFile /dev/null\n`, { mode: 0o600 });
    const args = buildManagedSshArgs({ target: 'owned-fixture', configPath, knownHostsPath, controlPath }, 'true');
    const execute = async argv => {
      try { await execFileAsync('ssh', argv, { encoding: 'utf8', timeout: 3000, maxBuffer: 8192 }); }
      catch (error) { return error; }
      assert.fail('the unauthenticated owned fixture must not execute a command');
    };
    const guarded = await execute(args);
    assert.equal(guarded.code, 255); assert.equal(guarded.killed, false);
    assert.equal(connections.length, 0, 'the production builder must not create a fresh TCP connection');
    // Independent negative control proves this listener can see a direct transport.
    const direct = [];
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '-S') { index++; continue; }
      if (args[index] === '-o' && /^(?:ProxyCommand|ControlPath)=/i.test(args[index + 1] || '')) { index++; continue; }
      direct.push(args[index]);
    }
    const refused = await execute(direct);
    assert.equal(refused.code, 255); assert.equal(refused.killed, false);
    assert.equal(connections.length, 1, 'a direct attempt must reach only this owned refusing listener');
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
