import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
const { openAdditionalWindow, sendDesktopMenuCommand } = await import(process.env.KCODER_BOOTSTRAP_ADDITIONAL_MODULE || './additional-window.mjs');

class Window extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.destroyed = false; this.sent = [];
    this.webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'http://127.0.0.1:4321/' },
      getURL: () => this.webContents.mainFrame.url,
      getZoomFactor: () => 1, send: (...args) => this.sent.push(args),
      setWindowOpenHandler: handler => { this.openHandler = handler; },
    });
  }
  isDestroyed() { return this.destroyed; }
  setMenu(menu) { this.menu = menu; }
  setMenuBarVisibility() {}
  getContentSize() { return [1440, 900]; }
  show() { this.visible = true; }
  async loadURL(url) { this.url = url; this.emit('ready-to-show'); }
  close() { this.emit('close', { preventDefault() {} }); }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

test('additional windows retain isolated IPC, guarded close and source window handlers', async () => {
  const windows = new Set(), handlers = new Map([['kcoder:menu:list', () => 'primary']]);
  let quits = 0, closed = 0;
  const primary = new Window();
  const menu = { items: [{ label: '文件', submenu: {} }] };
  const window = await openAdditionalWindow({ BrowserWindow: Window, Menu: {},
    ipcMain: { handle: (name, fn) => { assert.ok(!handlers.has(name)); handlers.set(name, fn); }, removeHandler: name => handlers.delete(name) },
    dialog: { showMessageBox: async () => ({ response: 1 }) }, shell: { openExternal() {} },
    windows, partition: 'fixture', getGatewayOrigin: () => 'http://127.0.0.1:4321', menu,
    customMenu: true, isQuitting: () => false, requestQuit: () => { quits += 1; }, onLastClosed: () => { closed += 1; },
    directoryOptions: { getGatewayOrigin: () => 'http://127.0.0.1:4321', getHomeDirectory: () => '/tmp', getServers: async () => [] },
  });
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.visible, true);
  const scope = window.options.webPreferences.additionalArguments.find(value => value.startsWith('--kcoder-window-scope=')).split('=')[1];
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const action = handlers.get(`kcoder:tray:window:${scope}`);
  assert.throws(() => action({ sender: primary.webContents, senderFrame: primary.webContents.mainFrame }, 'close'), /restricted/);
  assert.equal(handlers.get('kcoder:menu:list')(), 'primary');
  sendDesktopMenuCommand('new-chat', window, primary, windows, 'http://127.0.0.1:4321');
  assert.deepEqual(window.sent, [['kcoder:menu:command', 'new-chat']]);
  assert.deepEqual(primary.sent, []);
  window.webContents.mainFrame.url = 'https://untrusted.example';
  sendDesktopMenuCommand('new-chat', window, primary, windows, 'http://127.0.0.1:4321');
  assert.equal(window.sent.length, 1);
  window.webContents.mainFrame.url = 'http://127.0.0.1:4321/';
  handlers.get(`kcoder:tray:activity:${scope}`)(event, 0);
  action(event, 'close');
  assert.equal(quits, 0);
  assert.equal(closed, 1);
  assert.equal(windows.size, 0);
  assert.deepEqual([...handlers.keys()], ['kcoder:menu:list']);
});

test('new windows are bounded before any native allocation', async () => {
  await assert.rejects(openAdditionalWindow({ windows: new Set(Array.from({ length: 8 }, (_, index) => index)), isQuitting: () => false }), /8/);
});


test('additional views block server redirects and retain only owned cancellation', async () => {
 const windows=new Set(),handlers=new Map();let external=0;
 const options={BrowserWindow:Window,Menu:{},ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},
 dialog:{},shell:{openExternal:async()=>{external++;}},windows,partition:'owned',getGatewayOrigin:()=> 'http://127.0.0.1:4321',menu:{items:[]},isQuitting:()=>false,requestQuit(){}};
 const window=await openAdditionalWindow(options);let prevented=false;
 window.webContents.emit('will-redirect',{preventDefault(){prevented=true;}},'https://outside.invalid/');
 assert.equal(prevented,true);assert.equal(external,1);window.destroy();
 class ClosingWindow extends Window{async loadURL(){this.destroy();throw Object.assign(Error('owned navigation cancelled'),{code:'ERR_ABORTED'});}}
 assert.equal(await openAdditionalWindow({...options,BrowserWindow:ClosingWindow}),null);
 assert.equal(await openAdditionalWindow({...options,isQuitting:()=>true}),null);
});

test('production menu factories give additional windows independent mutable native menus',async()=>{
 const windows=new Set(),primary={items:[{label:'primary'}]},own={items:[{label:'owned'}]};
 const window=await openAdditionalWindow({BrowserWindow:Window,Menu:{},ipcMain:{handle(){},removeHandler(){}},dialog:{},shell:{},windows,partition:'owned',getGatewayOrigin:()=> 'http://127.0.0.1:4321',menu:primary,createMenu:()=>own,isQuitting:()=>false,requestQuit(){}});
 assert.equal(window.menu,own);assert.notEqual(window.menu,primary);window.destroy();
});
