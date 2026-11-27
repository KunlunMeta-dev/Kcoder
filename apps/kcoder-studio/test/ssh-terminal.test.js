import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createSshTerminalSession } from '../src/ssh-terminal.js';

const hostKey = Buffer.from('model-independent-test-host-key');
const fingerprint = `SHA256:${createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '')}`;
const profile = { id: 'test', label: 'Development', host: 'localhost', port: 22, username: 'developer', authMethod: 'password' };

// These fakes exercise transport ownership and host-key gates, independently of model behavior.
function fixture({ pinned = false, stall = false, handshakeTimeoutMs, sendResult } = {}) {
  const stored = { ...profile, ...(pinned ? { hostFingerprint: fingerprint } : {}) };
  const notices = [];
  const clients = [];
  const store = {
    list: async () => [stored],
    pinFingerprint: async (_, value) => { stored.hostFingerprint = value; },
  };
  class FakeClient extends EventEmitter {
    destroyed = false;
    authenticated = false;
    channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(), writableLength: 0,
      write: (data) => { this.input = data; return true; },
      setWindow: (...args) => { this.window = args; },
      destroy: () => { this.channelDestroyed = true; },
    });
    connect(options) {
      this.options = options;
      if (stall) return;
      queueMicrotask(() => options.hostVerifier(hostKey, (accepted) => {
        if (!accepted) return this.emit('error', new Error('Sensitive remote authentication error'));
        this.authenticated = true;
        this.emit('ready');
      }));
    }
    shell(options, callback) { this.shellOptions = options; callback(null, this.channel); }
    destroy() { this.destroyed = true; }
  }
  const session = createSshTerminalSession({ store, handshakeTimeoutMs, send: (notice) => { notices.push(notice); return sendResult; }, clientFactory: () => { const client = new FakeClient(); clients.push(client); return client; } });
  return { session, clients, notices, stored, store };
}

test('unknown SSH host is rejected before authentication and requires explicit fingerprint confirmation', async () => {
  const { session, clients, stored } = fixture();
  const result = await session.handle('ssh/connect', { profileId: 'test', password: 'transient-secret' });
  assert.deepEqual(result, { status: 'host-key-required', fingerprint, host: 'localhost', port: 22 });
  assert.equal(clients[0].authenticated, false);
  assert.equal(clients[0].destroyed, true);
  assert.equal(stored.hostFingerprint, undefined);
  assert.equal((await session.handle('ssh/connect', { profileId: 'test', password: 'transient-secret', acceptFingerprint: fingerprint })).status, 'connected');
  assert.equal(stored.hostFingerprint, fingerprint);
  assert.equal(clients[1].shellOptions.term, 'xterm-256color');
  session.dispose();
  assert.equal(clients[1].destroyed, true);
});

test('SSH rejects changed host keys and mismatched acceptance before authentication', async () => {
  const { session, clients, stored } = fixture({ pinned: true });
  stored.hostFingerprint = 'SHA256:' + 'A'.repeat(43);
  await assert.rejects(session.handle('ssh/connect', { profileId: 'test', password: 'secret', acceptFingerprint: fingerprint }), /指纹已变化/);
  assert.equal(clients[0].authenticated, false);
  delete stored.hostFingerprint;
  await assert.rejects(session.handle('ssh/connect', { profileId: 'test', password: 'secret', acceptFingerprint: 'SHA256:' + 'B'.repeat(43) }), /不一致/);
  assert.equal(clients[1].authenticated, false);
  session.dispose();
});

test('SSH input, UTF-8 split output, resize and close remain isolated between owners', async () => {
  const first = fixture({ pinned: true });
  const second = fixture({ pinned: true });
  await Promise.all([first, second].map(({ session }) => session.handle('ssh/connect', { profileId: 'test', password: 'secret' })));
  await first.session.handle('ssh/write', { data: 'echo hello\n' });
  assert.equal(first.clients[0].input, 'echo hello\n');
  assert.equal(second.clients[0].input, undefined);
  await first.session.handle('ssh/resize', { rows: 40, cols: 100 });
  assert.deepEqual(first.clients[0].window, [40, 100, 0, 0]);
  const utf8 = Buffer.from('你好');
  first.clients[0].channel.emit('data', utf8.subarray(0, 1));
  first.clients[0].channel.emit('data', utf8.subarray(1));
  assert.equal(first.notices.map(({ params }) => params.data ?? '').join(''), '你好');
  assert.deepEqual(second.notices, []);
  await first.session.handle('ssh/close');
  assert.equal(first.clients[0].destroyed, true);
  assert.equal(second.clients[0].destroyed, false);
  second.session.dispose();
});

