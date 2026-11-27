import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { registerDirectoryDialog } from './directory-dialog-controller.mjs';

function fixture() {
  const handlers = new Map();
  const contents = { mainFrame: { url: 'http://127.0.0.1:3210/' } };
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
  let servers = [{ id: 'local', transport: 'local' }, { id: 'ssh', transport: 'ssh' }];
  let result = { canceled: false, filePaths: ['/workspace/a', '/workspace/b'] };
  const dialogs = [];
  const dispose = registerDirectoryDialog({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    window, getGatewayOrigin: () => 'http://127.0.0.1:3210', getServers: async () => servers,
    getHomeDirectory: () => '/fixture-home',
    dialog: { showOpenDialog: async (owner, options) => { dialogs.push({ owner, options }); return result; } },
  });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const invoke = (params = { serverId: 'local', initialDirectory: null, multiple: true }) =>
    handlers.get('kcoder:directories:pick')(event, params);
  return { handlers, window, contents, event, invoke, dialogs, dispose,
    setResult: value => { result = value; }, setServers: value => { servers = value; } };
}

test('local target opens a parented directory-only multi-selection dialog and cancellation returns no roots', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke(), ['/workspace/a', '/workspace/b']);
  assert.equal(f.dialogs[0].owner, f.window);
  assert.deepEqual(f.dialogs[0].options, { defaultPath: '/fixture-home', properties: ['openDirectory', 'multiSelections'] });
  f.setResult({ canceled: true, filePaths: ['/ignored'] });
  assert.deepEqual(await f.invoke(), []);
  f.dispose();
  assert.equal(f.handlers.size, 0);
});

test('directory IPC rejects foreign frames, remote targets and malformed requests before any dialog', async () => {
  const f = fixture();
  const handler = f.handlers.get('kcoder:directories:pick');
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: { url: f.contents.mainFrame.url } }]) {
    await assert.rejects(handler(event, {}), /restricted/);
  }
  for (const params of [null, [], { serverId: 'ssh', multiple: true }, { serverId: 'unknown', multiple: true },
    { serverId: 'local', multiple: 'true' }, { serverId: 'local', multiple: true, initialDirectory: '../foreign' },
    { serverId: 'local', multiple: true, properties: ['openFile'] }]) {
    await assert.rejects(f.invoke(params));
  }
  assert.equal(f.dialogs.length, 0);
});

test('concurrent dialogs are rejected and navigation cannot receive selected local paths', async () => {
  const f = fixture();
  let resolve;
  f.setResult(new Promise(done => { resolve = done; }));
  const first = f.invoke();
  await Promise.resolve();
  await assert.rejects(f.invoke(), /already open/);
  f.contents.mainFrame.url = 'https://untrusted.example/';
  resolve({ canceled: false, filePaths: ['/private'] });
  await assert.rejects(first, /restricted/);
  f.contents.mainFrame.url = 'http://127.0.0.1:3210/';
  f.setResult({ canceled: true, filePaths: [] });
  assert.deepEqual(await f.invoke(), []);
});

test('target transport is rechecked after native selection', async () => {
  const f = fixture();
  let resolve;
  f.setResult(new Promise(done => { resolve = done; }));
  const pending = f.invoke();
  await Promise.resolve();
  f.setServers([{ id: 'local', transport: 'ssh' }]);
  resolve({ canceled: false, filePaths: ['/private'] });
  await assert.rejects(pending, /local target/);
});

test('single selection and project-root limits are enforced on native results', async () => {
  const f = fixture();
  await assert.rejects(f.invoke({ serverId: 'local', multiple: false }), /invalid paths/);
  f.setResult({ canceled: false, filePaths: Array.from({ length: 65 }, (_, index) => `/root/${index}`) });
  await assert.rejects(f.invoke(), /invalid paths/);
  f.setResult({ canceled: false, filePaths: [`/${'x'.repeat(32767)}`] });
  await assert.rejects(f.invoke(), /invalid paths/);
});
