import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WeixinAdapter } from '../src/adapters/weixin.mjs';

const credentials={botToken:'SYNTHETIC_OWNED_TOKEN'};
const configuration={accountId:'owned-account',channelId:'owned-channel'};
const waitForStop=signal=>new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});

test('Weixin startup and shutdown notify the official lifecycle endpoints once',async t=>{
 const paths=[];let polls=0;
 const adapter=new WeixinAdapter({configuration,credentials,transport:async(url,{signal})=>{
  const path=new URL(url).pathname;paths.push(path);
  if(path.endsWith('/notifystart')||path.endsWith('/notifystop'))return {ret:0};
  if(++polls===1)return {ret:0};return waitForStop(signal);
 }});t.after(()=>adapter.stop());
 await adapter.start(async()=>{});
 assert.equal(paths[0],'/ilink/bot/msg/notifystart');
 assert.equal(adapter.connectionState(),'connected');
 await adapter.stop();await adapter.stop();
 assert.equal(paths.filter(path=>path.endsWith('/notifystart')).length,1);
 assert.equal(paths.filter(path=>path.endsWith('/notifystop')).length,1);
});

test('expected empty long-poll timeouts preserve the cursor and do not exhaust reconnection',async t=>{
 let polls=0,healthy;const ready=new Promise(resolve=>{healthy=resolve;});let writes=0;
 const adapter=new WeixinAdapter({configuration,credentials,checkpoint:{load:async()=>'original-cursor',save:async()=>{writes++;}},transport:async(url,{signal,body})=>{
  if(!url.endsWith('/getupdates'))return {ret:0};polls++;
  assert.equal(body.get_updates_buf,'original-cursor');
  if(polls===1)return {ret:0};
  if(polls<=6)throw new DOMException('Synthetic timeout; never expose upstream private details','TimeoutError');
  healthy();return waitForStop(signal);
 }});t.after(()=>adapter.stop());await adapter.start(async()=>{});
 await Promise.race([ready,adapter.loop,delay(8000)]);
 assert.equal(polls,7);assert.equal(writes,0);assert.equal(adapter.cursor,'original-cursor');
 assert.equal(adapter.connectionState(),'connected');
});

test('a timed-out first authenticated poll does not mark Weixin connected',async t=>{
 const states=[];
 const adapter=new WeixinAdapter({configuration,credentials,transport:async url=>{
  if(url.endsWith('/getupdates'))throw new DOMException('Owned initial poll timeout','TimeoutError');
  return {ret:0};
 }});t.after(()=>adapter.stop());
 adapter.setConnectionObserver(()=>states.push(adapter.connectionState()));
 await assert.rejects(adapter.start(async()=>{}),{name:'TimeoutError'});
 assert.deepEqual(states,['starting','degraded']);
 assert.equal(adapter.connectionFailureReason(),'WEIXIN_POLL_FAILED');
});

test('Weixin session expiry is authorization loss and never an automatic reconnect',async t=>{
 let polls=0;const adapter=new WeixinAdapter({configuration,credentials,transport:async url=>url.endsWith('/getupdates')?(++polls===1?{ret:0}:{ret:-14,errmsg:'SYNTHETIC_PRIVATE_RESPONSE'}):{ret:0}});
 t.after(()=>adapter.stop());await adapter.start(async()=>{});await adapter.loop;
 assert.equal(adapter.connectionState(),'authorization_required');
 await assert.rejects(adapter.reconnect(),/CHANNEL_STOPPED/);
});

test('an unavailable optional Weixin start notification does not block authenticated receive startup',async t=>{
 let polls=0;const paths=[];
 const adapter=new WeixinAdapter({configuration,credentials,transport:async(url,{signal})=>{
  const path=new URL(url).pathname;paths.push(path);
  if(path.endsWith('/notifystart'))throw new Error('SYNTHETIC_LIFECYCLE_ENDPOINT_UNAVAILABLE');
  if(path.endsWith('/notifystop'))return {ret:0};
  if(++polls===1)return {ret:0};return waitForStop(signal);
 }});t.after(()=>adapter.stop());await adapter.start(async()=>{});assert.equal(adapter.connectionState(),'connected');assert.equal(polls,2);assert.equal(paths[0],'/ilink/bot/msg/notifystart');
});

test('ignoring a Weixin lifecycle failure never bypasses getUpdates authorization rejection',async()=>{
 const adapter=new WeixinAdapter({configuration,credentials,transport:async url=>{
  if(url.endsWith('/notifystart'))throw new Error('SYNTHETIC_OPTIONAL_ENDPOINT_FAILURE');
  return url.endsWith('/getupdates')?{ret:-14}:{ret:0};
 }});
 await assert.rejects(adapter.start(async()=>{}),/PLATFORM_AUTHORIZATION_FAILED/);assert.equal(adapter.connectionState(),'authorization_required');await adapter.stop();
});

test('Weixin explicit business rejection is a failed effect without exposing private upstream details',async()=>{
 for(const ret of [-14,1234]){
  const adapter=new WeixinAdapter({configuration,credentials,transport:async()=>({ret,errmsg:'SYNTHETIC_PRIVATE_DETAIL'})});
  await assert.rejects(adapter.post('ilink/bot/sendmessage',{},undefined),error=>{assert.equal(error.externalOutcome,'failed');assert.ok(!error.message.includes('SYNTHETIC_PRIVATE_DETAIL'));return true;});
 }
});

test('malformed Weixin rejection fields remain unknown and cannot authorize a resend',async()=>{
 for(const response of [{ret:'-14'},{ret:null},{errcode:'0'},{ret:0.5},{ret:-14,errcode:'invalid'},null,[]]){
  let calls=0;const adapter=new WeixinAdapter({configuration,credentials,transport:async()=>{calls++;return response;}});
  await assert.rejects(adapter.post('ilink/bot/sendmessage',{},undefined),error=>{assert.equal(error.code,'PLATFORM_INVALID_JSON');assert.equal(error.externalOutcome,undefined);return true;});assert.equal(calls,1);
 }
});
