import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { QQGateway } from '../src/adapters/qq-sdk.mjs';
import { QQAdapter } from '../src/adapters/qq.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate) { for (let n=0;n<500;n++) { if(predicate())return; await new Promise(resolve=>setTimeout(resolve,2)); } throw new Error('fixture deadline'); }
function fixture({replay=[]}={}){
 const sockets=[],requests=[];
 class Socket extends EventEmitter {
  constructor(url,options){super();this.url=url;this.options=options;this.readyState=1;this._receiver={_maxPayload:1024*1024};this.writes=[];sockets.push(this);queueMicrotask(()=>this.packet({op:10,d:{heartbeat_interval:1000}}));}
  packet(value){this.emit('message',Buffer.from(JSON.stringify(value)));}
  send(raw){
   const packet=JSON.parse(raw);this.writes.push(packet);
   if(packet.op===2)queueMicrotask(()=>this.packet({op:0,t:'READY',s:1,d:{session_id:'owned-session'}}));
   if(packet.op===6)queueMicrotask(()=>{
    for(const event of replay)this.packet(event);
    this.packet({op:0,t:'RESUMED',s:2+replay.length,d:{}});
   });
  }
  close(code=1000){if(this.readyState===3)return;this.readyState=3;this.emit('close',code);}
  terminate(){this.close(1006);}
 }
 class Gateway extends QQGateway {
  constructor(options){super({...options,reconnect:{delays:[10]}});}
  openSocket(url,token){
   const socket=new Socket(url);this.currentWs=socket;this.guardSocket(socket);
   socket.on('message',raw=>this.handlePayload(socket,JSON.parse(raw),token));
   socket.on('close',code=>{if(this.currentWs===socket)this.handleClose(code,'fixture');});
  }
 }
 const adapter=new QQAdapter({configuration:{appId:'owned-app',channelId:'owned-qq'},credentials:{appSecret:'SYNTHETIC_NOT_A_PLATFORM_ACCOUNT'},GatewayClass:Gateway,transport:async(url,args)=>{requests.push({url,args});return url.includes('getAppAccessToken')?{access_token:'synthetic-access',expires_in:3600}:{url:'wss://api.sgroup.qq.com/owned-gateway'};}});
 return {adapter,sockets,requests};
}

test('the SDK owns QQ reconnect and resumes without a second worker reconnect loop',async t=>{
 const {adapter,sockets}=fixture();t.after(()=>adapter.stop());const states=[];adapter.setConnectionObserver(()=>states.push(adapter.connectionState()));
 await adapter.start(async()=>{});assert.equal(adapter.connectionState(),'connected');assert.equal(sockets[0].writes[0].op,2);
 sockets[0].close(1006);await flush();assert.equal(adapter.connectionState(),'starting');assert.equal(sockets.length,1);
 await until(()=>sockets.length===2&&adapter.connectionState()==='connected');assert.equal(adapter.connectionState(),'connected');assert.equal(sockets.length,2);assert.equal(sockets[1].writes[0].op,6);assert.equal(sockets[1].writes[0].d.seq,1);
 sockets[0].emit('close',4004);assert.equal(adapter.connectionState(),'connected');
 await adapter.stop();assert.equal(adapter.connectionState(),'stopped');assert.equal(adapter.reconnect,undefined);assert.ok(states.includes('starting'));
});

test('QQ private reply stops at four sends while group replies allow five',async t=>{
 const {adapter,requests}=fixture();t.after(()=>adapter.stop());
 const destination={chatKind:'private',conversationId:'owned-user',replyMessageId:'original',replyExpiresAt:Date.now()+60000,replySequence:5};
 await assert.rejects(adapter.send({destination,content:{text:'Out of budget'}},{}),/QQ_REPLY_LIMIT_REACHED/);
 assert.equal(requests.length,0);
 assert.doesNotThrow(()=>adapter.validateDestination({...destination,replySequence:4}));
 assert.doesNotThrow(()=>adapter.validateDestination({...destination,chatKind:'group'}));
});

test('an expired original QQ message fails before network effects and cannot gain a fresh reply window',async t=>{
 const {adapter,requests}=fixture();t.after(()=>adapter.stop());
 await assert.rejects(adapter.send({destination:{chatKind:'private',conversationId:'owned-user',replyMessageId:'old',replyExpiresAt:Date.now()-1,replySequence:1},content:{text:'expired'}},{}),error=>{
  assert.equal(error.code,'QQ_PASSIVE_REPLY_EXPIRED');assert.equal(error.externalOutcome,'failed');return true;
 });
 assert.equal(requests.length,0);
});

test('QQ consumes replayed private messages before marking the resumed connection ready',async t=>{
 const replay=[{op:0,t:'C2C_MESSAGE_CREATE',s:2,d:{id:'missed-message',author:{user_openid:'owned-user'},content:'missed text'}}];
 const {adapter,sockets}=fixture({replay});t.after(()=>adapter.stop());
 let release;
 const accepted=new Promise(resolve=>{release=resolve;});
 const seen=[];
 await adapter.start(async event=>{seen.push(event.eventId);await accepted;});
 sockets[0].close(1006);
 await until(()=>seen.length===1);
 assert.deepEqual(seen,['missed-message']);
 assert.equal(adapter.connectionState(),'starting');
 assert.equal(adapter.gateway.lastSeq,1);
 release();
 await until(()=>adapter.connectionState()==='connected');
 assert.equal(adapter.connectionState(),'connected');
 assert.equal(adapter.gateway.lastSeq,3);
});

