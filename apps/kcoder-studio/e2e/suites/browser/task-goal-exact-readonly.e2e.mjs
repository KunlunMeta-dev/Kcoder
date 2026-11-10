import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, isTurnCompletion, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'task-original-goal-readonly-native-browser', tier: 'full-integration',
  modelPolicy: 'One bounded deterministic text turn publishes an actual original conversation. Goal state, history reads, replacement and reference mismatch use real native public RPC. No Goal execution or model-quality claim.', retainSuccessEvidence: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot,'target/debug/kcoder'), 'actual Native Goal');
  const model = await startApprovalModelFixture(context, { responseSteps: ({requestNumber}) => {
    assert.ok(requestNumber<=2,'Goal observation must not create model continuations');
    return [{delta:{content:'ACTUAL_ORIGINAL_GOAL_CONTAINER_READY'}},{finishReason:'stop'}];
  } });
  const { path:workspace }=await materializeWorkspace(context,'minimal',{instanceId:'fixed-goal-reader'});
  const profile=context.pathInState('profile');
  await context.writeStateJson('profile/settings.json',{active_provider:'goal-protocol',model:'goal-protocol',permission_mode:'bypass',max_retries:0,session_memory:{enabled:false},providers:{'goal-protocol':{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'goal-protocol',context_window_tokens:128000,max_output_tokens:4096,output_headroom_tokens:8192,no_proxy:true,discover_models:false}}});
  const serversFile=await context.writeStateJson('servers.json',[{id:'local',label:'Original Goal Native',transport:'local',command:binary,workspace}]);
  const gateway=await startGateway(context,{workspace,serversFile,kcoderBin:binary,auth:true,...(process.env.KCODER_E2E_GATEWAY_ROOT?{gatewayRoot:process.env.KCODER_E2E_GATEWAY_ROOT}:{}),env:{KCODER_CONFIG_DIR:profile}});
  const browser=await startChromium(context), page=await browser.newPage({viewport:{width:1400,height:1000}});
  const errors=[], wire=[],snapshots=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('websocket',socket=>{const pending=new Map();socket.on('framesent',event=>{try{const frame=JSON.parse(String(event.payload));if(frame.method){pending.set(String(frame.id),frame.method);wire.push(frame.method)}}catch{}});socket.on('framereceived',event=>{try{const frame=JSON.parse(String(event.payload)),method=pending.get(String(frame.id));pending.delete(String(frame.id));if(method==='integrations/tasks/readWorkspace'&&frame.result?.status==='completed')snapshots.push(frame.result.result)}catch{}})});
  let seed;
  try {
    await page.goto(gateway.baseUrl,{waitUntil:'domcontentloaded'});await page.locator('input[name="token"]').fill(gateway.authToken);await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login')),page.locator('button[type="submit"]').click()]);
    const csrf=await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content');assert.ok(csrf);context.registerSecret(csrf);
    const cookie=(await page.context().cookies(gateway.baseUrl)).map(value=>`${value.name}=${value.value}`).join('; ');context.registerSecret(cookie);
    seed=await openRpc(gatewayRpcUrl(gateway,'local',csrf),{headers:{Cookie:cookie,Origin:gateway.baseUrl}});context.addCleanup('close actual Goal source RPC',()=>closeRpcAndWait(seed));
    const initialized=await seed.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'actual-goal-observation-seed',version:'1'},capabilities:{experimental:{taskWorkspaceV1:true,integrationScopeV1:true,studioWorkModesV1:true,goalCancellationV1:true}}});assert.equal(initialized.capabilities?.experimental?.taskWorkspaceV1,true);
    const {thread}=await seed.request('thread/start',{cwd:workspace,studioWorkMode:'kworker'});
    const {turn}=await seed.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'Publish the original owned Goal observation conversation.'}]});await seed.waitFor(message=>isTurnCompletion(message,thread.id,turn.id),30000,'actual original Goal container');
    const objective='Read the exact original Goal and its recorded events. This paused Goal must not execute.';
    const created=await seed.request('thread/goal/set',{threadId:thread.id,objective,status:'paused',mode:'standard',requireNoGoal:true});assert.ok(created.goal?.goalId);assert.equal(created.goal.status,'paused');
    const first={...created.goal};await seed.request('thread/metadata/update',{threadId:thread.id,title:'Original Goal observation task'});
    const beforeCalls=model.requests.length;assert.equal(beforeCalls,1);
    await page.reload({waitUntil:'domcontentloaded'});await page.getByTestId('task-workspace-button').click();await page.waitForURL(url=>url.pathname==='/tasks');
    const tasks=page.getByTestId('native-task-workspace'),select=tasks.getByTestId('task-workspace-thread-select');await select.waitFor();
    const value=await waitFor(()=>select.locator('option').evaluateAll((values,id)=>values.find(value=>{try{return JSON.parse(value.value)[0]===id}catch{return false}})?.value,thread.id),30000,'actual original Goal task indexed');await select.selectOption(value);await tasks.getByTestId('task-workspace-observation').waitFor();
    const snapshot=snapshots.at(-1),index=snapshot.entries.findIndex(entry=>entry.reference.kind==='goal'&&entry.reference.goalId===first.goalId);assert.ok(index>=0);
    const beforeWire=wire.length;await tasks.getByTestId(`task-workspace-open-reference-${index}`).click();
    const view=page.getByTestId('task-goal-viewer');await view.waitFor();await view.getByText(objective,{exact:true}).first().waitFor();
    assert.equal(await view.locator('[data-testid="edit-goal-button"], [data-testid="pause-goal-button"], [data-testid="resume-goal-button"], [data-testid="clear-goal-button"]').count(),0);
    assert.ok((await view.innerText()).includes('最近'));assert.ok(wire.slice(beforeWire).includes('thread/goal/get'));
    assert.ok(!wire.slice(beforeWire).some(method=>['thread/resume','thread/start','turn/start','thread/goal/set','thread/goal/clear'].includes(method)),'Viewing does not resume/create/execute/edit the original Goal');
    assert.equal(model.requests.length,beforeCalls);
    await page.screenshot({path:context.pathInArtifacts('native-task-goal-original-records.png'),fullPage:true});
    // The external owned test driver replaces the current Goal through real CAS.
    // The view remains pinned to the original Goal and must reject this replacement.
    await seed.request('thread/goal/clear',{threadId:thread.id,expectedGoalId:first.goalId,expectedRevision:first.revision});
    const replaced=await seed.request('thread/goal/set',{threadId:thread.id,objective:'NEW_GOAL_MUST_NOT_REPLACE_ORIGINAL_VIEW',status:'paused',mode:'standard',requireNoGoal:true});assert.notEqual(replaced.goal.goalId,first.goalId);
    await view.getByTestId('task-goal-refresh').click();await view.getByRole('alert').waitFor();
    assert.ok((await view.getByRole('alert').innerText()).includes('未自动替换'));assert.equal(await view.getByText('NEW_GOAL_MUST_NOT_REPLACE_ORIGINAL_VIEW',{exact:true}).count(),0);assert.equal(await view.getByTestId('goal-status-bar').count(),0);
    await page.screenshot({path:context.pathInArtifacts('native-task-goal-original-reference-changed.png'),fullPage:true});
    assert.equal(model.requests.length,beforeCalls);await closeRpcAndWait(seed,'actual Goal source RPC');
    await view.getByRole('button',{name:/打开.*会话|Open.*conversation/i}).click();await page.waitForURL(url=>url.pathname==='/runtime-tasks');assert.deepEqual(errors,[]);
    await context.writeArtifactJson('native-task-goal-evidence.json',{originalThreadId:thread.id,originalGoalId:first.goalId,originalRevision:first.revision,replacementGoalId:replaced.goal.goalId,originalReferenceNeverReplaced:true,actualNativeGoalRead:true,noViewerGoalEdits:true,noViewerTaskResume:true,readonlyControlsAbsent:true,recordedEventsBound:5,providerCalls:model.requests.length,explicitOriginalParent:true,
      limits:['A deterministic ordinary text response publishes the native container; no model quality is asserted.','The explicit external test driver, not the viewer, replaces the Goal.','Only up to five original native events are returned; this is not a full task audit.','No Windows/Electron acceptance is claimed.']});return {originalGoal:true,actualNativeRead:true,referenceMismatchRejected:true,readonly:true,originalParent:true};
  } catch(error) {await context.writeArtifactJson('native-task-goal-failure.json',{error:error.message,errors,wire,providerCalls:model.requests.length,body:(await page.locator('body').innerText().catch(()=>'')).slice(0,12000)});await page.screenshot({path:context.pathInArtifacts('native-task-goal-failure.png'),fullPage:true}).catch(()=>{});throw error}
  finally {await page.close()}
});
