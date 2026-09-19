import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createDesktopTray } from './tray-controller.mjs';

function fixture({ trayFails = false, requestWindowClose } = {}) {
  const handlers = new Map();
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: 'http://127.0.0.1:3210/' }, send: (...args) => events.push(args) });
  const events = [];
  let visible = true;
  let quits = 0;
  let promptResponse = 1;
  let prompts = 0;
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => false,
    isMinimized: () => false, show: () => { visible = true; }, hide: () => { visible = false; },
    focus() {}, restore() {}, minimize() {}, isMaximized: () => false, maximize() {}, unmaximize() {},
    close() { this.emit('close', { preventDefault() {} }); },
  });
  let tray;
  class Tray extends EventEmitter {
    constructor() { super(); if (trayFails) throw new Error('No tray'); tray = this; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
    destroy() { this.destroyed = true; }
  }
  const controller = createDesktopTray({
    Tray, Menu: { buildFromTemplate: items => items },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    dialog: { async showMessageBox() { prompts += 1; return { response: promptResponse }; } },
    window, icon: {}, getGatewayOrigin: () => 'http://127.0.0.1:3210',
    isQuitting: () => false, requestQuit: () => { quits += 1; }, onError() {},
    ...(requestWindowClose ? { requestWindowClose } : {}),
  });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const invoke = (name, value) => handlers.get(`kcoder:tray:${name}`)(event, value);
  return { controller, window, contents, event, handlers, invoke, events, get tray() { return tray; },
    get visible() { return visible; }, get quits() { return quits; }, get prompts() { return prompts; },
    setResponse: value => { promptResponse = value; } };
}

test('tray restores the same live window and offers settings and explicit quit', () => {
  const f = fixture();
  f.window.close();
  assert.equal(f.visible, false);
  assert.equal(f.quits, 0);
  f.tray.emit('click');
  assert.equal(f.visible, true);
  f.tray.menu.find(item => item.id === 'settings').click();
  assert.deepEqual(f.events, [['kcoder:tray:settings']]);
  f.tray.menu.find(item => item.id === 'quit').click();
  assert.equal(f.quits, 1);
  f.controller.dispose();
  assert.equal(f.tray.destroyed, true);
  assert.equal(f.handlers.size, 0);
});

test('explicit Quit in the primary close warning still quits when ordinary close only hides', async () => {
  let closes = 0;
  const f = fixture({ requestWindowClose: () => { closes += 1; } });
  f.invoke('preferences', { closeToTrayEnabled: false, language: 'zh-CN' });
  f.invoke('activity', 1);
  f.setResponse(2);
  f.window.close();
  await Promise.resolve();
  assert.equal(f.quits, 1);
  assert.equal(closes, 0);
  f.controller.dispose();
});

test('disabled close-to-tray quits only after idle state is known and protects running tasks', async () => {
  const f = fixture();
  f.invoke('preferences', { closeToTrayEnabled: false, language: 'en' });
  f.invoke('state', { language: 'en', activeTaskIds: ['task-1'] });
  f.invoke('activity', 1);
  f.window.close();
  await Promise.resolve();
  assert.equal(f.quits, 0);
  assert.equal(f.visible, true);
  assert.equal(f.prompts, 1);
  f.setResponse(0);
  f.window.close();
  await Promise.resolve();
  assert.equal(f.visible, false);
  assert.equal(f.quits, 0);
  f.invoke('state', { language: 'en', activeTaskIds: [] });
  f.invoke('activity', 0);
  f.window.close();
  assert.equal(f.quits, 1);
});

test('tray failure never hides an unreachable window, and untrusted IPC fails closed', async () => {
  const f = fixture({ trayFails: true });
  assert.equal(f.controller.available, false);
  assert.throws(() => f.invoke('hide'), /unavailable/);
  f.window.close();
  await Promise.resolve();
  assert.equal(f.visible, true);
  assert.equal(f.quits, 0);
  const configure = f.handlers.get('kcoder:tray:preferences');
  for (const event of [{ sender: {}, senderFrame: f.contents.mainFrame }, { sender: f.contents, senderFrame: { url: f.contents.mainFrame.url } }]) {
    assert.throws(() => configure(event, {}), /restricted/);
  }
  f.contents.mainFrame.url = 'https://untrusted.example/';
  assert.throws(() => configure(f.event, {}), /restricted/);
});

test('tray state rejects malformed or unbounded input and honors preference changes', () => {
  const f = fixture();
  assert.throws(() => f.invoke('preferences', { closeToTrayEnabled: 'false', language: 'en' }), /Invalid/);
  assert.throws(() => f.invoke('state', { language: 'en', activeTaskIds: [12] }), /Invalid/);
  assert.throws(() => f.invoke('state', { language: 'en', activeTaskIds: [], command: 'quit' }), /Invalid/);
  f.invoke('preferences', { closeToTrayEnabled: true, language: 'en' });
  f.invoke('state', { language: 'en', activeTaskIds: [] });
  f.window.close();
  assert.equal(f.visible, false);
  assert.equal(f.quits, 0);
  assert.equal(f.tray.menu[0].label, 'Show KCoder Studio');
});

test('cosmetic tray metadata cannot override authoritative running task protection', async () => {
  const f = fixture();
  f.invoke('preferences', { closeToTrayEnabled: false, language: 'en' });
  f.invoke('activity', 1);
  f.invoke('state', { language: 'en', activeTaskIds: [] });
  f.window.close();
  await Promise.resolve();
  assert.equal(f.quits, 0);
  assert.equal(f.prompts, 1);
  f.invoke('activity', 0);
  f.contents.emit('render-process-gone');
  f.window.close();
  await Promise.resolve();
  assert.equal(f.quits, 0);
  assert.equal(f.prompts, 2);
  assert.throws(() => f.invoke('activity', -1), /Invalid/);
  assert.throws(() => f.invoke('activity', Number.NaN), /Invalid/);
});

test('both desktop packages include tray controller, preload and native image resources', async () => {
  const { readFile, access } = await import('node:fs/promises');
  const local = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const remote = JSON.parse(await readFile(new URL('../electron-builder.remote.json', import.meta.url), 'utf8'));
  for (const files of [local.build.files, remote.files]) {
    for (const required of ['desktop/tray-controller.mjs', 'desktop/menu-preload.cjs',
      'desktop/application-menu.mjs', 'desktop/desktop-menu-controller.mjs',
      'renderer/src-tauri/icons/icon.ico', 'renderer/src-tauri/icons/32x32.png']) {
      assert.ok(files.includes(required), `missing packaged tray asset ${required}`);
      await access(new URL(`../${required}`, import.meta.url));
    }
  }
});

test('trusted explicit quit uses host cleanup even with running tasks, while foreign senders cannot quit', () => {
  const f = fixture();
  f.invoke('preferences', { closeToTrayEnabled: true, language: 'en' });
  f.invoke('activity', 1);
  const action = f.handlers.get('kcoder:tray:window');
  assert.throws(() => action({ ...f.event, sender: {} }, 'quit'), /restricted/);
  assert.equal(f.quits, 0);
  assert.throws(() => f.invoke('window', 'delete'), /Invalid/);
  f.invoke('window', 'quit');
  assert.equal(f.quits, 1);
  assert.equal(f.visible, true);
});
