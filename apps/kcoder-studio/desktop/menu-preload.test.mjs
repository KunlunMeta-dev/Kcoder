import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { EventEmitter } from 'node:events';

const source = await readFile(new URL('./menu-preload.cjs', import.meta.url), 'utf8');

test('preload exposes only named desktop operations on the main frame', () => {
  for (const isMainFrame of [false, true]) {
    const exposed = {};
    const calls = [];
    const listeners = new EventEmitter();
    const ipcRenderer = {
      invoke: (...args) => { calls.push(args); return Promise.resolve(); },
      on: (name, fn) => listeners.on(name, fn),
      removeListener: (name, fn) => listeners.removeListener(name, fn),
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
    assert.deepEqual(Object.keys(host).sort(), ['capabilities', 'captureFeedbackScreenshot', 'download', 'getTrayCapabilities', 'hideToTray', 'onMenuCommand', 'onSettings', 'readFeedbackDiagnostics', 'setPreferences', 'setTaskActivity', 'setTrayState', 'widgets', 'windowAction']);
    host.hideToTray();
    assert.deepEqual(calls, [['kcoder:tray:hide']]);
    let callbackArguments = null;
    const unsubscribe = host.onSettings((...args) => { callbackArguments = args; });
    listeners.emit('kcoder:tray:settings', { sender: 'must not escape isolated world' });
    assert.deepEqual(callbackArguments, []);
    unsubscribe();
    assert.equal(listeners.eventNames().length, 0);
    const commands = [];
    const off = host.onMenuCommand(command => commands.push(command));
    listeners.emit('kcoder:menu:command', { private: true }, 'new-chat');
    listeners.emit('kcoder:menu:command', {}, 'arbitrary-script');
    assert.deepEqual(commands, ['new-chat']);
    off();
    assert.equal(listeners.eventNames().length, 0);
    listeners.emit('kcoder:menu:command', {}, 'new-chat');
    assert.deepEqual(commands, ['new-chat']);
  }
});

test('storage location operations use named IPC calls and the host-assigned window scope', async () => {
  const exposed = {}, calls = [];
  runInNewContext(source, {
    process: { isMainFrame: true, argv: ['--kcoder-local-storage-locations', '--kcoder-window-scope=child-1'] },
    require: () => ({
      contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(null); } },
    }),
  });
  const bridge = exposed.kcoderDesktopHost.storageLocations;
  assert.ok(Object.isFrozen(bridge));
  await bridge.read();
  await bridge.pick({ kind: 'data' });
  await bridge.preview({ dataRoot: '/data', cacheRoot: '/cache' });
  await bridge.migrate({ operationId: 'operation-1' });
  await bridge.retry({ operationId: 'original-deferred' });
  await bridge.cleanupPreview({ operationId: 'original-operation' });
  await bridge.cleanupConfirm({ operationId: 'original-operation', confirmation: 'c'.repeat(64) });
  await bridge.cleanupStatus({ operationId: 'original-operation' });
  assert.deepEqual(calls, [
    ['kcoder:storage-locations:read:child-1'],
    ['kcoder:storage-locations:pick:child-1', { kind: 'data' }],
    ['kcoder:storage-locations:preview:child-1', { dataRoot: '/data', cacheRoot: '/cache' }],
    ['kcoder:storage-locations:migrate:child-1', { operationId: 'operation-1' }],
    ['kcoder:storage-locations:retry:child-1', { operationId: 'original-deferred' }],
    ['kcoder:storage-locations:cleanupPreview:child-1', { operationId: 'original-operation' }],
    ['kcoder:storage-locations:cleanupConfirm:child-1', { operationId: 'original-operation', confirmation: 'c'.repeat(64) }],
    ['kcoder:storage-locations:cleanupStatus:child-1', { operationId: 'original-operation' }],
  ]);
});

test('storage location operations are not exposed without the local desktop capability flag', () => {
  const exposed = {};
  runInNewContext(source, {
    process: { isMainFrame: true, argv: ['--kcoder-window-scope=remote-1'] },
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } }, ipcRenderer: { invoke() {} } }),
  });
  assert.equal(exposed.kcoderDesktopHost.storageLocations, undefined);
});

test('widget IPC is bound by the main process sender even in additional windows', async () => {
  const exposed = {}, calls = [], listeners = new Map();
  runInNewContext(source, {
    process: { isMainFrame: true, argv: ['--kcoder-window-scope=child-1'] },
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); },
        on: (name, callback) => listeners.set(name, callback), removeListener: name => listeners.delete(name) } }),
  });
  const bridge = exposed.kcoderDesktopHost.widgets;
  assert.ok(Object.isFrozen(bridge));
  await bridge.getCapabilities();
  await bridge.authorize({ frameName: 'owned' });
  await bridge.heartbeat({ leaseId: 'own-lease' });
  await bridge.revoke({ leaseId: 'own-lease' });
  assert.deepEqual(calls.map(call => call[0]), ['kcoder:widgets:capabilities', 'kcoder:widgets:authorize',
    'kcoder:widgets:heartbeat', 'kcoder:widgets:revoke']);
  let observed;
  const off = bridge.onRevoked(value => { observed = value; });
  listeners.get('kcoder:widgets:revoked')({ sender: 'private' }, { leaseId: 'own-lease' });
  assert.deepEqual(observed, { leaseId: 'own-lease' });
  off();
  assert.equal(listeners.size, 0);
});

