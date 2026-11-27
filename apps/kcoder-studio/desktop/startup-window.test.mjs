import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createStartupWindow, runDesktopStartup, startOwnedGateway } from './startup-window.mjs';

async function fixture({ loadFailure = false } = {}) {
  let window, options, closed = 0, permission, check, requests;
  const isolated = { setPermissionRequestHandler: value => {permission=value;}, setPermissionCheckHandler: value => {check=value;}, webRequest: {onBeforeRequest: (filter, callback) => {requests=callback;}} };
  class BrowserWindow extends EventEmitter {
    constructor(value) { super();options=value;window=this;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=value=>{this.open=value;}; }
    setMenu(value) {this.menu=value;}
    async loadURL(value) {this.url=value;if(loadFailure)throw Error('Owned startup document failed');}
    isDestroyed() {return this.destroyed===true;}
    destroy() {this.destroyed=true;this.emit('closed');}
  }
  const handle=await createStartupWindow({BrowserWindow, session:{fromPartition: name=>{assert.ok(!name.startsWith('persist:'));return isolated;}},locale:'zh-CN',onClose:()=>{closed++;}});
  return {window,options,handle,get closed(){return closed;},permission,check,requests};
}

test('startup status is a visible isolated document with no preload or runtime permissions', async () => {
  const f=await fixture();
  assert.equal(f.options.show,true);assert.equal(f.options.webPreferences.sandbox,true);
  assert.equal(f.options.webPreferences.contextIsolation,true);assert.equal(f.options.webPreferences.nodeIntegration,false);
  assert.equal(f.options.webPreferences.preload,undefined);assert.equal(f.window.menu,null);
  const html=decodeURIComponent(f.window.url.split(',').slice(1).join(','));
  assert.match(html,/default-src 'none'/);assert.match(html,/kcoder-desktop-startup/);assert.match(html,/正在启动/);
  assert.doesNotMatch(html,/<script|<iframe|http:\/\/|https:\/\//);
  let allowed;f.permission(null,'filesystem',value=>{allowed=value;});assert.equal(allowed,false);assert.equal(f.check(),false);
  for(const url of ['http://127.0.0.1:1234/api/rpc','https://example.invalid/','file:///private']){
    f.requests({url},value=>{allowed=value.cancel;});assert.equal(allowed,true);
  }
  assert.deepEqual(f.window.open({url:'https://example.invalid'}),{action:'deny'});
  let prevented=false;f.window.webContents.emit('will-navigate',{preventDefault(){prevented=true;}});assert.equal(prevented,true);
  f.handle.dispose();assert.equal(f.closed,0);
});

test('user close quits only its startup owner while the normal-window handoff is idempotent', async () => {
  const user=await fixture();user.window.emit('closed');assert.equal(user.closed,1);
  const handoff=await fixture();handoff.handle.dispose();handoff.handle.dispose();assert.equal(handoff.window.destroyed,true);assert.equal(handoff.closed,0);
});

test('a failed startup document remains owned until the parent reports failure and disposes it', async () => {
  const f=await fixture({loadFailure:true});
  await assert.rejects(f.handle.ready,/Owned startup document failed/);
  assert.equal(f.window.isDestroyed(),false);assert.equal(f.closed,0);
  f.handle.dispose();assert.equal(f.window.isDestroyed(),true);assert.equal(f.closed,0);
});

const deferred = () => { let resolve, reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
function sequence(ready, main) {
  let current, quitting=false, starts=0, disposes=0;
  const owned={ready,dispose(){disposes++;}};
  const result=runDesktopStartup({createWindow:()=>owned,publish:value=>{current=value;},clear:value=>{if(current===value)current=null;},isQuitting:()=>quitting,startMain:()=>{starts++;return main;}});
  return {result,owned,get current(){return current;},get starts(){return starts;},get disposes(){return disposes;},cancel(){quitting=true;owned.dispose();current=null;},replace(value){current=value;}};
}

test('closing during document readiness cannot dereference a cleared global or start the main UI', async () => {
  const ready=deferred();const s=sequence(ready.promise,Promise.resolve());s.cancel();ready.resolve();await s.result;
  assert.equal(s.current,null);assert.equal(s.starts,0);
});

test('closing during main startup disposes the captured window and preserves a replacement owner', async () => {
  const main=deferred();const s=sequence(Promise.resolve(),main.promise);await Promise.resolve();assert.equal(s.starts,1);
  s.cancel();const peer={peer:true};s.replace(peer);main.resolve();await s.result;assert.equal(s.current,peer);
});

test('a cancelled main await does not display a startup error while an uncancelled error retains its owner', async () => {
  const pending=deferred();const cancelled=sequence(Promise.resolve(),pending.promise);await Promise.resolve();cancelled.cancel();pending.reject(Error('cancelled'));await cancelled.result;
  const failed=sequence(Promise.resolve(),Promise.reject(Error('original failure')));await assert.rejects(failed.result,/original failure/);assert.equal(failed.current,failed.owned);assert.equal(failed.disposes,0);
});

test('cancellation before spawn creates no Gateway and cancellation during spawn stops only its returned instance', async () => {
  let quitting=true,spawns=0,stops=0;
  const start=()=>{spawns++;return Promise.resolve({stop:async()=>{stops++;}});};
  assert.equal(await startOwnedGateway({start,isQuitting:()=>quitting}),null);assert.equal(spawns,0);
  const pending=deferred();quitting=false;const result=startOwnedGateway({start:()=>pending.promise,isQuitting:()=>quitting});quitting=true;pending.resolve({stop:async()=>{stops++;}});
  assert.equal(await result,null);assert.equal(stops,1);
});
