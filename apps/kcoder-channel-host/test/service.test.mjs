import { createFixtureStore,removeFixtureStore } from './store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { ApplicationService } from '../src/index.mjs';
import { ChannelError } from '../src/errors.mjs';
import { PassThrough } from 'node:stream';
import { PrivateParentPeer } from '../src/applications/private-peer.mjs';
const scope={accountId:'alice',targetId:'local',workspaceId:'w',identityGeneration:'1',targetRevision:'1'};
const persistedState=store=>JSON.stringify({entities:store.db.prepare('SELECT * FROM entities ORDER BY kind,scope,id').all(),operations:store.db.prepare('SELECT * FROM operations ORDER BY id').all()});
function req(payload,operationId){return {contractVersion:'parallel-v1',requestId:'request',scope,timeoutMs:1000,payload,...(operationId?{operationId}:{})};}
function fixture(t,{decision='allow',inventory,applications,storeOptions={}}={}){
 const root=mkdtempSync(join(tmpdir(),'kcoder-application-service-'));const store=createFixtureStore(root,storeOptions);
 const calls=[];const ports={async call(port,method,r){calls.push({port,method,r});return {contractVersion:'parallel-v1',requestId:r.requestId,status:'completed',operationId:r.operationId??null,entityRevision:null,observedAt:new Date().toISOString(),error:null,result:{decision,policyRevision:'1',reasonCode:'SYNTHETIC_TEST_POLICY'}};}};
 const service=new ApplicationService({store,ports,inventory,applications,settings:{enabled:true}});
 t.after(async()=>{await service.close();store.close();removeFixtureStore(root);});
 return {store,service,calls,ports};
}
test('public scope is never authorization',async t=>{
 const {service}=fixture(t,{decision:'deny'});
 const result=await service.call('P-CONNECTION','listConnections',req({}));
 assert.equal(result.status,'rejected');assert.equal(result.error.code,'RESOURCE_DENIED');assert.equal(result.result,null);
});

