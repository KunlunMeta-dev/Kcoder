import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { registerDesktopMenu } from './desktop-menu-controller.mjs';
import { applicationMenuTemplate } from './application-menu.mjs';

function fixture(beforeMenu = () => {}) {
  const handlers = new Map();
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const webContents = Object.assign(new EventEmitter(), { mainFrame: { url: 'http://127.0.0.1:3210/' }, getZoomFactor: () => 1.5 });
  const visibility = [];
  const window = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => false, getContentSize: () => [960, 640], setMenuBarVisibility: value => visibility.push(value) });
  const popups = [];
  beforeMenu(window);
  const menu = { items: applicationMenuTemplate({ openAutomations() {}, quit() {} }).map(item => ({ label: item.label, submenu: { popup: options => popups.push(options), closePopup: () => popups.at(-1)?.callback() } })) };
  const dispose = registerDesktopMenu({ ipcMain, window, menu, getGatewayOrigin: () => 'http://127.0.0.1:3210' });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { handlers, window, event, menu, popups, visibility, dispose };
}

test('custom bar preserves existing top-level menu labels and only hides native bar when ready', () => {
  const f = fixture();
  assert.deepEqual(f.visibility, []);
  assert.deepEqual(f.handlers.get('kcoder:menu:list')(f.event).map(item => item.label), ['文件', '编辑', '视图']);
  f.handlers.get('kcoder:menu:visible')(f.event, true);
  assert.deepEqual(f.visibility, [false]);
  f.window.webContents.emit('did-navigate');
  assert.deepEqual(f.visibility, [false, true]);
  f.dispose();
  assert.equal(f.handlers.size, 0);
});

test('native popup is dismissed before an earlier-registered tray handler hides its owner', async () => {
  const order = [];
  const f = fixture(window => window.on('close', () => order.push('hide')));
  f.menu.items[0].submenu.closePopup = () => { order.push('dismiss'); f.popups.at(-1).callback(); };
  const popup = f.handlers.get('kcoder:menu:open')(f.event, { index: 0, x: 0, y: 32 });
  f.window.emit('close');
  await popup;
  assert.deepEqual(order, ['dismiss', 'hide']);
  f.dispose();
});

test('menu IPC rejects foreign windows, frames, origins and invalid requests', () => {
  const f = fixture();
  const list = f.handlers.get('kcoder:menu:list');
  assert.throws(() => list({ ...f.event, sender: {} }), /restricted/);
  assert.throws(() => list({ ...f.event, senderFrame: { url: f.event.senderFrame.url } }), /restricted/);
  f.event.senderFrame.url = 'https://untrusted.example/';
  assert.throws(() => list(f.event), /restricted/);
  f.event.senderFrame.url = 'http://127.0.0.1:3210/';
  const open = f.handlers.get('kcoder:menu:open');
  for (const params of [null, [], {index: 9, x: 0, y: 0}, {index: 0, x: NaN, y: 0}, {index: 0, x: 0, y: 0, command: 'bad'}]) {
    assert.throws(() => open(f.event, params), /Invalid/);
  }
  assert.throws(() => f.handlers.get('kcoder:menu:visible')(f.event, 'true'), /Invalid/);
  assert.equal(f.popups.length, 0);
  f.dispose();
});

test('menu popup uses clamped zoom-aware coordinates, serializes opens and resolves on close', async () => {
  const f = fixture();
  const open = f.handlers.get('kcoder:menu:open');
  let closed = false;
  const pending = open(f.event, {index: 1, x: -100, y: 9999}).then(() => { closed = true; });
  assert.equal(f.popups[0].x, 0);
  assert.equal(f.popups[0].y, 639);
  assert.equal(closed, false);
  assert.throws(() => open(f.event, {index: 2, x: 5, y: 5}), /already open/);
  f.popups[0].callback();
  await pending;
  assert.equal(closed, true);
  f.dispose();
});

test('popup failure restores native menu and reports failure to the custom bar', async () => {
  const f = fixture();
  f.menu.items[0].submenu.popup = () => { throw new Error('native fixture failure'); };
  await assert.rejects(f.handlers.get('kcoder:menu:open')(f.event, {index: 0, x: 1, y: 32}), /Unable to open/);
  assert.equal(f.visibility.at(-1), true);
  f.dispose();
});

test('renderer crash restores native recovery controls and closes a pending popup', async () => {
  const f = fixture();
  f.handlers.get('kcoder:menu:visible')(f.event, true);
  const pending = f.handlers.get('kcoder:menu:open')(f.event, { index: 0, x: 0, y: 32 });
  f.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await pending;
  assert.equal(f.visibility.at(-1), true);
  f.dispose();
  assert.equal(f.window.webContents.listenerCount('render-process-gone'), 0);
});

test('window close dismisses the native popup before destroying its owner', async () => {
  const f = fixture();
  let popupClosed = false;
  f.menu.items[0].submenu.closePopup = () => { popupClosed = true; f.popups[0].callback(); };
  const pending = f.handlers.get('kcoder:menu:open')(f.event, { index: 0, x: 0, y: 32 });
  f.window.emit('close');
  await pending;
  assert.equal(popupClosed, true);
  f.dispose();
});

test('only a main-frame load failure restores the native menu', () => {
  const f = fixture();
  f.handlers.get('kcoder:menu:visible')(f.event, true);
  f.window.webContents.emit('did-fail-load', {}, -105, 'fixture', 'https://frame.example', false);
  assert.deepEqual(f.visibility, [false]);
  f.window.webContents.emit('did-fail-load', {}, -105, 'fixture', 'http://127.0.0.1:3210', true);
  assert.deepEqual(f.visibility, [false, true]);
  f.dispose();
});

test('closed cleanup does not access the destroyed BrowserWindow webContents getter', () => {
  const f = fixture();
  const contents = f.window.webContents;
  Object.defineProperty(f.window, 'webContents', { get() { throw new Error('Object has been destroyed'); } });
  assert.doesNotThrow(() => f.window.emit('closed'));
  assert.equal(contents.listenerCount('render-process-gone'), 0);
  assert.equal(f.handlers.size, 0);
});

test('localized command snapshots preserve IDs and invoke only an enabled owned menu entry', () => {
  const f = fixture();
  let received;
  f.menu.items[0].id = 'file';
  f.menu.items[0].submenu.items = [
    { id: 'copy', role: 'copy', label: '复制', enabled: true, click: (...args) => { received = args; } },
    { id: 'logout', label: '注销', enabled: false, click() { throw new Error('must not run'); } },
    { type: 'separator' },
  ];
  const en = f.handlers.get('kcoder:menu:list')(f.event, 'en');
  assert.equal(en[0].label, 'File');
  assert.equal(en[0].entries[0].label, 'Copy');
  assert.equal(en[0].entries[0].accelerator, 'Ctrl+C');
  const invoke = f.handlers.get('kcoder:menu:invoke');
  invoke(f.event, { index: 0, position: 0 });
  assert.equal(received[1], f.window);
  assert.equal(received[2], f.window.webContents);
  for (const params of [null, {index: -1, position: 0}, {index: 0, position: 1}, {index: 0, position: 2}, {index: 0, position: 99}, {index: 0, position: 0, role: 'quit'}]) assert.throws(() => invoke(f.event, params));
  assert.throws(() => invoke({ ...f.event, sender: {} }, {index: 0, position: 0}), /restricted/);
  assert.equal(f.handlers.get('kcoder:menu:list')(f.event, 'zh-CN')[0].entries[0].label, '复制');
  assert.throws(() => f.handlers.get('kcoder:menu:theme')(f.event, 'dark'), /Invalid/);
  f.dispose();
});
