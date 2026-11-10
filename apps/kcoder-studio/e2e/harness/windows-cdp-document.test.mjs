import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {isCommittedLoopbackDocument,isCommittedStartupDocument,createCdpClient}=createRequire(import.meta.url)('./windows-cdp-document.cjs');
test('CDP can attach after a committed load without enabling Runtime on its initial document',()=>{
  const frame={url:'http://127.0.0.1:1234/',loaderId:'owned'};
  const document={documentURL:frame.url,children:[{nodeType:1,nodeName:'HTML',children:[
    {nodeType:1,nodeName:'BODY',children:[{nodeType:1,nodeName:'DIV',attributes:['id','root']}]},
  ]}]};
  assert.equal(isCommittedLoopbackDocument(frame,document),true);
  assert.equal(isCommittedLoopbackDocument(frame,{...document,documentURL:'about:blank'}),false);
  assert.equal(isCommittedLoopbackDocument({...frame,url:'http://127.0.0.1:5678/'},document),false);
  assert.equal(isCommittedLoopbackDocument(frame,{...document,documentURL:'http://external.invalid/'}),false);
  assert.equal(isCommittedLoopbackDocument(frame,{...document,children:[]}),false);
  assert.equal(isCommittedLoopbackDocument(frame,{...document,children:[{nodeType:1,nodeName:'HTML'}]}),false);
});

test('startup target creation is not document commitment and is checked without Runtime execution',()=>{
  const frame={url:'data:text/html,owned',loaderId:'original'};
  const document={documentURL:frame.url,children:[{nodeType:1,nodeName:'META',attributes:['name','kcoder-desktop-startup','content','restricted']}]};
  assert.equal(isCommittedStartupDocument(frame,document),true);
  assert.equal(isCommittedStartupDocument(frame,{...document,documentURL:'about:blank'}),false);
  assert.equal(isCommittedStartupDocument({...frame,loaderId:undefined},document),false);
  assert.equal(isCommittedStartupDocument(frame,{...document,children:[]}),false);
});

class OwnedSocket extends EventTarget {
  constructor() {super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
  send(value) {this.sent=JSON.parse(value);}
  reply(result,id=this.sent.id) {this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id,result})}));}
  close() {this.dispatchEvent(new Event('close'));}
}
test('startup and main CDP clients correlate replies only on their original socket',async()=>{
  const startup=createCdpClient('ws://owned-startup',{WebSocketType:OwnedSocket});
  const main=createCdpClient('ws://owned-main',{WebSocketType:OwnedSocket});
  await Promise.all([startup.ready,main.ready]);
  let resolved=false;const first=startup.request('Runtime.evaluate').then(value=>{resolved=true;return value;});
  const second=main.request('Page.getFrameTree');main.socket.reply({main:true});await second;assert.equal(resolved,false);
  startup.socket.reply({foreign:true},77);assert.equal(resolved,false);startup.socket.reply({startup:true});assert.deepEqual(await first,{startup:true});
  startup.close();main.close();
});
test('closing a temporary startup CDP client settles only that client pending request',async()=>{
  const startup=createCdpClient('ws://owned-startup',{WebSocketType:OwnedSocket});
  const main=createCdpClient('ws://owned-main',{WebSocketType:OwnedSocket});await Promise.all([startup.ready,main.ready]);
  const rejected=assert.rejects(startup.request('Runtime.evaluate'),/Owned CDP connection closed/);
  const alive=main.request('Runtime.evaluate');startup.close();await rejected;main.socket.reply({alive:true});assert.deepEqual(await alive,{alive:true});main.close();
});
