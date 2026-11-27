import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { registerFeedbackDiagnostics } from './feedback-controller.mjs';
import { createGatewayDiagnostics } from './gateway-diagnostics.mjs';

test('local and remote installer manifests include the feedback IPC module', async () => {
  const local = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const remote = JSON.parse(await readFile(new URL('../electron-builder.remote.json', import.meta.url), 'utf8'));
  for (const files of [local.build.files, remote.files]) assert.ok(files.includes('desktop/feedback-controller.mjs'));
});

function fixture() {
  const handlers = new Map();
  let origin = 'http://127.0.0.1:12345', reads = 0;
  const contents = { mainFrame: { url: origin + '/' }, isDestroyed: () => false,
    capturePage: async () => ({ toPNG: () => Buffer.from('owned-png') }) };
  const window = { isDestroyed: () => false };
  const dispose = registerFeedbackDiagnostics({
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    getWindow: sender => sender === contents ? window : null, getGatewayOrigin: () => origin,
    getVersion: () => '2.0.26', getRuntimeLogs: () => { reads++; return 'owned-log'; },
  });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { contents, handlers, event, dispose, reads: () => reads, setOrigin: value => { origin = value; } };
}

test('diagnostics expose only selected bounded application data', () => {
  const f = fixture(), read = f.handlers.get('kcoder:feedback:diagnostics');
  assert.deepEqual(read(f.event, { runtimeLogs: false, systemInfo: false }), { runtimeLogs: null, systemInfo: null });
  assert.equal(f.reads(), 0);
  const result = read(f.event, { runtimeLogs: true, systemInfo: true });
  assert.equal(result.runtimeLogs, 'owned-log');
  assert.equal(result.systemInfo.version, '2.0.26');
  assert.equal(result.systemInfo.platform, process.platform);
  assert.equal('env' in result.systemInfo, false);
  assert.throws(() => read(f.event, { runtimeLogs: true, systemInfo: false, path: '/private' }));
  f.dispose(); assert.equal(f.handlers.size, 0);
});

test('foreign frames and origins cannot collect logs or capture the application', async () => {
  const f = fixture(), capture = f.handlers.get('kcoder:feedback:capture');
  await assert.rejects(capture({ ...f.event, senderFrame: { url: f.contents.mainFrame.url } }), /main application frame/);
  f.contents.mainFrame.url = 'https://foreign.example/';
  assert.throws(() => f.handlers.get('kcoder:feedback:diagnostics')(f.event, { runtimeLogs: true, systemInfo: true }), /main application frame/);
  assert.equal(f.reads(), 0);
});

test('a late screenshot cannot cross navigation, Gateway replacement or disposal', async () => {
  for (const change of ['navigation', 'gateway', 'dispose']) {
    const f = fixture(); let release;
    f.contents.capturePage = () => new Promise(resolve => { release = resolve; });
    const pending = f.handlers.get('kcoder:feedback:capture')(f.event);
    if (change === 'navigation') f.contents.mainFrame.url = 'https://foreign.example/';
    if (change === 'gateway') f.setOrigin('http://127.0.0.1:54321');
    if (change === 'dispose') f.dispose();
    release({ toPNG: () => Buffer.from('owned-png') });
    await assert.rejects(pending, /main application frame/);
  }
});

test('screenshot bytes are captured from the requesting window and remain bounded', async () => {
  const f = fixture(), capture = f.handlers.get('kcoder:feedback:capture');
  assert.equal(await capture(f.event), 'data:image/png;base64,' + Buffer.from('owned-png').toString('base64'));
  f.contents.capturePage = async () => ({ toPNG: () => Buffer.alloc(8 * 1024 * 1024 + 1) });
  await assert.rejects(capture(f.event), /exceeds 8 MiB/);
});

test('recent Gateway output is bounded, redacted across chunks and held only in memory', () => {
  const token = 'owned-test-token-for-redaction-1234567890';
  const logs = createGatewayDiagnostics({ token });
  logs.stdout.write('token=' + token.slice(0, 12));
  logs.stdout.write(token.slice(12) + '\n');
  assert.equal(logs.stdout.snapshot().includes(token), false);
  assert.match(logs.stdout.snapshot(), /redacted/);
  logs.stdout.write('x'.repeat(1024 * 1024) + '\n');
  assert.ok(logs.stdout.snapshot().length <= 512 * 1024);
  assert.equal(logs.stderr.snapshot(), '');
});