test('an unknown original mutation remains fenced and cannot be replayed', async t => {
 const {service,store}=fixture(t);let effects=0;
 service.prepareConnectionAction=async()=>{effects++;throw new ChannelError('NATIVE_RESULT_UNAVAILABLE','reconcile_original');};
 const input=req({action:'save',connectionId:'docs',kind:'tencent_docs',label:'Documents',configuration:{mcpServerName:'original-docs'}},'unknown-original');
 const first=await service.call('P-CONNECTION','prepareConnectionAction',input);
 assert.equal(first.status,'unknown');assert.equal(first.error.recovery,'reconcile_original');
 const retry=await service.call('P-CONNECTION','prepareConnectionAction',input);
 assert.equal(retry.status,'unknown');assert.equal(retry.error.code,'OPERATION_UNCONFIRMED');
 assert.equal(effects,1);
 assert.equal(store.db.prepare('SELECT state FROM operations WHERE id=?').get(input.operationId).state,'pending');
});
test('a plain provider failure after mutation admission reports unknown and preserves the original fence', async t => {
 const {service,store}=fixture(t);let effects=0;
 service.prepareConnectionAction=async()=>{effects++;throw new Error('fixture provider lost its receipt');};
 const input=req({action:'save',connectionId:'docs',kind:'tencent_docs',label:'Documents',configuration:{mcpServerName:'original-docs'}},'plain-unknown');
 const first=await service.call('P-CONNECTION','prepareConnectionAction',input);
 assert.equal(first.status,'unknown');assert.equal(first.error.code,'INTERNAL_ERROR');assert.equal(first.error.recovery,'reconcile_original');
 assert.equal((await service.call('P-CONNECTION','prepareConnectionAction',input)).error.code,'OPERATION_UNCONFIRMED');
 assert.equal(effects,1);assert.equal(store.db.prepare('SELECT state FROM operations WHERE id=?').get(input.operationId).state,'pending');
});
test('invalid inner request identity is rejected at the outer RPC boundary with a typed error', async t => {
 const {service,calls}=fixture(t);
 for(const request of [null,undefined,42,'invalid']){
  await assert.rejects(service.call('P-CONNECTION','listConnections',request),{name:'ChannelError',code:'CONTRACT_UNSUPPORTED'});
 }
 assert.equal(calls.length,0);
});
test('prototype property port names are unsupported methods rather than internal errors', async t => {
 const {service,calls}=fixture(t);
 for(const port of ['constructor','__proto__','toString']){
  const result=await service.call(port,'listConnections',req({}));
  assert.equal(result.status,'rejected');assert.equal(result.error.code,'METHOD_UNSUPPORTED');
 }
 assert.equal(calls.length,0);
});
test('an invalid inner request receives an outer RPC error while the owned pipe stays usable', async t => {
 const {service}=fixture(t),toHost=new PassThrough(),fromHost=new PassThrough();
 const host=new PrivateParentPeer(toHost,fromHost),parent=new PrivateParentPeer(fromHost,toHost);
 host.handler=(_method,params)=>service.call(params.port,params.method,params.request);
 const runs=[host.run(),parent.run()];
 t.after(async()=>{toHost.end();fromHost.end();await Promise.allSettled(runs);});
 await assert.rejects(parent.call('connectivity.call',{port:'P-CONNECTION',method:'listConnections',request:null},1000),{code:'CONTRACT_UNSUPPORTED'});
 const valid=await parent.call('connectivity.call',{port:'P-CONNECTION',method:'listConnections',request:req({})},1000);
 assert.equal(valid.status,'completed');assert.deepEqual(valid.result.items,[]);
});
test('a proven unstarted mutation stores its rejected receipt without replaying it', async t => {
 const {service}=fixture(t);let attempts=0;
 service.prepareConnectionAction=async()=>{attempts++;throw Object.assign(new ChannelError('FIXTURE_NOT_STARTED'),{operationNotStarted:true});};
 const input=req({action:'save',connectionId:'docs',kind:'tencent_docs',label:'Documents',configuration:{mcpServerName:'original-docs'}},'unstarted');
 for(let repeat=0;repeat<2;repeat++){
  const result=await service.call('P-CONNECTION','prepareConnectionAction',input);
  assert.equal(result.status,'rejected');assert.equal(result.error.code,'FIXTURE_NOT_STARTED');
 }
 assert.equal(attempts,1);
});
test('private resource locators require the current generation and a live owned store lease', t => {
 let owned=true;const {service,store}=fixture(t,{storeOptions:{assertExclusiveLease:()=>owned}});
 const ref={id:'resource',revision:'1',kind:'document'};
 store.putEntity('connection',scope,'docs',{kind:'tencent_docs',configuration:{mcpServerName:'original-docs'},resourceGrants:[ref]});
 store.putEntity('connection_fence',scope,'docs',{identityGeneration:scope.identityGeneration,targetRevision:scope.targetRevision});
 store.putEntity('resource_candidate',scope,ref.id,{connectionId:'docs',kind:ref.kind,nativeResourceRef:{id:'native-document',revision:'1',kind:ref.kind}});
 assert.equal(service.resolveApplicationResources(scope,'docs',[ref]).resources[0].sourceResourceRef.id,'native-document');
 for(const changed of [{...scope,identityGeneration:'next-generation'},{...scope,targetRevision:'next-target'}])
  assert.throws(()=>service.resolveApplicationResources(changed,'docs',[ref]),{code:'APPLICATION_SCOPE_CHANGED'});
 owned=false;
 assert.throws(()=>service.resolveApplicationResources(scope,'docs',[ref]),{code:'NATIVE_STORE_LEASE_REQUIRED'});
});
test('mutation requires operation identity and rejects secrets before authorization',async t=>{
 const {service,calls}=fixture(t);
 const noId=await service.call('P-CONNECTION','prepareConnectionAction',req({action:'save'}));
 assert.equal(noId.error.code,'INVALID_OPERATION');
 const secret=await service.call('P-CONNECTION','prepareConnectionAction',req({token:'synthetic-only'},'op'));
 assert.equal(secret.error.code,'SECRET_IN_PUBLIC_PAYLOAD');assert.equal(calls.length,0);
});
test('application host has no channel save, binding or delivery execution path',async t=>{
 const {service,store,calls}=fixture(t);
 store.putEntity('connection',scope,'retired-channel',{kind:'feishu',enabled:true,hasCredential:true,configuration:{appId:'historical-app'}});
 const original=persistedState(store);
 for(const kind of ['feishu','qq','weixin','wecom','dingtalk','github']){
  const reply=await service.call('P-CONNECTION','prepareConnectionAction',req({action:'save',connectionId:'new-channel',kind,label:'Legacy',configuration:{}},'save-'+kind));
  assert.equal(reply.error.code,'APPLICATION_UNSUPPORTED');
 }
 for(const action of ['prepareBinding','bindIdentity','unbindIdentity','reconcileBinding','testMessage']){
  const reply=await service.call('P-CONNECTION','prepareConnectionAction',req({action,connectionId:'retired-channel'},'old-'+action));
  assert.equal(reply.error.code,'CONNECTION_ACTION_UNSUPPORTED');
 }
 for(const method of ['submitDelivery','readDelivery','cancelDelivery','reconcileDelivery']){
  const reply=await service.call('P-DELIVERY',method,req({deliveryId:'old-delivery'},'old-'+method));
  assert.equal(reply.error.code,'METHOD_UNSUPPORTED');
 }
 assert.equal((await service.call('P-CONNECTION','listConnections',req({category:'channels'}))).error.code,'METHOD_UNSUPPORTED');
 assert.equal((await service.call('P-CONNECTION','readConnection',req({connectionId:'retired-channel'}))).error.code,'APPLICATION_UNSUPPORTED');
 assert.equal(calls.length,0,'Retired channel calls must not evaluate policy or allocate workers');
 assert.equal(persistedState(store),original);
});
test('application listing excludes historical channels and retains configured task-source discovery',async t=>{
 const source={sourceRef:{id:'docs',revision:'1'},accountRef:null,kind:'mcp',displayName:'Configured source',accountDisplayName:null,state:'ready',reasonCode:null,capabilities:['tools']};
 const {service,store}=fixture(t,{inventory:async()=>({tools:[],taskSources:[source]})});
 store.putEntity('connection',scope,'old-channel',{kind:'qq',enabled:true,configuration:{appId:'old-app'}});
 store.putEntity('connection',scope,'docs',{kind:'tencent_docs',label:'Documents',enabled:false,configuration:{mcpServerName:'original-docs'}});
 const result=await service.call('P-CONNECTION','listConnections',req({limit:1}));
 assert.deepEqual(result.result.items.map(item=>item.id),['docs']);
 assert.equal(result.result.catalog.channels,undefined);
 assert.deepEqual(result.result.taskSources,[source]);
 assert.equal(result.result.taskSourcesState,'observed');
});
test('application save keeps its original idempotent operation and does not allocate channel credentials',async t=>{
 const {service,store}=fixture(t);
 const input=req({action:'save',connectionId:'docs',kind:'tencent_docs',label:'Documents',configuration:{mcpServerName:'original-docs'}},'save-original-docs');
 const saved=await service.call('P-CONNECTION','prepareConnectionAction',input);
 assert.equal(saved.status,'completed');assert.equal(saved.result.enabled,false);
 assert.equal(saved.result.hasCredential,false);
 const original=persistedState(store);
 assert.deepEqual((await service.call('P-CONNECTION','prepareConnectionAction',input)).result,saved.result);
 assert.equal(persistedState(store),original);
 assert.equal(store.listEntities('credential_binding',scope).items.length,0);
});
test('readiness separates unknown authorization and unexecuted business check',async t=>{
 const {service}=fixture(t,{inventory:async()=>({tools:[],requestRevision:'real-shaped-test-revision'})});
 const report=await service.call('P-READINESS','inspectReadiness',req({}));
 assert.equal(report.status,'completed');
 assert.equal(report.result.observations.find(o=>o.level==='L3').state,'unknown');
 assert.equal(report.result.observations.find(o=>o.level==='L6').reasonCode,'BUSINESS_CHECK_NOT_EXECUTED');
});
test('semantic capability is resolved only through registered and allowed native inventory',async t=>{
 const {service}=fixture(t,{inventory:async()=>({tools:[{name:'real-shaped',registered:true,allowed:true,schemaRevision:'1',sourceRevision:'s',capabilities:['table.read']},{name:'unregistered',registered:false,allowed:true,capabilities:['table.read']}]})});
 const found=await service.call('P-CONNECTION','resolveCapability',req({capabilityId:'table.read'}));
 assert.equal(found.result.matches.length,1);assert.equal(found.result.matches[0].name,'real-shaped');
 const missing=await service.call('P-CONNECTION','resolveCapability',req({capabilityId:'mail.send'}));
 assert.equal(missing.result.state,'unresolved');
});
test('readiness only says ready for current exact native tools and explicit policy allow',async t=>{
 const tool={name:'mcp__docs__read',schemaRevision:'1',sourceRevision:'source-1',capabilities:['document.read'],registered:true,allowed:true};
 const {service}=fixture(t,{inventory:async()=>({requestRevision:'inventory-1',tools:[tool]})});
 const result=await service.call('P-READINESS','inspectReadiness',req({capabilityIds:['document.read','mail.send']}));
 assert.equal(result.result.capabilities[0].state,'ready');
 assert.equal(result.result.capabilities[0].policyRevision,'1');
 assert.equal(result.result.capabilities[1].state,'unavailable');
 assert.equal(result.result.observations.find(o=>o.level==='L6').state,'unknown');
});
test('missing mapping revisions or inventory revision never imply readiness',async t=>{
 const {service}=fixture(t,{inventory:async()=>({tools:[{name:'partial',registered:true,allowed:true,capabilities:['document.read']}]})});
 const result=await service.call('P-READINESS','inspectReadiness',req({capabilityIds:['document.read']}));
 assert.equal(result.result.capabilities[0].state,'unknown');
 assert.deepEqual(result.result.capabilities[0].toolRefs,[]);
});
test('old readiness observations become unknown after the actual request inventory changes',async t=>{
 let revision='first';const {service}=fixture(t,{inventory:async()=>({requestRevision:revision,tools:[{name:'native-read',registered:true,allowed:true,schemaRevision:'schema',sourceRevision:'source',capabilities:['document.read']}]})});
 const first=await service.call('P-READINESS','inspectReadiness',req({capabilityIds:['document.read']}));assert.equal(first.result.capabilities[0].state,'ready');
 revision='changed';const read=await service.call('P-READINESS','readReadiness',req({}));assert.equal(read.result.state,'stale');assert.equal(read.result.capabilities[0].state,'unknown');assert.equal(read.result.observations.find(value=>value.level==='L5').state,'stale');
});
