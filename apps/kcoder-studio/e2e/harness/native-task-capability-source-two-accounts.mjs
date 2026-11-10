import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {startApprovalModelFixture} from './approval-model.mjs';
import {startOAuthMcpFixture} from './oauth-mcp.mjs';
import {startGateway,waitForGatewayRpcToken} from './gateway.mjs';
import {login} from './http.mjs';
import {closeRpcAndWait,gatewayRpcUrl,openRpc} from './rpc.mjs';
import {requireExecutable,waitFor} from './run-context.mjs';
import {materializeWorkspace} from './workspace-fixture.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const connectors={A:'owned_twd01_a',B:'owned_twd01_b'};

/** Actual target-side Accepted identities and Native catalog refs; no task-store seeding. */
export async function verifyTwoNativeTaskCapabilitySourceAccounts(context){
 const binary=await requireExecutable(process.env.KCODER_E2E_KCODER_BIN,'explicit immutable current Native CLI');
 const identity=await stat(binary),binarySha256=digest(await readFile(binary));
 assert.equal(identity.nlink,1);assert.equal(binarySha256,process.env.KCODER_E2E_KCODER_BIN_SHA256??process.env.KCODER_E2E_KCODER_SHA256);
 context.addCleanup('verify original TWD01 Native binary',async()=>{const after=await stat(binary);assert.deepEqual([after.dev,after.ino,after.size,after.nlink],[identity.dev,identity.ino,identity.size,1]);assert.equal(digest(await readFile(binary)),binarySha256);});
 const {path:workspace}=await materializeWorkspace(context,'minimal',{instanceId:'two-task-source-accounts'});
 const issuer=await startOAuthMcpFixture(context,{manualApproval:true,resourceScopes:['probe:read'],accountSubjects:['A','B']});
 const released={A:false,B:false},seen={A:0,B:0},requests=[];
 const model=await startApprovalModelFixture(context,{responseSteps:({body})=>{
  const text=JSON.stringify(body.messages.filter(message=>message.role==='user'));
  const subject=text.includes('OWNED_TWD01_TASK_A')?'A':text.includes('OWNED_TWD01_TASK_B')?'B':null;
  assert.ok(subject,'Only the two original actual task inputs may reach this fixture');
  assert.ok(++seen[subject]<=2,'Each real task has at most two protocol requests');
  assert.ok(model.requests.length<=4,'No model retry, replay or reopen inference');
  if(body.messages.at(-1)?.role==='tool'){
   assert.ok(String(body.messages.at(-1).content).includes(`OAUTH_SUBJECT_${subject}_RESOURCE_${subject}_ONLY`),'The actual selected connector must read its actual private account');
   requests.push({subject,phase:'actual_tool_result',originalAccountResult:true});
   return [{delta:{content:`OWNED_TWD01_${subject}_COMPLETE`},finishReason:'stop'}];
  }
  const tool=body.tools?.find(item=>item.function?.name.includes(connectors[subject])&&item.function.name.includes('oauth_probe'));
  assert.ok(tool,'The actual registered connector tool must exist before selecting it');
  requests.push({subject,phase:'original_provider_boundary',tool:tool.function.name});
  return [{ready:()=>released[subject]},
   {delta:{role:'assistant',tool_calls:[{index:0,id:`twd01-${subject}`,type:'function',function:{name:tool.function.name,arguments:'{}'}}]},finishReason:'tool_calls'}];
 }});
 await context.writeStateJson('profile/settings.json',{
  active_provider:'twd01',model:'owned-two-task-protocol',credential_store:'file',permission_mode:'ask',max_retries:0,max_tokens:256,
  session_memory:{enabled:false},memory:{observer_mode:'disabled',structured_enabled:false,legacy_prompt_enabled:false},
  permission_rules:Object.values(connectors).map(name=>({tool:`mcp__${name}__oauth_probe`,action:'allow'})),
  providers:{twd01:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'owned-two-task-protocol',context_window_tokens:128000,max_output_tokens:256,output_headroom_tokens:256,discover_models:false,no_proxy:true}},
  integrations:{connectivity:{enabled:true}},
  mcp_servers:Object.entries(connectors).map(([subject,name])=>({name,transport:'http',url:issuer.root+'/mcp',policy:{oauth_account:'twd01_'+subject.toLowerCase()}})),
 });
 await context.writeStateJson('profile/trusted-folders.json',{trusted:[workspace],never:[]});
 await context.writeStateJson('profile/credentials.json',{});
 const serversFile=await context.writeStateJson('servers.jsonc',[{id:'local',label:'Owned Native TWD01 target',runtime:'kcoder',transport:'local',command:binary,workspace}]);
 const gateway=await startGateway(context,{auth:true,workspace,serversFile,kcoderBin:binary,startTimeoutMs:60000,gatewayRoot:process.env.KCODER_E2E_GATEWAY_ROOT,env:{KCODER_CONFIG_DIR:context.pathInState('profile')}});
 const cookie=await login(gateway.baseUrl,gateway.authToken);context.registerSecret(cookie);
 const token=await waitForGatewayRpcToken(context,gateway,{headers:{cookie},expectedToken:'cookie-auth'});
 const open=async label=>{
  const rpc=await openRpc(gatewayRpcUrl(gateway,'local',token),{headers:{Cookie:cookie,Origin:gateway.baseUrl}});
  context.addCleanup(`close TWD01 ${label} RPC`,()=>closeRpcAndWait(rpc));
  const initialized=await rpc.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'twd01-'+label,version:'1'},capabilities:{experimental:{integrationScopeV1:true,connectivityV1:true,taskSourcesV1:true,taskSourceChoicesV1:true,studioWorkModesV1:true}}},60000);
  assert.equal(initialized.capabilities.experimental.taskSourcesV1,true);assert.equal(initialized.capabilities.experimental.taskSourceChoicesV1,true);return rpc;
 };
 let rpc=await open('original');
 const originalProcessId=(await rpc.request('server/resources/read')).processId;
 for(const subject of ['A','B']){
  const flow=await rpc.request('gateway/mcp/login',{server:{name:connectors[subject],pluginId:null}});context.registerSecret(flow.authorizationUrl);
  const approval=new URL(flow.authorizationUrl);assert.equal(new URL(approval.searchParams.get('redirect_uri')).origin,gateway.baseUrl);
  approval.pathname='/approve';approval.searchParams.set('subject',subject);context.registerSecret(approval.href);
  const response=await fetch(approval);await response.text();assert.ok(response.ok,'The original owned Native OAuth callback must complete');
  const complete=await rpc.waitFor(frame=>frame.method==='mcp/authorizationChanged'&&frame.params?.flowId===flow.flowId,15000,'original '+subject+' OAuth');assert.equal(complete.params.status,'authorized');
 }
 assert.equal(issuer.events.filter(event=>event==='token-exchange').length,2);
 const scope=await rpc.request('integrations/scope/read',{});let serial=0;
 const native=async(method,payload,operationId,revision)=>{
  const reply=await rpc.request('integrations/tasks/'+method,{contractVersion:'parallel-v1',requestId:'twd01-'+(++serial),scope,timeoutMs:15000,payload,...(operationId?{operationId}:{}),...(revision?{expectedRevision:String(revision)}:{})},20000);
  assert.equal(reply.status,'completed',reply.error?.code??'Original Native task-source operation failed');return reply.result;
 };
 const tasks=[],deletionAttempts=new Map();let cleanupSequence=0;
 const deleteOwnedThreads=async()=>{
  const failures=[];let invoked=0;
  for(const task of [...tasks].reverse()){
   const threadId=task.tuple.threadId;
   if(deletionAttempts.has(threadId))continue;
   const attempt={threadId,state:'invoked'};deletionAttempts.set(threadId,attempt);invoked++;
   try{await rpc.request('thread/delete',{threadId});attempt.state='known_completed';}
   catch(error){attempt.state='unconfirmed';failures.push(error);}
  }
  if(invoked){
   try{await context.writeArtifactJsonInternal(`two-task-source-cleanup-${++cleanupSequence}.json`,{attempts:[...deletionAttempts.values()]});}
   catch(error){failures.push(error);}
  }
  if(failures.length)throw new AggregateError(failures,'Original owned TWD01 thread deletion unconfirmed; attempted IDs are never replayed');
 };
 context.addCleanup('delete only owned TWD01 threads before original RPC closes',deleteOwnedThreads);
 const read=task=>native('readTaskSources',{target:{initialAttempt:task.tuple},params:{threadId:task.tuple.threadId}});
 for(const subject of ['A','B']){
  const {thread}=await rpc.request('thread/start',{cwd:workspace,studioWorkMode:'kcoder'},45000);
  const task={subject,tuple:{threadId:thread.id}};tasks.push(task);
  const boundary=new Set(rpc.messages());
  const {turn}=await rpc.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'OWNED_TWD01_TASK_'+subject}],clientPresentation:{version:1,studioWorkMode:'kcoder'}},45000);
  const started=await rpc.waitFor(frame=>!boundary.has(frame)&&frame.method==='turn/started'&&frame.params?.threadId===thread.id&&(frame.params.turnId??frame.params.turn?.id)===turn.id,20000,'actual Accepted '+subject);
  const tuple={threadId:thread.id,turnId:turn.id,attemptId:started.params.attemptId??started.params.turn?.attemptId};assert.ok(tuple.attemptId);
  task.tuple=tuple;
  await waitFor(()=>seen[subject]===1,20000,'original provider selection boundary '+subject,25,context.abortSignal);
  const snapshot=await read(task),catalog=await native('listTaskSourceChoices',{target:{initialAttempt:tuple}});
  const descriptor=catalog.items.find(item=>item.displayName===connectors[subject]);
  assert.ok(descriptor&&descriptor.accountRef&&descriptor.state==='ready','Select only a ready actual Native source/account, never fabricate it');
  const choice={sourceRef:descriptor.sourceRef,accountRef:descriptor.accountRef};task.choice=choice;
  const changed=await native('setTaskSources',{target:{initialAttempt:tuple},params:{threadId:thread.id,selection:{mode:'selected',sources:[choice]}}},'twd01-select-'+subject,snapshot.revision);
  assert.equal(changed.operation.operationId,'twd01-select-'+subject);
  if(subject==='B')assert.deepEqual((await read(tasks[0])).selection,{mode:'selected',sources:[tasks[0].choice]},'Selecting B cannot overwrite actual task A');
  released[subject]=true;
  const completed=await rpc.waitFor(frame=>!boundary.has(frame)&&frame.method==='turn/completed'&&frame.params?.threadId===thread.id&&frame.params?.turnId===turn.id,45000,'original selected task '+subject+' completion');
  assert.equal(completed.params.turn.status,'completed');task.beforeReopen=await read(task);
  assert.deepEqual(task.beforeReopen.selection,{mode:'selected',sources:[choice]});assert.deepEqual(task.beforeReopen.effectiveSources,[choice]);
 }
 assert.notEqual(tasks[0].tuple.threadId,tasks[1].tuple.threadId);
 assert.notEqual(tasks[0].choice.sourceRef.id,tasks[1].choice.sourceRef.id);assert.notEqual(tasks[0].choice.accountRef.id,tasks[1].choice.accountRef.id);
 assert.deepEqual(issuer.accountEvents.filter(event=>event.type==='tools/call').map(event=>event.subject),['A','B']);assert.equal(model.requests.length,4);
 const stopped=await rpc.request('gateway/app-server/restart',{confirm:true,force:false});assert.deepEqual(stopped,{restarted:false,stopped:true,reconnectRequired:true});
 await waitFor(()=>rpc.socket.readyState===rpc.socket.constructor.CLOSED,5000,'old TWD01 target RPC closed');
 rpc=await open('reopened');
 // LIFO: delete through the fresh current owner before its close callback runs.
 context.addCleanup('delete only owned TWD01 threads before reopened RPC closes',deleteOwnedThreads);
 const reopenedProcessId=(await rpc.request('server/resources/read')).processId;assert.notEqual(reopenedProcessId,originalProcessId,'Read after real target process restart, not old in-memory state');
 assert.deepEqual(await rpc.request('integrations/scope/read',{}),scope);
 for(const task of [...tasks].reverse()){
  await rpc.request('thread/resume',{threadId:task.tuple.threadId},45000);
  task.afterReopen=await read(task);
  assert.deepEqual(task.afterReopen.selection,task.beforeReopen.selection);assert.deepEqual(task.afterReopen.effectiveSources,task.beforeReopen.effectiveSources);assert.equal(task.afterReopen.revision,task.beforeReopen.revision);
 }
 assert.equal(model.requests.length,4,'Reopening and source observation cannot start a third task or rerun either original task');
 assert.equal(issuer.events.filter(event=>event==='token-exchange').length,2,'Reopen does not reauthorize accounts');
 assert.deepEqual(issuer.accountEvents.filter(event=>event.type==='tools/call').map(event=>event.subject),['A','B']);assert.deepEqual(issuer.fixtureErrors,[]);
 await context.writeArtifactJson('two-real-task-source-account-reopen-proof.json',{binarySha256,originalProcessId,reopenedProcessId,scope,tasks,protocol:requests,actualMcpSubjects:['A','B'],modelRequests:model.requests.length,oauthExchanges:2,paidCalls:0,actualNativeAcceptedTasks:2,sourceSelectionStoredOnTarget:true,coldProcessReopen:true,noCrossTaskOverwrite:true,noModelOrToolReplayOnReopen:true,limits:['Two actual configured MCP connector instances with separate real Native OAuth account slots against a controlled local issuer; not branded vendor account qualification.','Native RPC/protocol/storage verification only; no browser rows or Electron/Windows claim.']});
 return {actualTasks:2,differentNativeConnectorAccounts:true,persistentTargetReopen:true,modelRequests:4,paidCalls:0};
}
