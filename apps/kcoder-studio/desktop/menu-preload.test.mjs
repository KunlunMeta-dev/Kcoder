import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('./menu-preload.cjs', import.meta.url), 'utf8');

test('preload exposes only named desktop operations on the main frame', () => {
  for (const isMainFrame of [false, true]) {
    const exposed = {};
    const calls = [];
    const listeners = new Map();
    const ipcRenderer = {
      invoke: (...args) => { calls.push(args); return Promise.resolve(); },
      on: (name, fn) => listeners.set(name, fn),
      removeListener: name => listeners.delete(name),
    };
    runInNewContext(source, {
      process: { isMainFrame, platform: 'win32', argv: [] },
      require: name => {
        assert.equal(name, 'electron');
        return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } }, ipcRenderer };
      },
    });
    if (!isMainFrame) { assert.deepEqual(exposed, {}); continue; }
    assert.equal(exposed.kcoderDesktopMenu, undefined);
    const host = exposed.kcoderDesktopHost;
    assert.ok(Object.isFrozen(host));
    assert.ok(Object.isFrozen(host.capabilities));
    assert.equal(host.capabilities.completionBadge, true);
    assert.deepEqual(Object.keys(host).sort(), ['capabilities', 'download', 'hideToTray', 'onMenuCommand', 'onSettings', 'setPreferences', 'setTaskActivity', 'setTrayState', 'windowAction']);
    host.hideToTray();
    assert.deepEqual(calls, [['kcoder:tray:hide']]);
    let callbackArguments = null;
    const unsubscribe = host.onSettings((...args) => { callbackArguments = args; });
    listeners.get('kcoder:tray:settings')({ sender: 'must not escape isolated world' });
    assert.deepEqual(callbackArguments, []);
    unsubscribe();
    assert.equal(listeners.size, 0);
    const commands = [];
    const off = host.onMenuCommand(command => commands.push(command));
    listeners.get('kcoder:menu:command')({ private: true }, 'new-chat');
    listeners.get('kcoder:menu:command')({}, 'arbitrary-script');
    assert.deepEqual(commands, ['new-chat']);
    off();
    assert.equal(listeners.size, 0);
  }
});

test('additional window IPC uses its own host-assigned scope', () => {
  const exposed = {}, calls = [];
  runInNewContext(source, {
    process: { isMainFrame: true, argv: ['--kcoder-custom-menu', '--kcoder-local-directory-picker', '--kcoder-window-scope=child-1'] },
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: { invoke: (...args) => calls.push(args) } }),
  });
  exposed.kcoderDesktopMenu.list();
  exposed.kcoderDesktopHost.windowAction('close');
  exposed.kcoderDesktopHost.pickWorkspacePaths({});
  assert.deepEqual(calls.map(call => call[0]), ['kcoder:menu:list:child-1', 'kcoder:tray:window:child-1', 'kcoder:directories:pick:child-1']);
});

test('only the local desktop launcher can expose the native directory picker capability', () => {
  for (const local of [false, true]) {
    const exposed = {};
    const calls = [];
    runInNewContext(source, {
      process: { isMainFrame: true, argv: local ? ['--kcoder-local-directory-picker'] : [] },
      require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
        ipcRenderer: { invoke: (...args) => calls.push(args) } }),
    });
    assert.equal(typeof exposed.kcoderDesktopHost.pickWorkspacePaths, local ? 'function' : 'undefined');
    if (local) {
      exposed.kcoderDesktopHost.pickWorkspacePaths({ serverId: 'local', multiple: true });
      assert.equal(calls[0][0], 'kcoder:directories:pick');
    }
  }
});

test('legacy main-document Blob anchors use the approved download bridge without adapting foreign documents', async () => {
  const calls = [], events = [], listeners = new Map();
  const document = { addEventListener: (name, callback) => listeners.set(name, callback) };
  class Anchor { constructor(ownerDocument) { this.ownerDocument = ownerDocument; this.href = 'blob:http://127.0.0.1:12345/owned'; this.download = 'owned.md'; this.nativeClicks = 0; } click() { this.nativeClicks++; } }
  const window = { dispatchEvent: event => { events.push(event.detail); } };
  const mainWorld = { window, document, HTMLAnchorElement: Anchor, location: { origin: 'http://127.0.0.1:12345' }, URL, CustomEvent };
  runInNewContext(source, {
    process: { isMainFrame: true, argv: [] },
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, value) => { window[name] = value; },
        executeInMainWorld: script => runInNewContext(`(${script.func.toString()})()`, mainWorld) },
      ipcRenderer: { invoke: (channel, params) => { calls.push({ channel, params }); return Promise.resolve({ status: 'completed', filename: params.filename }); } },
    }),
  });
  const own = new Anchor(document); own.click();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(own.nativeClicks, 0);
  assert.equal(calls[0]?.channel, 'kcoder:download');
  assert.equal(events[0]?.status, 'completed');
  const foreign = new Anchor({}); foreign.click();
  assert.equal(foreign.nativeClicks, 1);
  const external = new Anchor(document); external.href = 'https://example.test/file'; external.click();
  assert.equal(external.nativeClicks, 1);
  assert.equal(calls.length, 1);
});
