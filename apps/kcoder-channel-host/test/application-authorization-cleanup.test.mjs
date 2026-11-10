import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApplicationService} from '../src/applications/service.mjs';
import {createFixtureStore,removeFixtureStore} from './store-fixture.mjs';
const scope={accountId:'owner',targetId:'target',workspaceId:'workspace',identityGeneration:'generation',targetRevision:'revision'};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'kcoder-local-auth-cleanup-')),store=createFixtureStore(root);let loggedOut=0,providerRequests=0,pendingDisable=false,finishDisable,enteredDisable;
 const entered=new Promise(resolve=>{enteredDisable=resolve;});
 const service=new ApplicationService({store,settings:{enabled:true},ports:{async call(_port,_method,request){return {contractVersion:'parallel-v1',requestId:request.requestId,status:'completed',operationId:request.operationId??null,entityRevision:null,observedAt:new Date().toISOString(),error:null,result:{decision:'allow',policyRevision:'1',reasonCode:'OWNED_COMPONENT_TEST'}};}},applications:{
  async read(){if(pendingDisable)throw Error('metadata receipt must not wait for a busy Native read');return {enabled:loggedOut===0,authorization:loggedOut?'notAuthorized':'authorized'};},
  async disconnect(){loggedOut++;return {loggedOut:true,localCredentialsRemoved:true,providerRevocationRequested:false};},
  async setEnabled(){pendingDisable=true;enteredDisable();return new Promise(resolve=>{finishDisable=()=>{pendingDisable=false;resolve({appliesToNewConversations:true});};});},
  async close(){if(finishDisable)finishDisable();},
 }});
 const connection=store.putEntity('connection',scope,'original-connection',{kind:'tencent_docs',label:'Owned source',configuration:{mcpServerName:'original-source',pluginId:null},resourceGrants:[],enabled:true,hasCredential:true,state:'configured'});
 store.putEntity('connection_fence',scope,connection.id,{identityGeneration:scope.identityGeneration,targetRevision:scope.targetRevision});
 t.after(async()=>{await service.close();store.close();removeFixtureStore(root);});
 const request=(payload,operationId)=>({contractVersion:'parallel-v1',requestId:'request-'+(operationId??'read'),scope,timeoutMs:10000,payload,...(operationId?{operationId,expectedRevision:connection.revision}:{})});
 return {service,store,connection,entered,request,finish:()=>finishDisable(),counts:()=>({loggedOut,providerRequests})};
}
test('local removal and disablement keep separate original metadata while provider revocation remains unrequested',async t=>{
 const f=fixture(t),id='original-local-clear';
 const pending=f.service.call('P-CONNECTION','prepareConnectionAction',f.request({action:'disconnect',connectionId:f.connection.id},id));
 await f.entered;
 const query={connectionId:f.connection.id,localCleanupReceipt:{operationId:id,connectionRef:{id:f.connection.id,revision:f.connection.revision}}};
 const original=await f.service.call('P-CONNECTION','readConnection',f.request(query));
 assert.equal(original.status,'completed');assert.equal(original.result.localAuthorizationCleanup.localRemoval,'accepted');assert.equal(original.result.localAuthorizationCleanup.availability,'unknown');assert.equal(original.result.localAuthorizationCleanup.providerRevocationRequested,false);
 assert.equal(original.result.connectionObservationState,'unknown','a receipt read must not promote saved connection state into current authorization');
 f.finish();const complete=await pending;
 assert.equal(complete.result.localAuthorizationCleanup.availability,'disabled');assert.equal(complete.result.localAuthorizationCleanup.operationId,id);
 const reopened=await f.service.call('P-CONNECTION','readConnection',f.request(query));assert.deepEqual(reopened.result.localAuthorizationCleanup,complete.result.localAuthorizationCleanup);
 assert.deepEqual(f.counts(),{loggedOut:1,providerRequests:0});
 const duplicate=await f.service.call('P-CONNECTION','prepareConnectionAction',f.request({action:'disconnect',connectionId:f.connection.id},id));
 assert.equal(duplicate.status,'completed');assert.deepEqual(f.counts(),{loggedOut:1,providerRequests:0});
});
test('missing or foreign original cleanup references stay unknown and cannot observe another execution scope',async t=>{
 const f=fixture(t),ref={id:f.connection.id,revision:f.connection.revision};
 const missing=await f.service.call('P-CONNECTION','readConnection',f.request({connectionId:f.connection.id,localCleanupReceipt:{operationId:'missing-original',connectionRef:ref}}));
 assert.equal(missing.result.localAuthorizationCleanupObservation,'unknown');assert.equal(missing.result.localAuthorizationCleanup,null);assert.deepEqual(f.counts(),{loggedOut:0,providerRequests:0});
 const pending=f.service.call('P-CONNECTION','prepareConnectionAction',f.request({action:'disconnect',connectionId:f.connection.id},'original-clear'));await f.entered;
 const wrong=await f.service.call('P-CONNECTION','readConnection',f.request({connectionId:f.connection.id,localCleanupReceipt:{operationId:'original-clear',connectionRef:{...ref,revision:'foreign'}}}));
 assert.notEqual(wrong.status,'completed');
 const request=f.request({connectionId:f.connection.id,localCleanupReceipt:{operationId:'original-clear',connectionRef:ref}});request.scope={...scope,identityGeneration:'foreign-owner'};
 const owner=await f.service.call('P-CONNECTION','readConnection',request);assert.notEqual(owner.status,'completed');
 f.finish();await pending;
});
