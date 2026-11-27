import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,stat,open,copyFile,chown,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startApprovalModelFixture} from './approval-model.mjs';
import {startGateway,waitForGatewayRpcToken} from './gateway.mjs';
import {login} from './http.mjs';
import {closeRpcAndWait,gatewayRpcUrl,openRpc} from './rpc.mjs';
import {requireExecutable,waitFor} from './run-context.mjs';
import {materializeWorkspace} from './workspace-fixture.mjs';
import {originalApplicationFixtureExited} from './native-application-evidence.mjs';
import {createNativeSystemdUser} from './native-systemd-user.mjs';
import {applicationFixture} from './application-service.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const uri='owned-application://document/original',deniedUri='owned-application://document/unselected';
const schema={additionalProperties:false,properties:{uri:{type:'string'}},required:['uri'],type:'object'};
const expectedText='OWNED_DOC_START\nDocument reviewed total: 37 units.\nOWNED_DOC_END';
export async function verifyNativeTaskResourceBindings(context){
 const binary=await requireExecutable(process.env.KCODER_E2E_KCODER_BIN,'explicit frozen Native resource candidate');
 const before=await stat(binary),binarySha=sha(await readFile(binary));
 assert.equal(before.nlink,1);assert.equal(binarySha,process.env.KCODER_E2E_KCODER_BIN_SHA256);
 context.addCleanup('verify original resource Native binary',async()=>{
  const after=await stat(binary);assert.deepEqual([after.dev,after.ino,after.size,after.nlink],[before.dev,before.ino,before.size,1]);
  assert.equal(sha(await readFile(binary)),binarySha);
 });
 const user=process.env.KCODER_TEST_SYSTEM_USERS==='1'?await createNativeSystemdUser(context):null;
 assert.ok(process.getuid()!==0||user,'UNMET_PREREQUISITE: root Native Main acceptance requires the existing owned nonprivileged user-manager fixture');
 const owned=user?await applicationFixture(context,binary,{account:user.account}):null;
 const closeCarrier=async()=>{if(owned){await user.close();owned.activeManagers.delete('original-resource-systemd-carrier');}};
 if(owned){owned.activeManagers.add('original-resource-systemd-carrier');context.addCleanup('close original resource carrier before its owned profile removal',closeCarrier);}
 const workspace=owned?.workspace??(await materializeWorkspace(context,'minimal')).path;
 const log=resolve(workspace,'original-mcp-resource-observations.jsonl');
 const rows=async()=>{try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
 const held=await open(context.pathInArtifacts('task-resource-owned-exit.json'),'wx',0o600);
 context.addCleanup('close held resource source observation',()=>held.close());
 context.addCleanup('verify original resource source processes exited',async()=>{
  const observations=await rows();
  for(const record of observations.filter(row=>row.event==='started'))await waitFor(()=>originalApplicationFixtureExited(record),5000,'original resource MCP process exit',50);
  await held.writeFile(JSON.stringify(context.redactValue({knownFixturePidsGone:true,observations}),null,2)+'\n');await held.sync();
 });
 let actualReadName=null,actualDeferredName=null;
 let rootCalls=0,childCalls=0,releaseBinding=false,releaseChild=false,releaseRevoke=false,widget=null;
 const boundaryErrors=[],observed=[],toolReceipts=[];
 const projectOperation=value=>value?{...Object.fromEntries(['operationId','status','phase','reasonCode','revision','entityRevision'].filter(key=>key in value).map(key=>[key,value[key]])),error:value.error?{code:value.error.code,recovery:value.error.recovery}:undefined}:null;
 const projectSnapshot=value=>({revision:value.revision,effectiveFrom:value.effectiveFrom,selectionMode:value.selection?.mode,
  resourceBindings:value.resourceBindings,effectiveResourceBindings:value.effectiveResourceBindings,
  sourceRefs:value.effectiveSources?.map(source=>({id:source.id,revision:source.revision,kind:source.kind}))});
 const tool=(id,name,input)=>[{delta:{role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(input)}}]}},{finishReason:'tool_calls'}];
 const model=await startApprovalModelFixture(context,{responseSteps:({body})=>{
  for(const message of body.messages.filter(message=>message.role==='tool').slice(-8)){
   if(toolReceipts.length>=56||toolReceipts.some(row=>row.toolCallId===message.tool_call_id))continue;
   const content=typeof message.content==='string'?message.content:'';
   let value;try{value=JSON.parse(/```json\s*([\s\S]*?)```/.exec(content)?.[1]??content);}catch{}
   const code=value?.error?.code;
   toolReceipts.push({toolCallId:message.tool_call_id,bytes:Buffer.byteLength(content),
    jsonKeys:value&&typeof value==='object'?Object.keys(value).slice(0,16):[],
    isError:typeof value?.isError==='boolean'?value.isError:undefined,
    errorCode:typeof code==='string'&&/^[A-Z][A-Z0-9_]{2,100}$/.test(code)?code:undefined});
  }
  const child=body.messages.filter(message=>message.role==='user').some(message=>JSON.stringify(message.content).includes('C79_CHILD_ORIGINAL_READ'));
  const names=new Set((body.tools??[]).map(item=>item.function?.name));
  const read=[...names].find(name=>name?.endsWith('__read_document')||child&&name?.endsWith('__read_deferred'));
  observed.push({child,readExposed:Boolean(read),executeExposed:names.has('tool_execute'),agentsExposed:names.has('spawn_agent'),readerName:read??null});
  if(child){
   childCalls++;assert.ok(childCalls<=2,'The original child has a finite two-request protocol');
   if(childCalls===1){assert.ok(read||names.has('tool_execute'),'Original child must inherit a real registered reader');return read?tool('original-child-read',read,{uri}):tool('original-child-read','tool_execute',{tool_name:actualReadName,arguments:{uri}});}
   return [{delta:{role:'assistant',content:'C79_CHILD_COMPLETE'}},{finishReason:'stop'}];
  }
  rootCalls++;assert.ok(rootCalls<=7,'No second root attempt or hidden request');
  if(rootCalls===1){assert.ok(read,'Original registered reader must reach the real Provider');actualReadName=read;return tool('original-open-view',read,{uri});}
  if(rootCalls===2){assert.ok(names.has('tool_search'),'Original deferred discovery must be attached');return [{ready:()=>releaseBinding},...tool('original-search-deferred','tool_search',{query:actualReadName.replace(/__read_document$/,'__read_deferred'),limit:1})];}
  if(rootCalls===3){
   const message=body.messages.find(message=>message.role==='tool'&&message.tool_call_id==='original-search-deferred');
   const fenced=/```json\s*([\s\S]*?)```/.exec(message?.content??'');
   if(!fenced){boundaryErrors.push({stage:'search_receipt',code:'MISSING_DISCOVERY_RECEIPT'});throw new Error('MISSING_DISCOVERY_RECEIPT');}
   const receipt=JSON.parse(fenced[1]);
   observed.push({stage:'search_receipt',matches:receipt.tools?.length,names:receipt.tools?.map(tool=>tool.name),routes:receipt.tools?.map(tool=>tool.call_via)});
   assert.equal(receipt.tools.length,1);assert.equal(receipt.tools[0].call_via,'tool_execute');actualDeferredName=receipt.tools[0].name;
   return tool('original-execute-allowed','tool_execute',{tool_name:actualDeferredName,arguments:{uri}});
  }
  if(rootCalls===4){assert.ok(read);return tool('original-direct-bound',read,{uri});}
  if(rootCalls===5){assert.ok(names.has('spawn_agent'),'Actual native child entry must remain attached');return [{ready:()=>releaseChild},...tool('original-child','spawn_agent',{message:`C79_CHILD_ORIGINAL_READ ${uri}`,agent_type:'general',context_mode:'none'})];}
  if(rootCalls===6)return [{ready:()=>releaseRevoke},...tool('original-execute-revoked','tool_execute',{tool_name:actualDeferredName,arguments:{uri}})];
  return [{delta:{role:'assistant',content:'C79_ORIGINAL_RESOURCE_CHECK_COMPLETE'}},{finishReason:'stop'}];
 }});
 const originalScript=fileURLToPath(new URL('./application-resource-mcp.cjs',import.meta.url));
 const script=owned?resolve(workspace,'original-application-resource-mcp.cjs'):originalScript;
 if(owned){await copyFile(originalScript,script);await chown(script,owned.uid,owned.gid);}
 const settings={
  active_provider:'fixture',model:'owned-resource-protocol',permission_mode:'bypass',credential_store:'file',max_tokens:256,max_retries:0,
  session_memory:{enabled:false},memory:{observer_mode:'disabled',structured_enabled:false,legacy_prompt_enabled:false},
  providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'owned-resource-protocol',context_window_tokens:128000,max_output_tokens:256,output_headroom_tokens:256,discover_models:false,no_proxy:true}},
  tools:{profile:'full',luna:{allowed:['mcp__owned-resource__read_document','tool_search','tool_execute','spawn_agent']}},
  integrations:{connectivity:{enabled:true}},
  mcp_servers:[{name:'owned-resource',transport:'stdio',command:process.execPath,args:[script,'tencent_docs',log,'task-resource-bindings'],policy:{task_resource_reads:Object.fromEntries(['read_document','read_deferred'].map(name=>[name,{schema_sha256:sha(JSON.stringify(schema)),uri_input_pointer:'/uri',input_template:{uri:null}}]))}}],
 };
 if(owned){
  settings.integrations.services={enabled:true};
  await writeFile(owned.settings,JSON.stringify(settings),{mode:0o600});
  const trust=resolve(owned.profile,'trusted-folders.json');await writeFile(trust,JSON.stringify({trusted:[workspace],never:[]}),{mode:0o600});await chown(trust,owned.uid,owned.gid);
 }else{
  await context.writeStateJson('profile/settings.json',settings);
  await context.writeStateJson('profile/trusted-folders.json',{trusted:[workspace],never:[]});
 }
 // Register after source/model observers but before Gateway close registration:
 // LIFO closes the UI/Gateway, then its exact carrier, then verifies MCP exits.
 if(owned)context.addCleanup('confirm original resource carrier before MCP exit observation',closeCarrier);
 const serversFile=await context.writeStateJson('servers.jsonc',[{id:'local',label:'Owned task resource target',runtime:'kcoder',transport:'local',command:owned?.binary??binary,workspace}]);
 if(owned){await copyFile(serversFile,resolve(owned.root,'resource-servers.jsonc'));await chown(resolve(owned.root,'resource-servers.jsonc'),owned.uid,owned.gid);}
 const selectedServersFile=owned?resolve(owned.root,'resource-servers.jsonc'):serversFile;
 const gateway=await startGateway(context,{auth:true,redactedStderrDiagnostics:true,workspace,serversFile:selectedServersFile,kcoderBin:owned?.binary??binary,startTimeoutMs:60000,
  gatewayRoot:owned?.gatewayRoot??process.env.KCODER_E2E_GATEWAY_ROOT,
  ...(owned?{uid:owned.uid,gid:owned.gid}:{}),env:owned?.env??{KCODER_CONFIG_DIR:context.pathInState('profile')}});
 const cookie=await login(gateway.baseUrl,gateway.authToken);context.registerSecret(cookie);
 const token=await waitForGatewayRpcToken(context,gateway,{headers:{cookie},expectedToken:'cookie-auth'});
 const rpc=await openRpc(gatewayRpcUrl(gateway,'local',token),{headers:{Cookie:cookie,Origin:gateway.baseUrl}});
 context.addCleanup('close original task resource RPC',()=>closeRpcAndWait(rpc));
 const initialized=await rpc.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'actual-original-task-resource-bindings',version:'1'},capabilities:{experimental:{integrationScopeV1:true,connectivityV1:true,taskSourcesV1:true,taskSourceChoicesV1:true,taskResourceBindingsV1:true,studioWorkModesV1:true,inlineWidgetsV1:true,isolatedWidgetsV1:true,mcpAppsV1:true}}},60000);
 await context.writeArtifactJson('resource-binding-negotiated-capabilities.json',{taskResourceBindingsV1:initialized.capabilities.experimental.taskResourceBindingsV1,taskSourcesV1:initialized.capabilities.experimental.taskSourcesV1});
 assert.equal(initialized.capabilities.experimental.taskResourceBindingsV1,true);
 const scope=await rpc.request('integrations/scope/read',{});let serial=0;
 const call=async(method,payload,operationId,expectedRevision)=>{
  const reply=await rpc.request(method,{contractVersion:'parallel-v1',requestId:`resource-${++serial}`,scope,timeoutMs:30000,payload,...(operationId?{operationId}:{}),...(expectedRevision?{expectedRevision:String(expectedRevision)}:{})},35000);
  assert.equal(reply.status,'completed',reply.error?.code??'Native resource operation failed');return reply.result;
 };
 let connection=await call('integrations/connectivity/prepareConnectionAction',{action:'save',connectionId:'task-resource-application',kind:'tencent_docs',label:'Owned task resource application',configuration:{mcpServerName:'owned-resource'},resourceGrants:[]},'resource-application-save');
 connection=await call('integrations/connectivity/prepareConnectionAction',{action:'enable',connectionId:connection.id},'resource-application-enable',connection.revision);
 const discovered=await call('integrations/connectivity/readResourceGrant',{connectionId:connection.id,discover:true,limit:10});
 const selected=discovered.items.find(item=>item.label==='Owned document');assert.ok(selected);
 const reference={id:selected.id,revision:selected.revision,kind:selected.kind};
 connection=await call('integrations/connectivity/prepareConnectionAction',{action:'setResources',connectionId:connection.id,resourceGrants:[reference]},'resource-application-select',connection.revision);
 const {thread}=await rpc.request('thread/start',{studioWorkMode:'kworker',cwd:workspace});
 const processId=(await rpc.request('server/resources/read')).processId;
 rpc.socket.addEventListener('message',event=>{
  const frame=JSON.parse(event.data);
  if(frame.method==='item/completed'&&frame.params?.threadId===thread.id&&frame.params.item?.id==='original-open-view')widget=frame.params.item.widgetRef??null;
 });
 const passive=await open(context.pathInArtifacts('task-resource-passive.json'),'wx',0o600);
 context.addCleanup('close held resource passive artifact',()=>passive.close());
 context.addCleanup('retain bounded resource observations',async()=>{
  await passive.writeFile(JSON.stringify(context.redactValue({rootCalls,childCalls,observed,boundaryErrors,widgetPresent:Boolean(widget),notifications:rpc.messages().filter(frame=>frame.method).map(frame=>({method:frame.method,threadId:frame.params?.threadId,turnId:frame.params?.turnId,status:frame.params?.turn?.status,code:frame.params?.error?.code})).slice(-100)}),null,2)+'\n');await passive.sync();
 });
 const {turn}=await rpc.request('turn/start',{threadId:thread.id,clientPresentation:{version:1,studioWorkMode:'kworker',inlineWidgets:true,isolatedWidgets:true},input:[{type:'text',text:'C79_ROOT_TASK: use only the selected original document and its one explicitly requested child; do not send or change external data.'}]});
 const started=await rpc.waitFor(frame=>frame.method==='turn/started'&&frame.params?.turnId===turn.id,15000,'original native Accepted turn');
 assert.equal(typeof started.params.attemptId,'string');
 const target={initialAttempt:{threadId:thread.id,turnId:turn.id,attemptId:started.params.attemptId}};
 await waitFor(()=>rootCalls===2&&widget,30000,'original tool and retained App widget',50,context.abortSignal);
 let snapshot=await call('integrations/tasks/readTaskSources',{target,params:{threadId:thread.id}});
 assert.equal(snapshot.effectiveSources.length,1);assert.equal(snapshot.effectiveResourceBindings,undefined);
 const source=snapshot.effectiveSources[0];
 const mutation=await call('integrations/tasks/setTaskSources',{target,params:{threadId:thread.id,selection:snapshot.selection,resourceBindings:[{source,connectionRef:{id:connection.id,revision:connection.revision},resourceRefs:[reference]}]}},'bind-original-task-resources',snapshot.revision);
 await context.writeArtifactJson('resource-binding-original-mutation.json',{before:projectSnapshot(snapshot),snapshot:mutation.snapshot?projectSnapshot(mutation.snapshot):null,operation:projectOperation(mutation.operation)});
 assert.equal(mutation.operation.operationId,'bind-original-task-resources');
 releaseBinding=true;
 await waitFor(()=>rootCalls===5,30000,'original attached executor resource read',50,context.abortSignal);
 snapshot=await call('integrations/tasks/readTaskSources',{target,params:{threadId:thread.id}});
 await context.writeArtifactJson('resource-binding-current-before-reconcile.json',{snapshot:projectSnapshot(snapshot),toolReceipts});
 const reconciled=await call('integrations/tasks/readTaskSourceOperation',{target,operationId:'bind-original-task-resources'});
 await context.writeArtifactJson('resource-binding-original-operation.json',{snapshot:reconciled.snapshot?projectSnapshot(reconciled.snapshot):null,operation:projectOperation(reconciled.operation)});
 assert.equal(snapshot.effectiveResourceBindings.length,1);
 assert.equal(snapshot.effectiveResourceBindings[0].connectionRef.revision,connection.revision);
 const binding={threadId:thread.id,widgetId:widget.widgetId,revision:widget.revision,connectionId:widget.mcpApp.connectionId};
 const bodyRead=await rpc.request('mcp/apps/resourceRead',{...binding,uri});
 const content=await rpc.request('mcp/apps/resourceContentRead',{...binding,resourceId:bodyRead.resource.resourceId,sha256:bodyRead.resource.sha256,offset:0});
 assert.equal(JSON.parse(Buffer.from(content.dataBase64,'base64').toString()).contents[0].text,expectedText);
 const beforeDeny=(await rows()).filter(row=>row.event==='resourceRead').length;
 await assert.rejects(rpc.request('mcp/apps/resourceRead',{...binding,uri:deniedUri}));
 assert.equal((await rows()).filter(row=>row.event==='resourceRead').length,beforeDeny);
 const beforeCallback=(await rows()).filter(row=>row.event==='toolRead').length;
 const callback=await rpc.request('mcp/apps/toolCall',{...binding,name:'read_document',arguments:{uri},operationId:'original-unmapped-resource-callback'});
 assert.ok(['not_sent','denied'].includes(callback.status),'Unmapped App callback must retain an authoritative non-dispatched receipt');
 assert.equal((await rows()).filter(row=>row.event==='toolRead').length,beforeCallback);
 releaseChild=true;
 await waitFor(()=>rootCalls===6&&childCalls===2,30000,'actual original native child reader',50,context.abortSignal);
 const childObservation=(await rows()).filter(row=>row.event==='toolRead');
 assert.equal(childObservation.length,4);assert.ok(childObservation.every(row=>row.allowedFixtureUri===true));
 connection=await call('integrations/connectivity/prepareConnectionAction',{action:'setResources',connectionId:connection.id,resourceGrants:[]},'resource-application-revoke',connection.revision);
 const afterRevokeReads=(await rows()).filter(row=>['toolRead','resourceRead'].includes(row.event)).length;
 await assert.rejects(rpc.request('mcp/apps/resourceRead',{...binding,uri}));
 await assert.rejects(rpc.request('mcp/apps/resourceContentRead',{...binding,resourceId:bodyRead.resource.resourceId,sha256:bodyRead.resource.sha256,offset:0}));
 releaseRevoke=true;
 const completed=await rpc.waitFor(frame=>frame.method==='turn/completed'&&frame.params?.turnId===turn.id,30000,'same original native task terminal');
 assert.equal(completed.params.turn.status,'completed');
 assert.equal((await rows()).filter(row=>['toolRead','resourceRead'].includes(row.event)).length,afterRevokeReads);
 assert.equal((await rows()).filter(row=>row.event==='unselectedResourceRead'||row.event==='unexpectedMethod').length,0);
 assert.equal(rootCalls,7);assert.equal(childCalls,2);assert.equal(model.requests.length,9);
 assert.equal((await rpc.request('server/resources/read')).processId,processId);
 await context.writeArtifactJson('task-resource-original-result.json',{binarySha256:binarySha,original:{threadId:thread.id,turnId:turn.id,attemptId:started.params.attemptId},originalBindingOperation:'bind-original-task-resources',ordinaryOriginalRead:true,ordinaryOriginalBoundRead:true,unmappedAppCallbackStatus:callback.status,unmappedAppCallbackNoIo:true,attachedExecutorSameUriRead:true,actualChildRequests:2,actualChildSameGrantRead:true,appSameUriFullBytesSha256:sha(expectedText),unselectedAppUriDenied:true,revokeBlocksExecutorAndAppAndCachedRead:true,rootProviderRequests:7,childProviderRequests:2,sameBackendProcess:true,secondRootTaskStarted:false,paidModelCalls:0});
}
