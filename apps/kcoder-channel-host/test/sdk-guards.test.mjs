import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import { hardenFeishuSdk,hardenDingTalkSdk,hardenWecomSdk,BoundedPlatformEvents,PLATFORM_FRAME_BYTES } from '../src/adapters/sdk-guards.mjs';
import { silentSdkLogger } from '../src/transport.mjs';

test('the exact installed Feishu and DingTalk SDKs expose the required guarded transport hooks',async()=>{
 const lark=await import('@larksuiteoapi/node-sdk');const ding=await import('dingtalk-stream');
 const feishu=new lark.WSClient({appId:'inert-test-app',appSecret:'inert-test-secret',autoReconnect:false,logger:silentSdkLogger});
 hardenFeishuSdk(feishu);feishu.close({force:true});
 const client=new ding.DWClient({clientId:'inert-test-app',clientSecret:'inert-test-secret',debug:false});
 hardenDingTalkSdk(client);assert.equal(client.sslopts.maxPayload,PLATFORM_FRAME_BYTES);assert.equal(client.sslopts.perMessageDeflate,false);
});
test('SDK raw frame guard rejects oversized network input before a message decoder runs',async t=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0,perMessageDeflate:false});await once(server,'listening');
 t.after(()=>new Promise(resolve=>{for(const socket of server.clients)socket.terminate();server.close(resolve);}));
 server.on('connection',socket=>socket.once('message',()=>socket.send(Buffer.alloc(PLATFORM_FRAME_BYTES+1,1))));
 const socket=new WebSocket('ws://127.0.0.1:'+server.address().port);let decoded=0;
 const fake={wsConfig:{setWSInstance(){}},dataCache:{cache:new Map(),mergeData:()=>null}};hardenFeishuSdk(fake);
 socket.on('message',()=>{decoded++;});socket.on('error',()=>{});
 socket.once('open',()=>{fake.wsConfig.setWSInstance(socket);socket.send('ready');});
 await new Promise(resolve=>socket.once('close',resolve));assert.equal(decoded,0);assert.equal(socket._closeCode,1006);
});
test('SDK fragment metadata cannot allocate unbounded arrays or aggregate buffers',()=>{
 let merges=0;const cache=new Map([['partial',{buffer:[Buffer.alloc(PLATFORM_FRAME_BYTES-10)]}]]);
 const fake={wsConfig:{setWSInstance(){}},dataCache:{cache,mergeData:()=>{merges++;}}};hardenFeishuSdk(fake);
 assert.throws(()=>fake.dataCache.mergeData({message_id:'x',sum:100000000,seq:0,data:new Uint8Array(1)}),/PLATFORM_FRAGMENT_INVALID/);
 assert.throws(()=>fake.dataCache.mergeData({message_id:'partial',sum:2,seq:1,data:new Uint8Array(20)}),/PLATFORM_EVENT_TOO_LARGE/);
 assert.equal(merges,0);
});
test('SDK callback work is bounded while a slow durable owner accepts the preceding message',async()=>{
 let release;const events=new BoundedPlatformEvents(1);const current=events.run(()=>new Promise(resolve=>{release=resolve;}));const next=events.run(async()=>2);
 await assert.rejects(events.run(async()=>3),/PLATFORM_EVENT_CAPACITY/);release(1);assert.equal(await current,1);assert.equal(await next,2);events.close();
 await assert.rejects(events.run(async()=>4),/CHANNEL_STOPPED/);
});
test('WeCom cancellation prevents later SDK retry writes while preserving a late original acknowledgement',async()=>{
 let finish,writes=0,late;
 const fake={wsManager:{pendingAcks:new Map(),replyQueues:new Map(),sendReply:()=>{writes++;return new Promise(resolve=>{finish=resolve;});}}};const run=hardenWecomSdk(fake),controller=new AbortController();
 const pending=run(controller.signal,()=>fake.wsManager.sendReply('original',{},'aibot_send_msg'),frame=>{late=frame;});controller.abort();await assert.rejects(pending,/PLATFORM_SEND_CANCELLED/);
 assert.throws(()=>run(controller.signal,()=>fake.wsManager.sendReply('retry',{},'aibot_send_msg')),/abort/i);assert.equal(writes,1);
 finish({headers:{req_id:'original'},errcode:0});await new Promise(resolve=>setImmediate(resolve));assert.equal(late.headers.req_id,'original');
});
test('WeCom upload chunk identity is fenced by its native invocation owner and original content',async()=>{
 let writes=0;const fake={wsManager:{pendingAcks:new Map(),replyQueues:new Map(),sendReply:async()=>{writes++;return {errcode:0};}}};const run=hardenWecomSdk(fake);
 const body={upload_id:'owned-upload',chunk_index:0,base64_data:Buffer.from('owned bytes').toString('base64')};
 assert.throws(()=>fake.wsManager.sendReply('unowned',body,'aibot_upload_media_chunk'),/WECOM_UPLOAD_GUARD_UNAVAILABLE/);
 await run(undefined,async()=>{
  const first=fake.wsManager.sendReply('native-first',body,'aibot_upload_media_chunk');
  assert.equal(fake.wsManager.sendReply('native-retry',body,'aibot_upload_media_chunk'),first);
  assert.throws(()=>fake.wsManager.sendReply('different-content',{...body,base64_data:Buffer.from('different bytes').toString('base64')},'aibot_upload_media_chunk'),/WECOM_UPLOAD_INTENT_CONFLICT/);
  await first;
 });
 assert.equal(writes,1);
 await run(undefined,()=>fake.wsManager.sendReply('explicit-new-native-invocation',body,'aibot_upload_media_chunk'));
 assert.equal(writes,2,'a different explicit native upload owns a separate attempt; Outbox controls whether it is authorized');
});
