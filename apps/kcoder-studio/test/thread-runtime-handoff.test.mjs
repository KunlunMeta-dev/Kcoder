import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { ThreadRuntimeHandoffClient, THREAD_RUNTIME_HANDOFF_CAPABILITY as CAP,
  THREAD_RUNTIME_HANDOFF_READ as READ, THREAD_RUNTIME_HANDOFF_RELEASE as RELEASE,
  confirmsReleasedThreadRuntime } from '../shared/threadRuntimeHandoff.mjs';
const params={threadId:'thread',operationId:'release-once',expectedServerId:'native-server',expectedOwnerRef:'original-owner',expectedClientTurnCount:0};
const snapshot={serverId:'native-server',threadId:'thread',ownerRef:null,clientTurnCount:null,releasable:false};
const receipt={serverId:'native-server',threadId:'thread',operationId:'release-once',ownerRef:'original-owner',status:'released'};
const released={snapshot,receipt};
test('one explicit release keeps its original identity and never retries a lost response',async()=>{
  const calls=[];
  const client=new ThreadRuntimeHandoffClient({supported:()=>true,ownerStamp:()=>1,
    request:async(method,body)=>{calls.push({method,body});throw Error('connection closed after write');}});
  await assert.rejects(client.release(params),error=>error.outcome==='unknown');
  assert.deepEqual(calls,[{method:RELEASE,body:params}]);
});
test('the dispatched intent is not changed by a newer caller selection',async()=>{
  let settle,sent;
  const client=new ThreadRuntimeHandoffClient({supported:()=>true,ownerStamp:()=>1,
    request:async(method,body)=>{sent=body;return new Promise(resolve=>{settle=resolve;});}});
  const selection={...params},pending=client.release(selection);
  selection.threadId='different-task';selection.expectedOwnerRef='different-owner';
  settle(released);
  assert.equal((await pending).receipt.status,'released');
  assert.deepEqual(sent,params);
});
test('unknown release is reconciled by a read; a changed connection cannot certify the previous response',async()=>{
  let stamp=1,settle;
  const calls=[];
  const client=new ThreadRuntimeHandoffClient({supported:()=>true,ownerStamp:()=>stamp,
    request:(method,body)=>{calls.push({method,body});return new Promise(resolve=>{settle=resolve;});}});
  const pending=client.release(params);stamp=2;settle(released);
  await assert.rejects(pending,error=>error.outcome==='unknown'&&error.message==='THREAD_HANDOFF_OWNER_CHANGED');
  const query=client.observe('thread','release-once');
  settle({snapshot,operation:receipt});
  assert.equal((await query).operation.status,'released');
  assert.deepEqual(calls.map(c=>c.method),[RELEASE,READ]);
});
test('unsupported targets and untrusted fields fail before dispatch; a new owner is not cleared by an old receipt',async()=>{
  let calls=0;
  const transport={supported:()=>false,ownerStamp:()=>1,request:async()=>{calls++;return released;}};
  const client=new ThreadRuntimeHandoffClient(transport);
  await assert.rejects(client.release(params),error=>error.outcome==='not_sent');
  transport.supported=()=>true;
  await assert.rejects(client.release({...params,approved:true}),error=>error.outcome==='not_sent');
  assert.equal(calls,0);
  assert.equal(confirmsReleasedThreadRuntime(params,released),true);
  assert.equal(confirmsReleasedThreadRuntime(params,{...released,snapshot:{...snapshot,ownerRef:'new-owner',clientTurnCount:0,releasable:true}}),false);
});

function fixture() {
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const broker=new WorkspaceAppServerBroker({child,adapter:{rawPassthrough:true,
    toUpstream:message=>({upstream:[message],client:[]}),fromUpstream:message=>({upstream:[],client:[message]})},
    maxMessageBytes:1024*1024,serverId:'handoff-broker',residentThreads:true});
  const sent=[];let buffer='';
  child.stdin.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\n');if(end<0)break;sent.push(JSON.parse(buffer.slice(0,end)));buffer=buffer.slice(end+1);}});
  const response=async(id,result)=>{child.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');await new Promise(setImmediate);};
  const request=async(client,method,body,id=method)=>{broker.receive(client,JSON.stringify({jsonrpc:'2.0',id,method,params:body}));await new Promise(setImmediate);return sent.at(-1);};
  const client=()=>{const c={channel:'runtime',authorizationOwner:'same-account',messages:[],send(m){this.messages.push(m);return true;},pause(){},resume(){},close(){}};broker.attach(c);return c;};
  const init=async(c,offer)=>{
    const previous=sent.length;
    const r=await request(c,'initialize',{protocolVersion:'2026-07-27',capabilities:{experimental:{[CAP]:offer,gatewaySharedThreadsV1:true}},clientInfo:{name:'handoff',version:'1'}},'init');
    if(sent.length>previous)await response(r.id,{protocolVersion:'2026-07-27',serverInfo:{name:'native',version:'1'},capabilities:{experimental:{residentThreads:true,[CAP]:true}}});
  };
  return {broker,sent,response,request,client,init};
}
test('Gateway freezes each caller offer and refuses unnegotiated or foreign release requests',async()=>{
  const f=fixture();try {
    const owner=f.client(),legacy=f.client();await f.init(owner,true);await f.init(legacy,false);
    assert.equal(owner[CAP],true);assert.equal(legacy[CAP],false);
    assert.equal(legacy.messages.at(-1).result.capabilities.experimental[CAP],false);
    f.broker.threadOwners.set('thread',owner);
    let before=f.sent.length;await f.request(legacy,RELEASE,params);assert.equal(f.sent.length,before);
    assert.ok(legacy.messages.at(-1).error);
    const peer=f.client();await f.init(peer,true);
    before=f.sent.length;await f.request(peer,RELEASE,params);assert.equal(f.sent.length,before);
    assert.ok(peer.messages.at(-1).error);
    assert.equal(f.broker.threadOwners.get('thread'),owner);
  }finally{f.broker.clearTransientState();}
});
test('Gateway retains a fresh runtime on receipt replay, and refuses release while another device shares the task',async()=>{
  const f=fixture();try {
    const owner=f.client(),peer=f.client();await f.init(owner,true);await f.init(peer,true);
    f.broker.threadOwners.set('thread',owner);f.broker.sharedThreads.join('thread',owner);
    let r=await f.request(owner,RELEASE,params,'release-first');await f.response(r.id,released);
    assert.equal(f.broker.threadOwners.has('thread'),false);
    f.broker.threadOwners.set('thread',owner);f.broker.sharedThreads.join('thread',owner);
    r=await f.request(owner,RELEASE,params,'release-replayed');
    await f.response(r.id,{...released,snapshot:{...snapshot,ownerRef:'fresh-owner',clientTurnCount:0,releasable:true}});
    assert.equal(f.broker.threadOwners.get('thread'),owner);
    f.broker.sharedThreads.join('thread',peer);
    const before=f.sent.length;await f.request(owner,RELEASE,{...params,operationId:'fresh-release',expectedOwnerRef:'fresh-owner'},'shared-release');
    assert.equal(f.sent.length,before);assert.ok(owner.messages.at(-1).error);
    assert.equal(f.broker.sharedThreads.has('thread',peer),true);
  }finally{f.broker.clearTransientState();}
});
