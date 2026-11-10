import test from 'node:test';
import assert from 'node:assert/strict';
import { WSClient } from '@wecom/aibot-node-sdk';
import { WeComAdapter } from '../src/adapters/sdk.mjs';
import { hardenWecomSdk } from '../src/adapters/sdk-guards.mjs';
import { wecomCardActionEvent } from '../src/normalizers.mjs';
import { EphemeralSecretStore,silentSdkLogger } from '../src/transport.mjs';
import { ChannelError } from '../src/errors.mjs';

const scope={accountId:'owned-fixture',targetId:'owned-target',workspaceId:'owned-workspace',identityGeneration:'1',targetRevision:'1'};
const configuration={channelId:'channel',botId:'owned-bot',tenantId:'owned-corp'};
const event={platform:'wecom',channelId:'channel',channelInstanceId:'owned-sdk',tenantId:'owned-corp',botId:'owned-bot',eventId:'owned-message',senderId:'owned-user',conversationId:'owned-user',chatKind:'private',kind:'message',text:'Summarize this fixture.',attachments:[]};
function adapterFixture({failUpdate=false}={}){
 const secrets=new EphemeralSecretStore(),writes=[],adapter=new WeComAdapter({configuration,credentials:{secret:'INERT_NO_PLATFORM_ACCOUNT'},secretStore:secrets});
 const client=new WSClient({botId:configuration.botId,secret:'INERT_NO_PLATFORM_ACCOUNT',logger:silentSdkLogger});
 client.wsManager.sendReply=async(reqId,body,cmd)=>{writes.push({reqId,body,cmd});if(failUpdate&&cmd==='aibot_respond_update_msg')throw new Error('owned lost card update acknowledgement');return {headers:{req_id:reqId},errcode:0};};
 adapter.client=client;adapter.withSignal=hardenWecomSdk(client);return {adapter,secrets,writes};
}
function packet(ref,taskId,{id='owned-click',sender='owned-user',task=taskId,created=Math.floor(Date.now()/1000)}={}){
 return {cmd:'aibot_event_callback',headers:{req_id:'SYNTHETIC_PRIVATE_CALLBACK_'+id},body:{msgtype:'event',msgid:id,aibotid:'owned-bot',chattype:'single',from:{userid:sender},create_time:created,event:{eventtype:'template_card_event',event_key:ref,task_id:task}}};
}
test('callback window is measured from actual arrival and event creation, not from queue execution or redelivery',async()=>{
 const secrets=new EphemeralSecretStore();const fresh=packet('owned-action','owned-card');
 await assert.rejects(wecomCardActionEvent(configuration,fresh,secrets,Date.now()-6000),/CARD_CALLBACK_WINDOW_EXPIRED/);
 await assert.rejects(wecomCardActionEvent(configuration,packet('owned-action','owned-card',{created:Math.floor(Date.now()/1000)-6}),secrets),/CARD_CALLBACK_WINDOW_EXPIRED/);
 const event=await wecomCardActionEvent(configuration,fresh,secrets);assert.ok(event.replyRef);
 await assert.rejects(wecomCardActionEvent(configuration,{...fresh,headers:{req_id:'different-transport-receipt'}},secrets),/CARD_CALLBACK_CONTEXT_CHANGED/);
});
test('actual SDK update cancellation retains the original late receipt without a second update',async()=>{
 const f=adapterFixture(),raw=packet('owned-action','owned-card'),click=await wecomCardActionEvent(configuration,raw,f.secrets);let finish,late,writes=0;
 const client=new WSClient({botId:'owned-bot',secret:'INERT_NO_PLATFORM_ACCOUNT',logger:silentSdkLogger});client.wsManager.sendReply=()=>{writes++;return new Promise(resolve=>{finish=resolve;});};f.adapter.client=client;f.adapter.withSignal=hardenWecomSdk(client);
 const controller=new AbortController(),pending=f.adapter.send({destination:{platform:'wecom',channelId:'channel',tenantId:'owned-corp',botId:'owned-bot',conversationId:'owned-user',chatKind:'private',externalSubjectId:'owned-user',replyRef:click.replyRef},content:{text:'Task status: running',presentation:{kind:'status',title:'Task progress',cardTaskId:'owned-card'}}},{deliveryId:'owned-update',signal:controller.signal,onLateReceipt:value=>{late=value;}});
 await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,/PLATFORM_SEND_CANCELLED/);finish({headers:{req_id:raw.headers.req_id},errcode:0});await new Promise(resolve=>setImmediate(resolve));assert.equal(late.state,'accepted');assert.equal(writes,1);await f.adapter.stop();
});
test('actual SDK event subscription waits for protected callback persistence before ingress and performs no direct write',async()=>{
 let writes=0,release,seen;const gate=new Promise(resolve=>{release=resolve;}),secrets=new EphemeralSecretStore(),put=secrets.put.bind(secrets);
 secrets.put=async(...args)=>{await gate;return put(...args);};
 class OwnedClient extends WSClient{constructor(options){super(options);this.wsManager.sendReply=async()=>{writes++;throw new Error('NO_CALLBACK_SEND_WITHOUT_OUTBOX');};}connect(){this.emit('authenticated');return this;}}
 const adapter=new WeComAdapter({configuration,credentials:{secret:'INERT_NO_PLATFORM_ACCOUNT'},secretStore:secrets,sdk:{WSClient:OwnedClient}});
 await adapter.start(async event=>{seen=event;return {durablyAccepted:true};});adapter.client.emit('event.template_card_event',packet('owned-action','owned-card'));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(seen,undefined);release();
 for(let i=0;i<20&&!seen;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(seen.cardActionRef,'owned-action');assert.equal(seen.cardTaskId,'owned-card');assert.equal(writes,0);await adapter.stop();
 const refusing=new WeComAdapter({configuration,credentials:{secret:'INERT_NO_PLATFORM_ACCOUNT'},secretStore:{async get(){throw new ChannelError('PLATFORM_CONTEXT_EXPIRED');},async put(){throw new Error('OWNED_PRIVATE_PERSISTENCE_FAILED');}},sdk:{WSClient:OwnedClient}});seen=undefined;
 await refusing.start(async event=>{seen=event;});refusing.client.emit('event.template_card_event',packet('owned-action','owned-card',{id:'persistence-denied'}));await new Promise(resolve=>setImmediate(resolve));assert.equal(seen,undefined);assert.equal(writes,0);await refusing.stop();
});
