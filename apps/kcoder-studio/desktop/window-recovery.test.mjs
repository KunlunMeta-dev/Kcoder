import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshGatewayWindows,restoreGatewayLoginPages}from './window-recovery.mjs';
import {createDesktopGatewayOwner}from './gateway-owner.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function view(url,{loadURL=async()=>{},executeJavaScript=async()=>{}}={}){return{isDestroyed:()=>false,webContents:{getURL:()=>url,executeJavaScript},loadURL};}
test('a held login view cannot prevent peer restoration and returnTo stays same-origin',async()=>{
 const held=deferred(),calls=[];
 const first=view('http://127.0.0.1:4321/login',{loadURL:()=>held.promise});
 const peer=view('http://127.0.0.1:4321/login?returnTo=https://outside.invalid',{loadURL:async url=>calls.push(url)});
 const operation=restoreGatewayLoginPages({windows:[first,peer],origin:'http://127.0.0.1:4321'});
 await Promise.resolve();assert.deepEqual(calls,['http://127.0.0.1:4321/']);held.resolve();await operation;
});
test('all owned views move to a new origin while same-origin restarts retain in-memory drafts',async()=>{
 const calls=[],first=view('http://127.0.0.1:4321/chat?a=b#owned',{loadURL:async url=>calls.push(url)});
 const peer=view('http://127.0.0.1:4321/settings',{loadURL:async url=>calls.push(url)});
 await refreshGatewayWindows({windows:[first,peer],previousOrigin:'http://127.0.0.1:4321',baseUrl:'http://127.0.0.1:4322',warn:assert.fail});
 assert.deepEqual(calls,['http://127.0.0.1:4322/chat?a=b#owned','http://127.0.0.1:4322/settings']);
 let signals=0;await refreshGatewayWindows({windows:[view('http://127.0.0.1:4321/chat',{executeJavaScript:async()=>{signals++;}})],previousOrigin:'http://127.0.0.1:4321',baseUrl:'http://127.0.0.1:4321',warn:assert.fail});assert.equal(signals,1);
});
test('gateway ownership joins the pending original cleanup and retains an unknown stop receipt',async()=>{
 const started=deferred(),exit=deferred(),cleanup=deferred();let calls=0;
 const owner=createDesktopGatewayOwner({start:()=>started.promise,signal:new AbortController().signal,isQuitting:()=>false});
 const admission=owner.start({});admission.catch(()=>{});await Promise.resolve();const stop=owner.stop();assert.equal(owner.stop(),stop);
 started.resolve({exit:exit.promise,stop(){calls++;return cleanup.promise;}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,1);cleanup.reject(Error('owned cleanup unknown'));await assert.rejects(stop,{code:'DESKTOP_GATEWAY_STOP_UNCONFIRMED'});await assert.rejects(admission,/owned cleanup unknown/);assert.equal(calls,1);assert.equal(await owner.start({}),null);
});
