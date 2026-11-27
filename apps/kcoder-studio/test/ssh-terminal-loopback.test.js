import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ssh2 from 'ssh2';
import { createSshConnectionStore } from '../src/ssh-terminal-store.js';
import { createSshTerminalSession } from '../src/ssh-terminal.js';

// Real SSH transport verifies host-key/auth ordering and PTY bytes without invoking any model or runtime.
test('real SSH loopback: no auth before trust, password/key shell, resize, output, exit and cleanup', { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-ssh-loopback-'));
  const filePath = join(directory, 'ssh_connections.jsonc');
  const passphrase = 'ephemeral-test-passphrase';
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const encrypted = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const privateKeyPath = join(directory, 'identity');
  await writeFile(privateKeyPath, encrypted, { mode: 0o600 });
  const connections = new Set();
  const methods = [];
  const windows = [];
  const ptys = [];
  let remoteShell;
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    connections.add(client);
    client.on('error', () => {});
    client.on('close', () => connections.delete(client));
    client.on('authentication', (context) => {
      methods.push(context.method);
      if ((context.method === 'password' && context.password === 'ephemeral-test-password') || context.method === 'publickey') context.accept();
      else context.reject();
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (acceptPty, _reject, info) => { ptys.push(info); acceptPty(); });
      session.on('window-change', (_accept, _reject, info) => windows.push(info));
      session.on('shell', (acceptShell) => {
        remoteShell = acceptShell();
        remoteShell.on('data', (data) => remoteShell.write(data));
        remoteShell.write('ready 你好\r\n');
      });
    }));
  });
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) session.dispose();
    for (const client of connections) client.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.equal(connections.size, 0);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const store = createSshConnectionStore({ filePath });
  const profile = await store.upsert({ label: 'Loopback', host: '127.0.0.1', port: server.address().port, username: 'test', authMethod: 'password' });
  const output = [];
  let onOutput;
  let onExit;
  const session = createSshTerminalSession({ store, send: ({ method, params }) => {
    if (method === 'ssh/output') { output.push(params.data); onOutput?.(); }
    if (method === 'ssh/exit') onExit?.(params);
  } });
  sessions.push(session);
  const discovery = await session.handle('ssh/connect', { profileId: profile.id, password: 'ephemeral-test-password' });
  assert.equal(discovery.status, 'host-key-required');
  assert.deepEqual(methods, []);
  assert.equal((await session.handle('ssh/connect', { profileId: profile.id, password: 'ephemeral-test-password', acceptFingerprint: discovery.fingerprint })).status, 'connected');
  const echoed = new Promise((resolve) => { onOutput = () => { if (output.join('').includes('echo-marker')) resolve(); }; });
  await session.handle('ssh/write', { data: 'echo-marker\n' });
  await echoed;
  await session.handle('ssh/resize', { rows: 37, cols: 91 });
  const exited = new Promise((resolve) => { onExit = resolve; });
  remoteShell.exit(7);
  remoteShell.end();
  assert.equal((await exited).exitCode, 7);
  assert.equal(ptys[0].term, 'xterm-256color');
  assert.ok(output.join('').includes('你好'));
  await store.upsert({ ...profile, password: 'ephemeral-test-password' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const savedSession = createSshTerminalSession({ store: createSshConnectionStore({ filePath }), send: () => true });
    sessions.push(savedSession);
    assert.equal((await savedSession.handle('ssh/connect', { profileId: profile.id })).status, 'connected');
    await savedSession.handle('ssh/close');
  }
  await store.upsert({ ...profile, authMethod: 'key', privateKeyPath });
  assert.equal((await session.handle('ssh/connect', { profileId: profile.id, passphrase })).status, 'connected');
  assert.ok(methods.includes('publickey'));
  await session.handle('ssh/close');
  const persisted = await readFile(filePath, 'utf8');
  assert.equal(persisted.includes(passphrase), false);
  assert.equal(persisted.includes('ephemeral-test-password'), false);
  assert.equal(persisted.includes('PRIVATE KEY'), false);
  assert.ok(windows.some(({ rows, cols }) => rows === 37 && cols === 91));
});
