import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { recoveryAdapter,clients } from './fixtures/recovery-adapters.mjs';

async function waitFor(check,message='bounded fixture condition'){for(let n=0;n<400;n++){const value=await check();if(value)return value;await delay(5);}assert.fail(message);}
async function endpoint(t,platform,{register=true}={}){
 let server,root,ca;
 if(platform==='dingtalk'){
  root=mkdtempSync(join(tmpdir(),'kcoder-owned-sdk-tls-'));ca=join(root,'certificate.pem');const key=join(root,'private-key.pem');
  const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',ca,'-days','1','-subj','/CN=fixture.dingtalk.com','-addext','subjectAltName=DNS:fixture.dingtalk.com'],{stdio:'ignore'});assert.equal(generated.status,0,'owned fixture TLS certificate');
  server=createServer({key:readFileSync(key),cert:readFileSync(ca)});server.listen(0,'127.0.0.1');await once(server,'listening');
 }
 const sockets=[],ws=server?new WebSocketServer({server}):new WebSocketServer({host:'127.0.0.1',port:0});if(!server)await once(ws,'listening');
 ws.on('connection',socket=>{sockets.push(socket);if(platform==='dingtalk'&&register)socket.send(JSON.stringify({type:'SYSTEM',headers:{topic:'REGISTERED',messageId:'owned-registration'},data:'{}'}));});
 t.after(async()=>{for(const socket of ws.clients)socket.terminate();await new Promise(resolve=>ws.close(resolve));if(server)await new Promise(resolve=>server.close(resolve));if(root)rmSync(root,{recursive:true,force:true});});
 const address=(server??ws).address();return {ws,sockets,configuration:platform==='feishu'?{appId:'cli_0123456789abcdef',channelId:'channel',fixtureEndpoint:'ws://127.0.0.1:'+address.port+'/?device_id=owned-device&service_id=1'}:{clientId:'owned-client',channelId:'channel',fixtureEndpoint:'wss://fixture.dingtalk.com:'+address.port,fixtureCa:ca}};
}
test('actual Feishu SDK start waits for onReady and real socket loss is observed before explicit bounded recovery',async t=>{
 let cursor='';const checkpoint={load:async()=>cursor,save:async value=>{cursor=value;}};
 const target=await endpoint(t,'feishu'),events=[],adapter=recoveryAdapter('feishu',{configuration:target.configuration,credentials:{appSecret:'INERT_NO_PLATFORM_ACCOUNT'},checkpoint});t.after(()=>adapter.stop());let changes=0;adapter.setConnectionObserver(()=>{changes++;});
 const started=adapter.start(async event=>{events.push(event);});assert.equal(adapter.connectionState(),'degraded');await started;assert.equal(adapter.connectionState(),'connected');
 const original=clients.at(-1);target.sockets[0].terminate();await waitFor(()=>adapter.connectionState()==='degraded');assert.ok(changes>0);
 await adapter.reconnect();assert.equal(adapter.connectionState(),'connected');assert.notEqual(clients.at(-1),original);assert.equal(target.sockets.length,2);assert.equal(original.getConnectionStatus().state,'idle');
 await assert.rejects(original.eventDispatcher.invoke({schema:'2.0',header:{event_type:'im.message.receive_v1',event_id:'old-sdk-event'},event:{sender:{sender_type:'user',sender_id:{open_id:'owned-user'}},message:{message_id:'old-sdk-event',chat_id:'owned-chat',chat_type:'p2p',message_type:'text',content:'{"text":"stale"}'}}}),/STALE_PLATFORM_SOURCE/);assert.equal(events.length,0);
});
test('actual DingTalk SDK needs REGISTERED and fences the old client after a real TLS socket reconnect',async t=>{
 const target=await endpoint(t,'dingtalk',{register:false}),events=[],adapter=recoveryAdapter('dingtalk',{configuration:target.configuration,credentials:{clientSecret:'INERT_NO_PLATFORM_ACCOUNT'}});t.after(()=>adapter.stop());
 let completed=false;const starting=adapter.start(async event=>{events.push(event);}).then(()=>{completed=true;});await waitFor(()=>target.sockets.length===1);assert.equal(completed,false);assert.equal(adapter.connectionState(),'degraded');
 target.sockets[0].send(JSON.stringify({type:'SYSTEM',headers:{topic:'REGISTERED'},data:'{}'}));await starting;assert.equal(adapter.connectionState(),'connected');const original=clients.at(-1);
 target.sockets[0].terminate();await waitFor(()=>adapter.connectionState()==='degraded');const recovering=adapter.reconnect();await waitFor(()=>target.sockets.length===2);target.sockets[1].send(JSON.stringify({type:'SYSTEM',headers:{topic:'REGISTERED'},data:'{}'}));await recovering;
 original.emit('/v1.0/im/bot/messages/get',{headers:{messageId:'old-sdk-event'},data:JSON.stringify({msgId:'old-sdk-event',senderStaffId:'owned-user',conversationId:'owned-chat',conversationType:'1',text:{content:'stale'}})});await delay(5);assert.equal(events.length,0);assert.equal(adapter.connectionState(),'connected');
});
