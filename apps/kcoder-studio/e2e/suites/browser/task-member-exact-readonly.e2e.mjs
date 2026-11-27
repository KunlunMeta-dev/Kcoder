import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {startApprovalModelFixture} from '../../harness/approval-model.mjs';
import {startChromium} from '../../harness/chromium.mjs';
import {startGateway} from '../../harness/gateway.mjs';
import {closeRpcAndWait,gatewayRpcUrl,openRpc} from '../../harness/rpc.mjs';
import {assertRendererBuildFresh} from '../../harness/renderer-build.mjs';
import {repoRoot,requireExecutable,runE2E,waitFor} from '../../harness/run-context.mjs';
import {materializeWorkspace} from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url,{testId:'task-member-exact-native-controls-browser',tier:'full-integration',
 modelPolicy:'Deterministic bounded Provider selects actual native background member only to validate full-key browser routing/stream/native steering/stop boundaries; no role quality or native desktop claim.',retainSuccessEvidence:true},async context=>{
 const binary=await requireExecutable(process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'),'current exact-run Native');
 let second=false,finish=false,replacementFinish=false,spawnedId;const protocolErrors=[];const stages={parent:0,child:0};
 const text=message=>typeof message?.content==='string'?message.content:(message?.content||[]).filter(value=>value.type==='text').map(value=>value.text).join('\n');
 const model=await startApprovalModelFixture(context,{responseSteps:({body,requestNumber})=>{
  try {
   assert.ok(requestNumber<=10,'fixture request bound');
   const systems=(body.messages||[]).filter(value=>value.role==='system').map(text).join('\n');
   const users=(body.messages||[]).filter(value=>value.role==='user').map(text).join('\n');
   const child=systems.includes('You are a KCoder general sub-agent.');
   if(child){stages.child++;
    if(users.includes('EXACT_MEMBER_RESTART'))return[{delta:{content:'NEW_RUN_MUST_NOT_REPLACE_ORIGINAL_VIEW'}},{ready:()=>replacementFinish,finishReason:'stop'}];
    if(users.includes('EXACT_MEMBER_FOLLOWUP'))return[{delta:{content:'ORIGINAL_MEMBER_FOLLOWUP_APPLIED'}},{finishReason:'stop'}];
    return[{delta:{content:'FIRST_ORIGINAL_MEMBER_DELTA'}},{ready:()=>second,delta:{content:'\nSECOND_ORIGINAL_MEMBER_DELTA'}},{ready:()=>finish,finishReason:'stop'}];
   }
   stages.parent++;
   const tools=(body.tools||[]).map(value=>value.function?.name||value.name);
   for(const value of (body.messages||[]).filter(value=>value.role==='tool')){try{const result=JSON.parse(text(value));if(result.agent_id)spawnedId=result.agent_id}catch{/* Only native tool result identity is used. */}}
   if(!spawnedId){const name=tools.includes('spawn_agent')?'spawn_agent':'Agent';assert.ok(tools.includes(name));return[{delta:{tool_calls:[{index:0,id:'exact-member-spawn',type:'function',function:{name,arguments:JSON.stringify({message:'EXACT_MEMBER_ORIGINAL: provide the fixed protocol stream',agent_type:'general',context_mode:'none',run_in_background:true,max_turns:3})}}]}},{finishReason:'tool_calls'}]}
   return[{delta:{content:'PARENT_ORIGINAL_TASK_READY'}},{finishReason:'stop'}];
  }catch(error){protocolErrors.push(error.message);return[{delta:{content:'EXACT_MEMBER_FIXTURE_PROTOCOL_FAILURE'}},{finishReason:'stop'}]}
 }});
 const {path:workspace}=await materializeWorkspace(context,'minimal',{instanceId:'exact-member-browser'});
 const profile=context.pathInState('profile');
 await context.writeStateJson('profile/settings.json',{active_provider:'member-protocol',model:'member-protocol',permission_mode:'bypass',max_retries:0,session_memory:{enabled:false},providers:{'member-protocol':{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'member-protocol',context_window_tokens:128000,max_output_tokens:4096,output_headroom_tokens:8192,no_proxy:true,discover_models:false}}});
 const serversFile=await context.writeStateJson('servers.json',[{id:'local',label:'Exact member Native',transport:'local',command:binary,workspace}]);
 const gateway=await startGateway(context,{workspace,serversFile,kcoderBin:binary,auth:true,...(process.env.KCODER_E2E_GATEWAY_ROOT?{gatewayRoot:process.env.KCODER_E2E_GATEWAY_ROOT}:{}),env:{KCODER_CONFIG_DIR:profile}});
 const browser=await startChromium(context);const page=await browser.newPage({viewport:{width:1400,height:1000}});
 const errors=[],wire=[];let originalThread,observedWorkspace;const snapshots=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('websocket',socket=>{const pending=new Map();socket.on('framesent',event=>{try{const frame=JSON.parse(String(event.payload));if(frame.method){pending.set(String(frame.id),frame.method);wire.push({method:frame.method,...(frame.method.startsWith('agent/')?{expected:frame.params?.expectedBackgroundRun}:{})})}}catch{}});socket.on('framereceived',event=>{try{const frame=JSON.parse(String(event.payload)),method=pending.get(String(frame.id));pending.delete(String(frame.id));if(method==='thread/start'&&frame.result?.thread?.id)originalThread=frame.result.thread.id;if(method==='integrations/tasks/readWorkspace'&&frame.result?.status==='completed'){observedWorkspace=frame.result.result;snapshots.push(observedWorkspace)}}catch{}})});


 try{
  await page.goto(gateway.baseUrl,{waitUntil:'domcontentloaded'});await page.locator('input[name="token"]').fill(gateway.authToken);await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login')),page.locator('button[type="submit"]').click()]);
  await page.getByTestId('chat-message-input').waitFor({timeout:30000});
  await page.getByTestId('chat-message-input').fill('EXACT_PARENT_START: start the owned member');await waitFor(()=>page.getByTestId('send-message-button').isEnabled(),15000,'configured exact Provider selection');await page.getByTestId('send-message-button').click();
  await waitFor(()=>Boolean(spawnedId&&originalThread),30000,'actual native parent/member creation');
  await page.waitForFunction(()=>document.body.innerText.includes('PARENT_ORIGINAL_TASK_READY'),undefined,{timeout:30000});
  await page.getByTestId('task-workspace-button').click();await page.waitForURL(url=>url.pathname==='/tasks');
  const taskSpace=page.getByTestId('native-task-workspace');await taskSpace.waitFor();
  const select=taskSpace.getByTestId('task-workspace-thread-select');
  const choice=await select.locator('option').evaluateAll((values,thread)=>values.map(value=>({value:value.value,label:value.textContent})).find(value=>{try{return JSON.parse(value.value)[0]===thread}catch{return false}}),originalThread);assert.ok(choice?.value);await select.selectOption(choice.value);
  await taskSpace.getByTestId('task-workspace-observation').waitFor({timeout:30000});
  const entry=observedWorkspace.entries.find(value=>value.reference.kind==='agent'&&value.reference.agentId===spawnedId);assert.ok(entry?.reference.backgroundRun,'Actual native task observation must supply the complete member key');const run=entry.reference.backgroundRun;assert.equal(run.parentSessionId,originalThread);
  const index=observedWorkspace.entries.indexOf(entry);await taskSpace.getByTestId(`task-workspace-open-reference-${index}`).click();
  const view=page.getByTestId('subagent-workspace');await view.waitFor({timeout:30000});await waitFor(async()=> (await view.getByTestId('subagent-workspace-records').innerText()).includes('FIRST_ORIGINAL_MEMBER_DELTA'),15000,'actual original member stream');
  await view.getByTestId('subagent-workspace-input').waitFor({timeout:15000});
  assert.equal(await view.getByTestId('subagent-workspace-stop').count(),1);assert.equal(await view.getByTestId('subagent-workspace-archive').count(),0);
  await view.getByTestId('subagent-workspace-input').fill('EXACT_MEMBER_FOLLOWUP');
  await view.getByTestId('subagent-workspace-send').click();
  await waitFor(()=>wire.some(value=>value.method==='agent/steer'&&value.expected?.runId===run.runId),15000,'actual constrained original-member command');
  assert.ok(wire.some(value=>value.method==='agent/stream/subscribe'&&value.expected?.parentSessionId===run.parentSessionId&&value.expected?.agentId===run.agentId&&value.expected?.runId===run.runId),'Full original key must cross the genuine transport');
  await page.screenshot({path:context.pathInArtifacts('native-task-member-exact-readonly-stream.png'),fullPage:true});
  second=true;await waitFor(async()=> (await view.getByTestId('subagent-workspace-records').innerText()).includes('SECOND_ORIGINAL_MEMBER_DELTA'),15000,'incremental same original run');
  finish=true;await waitFor(async()=> (await view.getByTestId('subagent-workspace-records').innerText()).includes('ORIGINAL_MEMBER_FOLLOWUP_APPLIED'),15000,'original native FIFO applied the manual instruction');await waitFor(async()=> (await view.innerText()).includes('完成'),15000,'completed same original member remains readable');assert.ok((await view.getByTestId('subagent-workspace-records').innerText()).includes('FIRST_ORIGINAL_MEMBER_DELTA'));
  const control=async(method,params)=>page.evaluate(async({method,params})=>{
    const invoke=window.__ELECTRON_INTERNALS__?.invoke;if(typeof invoke!=='function')throw new Error('Actual Gateway IPC is unavailable');
    return invoke('local_executor_request',{method,params});
  },{method,params});
  const listing=await control('runtime.tasks.list',{deviceId:'local'});
  const parents=listing.workspaces.flatMap(workspace=>workspace.tasks.filter(task=>task.threadId===originalThread).map(task=>({runtime:'kcoder',deviceId:workspace.deviceId,taskId:task.taskId,threadId:task.threadId,workspacePath:task.workspacePath,runtimeHandle:task.runtimeHandle})));
  assert.equal(parents.length,1,'Use one actual original runtime address, never infer an alias');const originalAddress=parents[0];
  await view.getByTestId('subagent-workspace-input').fill('EXACT_MEMBER_RESTART');
  await view.getByTestId('subagent-workspace-send').click();
  await waitFor(()=>wire.some(value=>value.method==='agent/continue'&&value.expected?.runId===run.runId),15000,'explicit original completed-member continuation');
  const next=await waitFor(async()=>{const result=await control('runtime.tasks.agent_list',{address:originalAddress});const value=result.agents.find(value=>value.agentId===spawnedId);return value?.backgroundRun?.runId!==run.runId?value:null},15000,'actual replacement native run');assert.notEqual(next.backgroundRun.runId,run.runId);
  await waitFor(async()=> (await view.innerText()).includes('精确成员运行'),15000,'old exact observer closes after genuine run change');assert.ok(!(await view.getByTestId('subagent-workspace-records').innerText()).includes('NEW_RUN_MUST_NOT_REPLACE_ORIGINAL_VIEW'));
  await page.screenshot({path:context.pathInArtifacts('native-task-member-original-run-closed.png'),fullPage:true});
  await view.getByTestId('subagent-workspace-back').click();await page.waitForURL(url=>url.pathname==='/runtime-tasks');
  await page.getByTestId('task-workspace-button').click();await page.waitForURL(url=>url.pathname==='/tasks');
  const refreshed=page.getByTestId('native-task-workspace');await refreshed.waitFor();
  const originalOption=await refreshed.getByTestId('task-workspace-thread-select').locator('option').evaluateAll((values,thread)=>values.map(value=>({value:value.value})).find(value=>{try{return JSON.parse(value.value)[0]===thread}catch{return false}}),originalThread);
  assert.ok(originalOption);await refreshed.getByTestId('task-workspace-thread-select').selectOption(originalOption.value);
  await waitFor(()=>observedWorkspace?.entries?.some(value=>value.reference?.kind==='agent'&&value.reference.backgroundRun?.runId===next.backgroundRun.runId),15000,'current observed replacement run');
  const replacementIndex=observedWorkspace.entries.findIndex(value=>value.reference?.kind==='agent'&&value.reference.backgroundRun?.runId===next.backgroundRun.runId);
  await refreshed.getByTestId(`task-workspace-open-reference-${replacementIndex}`).click();
  const currentView=page.getByTestId('subagent-workspace');await currentView.getByTestId('subagent-workspace-stop').waitFor({timeout:15000});
  await currentView.getByTestId('subagent-workspace-stop').click();
  await waitFor(()=>wire.some(value=>value.method==='agent/stop'&&value.expected?.runId===next.backgroundRun.runId),15000,'exact current member stop');
  const terminal=await waitFor(async()=>{const value=await control('runtime.tasks.agent_list',{address:originalAddress});return value.agents.find(item=>item.agentId===spawnedId&&item.backgroundRun?.runId===next.backgroundRun.runId&&item.status==='cancelled')},15000,'actual cancelled original replacement run');
  assert.equal(terminal.acceptingMessages,false);
  await page.screenshot({path:context.pathInArtifacts('native-task-member-exact-stop.png'),fullPage:true});
  assert.deepEqual(protocolErrors,[]);assert.deepEqual(errors,[]);
  await context.writeArtifactJson('native-task-member-exact-evidence.json',{schemaVersion:1,actualAuthenticatedGateway:true,actualNativeParent:originalThread,originalRun:run,replacementRun:next.backgroundRun,exactNativeSteering:true,exactNativeStop:true,archiveAbsent:true,oldRunNeverReplaced:true,ordinaryParentNavigation:true,modelRequests:model.requests.length,fixtureStages:stages,wire,limitations:['Fixed Provider chooses protocol only; no paid-model or native desktop quality claim.']});return {fullOriginalRun:true,exactNativeSteering:true,exactNativeStop:true,actualNewRunClosesOldObserver:true,explicitOriginalParent:true};
 }catch(error){await context.writeArtifactJson('native-task-member-failure.json',{error:error.message,errors,protocolErrors,wire,stages,body:(await page.locator('body').innerText().catch(()=>'' )).slice(0,12000)});await page.screenshot({path:context.pathInArtifacts('native-task-member-failure.png'),fullPage:true}).catch(()=>{});throw error}
 finally{second=true;finish=true;replacementFinish=true;await page.close()}
});
