import { createFixtureStore,removeFixtureStore } from './store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join } from 'node:path';
import { ApplicationService } from '../src/index.mjs';
const scope={accountId:'alice',targetId:'local',workspaceId:'w',identityGeneration:'1',targetRevision:'1'};
function req(payload,operationId){return {contractVersion:'parallel-v1',requestId:'request',scope,timeoutMs:1000,payload,...(operationId?{operationId}:{})};}
function fixture(t,{decision='allow',inventory,applications}={}){
 const root=mkdtempSync(join(tmpdir(),'kcoder-application-service-'));const store=createFixtureStore(root);
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
 const changes=store.db.prepare('SELECT total_changes() AS n').get().n;
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
 assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,changes);
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
 const changes=store.db.prepare('SELECT total_changes() AS n').get().n;
 assert.deepEqual((await service.call('P-CONNECTION','prepareConnectionAction',input)).result,saved.result);
 assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,changes);
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