test('QQ does not advance its resume sequence past an unaccepted replayed message',async t=>{
 const replay=['first-missed','second-missed'].map((id,index)=>({op:0,t:'C2C_MESSAGE_CREATE',s:2+index,d:{id,author:{user_openid:'owned-user'},content:'missed text'}}));
 const {adapter,sockets}=fixture({replay});t.after(()=>adapter.stop());
 const seen=[];
 await adapter.start(async event=>{seen.push(event.eventId);throw new Error('inbox unavailable');});
 sockets[0].close(1006);
 await until(()=>seen.length===1);
 await flush();
 assert.deepEqual(seen,['first-missed']);
 assert.equal(adapter.gateway.lastSeq,1);
 assert.equal(adapter.connectionState(),'starting');
});

test('SDK invalid-session handling resets identity; fatal platform closes end the owned loop',async t=>{
 const {adapter,sockets}=fixture();t.after(()=>adapter.stop());await adapter.start(async()=>{});
 sockets[0].packet({op:9,d:false});await flush();assert.equal(adapter.gateway.sessionId,null);
 await adapter.stop();assert.equal(adapter.connectionState(),'stopped');
 const second=fixture();t.after(()=>second.adapter.stop());await second.adapter.start(async()=>{});
 second.sockets[0].close(4915);await second.adapter.loop;assert.equal(second.adapter.connectionState(),'failed');
});

test('QQ missing heartbeat acknowledgements closes a dead gateway without starting another connection',async t=>{
 t.mock.timers.enable({apis:['setInterval']});const {adapter,sockets}=fixture();t.after(()=>adapter.stop());await adapter.start(async()=>{});
 t.mock.timers.tick(1000);assert.equal(sockets[0].writes.at(-1).op,1);
 sockets[0].packet({op:11});await flush();t.mock.timers.tick(1000);assert.equal(adapter.connectionState(),'connected');
 t.mock.timers.tick(1000);assert.equal(adapter.connectionState(),'starting');assert.equal(sockets.length,1);
});

test('QQ stop during startup refuses a late gateway response without creating a socket',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});let sockets=0;
 class Gateway extends QQGateway {openSocket(){sockets++;}}
 const adapter=new QQAdapter({configuration:{appId:'owned'},credentials:{appSecret:'SYNTHETIC'},GatewayClass:Gateway,
  transport:async url=>url.includes('getAppAccessToken')?{access_token:'synthetic',expires_in:3600}:pending});
 const starting=adapter.start(async()=>{});void starting.catch(()=>{});await flush();
 const stopping=adapter.stop();release({url:'wss://api.sgroup.qq.com/owned'});
 await stopping;await assert.rejects(starting);assert.equal(sockets,0);assert.equal(adapter.connectionState(),'stopped');
});

test('QQ reconnect admission timeout does not become the healthy socket lifetime',async t=>{
 const {adapter,sockets}=fixture();t.after(()=>adapter.stop());const admission=new AbortController();await adapter.start(async()=>{},{signal:admission.signal});admission.abort();
 assert.equal(adapter.connectionState(),'connected');assert.equal(sockets[0].readyState,1);sockets[0].close(1006);assert.equal(adapter.connectionState(),'starting');
});

test('QQ explicit API rejection is failed while a missing send receipt stays unknown',async()=>{
 for(const [response,failed] of [[{code:22009,message:'SYNTHETIC_PRIVATE_DETAIL'},true],[{},false]]){
  let sends=0;const adapter=new QQAdapter({configuration:{appId:'owned'},credentials:{appSecret:'SYNTHETIC'},transport:async url=>url.includes('getAppAccessToken')?{access_token:'synthetic',expires_in:3600}:(sends++,response)});
  await assert.rejects(adapter.send({destination:{chatKind:'private',conversationId:'owned-user',replyMessageId:'original',replySequence:1,replyExpiresAt:Date.now()+60000},content:{text:'owned fixture'}},{}),error=>{assert.equal(error.externalOutcome==='failed',failed);assert.ok(!error.message.includes('SYNTHETIC_PRIVATE_DETAIL'));return true;});assert.equal(sends,1);
 }
});

test('QQ startup deadline reports a timeout and closes its owned SDK loop', async t => {
 t.mock.timers.enable({apis:['setTimeout']});
 class WaitingGateway {
  constructor(options){this.signal=options.abortSignal;}
  start(){return new Promise(resolve=>this.signal.addEventListener('abort',resolve,{once:true}));}
 }
 const adapter=new QQAdapter({configuration:{appId:'fixture'},credentials:{appSecret:'fixture'},GatewayClass:WaitingGateway});
 t.after(()=>adapter.stop());const starting=adapter.start(async()=>{});void starting.catch(()=>{});
 t.mock.timers.tick(15000);
 await assert.rejects(starting,error=>error.code==='PLATFORM_CONNECT_TIMEOUT');
 await adapter.stop();assert.equal(adapter.connectionState(),'stopped');
});
