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
      process: { isMainFrame, argv: [] },
      require: name => {
        assert.equal(name, 'electron');
        return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } }, ipcRenderer };
      },
    });
    if (!isMainFrame) { assert.deepEqual(exposed, {}); continue; }
    assert.equal(exposed.kcoderDesktopMenu, undefined);
    const host = exposed.kcoderDesktopHost;
    assert.ok(Object.isFrozen(host));
    assert.deepEqual(Object.keys(host).sort(), ['hideToTray', 'onMenuCommand', 'onSettings', 'setPreferences', 'setTaskActivity', 'setTrayState', 'windowAction']);
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