test('additional window IPC uses its own host-assigned scope', () => {
  const exposed = {}, calls = [];
  runInNewContext(source, {
    process: { isMainFrame: true, argv: ['--kcoder-custom-menu', '--kcoder-local-directory-picker', '--kcoder-window-scope=child-1'] },
    require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: { invoke: (...args) => calls.push(args) } }),
  });
  exposed.kcoderDesktopMenu.list();
  exposed.kcoderDesktopMenu.setTheme(true, 'rgb(17, 19, 22)');
  exposed.kcoderDesktopHost.windowAction('close');
  exposed.kcoderDesktopHost.pickWorkspacePaths({});
  assert.deepEqual(calls.map(call => call[0]), ['kcoder:menu:list:child-1', 'kcoder:menu:theme:child-1', 'kcoder:tray:window:child-1', 'kcoder:directories:pick:child-1']);
  assert.deepEqual(calls[1], ['kcoder:menu:theme:child-1', true, 'rgb(17, 19, 22)']);
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

test('workspace intents are exposed only to the primary local main frame and strip IPC events', async () => {
  for (const isMainFrame of [false, true]) {
    const exposed = {}, calls = [], listeners = new EventEmitter();
    runInNewContext(source, {
      process: { isMainFrame, argv: ['--kcoder-local-workspace-open'] },
      require: () => ({ contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve([]); },
          on: (name, fn) => listeners.on(name, fn), removeListener: (name, fn) => listeners.removeListener(name, fn) } }),
    });
    if (!isMainFrame) { assert.deepEqual(exposed, {}); continue; }
    const host = exposed.kcoderDesktopHost;
    await host.takeWorkspaceOpenRequests(); await host.acknowledgeWorkspaceOpen('owned-id');
    assert.deepEqual(calls, [['kcoder:workspace-open:pending'], ['kcoder:workspace-open:ack', 'owned-id']]);
    let argumentsReceived;
    const off = host.onWorkspaceOpen((...args) => { argumentsReceived = args; });
    listeners.emit('kcoder:workspace-open:changed', { sender: 'private' });
    assert.deepEqual(argumentsReceived, []); off();
    assert.equal(listeners.listenerCount('kcoder:workspace-open:changed'), 0);
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
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(own.nativeClicks, 0);
  assert.equal(calls[0]?.channel, 'kcoder:download');
  assert.equal(events[0]?.status, 'completed');
  const foreign = new Anchor({}); foreign.click();
  assert.equal(foreign.nativeClicks, 1);
  const external = new Anchor(document); external.href = 'https://example.test/file'; external.click();
  assert.equal(external.nativeClicks, 1);
  assert.equal(calls.length, 1);
});

test('a failed optional Blob adapter cannot suppress the custom menu bridge', () => {
 const exposed={},warnings=[];
 runInNewContext(source,{process:{isMainFrame:true,argv:['--kcoder-custom-menu']},console:{warn:value=>warnings.push(value)},
 require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value;},executeInMainWorld(){throw Error('owned unavailable main world');}},ipcRenderer:{}})});
 assert.equal(typeof exposed.kcoderDesktopMenu.list,'function');assert.deepEqual(warnings,['DESKTOP_BLOB_ADAPTER_UNAVAILABLE']);
});

test('attached Blob anchors retain click dispatch and duplicate legacy clicks share one result', async () => {
 const calls=[],events=[],listeners=new Map();let finish;
 const document={addEventListener:(name,callback)=>listeners.set(name,callback)};
 class Anchor{constructor(){this.ownerDocument=document;this.isConnected=true;this.download='owned.md';this.href='blob:http://127.0.0.1:12345/owned';this.nativeClicks=0;}click(){this.nativeClicks++;listeners.get('click')?.({target:this,defaultPrevented:false,preventDefault(){}});}closest(){return this;}}
 const window={dispatchEvent:event=>events.push(event.detail)};
 const mainWorld={window,document,HTMLAnchorElement:Anchor,location:{origin:'http://127.0.0.1:12345'},URL,CustomEvent};
 runInNewContext(source,{process:{isMainFrame:true,argv:[]},require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>{window[name]=value;},executeInMainWorld:script=>runInNewContext(`(${script.func.toString()})()`,mainWorld)},ipcRenderer:{invoke:(...args)=>{calls.push(args);return new Promise(resolve=>{finish=resolve;});}}})});
 const anchor=new Anchor();anchor.click();anchor.click();assert.equal(anchor.nativeClicks,2);assert.equal(calls.length,1);assert.equal(events.length,0);
 finish({status:'completed',filename:'owned.md'});await new Promise(resolve => setImmediate(resolve));assert.equal(events.length,1);assert.equal(events[0].status,'completed');
});