test('SSH close cancels pending connect immediately, prevents duplicate connect and disposal prevents resurrection', async () => {
  const { session, clients } = fixture({ stall: true });
  const connecting = session.handle('ssh/connect', { profileId: 'test' });
  const rejected = assert.rejects(connecting, /已关闭/);
  await assert.rejects(session.handle('ssh/connect', { profileId: 'test' }), /已有 SSH/);
  await session.handle('ssh/close');
  await rejected;
  assert.equal(clients[0].destroyed, true);
  session.dispose();
  await assert.rejects(session.handle('ssh/connect', { profileId: 'test' }), /已关闭/);
});

test('SSH handshake timeout and transport errors destroy clients without exposing credentials', async () => {
  const timed = fixture({ stall: true, handshakeTimeoutMs: 10 });
  await assert.rejects(timed.session.handle('ssh/connect', { profileId: 'test' }), /超时/);
  assert.equal(timed.clients[0].destroyed, true);
  const failed = fixture({ stall: true });
  const connecting = failed.session.handle('ssh/connect', { profileId: 'test' });
  await Promise.resolve();
  failed.clients[0].emit('error', new Error('SSH secret-password key-data'));
  await assert.rejects(connecting, (error) => !error.message.includes('secret-password'));
  assert.equal(failed.clients[0].destroyed, true);
});

test('SSH terminal validates frame bounds and respects channel backpressure', async () => {
  const { session, clients } = fixture({ pinned: true });
  await session.handle('ssh/connect', { profileId: 'test', password: 'secret' });
  await assert.rejects(session.handle('ssh/write', { data: 'a'.repeat(65537) }), /64 KiB/);
  await assert.rejects(session.handle('ssh/resize', { rows: 0, cols: 80 }), /行列数/);
  clients[0].channel.write = () => false;
  await session.handle('ssh/write', { data: 'first' });
  await assert.rejects(session.handle('ssh/write', { data: 'second' }), /写入繁忙/);
  clients[0].channel.emit('drain');
  await session.handle('ssh/write', { data: 'third' });
  session.dispose();
});

test('SSH slow-client output backpressure and output rate overflow fail closed', async () => {
  for (const sendResult of [false, true]) {
    const { session, clients, notices } = fixture({ pinned: true, sendResult });
    await session.handle('ssh/connect', { profileId: 'test', password: 'secret' });
    clients[0].channel.emit('data', Buffer.alloc(sendResult ? 4 * 1024 * 1024 + 1 : 1, 65));
    assert.equal(clients[0].destroyed, true);
    assert.equal(notices.at(-1).method, 'ssh/exit');
  }
});

test('SSH disposal during profile lookup prevents a client from being created later', async () => {
  const { session, clients, store } = fixture();
  let resume;
  store.list = () => new Promise((resolve) => { resume = resolve; });
  const connecting = session.handle('ssh/connect', { profileId: 'test' });
  const rejected = assert.rejects(connecting, /已关闭/);
  session.dispose();
  resume([profile]);
  await rejected;
  assert.deepEqual(clients, []);
});

test('SSH cannot authenticate if host fingerprint persistence fails', async () => {
  const { session, clients, store } = fixture();
  store.pinFingerprint = async () => { throw new Error('untrusted secret failure'); };
  await assert.rejects(session.handle('ssh/connect', { profileId: 'test', password: 'secret', acceptFingerprint: fingerprint }), /拒绝连接/);
  assert.equal(clients[0].authenticated, false);
  assert.equal(clients[0].destroyed, true);
});

test('SSH rejects unknown actions, secret fields and missing passwords', async () => {
  const { session } = fixture({ pinned: true });
  await assert.rejects(session.handle('ssh/exec', {}), /不支持/);
  await assert.rejects(session.handle('ssh/connect', { profileId: 'test', command: 'secret' }), /字段/);
  await assert.rejects(session.handle('ssh/connect', { profileId: 'test' }), /请输入 SSH 密码/);
  await assert.rejects(session.handle('ssh/write', { data: 'hello' }), /尚未连接/);
  session.dispose();
});

test('SSH connect uses the Gateway 64-character identifier contract', async () => {
  const { session, stored } = fixture({ pinned: true });
  stored.id = 'gateway.profile-1_2';
  for (const profileId of ['_leading', '.leading', 'a'.repeat(65)]) await assert.rejects(session.handle('ssh/connect', { profileId }), /连接 ID/);
  assert.equal((await session.handle('ssh/connect', { profileId: stored.id, password: 'secret' })).status, 'connected');
  session.dispose();
});
