import test from 'node:test';
import assert from 'node:assert/strict';
import { WSClient } from '@wecom/aibot-node-sdk';
import { WeComAdapter } from '../src/adapters/sdk.mjs';
import { hardenWecomSdk } from '../src/adapters/sdk-guards.mjs';
import { wecomEvent } from '../src/normalizers.mjs';
import { EphemeralSecretStore,silentSdkLogger } from '../src/transport.mjs';

const scope={accountId:'owned-account',targetId:'owned-target',workspaceId:'owned-workspace',identityGeneration:'1',targetRevision:'1'};
const configuration={botId:'owned-bot',channelId:'channel',tenantId:'owned-corp',replyMode:'stream'};
function packet(id='original-message',text='Summarize this fixture.'){
 return {cmd:'aibot_msg_callback',headers:{req_id:'SYNTHETIC_PRIVATE_REQ_'+id},body:{aibotid:'owned-bot',msgid:id,create_time:Math.floor(Date.now()/1000),msgtype:'text',chattype:'single',from:{userid:'owned-user'},text:{content:text}}};
}
test('private context unknown put ACK is reconciled by the original record and never repeated after an unconfirmed absence',async()=>{
 const values=new Map(),intents=new Map();let puts=0;
 const secrets={async get(ref){if(!values.has(ref)){const error=new Error('PLATFORM_CONTEXT_EXPIRED');error.code='PLATFORM_CONTEXT_EXPIRED';throw error;}return values.get(ref);},async put(ref,value){puts++;values.set(ref,value);throw new Error('owned lost private metadata ACK');}};
 const first=await wecomEvent(configuration,packet(),secrets,{contextIntents:intents});await wecomEvent(configuration,{...packet(),headers:{req_id:'different-redelivery-req'}},secrets,{contextIntents:intents});assert.equal(puts,1);assert.equal(values.get(first.streamReplyRef).reqId,'SYNTHETIC_PRIVATE_REQ_original-message');
 values.clear();await assert.rejects(wecomEvent(configuration,packet(),secrets,{contextIntents:intents}),/STREAM_CONTEXT_UNCONFIRMED/);assert.equal(puts,1);
});
test('actual SDK implicit stream command preserves the late original ACK after cancellation without a second write',async()=>{
 const secrets=new EphemeralSecretStore(),event=await wecomEvent(configuration,packet(),secrets),adapter=new WeComAdapter({configuration,credentials:{secret:'INERT_NO_PLATFORM_ACCOUNT'},secretStore:secrets}),client=new WSClient({botId:'owned-bot',secret:'INERT_NO_PLATFORM_ACCOUNT',logger:silentSdkLogger});let finish,late,writes=0;
 client.wsManager.sendReply=()=>{writes++;return new Promise(resolve=>{finish=resolve;});};adapter.client=client;adapter.withSignal=hardenWecomSdk(client);const controller=new AbortController();
 const pending=adapter.send({destination:{platform:'wecom',channelId:'channel',tenantId:'owned-corp',botId:'owned-bot',conversationId:'owned-user',chatKind:'private',externalSubjectId:'owned-user',replyRef:event.streamReplyRef},content:{text:'Message received.',presentation:{kind:'status',title:'Task progress',wecomStream:{streamId:event.streamId,sequence:1,finish:false}}}},{deliveryId:'owned-first-stream',signal:controller.signal,onLateReceipt:value=>{late=value;}});
 await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,/PLATFORM_SEND_CANCELLED/);finish({headers:{req_id:'SYNTHETIC_PRIVATE_REQ_original-message'},errcode:0});await new Promise(resolve=>setImmediate(resolve));assert.equal(late.state,'accepted');assert.equal(late.sequence,1);assert.equal(late.finish,false);assert.equal(late.streamId,event.streamId);assert.ok(!JSON.stringify(late).includes('SYNTHETIC_PRIVATE_REQ_'));assert.equal(writes,1);await adapter.stop();
});
test('a missing real protected context provider refuses normalization instead of constructing an in-memory production context',async()=>{
 let puts=0;await assert.rejects(wecomEvent(configuration,packet(),{async get(){const error=new Error('PRIVATE_PROVIDER_UNAVAILABLE');error.code='PRIVATE_PROVIDER_UNAVAILABLE';throw error;},async put(){puts++;}}),/PRIVATE_PROVIDER_UNAVAILABLE/);assert.equal(puts,0);
});
