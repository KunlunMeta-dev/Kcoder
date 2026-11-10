import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url,{testId:'task-source-original-saved-and-resident-native-browser',tier:'full-integration',modelPolicy:'Two bounded deterministic ordinary text turns create actual Native source bindings for a real owned MCP fixture. Explicit selection enriches the existing task snapshot through its complete original tuple; absent runtime receipts stay unknown. One genuine source reply is delayed to check cancellation and late-result isolation. No source tool/model quality or external account claim.',retainSuccessEvidence:true},async context=>{
  const binary=await requireExecutable(process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'),'current source-control Native');
  const model=await startApprovalModelFixture(context,{responseSteps:({requestNumber})=>{assert.ok(requestNumber<=2,'Source records cannot call a model');return[{delta:{content:`ACTUAL_ORIGINAL_SOURCE_TURN_${requestNumber}_READY`}},{finishReason:'stop'}]}});
  const {path:workspace}=await materializeWorkspace(context,'minimal',{instanceId:'original-source-records'}),profile=context.pathInState('profile'),mcp=context.pathInState('mcp');await mkdir(mcp,{recursive:true,mode:0o700});
  await context.writeStateJson('profile/settings.json',{active_provider:'source-records',model:'source-records',permission_mode:'bypass',max_retries:0,session_memory:{enabled:false},
    providers:{'source-records':{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'source-records',context_window_tokens:128000,max_output_tokens:4096,output_headroom_tokens:8192,no_proxy:true,discover_models:false}},
    mcp_servers:[{name:'owned-server',transport:'stdio',command:'python3',args:[resolve(repoRoot,'crates/kcoder_mcp/tests/fixtures/apps_server.py'),'normal',mcp]}]});
  const serversFile=await context.writeStateJson('servers.json',[{id:'local',label:'Original source records Native',transport:'local',command:binary,workspace}]);
  let gateway=await startGateway(context,{label:'source-records-live-gateway',workspace,serversFile,kcoderBin:binary,auth:true,uiReceiptFault:true,...(process.env.KCODER_E2E_GATEWAY_ROOT?{gatewayRoot:process.env.KCODER_E2E_GATEWAY_ROOT}:{}),env:{KCODER_CONFIG_DIR:profile}});
  const browser=await startChromium(context),errors=[],turns=[],completed=[],wire=[],snapshots=[],indexObservations=[],phases=[];
  let page=await browser.newPage({viewport:{width:1400,height:1000}});
  const observe=page=>{
    page.on('pageerror',error=>errors.push(error.message));
    page.on('websocket',socket=>{
      const pending=new Map();
      socket.on('framesent',event=>{try{const frame=JSON.parse(String(event.payload));if(frame.method){pending.set(String(frame.id),{method:frame.method,payload:frame.params?.payload});wire.push({method:frame.method,payload:frame.method.startsWith('integrations/tasks/')?frame.params?.payload:undefined})}}catch{/* No raw frames or credentials are retained. */}});
      socket.on('framereceived',event=>{try{
        const frame=JSON.parse(String(event.payload)),request=pending.get(String(frame.id));pending.delete(String(frame.id));
        if(frame.method==='turn/started')turns.push({threadId:frame.params.threadId,turnId:frame.params.turnId??frame.params.turn.id,attemptId:frame.params.attemptId??frame.params.turn.attemptId});
        if(frame.method==='turn/completed')completed.push(frame.params);
        if(request?.method==='integrations/tasks/readWorkspace'&&frame.result?.status==='completed')snapshots.push({request:request.payload,result:frame.result.result});
        if(['runtime.models.list','thread/start','turn/start','thread/list'].includes(request?.method)){
          const active=frame.result?.activeConfiguration;
          phases.push({method:request.method,rpcErrorCode:frame.error?.code??null,
            threadId:frame.result?.thread?.id??null,turnId:frame.result?.turn?.id??null,
            turnStatus:frame.result?.turn?.status??null,threadCount:frame.result?.threads?.length??null,
            completeness:frame.result?.completeness??null,issueCount:frame.result?.issueCount??null,
            activeModel:active?{providerId:active.providerId,modelId:active.modelId,revision:active.revision}:null});
        }
      }catch{/* The unmodified client validates native protocol frames. */}});
    });
  };
  observe(page);
  const faultEvidence=async()=>JSON.parse(await readFile(context.pathInArtifacts('ui-receipt-fault.json'),'utf8').catch(()=>'{}'))['task-source-current'];
  const tuple=target=>target?JSON.stringify([target.initialAttempt.threadId,target.initialAttempt.turnId,target.initialAttempt.attemptId,target.runtimeOperationId??null]):null;
  const observeWorkspace=async(target,after=0)=>await waitFor(()=>snapshots.slice(after).findLast(value=>tuple(value.result.sourceTarget)===tuple(target)),15000,'actual original source-target task workspace response');
  const verifyUnknownRuntime=snapshot=>{
    assert.equal(snapshot.runtime??null,null,'An ordinary source record has no canonical runtime acceptance');
    const runtime=snapshot.facets.find(facet=>facet.kind==='runtime');assert.equal(runtime.availability,'unknown');assert.equal(runtime.observedCount,null);
  };
  const control=(method,params)=>page.evaluate(async({method,params})=>{const invoke=window.__ELECTRON_INTERNALS__?.invoke;if(typeof invoke!=='function')throw Error('Actual LocalExecutor IPC unavailable');return await invoke('local_executor_request',{method,params})},{method,params});
  const envelope=(scope,requestId,payload,operationId)=>({contractVersion:'parallel-v1',requestId,scope,timeoutMs:15000,payload,...(operationId?{operationId}:{})});
  try{
    await page.goto(gateway.baseUrl,{waitUntil:'domcontentloaded'});await page.locator('input[name="token"]').fill(gateway.authToken);await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login')),page.locator('button[type="submit"]').click()]);
    const send=async(text,number)=>{const input=page.getByTestId('chat-message-input');await input.waitFor({timeout:30000});await page.getByTestId('model-selector-button').waitFor({timeout:30000});await waitFor(async()=>await page.getByTestId('model-selector-button').isEnabled()&&(await page.getByTestId('model-selector-loading').count())===0,15000,'actual target model controls ready');await input.fill(text);await waitFor(()=>page.getByTestId('send-message-button').isEnabled(),15000,'configured original source task');await page.getByTestId('send-message-button').click();await waitFor(()=>turns.length>=number&&completed.some(value=>(value.turnId??value.turn?.id)===turns[number-1].turnId),30000,'actual original source turn completion')};
    await send('Create the first explicit original source record; return one bounded sentence.',1);
    const first=turns[0];assert.ok(first.attemptId);
    const originals=await waitFor(async()=>{
      const actualListing=await control('runtime.tasks.list',{deviceId:'local'});
      assert.ok(Array.isArray(actualListing.workspaces),'The actual task index must return its public workspace list');
      indexObservations.push({groups:actualListing.workspaces.map(group=>({deviceId:group.deviceId,workspacePath:group.workspacePath,
        available:group.available,threadsComplete:group.threadsComplete,threadListIssueCount:group.threadListIssueCount,
        threadListSyncFailed:group.threadListSyncFailed??false,taskRefs:group.tasks.map(task=>({taskId:task.taskId,threadId:task.threadId,ephemeral:task.ephemeral??false}))}))});
      if(indexObservations.length>20)indexObservations.shift();
      const matches=actualListing.workspaces.filter(group=>group.deviceId==='local').flatMap(group=>group.tasks.filter(task=>task.threadId===first.threadId).map(task=>({deviceId:group.deviceId,taskId:task.taskId,threadId:task.threadId,workspacePath:task.workspacePath})));
      assert.ok(matches.length<=1,'The exact original thread cannot resolve to ambiguous target workspaces');
      return matches.length===1?matches:undefined;
    },15000,'the completed original thread in its actual native task index',250);
    const actualWorkspace=originals[0].workspacePath;assert.ok(actualWorkspace);
    const scope=await control('runtime.integrations.request',{serverId:'local',workspacePath:actualWorkspace,method:'integrations/scope/read',params:{}});
    const sourceRead=async(method,payload,operationId)=>await control('runtime.integrations.request',{serverId:'local',workspacePath:actualWorkspace,method,params:envelope(scope,`diagnose-${method.split('/').at(-1)}`,payload,operationId)});
    const directoryBefore=await sourceRead('integrations/tasks/readSavedTaskSourceBindings',{threadId:first.threadId});
    const exactBefore=await sourceRead('integrations/tasks/readTaskSources',{target:{initialAttempt:first},params:{threadId:first.threadId}});
    await context.writeArtifactJson('native-task-source-precontrol.json',{configuredWorkspaceMatchesActual:workspace===actualWorkspace,originalTuple:first,directoryStatus:directoryBefore.status,directoryCode:directoryBefore.error?.code??null,directoryState:directoryBefore.result?.observationState??null,entries:directoryBefore.result?.entries?.map(row=>({referenceId:row.referenceId,target:row.target,state:row.observationState})),readStatus:exactBefore.status,readCode:exactBefore.error?.code??null});

    const selection={mode:'none',sources:[]},originalTarget={initialAttempt:first};
    const changed=await control('runtime.integrations.request',{serverId:'local',workspacePath:actualWorkspace,method:'integrations/tasks/setTaskSources',params:{...envelope(scope,'explicit-owned-first-source-selection',{target:originalTarget,params:{threadId:first.threadId,selection}},`source-record-${context.seed}`),expectedRevision:String(exactBefore.result.revision)}});
    assert.equal(changed.status,'completed');assert.equal(changed.result.snapshot.selection.mode,'none');
    await send('Create the second explicit original source record; retain its separate initial selection.',2);
    const second=turns[1];assert.equal(second.threadId,first.threadId);assert.notEqual(second.attemptId,first.attemptId);
    const before=wire.length,beforeModel=model.requests.length;assert.equal(beforeModel,2);
    await page.getByTestId('task-workspace-button').click();await page.waitForURL(url=>url.pathname==='/tasks');
    const tasks=page.getByTestId('native-task-workspace'),select=tasks.getByTestId('task-workspace-thread-select');await select.waitFor();
    const selected=await waitFor(()=>select.locator('option').evaluateAll((values,id)=>values.find(value=>{try{return JSON.parse(value.value)[0]===id}catch{return false}})?.value,first.threadId),30000,'actual original source thread index');await select.selectOption(selected);await tasks.getByTestId('task-workspace-observation').waitFor();
    const records=tasks.getByTestId('task-capability-scope-records');await records.waitFor();
    await records.getByRole('button',{name:new RegExp(first.turnId)}).waitFor({timeout:30000});
    assert.equal(wire.slice(before).filter(value=>value.method==='integrations/tasks/readTaskSources').length,0,'Opening the directory never selects its first/latest binding');
    assert.equal(wire.slice(before).filter(value=>value.method==='integrations/tasks/readWorkspace'&&value.payload?.sourceTarget).length,0,'Opening the directory never enriches the first/latest source implicitly');
    const initialSnapshot=await observeWorkspace(undefined);assert.equal(initialSnapshot.result.sourceSelection??null,null);verifyUnknownRuntime(initialSnapshot.result);
    const firstBoundary=snapshots.length;
    await records.getByRole('button',{name:new RegExp(first.turnId)}).click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="task-capability-scope-selected-record"]')?.getAttribute('data-state')==='current',undefined,{timeout:30000});
    const chosen=records.getByTestId('task-capability-scope-selected-record');assert.ok((await chosen.innerText()).includes('已保存记录'));assert.equal(await chosen.getByTestId('task-capability-scope-readonly-snapshot').count(),2);
    const firstObservation=await observeWorkspace(originalTarget,firstBoundary);
    assert.equal(tuple(firstObservation.request.sourceTarget),tuple(originalTarget));assert.equal(firstObservation.result.sourceSelection.selection.mode,'none');
    const firstSources=firstObservation.result.facets.find(facet=>facet.kind==='sources');assert.equal(firstSources.availability,'available');assert.equal(firstSources.observedCount,0);verifyUnknownRuntime(firstObservation.result);
    assert.equal(firstObservation.result.thread.reference.threadId,first.threadId);
    assert.ok(wire.slice(before).some(value=>value.method==='integrations/tasks/readTaskSources'&&value.payload?.target?.initialAttempt.attemptId===first.attemptId));
    assert.ok(!wire.slice(before).some(value=>['thread/start','thread/resume','turn/start','integrations/tasks/setTaskSources'].includes(value.method)),'Reading an original source does not create, resume, execute or mutate a task');
    assert.equal(await records.getByRole('radio').count(),0);assert.equal(await records.getByRole('checkbox').count(),0);assert.equal(model.requests.length,beforeModel);
    await chosen.scrollIntoViewIfNeeded();
    await page.screenshot({path:context.pathInArtifacts('native-task-original-source-current.png'),fullPage:true});
    const secondBoundary=snapshots.length;
    await records.getByRole('button',{name:new RegExp(second.turnId)}).click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="task-capability-scope-selected-record"]')?.getAttribute('data-state')==='current',undefined,{timeout:30000});
    await chosen.getByText('原始任务引用',{exact:true}).click();
    assert.ok((await chosen.innerText()).includes(second.attemptId));assert.ok((await chosen.innerText()).includes('沿用原会话选择'));
    const secondTarget={initialAttempt:second},secondObservation=await observeWorkspace(secondTarget,secondBoundary);
    assert.equal(tuple(secondObservation.request.sourceTarget),tuple(secondTarget));assert.equal(secondObservation.result.sourceSelection.selection.mode,'inherit_current');
    const secondSources=secondObservation.result.facets.find(facet=>facet.kind==='sources');assert.equal(secondSources.availability,'available');assert.equal(secondSources.observedCount,secondObservation.result.sourceSelection.effectiveSources.length);assert.ok(secondSources.observedCount>0);verifyUnknownRuntime(secondObservation.result);
    await context.writeArtifactJson('ui-receipt-plan.json',{mode:'task-source-current',threadId:first.threadId});
    const releasePath=context.pathInArtifacts('ui-receipt-release-task-source-current');
    const releaseReceipt=async()=>{try{await writeFile(releasePath,'{}\n',{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error}};
    context.addCleanup('release original genuine source snapshot',releaseReceipt);
    await records.getByRole('button',{name:new RegExp(first.turnId)}).click();
    await waitFor(async()=>Boolean((await faultEvidence())?.held),15000,'one genuine Native source reply held for explicit cancel');
    const cancelBoundary=snapshots.length;
    await chosen.getByRole('button',{name:'取消读取',exact:true}).click();
    const cancelledObservation=await observeWorkspace(undefined,cancelBoundary);
    assert.equal(cancelledObservation.request.sourceTarget??null,null);assert.equal(cancelledObservation.result.sourceSelection??null,null);verifyUnknownRuntime(cancelledObservation.result);
    const cancelledSources=cancelledObservation.result.facets.find(facet=>facet.kind==='sources');assert.equal(cancelledSources.availability,'unknown');assert.equal(cancelledSources.observedCount,null);
    await releaseReceipt();
    const released=await waitFor(async()=>{const value=await faultEvidence();return value?.released?value:undefined},5000,'the original late source reply released without mutation');
    assert.equal(released.timedOut,false);assert.equal(released.cancelled,false);
    assert.equal(await chosen.getAttribute('data-state'),'unknown');assert.equal(await chosen.getByTestId('task-capability-scope-readonly-snapshot').count(),1);
    await tasks.getByTestId('task-workspace-records').click();
    assert.ok((await tasks.getByTestId('task-workspace-facet-sources').innerText()).includes('尚未观察'));
    assert.equal(model.requests.length,beforeModel,'Cancellation and the late original reply cannot execute another task');
    await page.screenshot({path:context.pathInArtifacts('native-task-source-enrichment-cancelled.png'),fullPage:true});
    const coldBoundary=wire.length;
    // Close only this run's actual page/connections and owned gateway before
    // opening a fresh native process. Never bypass another client's busy guard.
    await page.close();await context.stopOwned('source-records-live-gateway');
    gateway=await startGateway(context,{label:'source-records-cold-gateway',workspace,serversFile,kcoderBin:binary,auth:true,...(process.env.KCODER_E2E_GATEWAY_ROOT?{gatewayRoot:process.env.KCODER_E2E_GATEWAY_ROOT}:{}),env:{KCODER_CONFIG_DIR:profile}});
    page=await browser.newPage({viewport:{width:1400,height:1000}});observe(page);
    await page.goto(gateway.baseUrl,{waitUntil:'domcontentloaded'});await page.locator('input[name="token"]').fill(gateway.authToken);await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login')),page.locator('button[type="submit"]').click()]);
    await page.getByTestId('task-workspace-button').click();await page.waitForURL(url=>url.pathname==='/tasks');
    const coldTasks=page.getByTestId('native-task-workspace'),coldSelect=coldTasks.getByTestId('task-workspace-thread-select'),coldRecords=coldTasks.getByTestId('task-capability-scope-records'),coldChosen=coldRecords.getByTestId('task-capability-scope-selected-record');await coldSelect.waitFor();
    await waitFor(()=>coldSelect.locator('option').count().then(count=>count>1),30000,'cold task index does not activate a thread');await coldSelect.selectOption(selected);await coldTasks.getByTestId('task-workspace-observation').waitFor();await coldRecords.getByRole('button',{name:new RegExp(first.turnId)}).waitFor({timeout:30000});
    const coldSnapshotBoundary=snapshots.length;
    await coldRecords.getByRole('button',{name:new RegExp(first.turnId)}).click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="task-capability-scope-selected-record"]')?.getAttribute('data-state')==='unknown',undefined,{timeout:30000});
    assert.ok((await coldChosen.innerText()).includes('已保留保存记录'));assert.equal(await coldChosen.getByTestId('task-capability-scope-readonly-snapshot').count(),1);
    const coldObservation=await observeWorkspace(originalTarget,coldSnapshotBoundary);assert.equal(tuple(coldObservation.request.sourceTarget),tuple(originalTarget));assert.equal(coldObservation.result.sourceSelection??null,null);verifyUnknownRuntime(coldObservation.result);
    const coldSources=coldObservation.result.facets.find(facet=>facet.kind==='sources');assert.equal(coldSources.availability,'unknown');assert.equal(coldSources.observedCount,null);assert.equal(coldObservation.result.thread.reference.threadId,first.threadId);
    assert.ok(!wire.slice(coldBoundary).some(value=>['thread/resume','thread/start','turn/start'].includes(value.method)),'A cold source record must not resume or invent its former owner');assert.equal(model.requests.length,beforeModel);assert.deepEqual(errors,[]);
    await coldChosen.scrollIntoViewIfNeeded();
    await page.screenshot({path:context.pathInArtifacts('native-task-original-source-saved-only.png'),fullPage:true});
    const enrichment=value=>({request:value.request,sourceTarget:value.result.sourceTarget??null,sourceSelection:value.result.sourceSelection?{selection:value.result.sourceSelection.selection,revision:value.result.sourceSelection.revision,effectiveCount:value.result.sourceSelection.effectiveSources.length}:null,runtime:value.result.runtime??null,facets:value.result.facets.filter(facet=>['sources','runtime'].includes(facet.kind)),snapshotId:value.result.snapshotId});
    await context.writeArtifactJson('native-task-source-record-evidence.json',{originalThread:first.threadId,firstOriginalTuple:first,secondOriginalTuple:second,firstSelection:'none',secondSelection:'inherit_current',explicitOriginalSelectionOnly:true,currentResidentSnapshot:true,coldSavedOnly:true,coldCurrentUnknown:true,sourceTargetEnrichment:{initial:enrichment(initialSnapshot),first:enrichment(firstObservation),second:enrichment(secondObservation),cancelled:enrichment(cancelledObservation),cold:enrichment(coldObservation)},genuineCancelledReplyReleased:released.released,sourceMutationByViewer:false,taskResumeByViewer:false,providerCalls:model.requests.length,limitations:['The explicit owned driver set the first tuple selection before viewing; the readonly view never changes it.','Ordinary accepted turns have no runtime operation receipt; the Runtime facet correctly remains unknown, while actual Runtime Some is verified in the separate original-pump Native regression.','Opening saved metadata does not prove an active lease or current resource grants.','Fixed text responses and real owned MCP registration are protocol evidence, not model/platform quality.','No Windows/Electron acceptance is claimed.']});return{explicitOriginalTuple:true,currentAndSavedSeparate:true,explicitTaskSnapshotEnrichment:true,cancellationClearsSourceTarget:true,lateReplyIsolated:true,coldUnknownNoResume:true};
  }catch(error){await context.writeArtifactJson('native-task-source-record-failure.json',{error:error.message,errors,turns,completed,wire,phases,indexObservations,modelRequests:model.requests.length,body:(await page.locator('body').innerText().catch(()=>'')).slice(0,14000)});await page.screenshot({path:context.pathInArtifacts('native-task-source-record-failure.png'),fullPage:true}).catch(()=>{});throw error}
  finally{await page.close()}
});
