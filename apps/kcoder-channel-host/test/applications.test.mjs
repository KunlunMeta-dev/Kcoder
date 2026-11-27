import { createFixtureStore,removeFixtureStore } from './store-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeApplicationProvider } from '../../kcoder-studio/src/integrations/connectivity/native-applications.mjs';
import { ConnectivityStore,ApplicationService } from '../src/index.mjs';

const scope={accountId:'alice',targetId:'native-target',workspaceId:'workspace',identityGeneration:'1',targetRevision:'1'};
const connection={id:'connection',revision:'1',kind:'tencent_docs',configuration:{mcpServerName:'custom-docs',pluginId:'docs-plugin'}};
function providerFixture(t,{request,decision='allow'}={}){
 let current={scope,nativeConnectionId:'native'};const calls=[];
 const provider=createNativeApplicationProvider({getHostContext:async()=>current,evaluateAction:async()=>({status:'completed',result:{decision}}),
  requestPlugin:async(context,method,params)=>{calls.push({context,method,params});if(request)return request(method,params);if(method==='mcp/list')return {servers:[{name:'custom-docs',pluginId:'docs-plugin',enabled:true,authorization:'authorized'}]};if(method==='mcp/setEnabled')return {name:params.name,enabled:params.enabled,appliesToNewConversations:true};return {};}});
 t.after(()=>provider.close());return {provider,calls,setContext:value=>{current=value;}};
}
test('application uses exact native configured source and preserves new-conversation semantics',async t=>{
 const {provider,calls}=providerFixture(t);
 assert.equal((await provider.read(scope,connection)).authorization,'authorized');
 const result=await provider.setEnabled(scope,connection,true);assert.equal(result.appliesToNewConversations,true);
 assert.deepEqual(calls.find(value=>value.method==='mcp/setEnabled').params,{name:'custom-docs',pluginId:'docs-plugin',enabled:true});
});
test('application rejects ambiguous sources and denied policy before native actions',async t=>{
 const denied=providerFixture(t,{decision:'deny'});await assert.rejects(denied.provider.setEnabled(scope,connection,true),/APPLICATION_ACCESS_DENIED/);assert.equal(denied.calls.length,0);
 const duplicate=providerFixture(t,{request:async()=>({servers:[{name:'custom-docs',pluginId:'docs-plugin'},{name:'custom-docs',pluginId:'docs-plugin'}]})});
 await assert.rejects(duplicate.provider.read(scope,connection),/APPLICATION_SOURCE_UNAVAILABLE/);
});
test('cancelled application OAuth cancels a late native flow and never publishes it',async t=>{
 let finish;const {provider,calls}=providerFixture(t,{request:async method=>method==='gateway/mcp/login'?await new Promise(resolve=>{finish=resolve;}):{}});
 const login=provider.authorize(scope,connection,'original-op');login.catch(()=>{});
 await new Promise(resolve=>setImmediate(resolve));
 await provider.cancelAuthorization(scope,connection,null,'original-op');
 finish({flowId:'native-flow',authorizationUrl:'https://auth.example.invalid/authorize?state=fixture'});
 await assert.rejects(login,/APPLICATION_AUTHORIZATION_CANCELLED/);
 assert.equal(calls.filter(value=>value.method==='gateway/mcp/login').length,1);
 assert.deepEqual(calls.find(value=>value.method==='mcp/cancel').params,{flowId:'native-flow'});
});
test('OAuth target changes clean only the original owned flow',async t=>{
 let finish;const {provider,calls,setContext}=providerFixture(t,{request:async method=>method==='gateway/mcp/login'?await new Promise(resolve=>{finish=resolve;}):{}});
 const login=provider.authorize(scope,connection,'original-op');login.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));
 setContext({scope:{...scope,targetId:'other'},nativeConnectionId:'other-native'});
 finish({flowId:'original-flow',authorizationUrl:'https://auth.example.invalid/authorize?state=fixture'});
 await assert.rejects(login,/APPLICATION_SCOPE_CHANGED/);
 assert.equal(calls.find(value=>value.method==='mcp/cancel').context.nativeConnectionId,'native');
});
test('three application business intents submit original resources through native runtime',async t=>{
 const root=mkdtempSync(join(tmpdir(),'kcoder-office-application-'));const store=createFixtureStore(root);const calls=[];
 const ports={async call(port,method,request){calls.push({port,method,request});return {contractVersion:'parallel-v1',requestId:request.requestId,status:method==='acceptTask'?'accepted':'completed',operationId:request.operationId??null,entityRevision:null,observedAt:new Date().toISOString(),error:null,result:method==='acceptTask'?{threadId:'native-thread',turnId:'native-turn',state:'queued'}:{decision:'allow',policyRevision:'1',reasonCode:'CONSUMER_CONTRACT_TEST'}};}};
 const service=new ApplicationService({store,ports,settings:{enabled:true}});t.after(async()=>{await service.close();store.close();removeFixtureStore(root);});
 for(const [kind,resourceKind,businessAction] of [['tencent_docs','document','document.summarize'],['agent_mail','mailbox','mail.summarize'],['feishu_bitable','table','table.analyze']]){
  const resource={id:'resource-'+kind,revision:'1',kind:resourceKind};
  store.putEntity('resource_candidate',scope,resource.id,{kind:resourceKind,connectionId:kind,nativeResourceRef:{id:'native-resource',revision:'original',kind:resourceKind}});
  store.putEntity('connection',scope,kind,{kind,label:kind,enabled:true,hasCredential:true,state:'configured',configuration:{mcpServerName:kind},resourceGrants:[resource]});
  store.putEntity('connection_fence',scope,kind,{identityGeneration:'1',targetRevision:'1'});
  const request={contractVersion:'parallel-v1',requestId:'request-'+kind,scope,operationId:'operation-'+kind,expectedRevision:'1',timeoutMs:3000,payload:{action:'runOfficeTask',connectionId:kind,businessAction,resourceRefs:[resource],taskText:'Summarize the selected resource with cited source rows.'}};
  const result=await service.call('P-CONNECTION','prepareConnectionAction',request);assert.equal(result.status,'completed');assert.equal(result.result.threadId,'native-thread');
  const native=calls.find(value=>value.method==='acceptTask'&&value.request.operationId===request.operationId);
  assert.deepEqual(native.request.payload.source,{kind:'application',applicationKind:kind,connectionId:kind,resourceRefs:[resource]});
  assert.equal(native.request.payload.allowedTools,undefined);assert.equal(native.request.payload.message.attachments.length,0);
 }
});

