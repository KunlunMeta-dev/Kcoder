import test from 'node:test';
import assert from 'node:assert/strict';
import { WSClient } from '@wecom/aibot-node-sdk';
import { WeComAdapter } from '../src/adapters/sdk.mjs';

function fixture({authenticate=true}={}){
 const clients=[];
 class Client extends WSClient {
  constructor(options){super(options);this.observedOptions=options;this.disconnects=0;clients.push(this);}
  connect(){if(authenticate)queueMicrotask(()=>this.emit('authenticated'));}
  disconnect(){this.disconnects++;this.emit('disconnected','owned offline fixture');}
 }
 return {clients,adapter:new WeComAdapter({configuration:{botId:'owned-bot',channelId:'owned-channel'},credentials:{secret:'SYNTHETIC_NOT_AN_ACCOUNT'},sdk:{WSClient:Client}})};
}

test('WeCom connection loss is observable and native reconnect uses a fresh guarded SDK owner',async t=>{
 const {adapter,clients}=fixture();t.after(()=>adapter.stop());await adapter.start(async()=>{});
 assert.equal(adapter.connectionState(),'connected');assert.equal(clients[0].observedOptions.maxReconnectAttempts,0);assert.equal(clients[0].observedOptions.maxAuthFailureAttempts,0);
 clients[0].emit('disconnected','fixture dropped');assert.equal(adapter.connectionState(),'degraded');assert.equal(clients.length,1);
 await adapter.reconnect();assert.equal(adapter.connectionState(),'connected');assert.equal(clients.length,2);assert.equal(clients[0].disconnects,1);
 clients[0].emit('error',{code:'WS_AUTH_FAILURE_EXHAUSTED'});assert.equal(adapter.connectionState(),'connected');
 await adapter.stop();assert.equal(adapter.connectionState(),'stopped');await assert.rejects(adapter.reconnect(),/CHANNEL_STOPPED/);
});

test('WeCom credential rejection stays authorization-required and is not repaired by a reconnect',async t=>{
 const {adapter,clients}=fixture();t.after(()=>adapter.stop());await adapter.start(async()=>{});
 clients[0].emit('error',{code:'WS_AUTH_FAILURE_EXHAUSTED'});clients[0].emit('disconnected','fixture auth failed');assert.equal(adapter.connectionState(),'authorization_required');await assert.rejects(adapter.reconnect(),/CHANNEL_STOPPED/);
});

test('WeCom cancelled startup closes only its owned client and ignores late authentication',async()=>{
 const {adapter,clients}=fixture({authenticate:false});const controller=new AbortController();
 const starting=adapter.start(async()=>{},{signal:controller.signal});controller.abort();await assert.rejects(starting,/PLATFORM_CONNECT_CANCELLED/);assert.equal(clients[0].disconnects,1);clients[0].emit('authenticated');assert.notEqual(adapter.connectionState(),'connected');await adapter.stop();
});

test('WeCom reconnect admission signal expires independently of the connected SDK lifetime',async t=>{
 const {adapter,clients}=fixture();t.after(()=>adapter.stop());const admission=new AbortController();await adapter.start(async()=>{},{signal:admission.signal});admission.abort();
 clients[0].emit('disconnected','owned later close');assert.equal(adapter.connectionState(),'degraded');
});
