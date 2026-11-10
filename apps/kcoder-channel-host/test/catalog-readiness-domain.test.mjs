import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureStore,removeFixtureStore } from './store-fixture.mjs';
import { ApplicationService } from '../src/applications/service.mjs';
import { APPLICATION_CATALOG,CHANNEL_CATALOG } from '../src/catalog.mjs';

const scope={accountId:'owned-account',targetId:'owned-target',workspaceId:'owned-workspace',identityGeneration:'native-epoch',targetRevision:'native-config'};
const request=payload=>({contractVersion:'parallel-v1',requestId:'owned-read',scope,timeoutMs:1000,payload});
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'kcoder-c-domain-'));const store=createFixtureStore(root);
 let now=1000000,policy='policy-1',decision='allow';const calls=[];
 const ports={async call(port,method,req){calls.push({port,method,req});return {contractVersion:'parallel-v1',requestId:req.requestId,operationId:req.operationId??null,entityRevision:null,observedAt:new Date(now).toISOString(),status:'completed',error:null,result:{decision:req.payload.action==='capability.use'?decision:'allow',policyRevision:policy,reasonCode:'OWNED_READONLY_POLICY_FIXTURE'}};}};
 const inventory=async()=>({requestRevision:'actual-shaped-request',tools:[{name:'native-doc-read',schemaRevision:'schema-1',sourceRevision:'source-1',registered:true,allowed:true,capabilities:['document.read']}]});
 const service=new ApplicationService({store,ports,inventory,now:()=>now});
 t.after(async()=>{await service.close();store.close();removeFixtureStore(root);});
 return {service,store,calls,ports,inventory,clock:value=>{now=value;},policy:value=>{policy=value;},decision:value=>{decision=value;}};
}
test('APP-01 catalog names finite native configuration fields and official help without claiming business access',()=>{
 assert.equal(APPLICATION_CATALOG.length,3);assert.equal(CHANNEL_CATALOG.length,6);
 for(const entry of APPLICATION_CATALOG){
  assert.equal(entry.transport,'registered_mcp');assert.equal(entry.credentialBoundary,'native_mcp_reference');
  assert.equal(entry.capabilityEvidence,'catalog_declaration_only');assert.equal(entry.configurationSchema.additionalProperties,false);
  assert.deepEqual(entry.configurationSchema.required,['mcpServerName']);assert.deepEqual(Object.keys(entry.configurationSchema.properties).sort(),['mcpServerName','pluginId']);
  assert.equal(new URL(entry.docs).protocol,'https:');assert.ok(entry.resourceKinds.length&&entry.capabilities.length);
 }
 assert.match(APPLICATION_CATALOG.find(value=>value.kind==='agent_mail').docs,/^https:\/\/docs\.agentmail\.to\//);
 assert.match(CHANNEL_CATALOG.find(value=>value.kind==='weixin').docs,/github\.com\/Tencent\/openclaw-weixin/);
 const github=CHANNEL_CATALOG.find(value=>value.kind==='github');
 assert.deepEqual([github.transport,github.credentialFields,github.capabilities.attachments],['rest_poll',['token'],false]);
});
test('APP-01 application schema refuses arbitrary configuration before policy or a durable mutation',async t=>{
 const f=fixture(t);const before=f.store.db.prepare('SELECT total_changes() AS n').get().n;
 for(const configuration of [{},{mcpServerName:'source',trusted:true},{mcpServerName:'source',pluginId:7}]){
  const result=await f.service.call('P-CONNECTION','prepareConnectionAction',{...request({action:'save',connectionId:'connection',kind:'tencent_docs',label:'Documents',configuration}),operationId:'owned-invalid'});
  assert.equal(result.status,'rejected');
 }
 assert.equal(f.calls.length,0);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,before);
 const result=await f.service.call('P-CONNECTION','prepareConnectionAction',{...request({action:'save',connectionId:'connection',kind:'tencent_docs',label:'Documents',configuration:{mcpServerName:'CaseSensitiveSource',pluginId:'CaseSensitivePlugin'}}),operationId:'owned-configure'});
 assert.equal(result.status,'completed');assert.equal(result.result.configuration.mcpServerName,'CaseSensitiveSource');assert.equal(result.result.enabled,false);
});
test('public platform credential fields are refused before any policy or SQLite write',async t=>{
 const f=fixture(t);const before=f.store.db.prepare('SELECT total_changes() AS n').get().n;
 for(const field of ['appSecret','app_secret','clientSecret','botSecret','botToken','tenant_access_token','userAccessToken','apiKey','sessionWebhook','context_token','aesKey','productGrant']){
  const result=await f.service.call('P-CONNECTION','prepareConnectionAction',{...request({action:'save',connectionId:'connection',kind:'qq',label:'QQ',configuration:{appId:'owned-inert',nested:{[field]:'SYNTHETIC_MUST_NOT_PERSIST'}}}),operationId:'secret-'+field});
  assert.equal(result.error.code,'SECRET_IN_PUBLIC_PAYLOAD',field);
 }
 assert.equal(f.calls.length,0);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n,before);
 assert.equal(f.store.listEntities('connection',scope).items.length,0);
});
test('RDY-01 inspect and read are actual SQLite read-only observations without durable report writes',async t=>{
 const f=fixture(t);
 const snapshot=()=>({changes:f.store.db.prepare('SELECT total_changes() AS n').get().n,schema:f.store.db.prepare('PRAGMA schema_version').get().schema_version,data:f.store.db.prepare('PRAGMA data_version').get().data_version,reports:f.store.listEntities('readiness',scope).items.length});
 const before=snapshot();const inspected=await f.service.call('P-READINESS','inspectReadiness',request({capabilityIds:['document.read']}));
 assert.equal(inspected.result.capabilities[0].state,'ready');assert.equal(inspected.result.observations.find(value=>value.level==='L6').state,'unknown');
 inspected.result.capabilities[0].state='caller-mutated';
 const read=await f.service.call('P-READINESS','readReadiness',request({}));assert.equal(read.result.capabilities[0].state,'ready');
 assert.deepEqual(snapshot(),before);assert.ok(f.calls.every(value=>value.port==='P-POLICY'));
 const restarted=new ApplicationService({store:f.store,ports:f.ports,inventory:f.inventory});
 const afterRestart=await restarted.call('P-READINESS','readReadiness',request({}));assert.equal(afterRestart.result.state,'unobserved');await restarted.close();
 assert.deepEqual(snapshot(),before);
});
test('RDY-01 cached reports expire and native policy revisions revoke prior ready without business calls',async t=>{
 const f=fixture(t);await f.service.call('P-READINESS','inspectReadiness',request({capabilityIds:['document.read']}));
 f.policy('policy-2');let read=await f.service.call('P-READINESS','readReadiness',request({}));assert.equal(read.result.state,'stale');assert.equal(read.result.capabilities[0].state,'unknown');
 await f.service.call('P-READINESS','inspectReadiness',request({capabilityIds:['document.read']}));f.clock(1060001);
 read=await f.service.call('P-READINESS','readReadiness',request({}));assert.equal(read.result.state,'stale');
 f.decision('deny');await f.service.call('P-READINESS','inspectReadiness',request({capabilityIds:['document.read']}));
 read=await f.service.call('P-READINESS','readReadiness',request({}));assert.equal(read.result.capabilities[0].state,'denied');
});