test('native application configuration facts retain the exact namespace, source and current fence without read authority',async t=>{
 const root=mkdtempSync(join(tmpdir(),'kcoder-application-facts-'));const store=createFixtureStore(root);
 let service; t.after(async()=>{await service?.close();store.close();removeFixtureStore(root);});
 service=new ApplicationService({store,settings:{enabled:true},ports:{async call(){throw new Error('Metadata facts must not invoke a policy or runtime port');}}});
 const saved=store.putEntity('connection',scope,'original-app',{kind:'agent_mail',label:'Owned mail',configuration:{mcpServerName:'owned-mail',pluginId:'owned-plugin'},enabled:false,hasCredential:false,state:'stopped',resourceGrants:[]});
 store.putEntity('connection_fence',scope,saved.id,{identityGeneration:scope.identityGeneration,targetRevision:scope.targetRevision});
 const fact=service.resolveApplicationConfiguration(scope,saved.id);
 assert.deepEqual(fact,{nativeNamespaceId:store.storage.binding.namespaceId,connectionId:saved.id,connectionRevision:saved.revision,kind:'agent_mail',source:{server:'owned-mail',plugin:'owned-plugin'}});
 assert.equal(fact.resourceGrants,undefined);assert.equal(fact.credentialRef,undefined);
 assert.throws(()=>service.resolveApplicationConfiguration({...scope,workspaceId:'peer-workspace'},saved.id),/APPLICATION_SOURCE_UNAVAILABLE/);
 assert.throws(()=>service.resolveApplicationConfiguration({...scope,identityGeneration:'changed'},saved.id),/APPLICATION_SCOPE_CHANGED/);
 assert.deepEqual(store.readEntity('connection',scope,saved.id).resourceGrants,[]);
});
