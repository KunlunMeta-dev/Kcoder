import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,stat,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startApprovalModelFixture} from './approval-model.mjs';
import {startGateway,waitForGatewayRpcToken} from './gateway.mjs';
import {login} from './http.mjs';
import {closeRpcAndWait,gatewayRpcUrl,openRpc} from './rpc.mjs';
import {requireExecutable,waitFor} from './run-context.mjs';
import {materializeWorkspace} from './workspace-fixture.mjs';
import {originalApplicationFixtureExited} from './native-application-evidence.mjs';
import {businessPolicies,createBusinessProtocol} from './application-business-protocol.mjs';
import {createBusinessUnknownProtocol} from './application-business-unknown-protocol.mjs';
import {createBusinessAcceptance} from './application-business-acceptance.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const resources=[
 {kind:'tencent_docs',resourceKind:'document',action:'document.summarize',text:'OWNED_DOC_START\nDocument reviewed total: 37 units.\nOWNED_DOC_END'},
 {kind:'agent_mail',resourceKind:'mailbox',action:'mail.summarize',text:'OWNED_MAIL_START\nFrom: owned-sender@example.invalid\nSubject: Fixture review\nReviewed total: 37 units.\nOWNED_MAIL_END'},
 {kind:'feishu_bitable',resourceKind:'table',action:'table.query',text:'{"marker":"OWNED_TABLE","rows":[{"region":"owned-east","reviewedUnits":37}]}'}
];
export async function verifyNativeApplicationTasks(context,{businessRed=false,businessGreen=false,businessAppOnly=false,businessReadProbe=false,businessReadSource='document',businessLookupProbe=false,businessHardDrop=false}={}){
 assert.ok(!(businessRed&&businessGreen));const businessMode=businessRed||businessGreen||businessAppOnly;
 assert.ok(['document','mail'].includes(businessReadSource),'Finite owned readonly source required');
 const selectedSources=businessReadProbe&&businessReadSource==='mail'?resources.filter(item=>item.kind==='agent_mail'):businessAppOnly||businessReadProbe||businessLookupProbe?resources.slice(0,1):resources;
 assert.equal(process.platform,'linux','Declared native owned process observation requires Linux');
 const binary=await requireExecutable(process.env.KCODER_E2E_KCODER_BIN,'explicit candidate native CLI');
 const identity=await stat(binary),binarySha=sha(await readFile(binary));
 assert.equal(identity.nlink,1);assert.equal(binarySha,process.env.KCODER_E2E_KCODER_BIN_SHA256);
 context.addCleanup('verify original application native binary',async()=>{
  const current=await stat(binary);assert.deepEqual([current.dev,current.ino,current.size,current.nlink],[identity.dev,identity.ino,identity.size,1]);
  assert.equal(sha(await readFile(binary)),binarySha);
 });
 const {path:workspace}=await materializeWorkspace(context,'minimal');
 if(businessGreen||businessAppOnly){
  const names=['./native-application-tasks.mjs','./application-resource-mcp.cjs','./application-business-fixture.cjs','./application-business-protocol.mjs','./application-business-acceptance.mjs','./application-business-unknown-protocol.mjs'];
  const pins=await Promise.all(names.map(async name=>{const path=fileURLToPath(new URL(name,import.meta.url)),identity=await stat(path);return {name,path,sha256:sha(await readFile(path)),dev:identity.dev,ino:identity.ino,size:identity.size,nlink:identity.nlink};}));
  await context.writeArtifactJson('application-business-original-input-pins.json',pins.map(({path,...pin})=>pin));
  context.addCleanup('verify original application business source inputs unchanged',async()=>{
   for(const pin of pins){const current=await stat(pin.path);assert.deepEqual([current.dev,current.ino,current.size,current.nlink],[pin.dev,pin.ino,pin.size,pin.nlink]);assert.equal(sha(await readFile(pin.path)),pin.sha256);}
  });
 }

 const errors=[],bodies=[],replies=[],originalTasks=[];
 const business=businessGreen?(businessLookupProbe?createBusinessUnknownProtocol({hardDrop:businessHardDrop}):createBusinessProtocol()):null;
 let rpcClient=null;
 const model=await startApprovalModelFixture(context,{responseSteps:({body,requestNumber})=>{
  if(business)return business.respond({body,requestNumber});
  try{
   assert.ok(requestNumber<=3,'No second model attempt or hidden health request');
   assert.ok(!body.tools?.length,'The original input-only task grants no tool or external-send capability');
   const input=JSON.parse(body.messages.find(item=>item.role==='user').content);
   assert.equal(input.untrustedSourceData,true);assert.equal(input.applicationMaterial.length,1);
   const expected=resources.find(item=>input.task===`OWNED_APPLICATION_TASK_${item.kind}`);assert.ok(expected);
   assert.equal(input.applicationMaterial[0].text,expected.text,'Full original MCP resource bytes reach the actual request');
   assert.equal(input.applicationMaterial[0].resourceRef.kind,expected.resourceKind);
   bodies.push({kind:expected.kind,sha256:sha(input.applicationMaterial[0].text),bytes:Buffer.byteLength(input.applicationMaterial[0].text)});
  }catch(error){errors.push({requestNumber,code:error.code==='ERR_ASSERTION'?'MODEL_BOUNDARY_ASSERTION':'MODEL_BOUNDARY_INVALID'});}
  return [{delta:{role:'assistant',content:`OWNED_APPLICATION_COMPLETED_${requestNumber}`}},{finishReason:'stop'}];
 }});
 const passiveFile=await open(context.pathInArtifacts('application-passive-observation.json'),'wx',0o600);
 context.addCleanup('close held application protocol artifact',()=>passiveFile.close());
 context.addCleanup('retain bounded application protocol observations',async()=>{
  const notifications=(rpcClient?.messages()??[]).filter(message=>typeof message.method==='string').slice(-200).map(message=>({method:message.method,threadId:message.params?.threadId??null,turnId:message.params?.turnId??null,status:message.params?.turn?.status??message.params?.state??null,errorCode:message.params?.error?.code??null}));
  await passiveFile.writeFile(JSON.stringify(context.redactValue({providerRequests:model.requests.length,modelBoundaryAccepted:bodies,modelBoundaryErrors:errors,replies,originalTasks,notifications}),null,2)+'\n');await passiveFile.sync();
 });
 const script=fileURLToPath(new URL('./application-resource-mcp.cjs',import.meta.url));
 const logs=selectedSources.map(item=>({...item,path:resolve(workspace,`mcp-${item.kind}.jsonl`)}));
 const exitFile=await open(context.pathInArtifacts('application-mcp-owned-exit.json'),'wx',0o600);
 context.addCleanup('close held application MCP exit artifact',()=>exitFile.close());
 context.addCleanup('verify observed owned MCP fixture processes exited',async()=>{
  const observations=[];
  for(const item of logs){
   let raw;try{raw=await readFile(item.path,'utf8');}catch(error){if(error.code==='ENOENT'){observations.push({kind:item.kind,sourceObservation:'not_observed',knownFixturePidsGone:null});continue;}throw error;}
   const rows=raw.trim().split('\n').filter(Boolean).map(JSON.parse);
   assert.equal(rows.filter(row=>row.event==='unexpectedMethod').length,0);
   const starts=rows.filter(row=>row.event==='started');
   assert.equal(starts.length,1,'Application tasks must reuse the original registered MCP client');
   for(const record of starts){
    await waitFor(()=>originalApplicationFixtureExited(record),5000,'original owned MCP fixture exit',50);
   }
   observations.push({kind:item.kind,originalProcessInstances:starts.length,knownFixturePidsGone:true,reads:rows.filter(row=>row.event==='resourceRead'),...(businessMode?{business:rows.filter(row=>row.event.startsWith('business'))}:{})});
  }
  await exitFile.writeFile(JSON.stringify(context.redactValue({scope:'Known fixed MCP fixture processes only; no independent whole-tree/kernel-receipt claim',observations}),null,2)+'\n');await exitFile.sync();
 });
 await context.writeStateJson('profile/settings.json',{
  active_provider:'fixture',model:'owned-native-application',credential_store:'file',max_tokens:512,max_retries:0,...(businessGreen?{permission_mode:'bypass'}:{}),
  session_memory:{enabled:false},memory:{observer_mode:'disabled',structured_enabled:false,legacy_prompt_enabled:false},
  providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'owned-native-application',context_window_tokens:128000,max_output_tokens:512,output_headroom_tokens:512,discover_models:false,no_proxy:true}},
  integrations:{connectivity:{enabled:true},...(businessGreen?{office:{enabled:true}}:{})},
  mcp_servers:logs.map(item=>({name:`owned-${item.kind}`,transport:'stdio',command:process.execPath,args:[script,item.kind,item.path,...(businessMode?[businessAppOnly?'office-business-app-only':businessLookupProbe?(businessHardDrop?'office-business-lost-create-hard-drop':'office-business-lost-create-ack'):'office-business']:[])],...((businessGreen||businessAppOnly)?{policy:{...(businessLookupProbe?{tool_timeout_secs:2}:{}),application_actions:businessPolicies(item.kind,{lookups:businessLookupProbe})}}:{})})),
 });
 await context.writeStateJson('profile/trusted-folders.json',{trusted:[workspace],never:[]});
 let readonlySettingsBaseline=null;
 if(businessReadProbe){
  const settingsPath=context.pathInState('profile/settings.json');
  context.addCleanup('verify readonly application preserves original settings bytes',async()=>{assert.ok(readonlySettingsBaseline,'Original read-task settings baseline must be captured after explicit connection setup');assert.deepEqual(await readFile(settingsPath),readonlySettingsBaseline);});
 }
 const serversFile=await context.writeStateJson('servers.jsonc',[{id:'local',label:'Owned application task target',runtime:'kcoder',transport:'local',command:binary,workspace}]);
 const gateway=await startGateway(context,{auth:true,workspace,serversFile,kcoderBin:binary,startTimeoutMs:60000,
  gatewayRoot:process.env.KCODER_E2E_GATEWAY_ROOT,env:{KCODER_CONFIG_DIR:context.pathInState('profile')}});
 const cookie=await login(gateway.baseUrl,gateway.authToken);context.registerSecret(cookie);
 const token=await waitForGatewayRpcToken(context,gateway,{headers:{cookie},expectedToken:'cookie-auth'});
 // The verified application host completes its cold startup before Gateway accepts this socket.
 const rpc=await openRpc(gatewayRpcUrl(gateway,'local',token),{timeoutMs:60000,headers:{Cookie:cookie,Origin:gateway.baseUrl}});
 rpcClient=rpc;
 context.addCleanup('close original application RPC',()=>closeRpcAndWait(rpc));
 const initialized=await rpc.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'actual-application-original-runtime',version:'1'},capabilities:{experimental:{sessionLifetimeV1:true,integrationScopeV1:true,connectivityV1:true,threadRunSummaryV1:true,integrationTaskStateV1:true,...(businessGreen?{officeWorkspaceV1:true}:{} ),...(businessReadProbe?{taskWorkspaceV1:true}:{} )}}},60000);
 if(businessReadProbe)assert.equal(initialized.capabilities?.experimental?.taskWorkspaceV1,true,'Actual native workspace read capability must be negotiated before observation');
 const scope=await rpc.request('integrations/scope/read',{});
 let sequence=0;
 const call=async(method,payload,operation,revision)=>{
  const reply=await rpc.request(`integrations/connectivity/${method}`,{contractVersion:'parallel-v1',requestId:`app-${++sequence}`,scope,timeoutMs:30000,payload,...(operation?{operationId:operation}:{}),...(revision?{expectedRevision:revision}:{})},35000);
  replies.push({method,operation:operation??null,status:reply.status,errorCode:reply.error?.code??null,threadId:reply.result?.threadId??null,turnId:reply.result?.turnId??null,state:reply.result?.state??null});
  assert.equal(reply.status,'completed',JSON.stringify(reply));return reply.result;
 };
 const outcomes=[];
 const businessAcceptance=businessGreen?await createBusinessAcceptance(context,{gateway,workspace,rpc,scope,protocol:business,readOnlyProbe:businessReadProbe,lookupProbe:businessLookupProbe,hardDrop:businessHardDrop}):null;
 for(const item of selectedSources){
  const id=`application-${item.kind}`;
  let connection=await call('prepareConnectionAction',{action:'save',connectionId:id,kind:item.kind,label:`Owned ${item.kind}`,configuration:{mcpServerName:`owned-${item.kind}`},resourceGrants:[]},`${id}-save`);
  connection=await call('prepareConnectionAction',{action:'enable',connectionId:id},`${id}-enable`,connection.revision);
  const discovered=await call('readResourceGrant',{connectionId:id,discover:true,limit:10});
  assert.equal(discovered.items.length,1);assert.equal(discovered.items[0].kind,item.resourceKind);
  const refs=discovered.items.map(({id,revision,kind})=>({id,revision,kind}));
  connection=await call('prepareConnectionAction',{action:'setResources',connectionId:id,resourceGrants:refs},`${id}-select`,connection.revision);
  if(businessReadProbe)readonlySettingsBaseline=await readFile(context.pathInState('profile/settings.json'));
  if(businessGreen){await businessAcceptance.run(item,connection,refs);continue;}
  if(businessAppOnly){
   const operationId=`${id}-app-only-original`;
   const reply=await rpc.request('integrations/connectivity/prepareConnectionAction',{contractVersion:'parallel-v1',requestId:`business-app-only-${++sequence}`,scope,timeoutMs:30000,operationId,expectedRevision:connection.revision,payload:{action:'runOfficeTask',connectionId:id,businessAction:'document.create',resourceRefs:refs,taskText:'Create only the explicitly selected owned document. App-only tools must remain outside the model.'}},35000);
   const rows=(await readFile(logs[0].path,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
   const declared=rows.find(row=>row.event==='businessInventory').tools;
   const appOnly=declared.find(tool=>tool.name==='document_create');assert.deepEqual(appOnly._meta.ui.visibility,['app']);
   assert.ok(businessPolicies(item.kind).document_create,'Exact reviewed business policy is configured');
   outcomes.push({operationId,status:reply.status,errorCode:reply.error?.code??null,taskAccepted:!!reply.result?.threadId,providerRequests:model.requests.length,businessEffects:rows.filter(row=>row.event==='businessEffect').length,appOnlySchemaSha256:sha(JSON.stringify(appOnly.inputSchema))});
   continue;
  }
  if(businessRed){
   const businessAction={tencent_docs:'document.create',agent_mail:'mail.send',feishu_bitable:'table.export'}[item.kind],operationId=`${id}-business-original`;
   const taskText={tencent_docs:'Create one owned document titled Owned review with exact body "Owned approved document: 37 units." in the selected resource. Retain its original operation receipt and never repeat an unknown effect.',agent_mail:'Send exactly one message to owned-recipient@example.invalid with subject Owned review and exact body "Owned approved send: 37 units." using the selected owned mailbox. This explicit test send is only to the owned .invalid fixture. Retain its original operation receipt; never resend an unknown outcome.',feishu_bitable:'Query only the first 1 row for region owned-east from the selected table and export exactly that bounded result as CSV. Retain the original operation receipt; never repeat an unknown export.'}[item.kind];
   const reply=await rpc.request('integrations/connectivity/prepareConnectionAction',{contractVersion:'parallel-v1',requestId:`app-business-${++sequence}`,scope,timeoutMs:30000,operationId,expectedRevision:connection.revision,payload:{action:'runOfficeTask',connectionId:id,businessAction,resourceRefs:refs,taskText}},35000);
   const rows=(await readFile(logs.find(log=>log.kind===item.kind).path,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
   const inventory=rows.find(row=>row.event==='businessInventory');assert.ok(inventory,'Actual registered original MCP business schemas must exist before a Native failure is classified');
   outcomes.push({kind:item.kind,businessAction,operationId,status:reply.status,errorCode:reply.error?.code??null,taskAccepted:!!(reply.result?.threadId&&reply.result?.turnId),providerRequests:model.requests.length,businessEffects:rows.filter(row=>row.event==='businessEffect').length,registeredTools:inventory.tools.map(tool=>({name:tool.name,schemaSha256:sha(JSON.stringify(tool.inputSchema)),action:tool._meta['io.kcoder.applicationBusiness'].action,readOnlyHint:tool.annotations.readOnlyHint}))});
   continue;
  }
  const accepted=await call('prepareConnectionAction',{action:'runOfficeTask',connectionId:id,businessAction:item.action,resourceRefs:refs,taskText:`OWNED_APPLICATION_TASK_${item.kind}`},`${id}-run`,connection.revision);
  assert.ok(accepted.threadId&&accepted.turnId,'Original native acceptance required');
  originalTasks.push({kind:item.kind,threadId:accepted.threadId,turnId:accepted.turnId,nativeOperationId:accepted.nativeOperationId});
  let completed;
  try{
   const deadline=Date.now()+30000;
   completed=await waitFor(async()=>{
    const remaining=deadline-Date.now();assert.ok(remaining>0,'Original canonical task deadline');
    const state=await rpc.request('integrations/runtime/readTaskState',{requestId:`original-${id}-snapshot`,scope,reference:{threadId:accepted.threadId,turnId:accepted.turnId}},Math.min(5000,remaining));
    assert.equal(state.operationId,`${id}-run`);assert.deepEqual(state.reference,{threadId:accepted.threadId,turnId:accepted.turnId});
    if(['failed','cancelled'].includes(state.state))throw new Error(`Original canonical task terminal: ${state.state}`);
    return state.state==='completed'?state:null;
   },30000,'original canonical application task completion',100,context.abortSignal);
  }
  catch(error){
   const diagnostic={kind:item.kind,threadId:accepted.threadId,turnId:accepted.turnId,providerRequests:model.requests.length};
   try{const state=await rpc.request('integrations/runtime/readTaskState',{requestId:`original-${id}-snapshot`,scope,reference:{threadId:accepted.threadId,turnId:accepted.turnId}},5000);diagnostic.snapshot={state:state.state,operationId:state.operationId,reference:state.reference,revision:state.revision};}catch{diagnostic.snapshot={state:'unavailable'};}
   try{const history=await rpc.request('thread/read',{threadId:accepted.threadId},5000);diagnostic.thread={status:history.thread.status,mainTurn:history.thread.runSummary?.mainTurn??null,recentError:history.thread.runSummary?.recentError??null,messages:history.messages.map(message=>({turnId:message.turnId??null,attemptId:message.attemptId??null,role:message.role,status:message.status??null,errorType:message.errorType??null}))};}catch{diagnostic.thread={status:'unavailable'};}
   await context.writeArtifactJson('application-original-task-timeout.json',diagnostic);throw error;
  }
  assert.equal(completed.state,'completed','Only the actual original canonical Core task confirms completion');
  originalTasks.at(-1).canonical={state:completed.state,revision:completed.revision,operationId:completed.operationId};
  const history=await rpc.request('thread/read',{threadId:accepted.threadId});
  assert.ok(history.messages.some(message=>message.turnId===accepted.turnId&&message.role==='assistant'&&message.content.includes('OWNED_APPLICATION_COMPLETED_')));
  const repeated=await call('prepareConnectionAction',{action:'runOfficeTask',connectionId:id,businessAction:item.action,resourceRefs:refs,taskText:`OWNED_APPLICATION_TASK_${item.kind}`},`${id}-run`,connection.revision);
  assert.deepEqual([repeated.threadId,repeated.turnId],[accepted.threadId,accepted.turnId],'Original known receipt must not create a second task');
  outcomes.push({kind:item.kind,threadId:accepted.threadId,turnId:accepted.turnId,nativeOperationId:accepted.nativeOperationId,sourceSha256:sha(item.text)});
 }
 if(businessAppOnly){
  await context.writeArtifactJson('application-reviewed-app-only-native-guard.json',{binarySha256:binarySha,actualRegisteredMcp:true,locallyReviewedBusinessAction:true,appOnlyModelVisibility:false,paidCalls:0,externalBrandAccountVerified:false,outcomes});
  await closeRpcAndWait(rpc);assert.equal(outcomes.length,1);assert.equal(outcomes[0].taskAccepted,false);assert.equal(outcomes[0].providerRequests,0);assert.equal(outcomes[0].businessEffects,0);return;
 }
 if(businessGreen){await businessAcceptance.finish(logs,binarySha,model.requests.length);await closeRpcAndWait(rpc);return;}
 if(businessRed){
  await context.writeArtifactJson('application-original-business-red.json',{binarySha256:binarySha,actualGateway:true,actualNativeMain:true,actualOriginalMcpClients:true,businessSchemasRegistered:8,expectedBusinessEffects:3,observedBusinessEffects:outcomes.reduce((sum,item)=>sum+item.businessEffects,0),providerRequests:model.requests.length,paidCalls:0,externalBrandAccountVerified:false,modelQualityClaim:false,outcomes});
  await closeRpcAndWait(rpc);
  assert.equal(outcomes.filter(item=>item.status==='completed'&&item.taskAccepted).length,3,'APP04 original Native runOfficeTask must accept document.create, explicit mail.send and table.export; all three outcomes retained');
  return;
 }
 assert.deepEqual(errors,[]);assert.equal(model.requests.length,3);assert.equal(bodies.length,3);
 for(const item of logs){const rows=(await readFile(item.path,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);assert.equal(rows.filter(row=>row.event==='resourceRead').length,1,'One original source read per completed business task');}
 await closeRpcAndWait(rpc);
 const reader=await openRpc(gatewayRpcUrl(gateway,'local',token),{headers:{Cookie:cookie,Origin:gateway.baseUrl}});
 context.addCleanup('close application lifetime inspection RPC',()=>closeRpcAndWait(reader));
 await reader.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'application-lifetime-observer',version:'1'},capabilities:{experimental:{sessionLifetimeV1:true}}});
 const lifetimes=[];
 for(const outcome of outcomes){
  const lifetime=await waitFor(async()=>{
   const value=await reader.request('thread/lifetime/read',{threadId:outcome.threadId});
   assert.equal(value.setting.mode,'background','Application execution retains background lifetime');
   return value.attachedClients===0?value:null;
  },10000,'application source observer released after its UI transport closes',100,context.abortSignal);
  lifetimes.push({threadId:outcome.threadId,attachedClients:lifetime.attachedClients,mode:lifetime.setting.mode});
 }
 await context.writeArtifactJson('application-source-observers-released.json',{lifetimes});
 await context.writeArtifactJson('application-original-runtime-result.json',{binarySha256:binarySha,actualGateway:true,actualNativeMain:true,actualMcpResourceReads:true,actualNativeCoreTurns:true,originalNoReplay:true,providerRequests:3,paidCalls:0,externalBrandAccountVerified:false,modelQualityClaim:false,outcomes,bodies});
 await closeRpcAndWait(rpc);
}
