import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { toolResult, toolSteps } from '../office/native-download-model.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url,{testId:'task-parent-exact-approval-question-native-browser',tier:'full-integration',
  modelPolicy:'Bounded deterministic Provider selects a real native Bash approval and AskUserQuestion. The task-space card must respond to its original parent/turn/attempt/epoch/request only. This is actual protocol/tool/UI evidence, not model quality.',retainSuccessEvidence:true},async context=>{
  const binary=await requireExecutable(process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'),'actual Native parent interactions');
  const protocolErrors=[],browserErrors=[],wire=[],selectors=[],protocolReceipts=[],resourceErrors=[],nativeTurns=[];
  let shellExecuted=false,questionAnswered=false,originalThread;
  const model=await startApprovalModelFixture(context,{responseSteps:({body,requestNumber})=>{
    try{
      assert.ok(requestNumber<=8,'Bounded original parent protocol requests');
      const names=(body.tools??[]).map(value=>value.function?.name??value.name);
      const shell=toolResult(body,'task-parent-bash'),question=toolResult(body,'task-parent-question');
      if(question){questionAnswered=JSON.stringify(question).includes('Use approved source');assert.ok(questionAnswered,'The actual original question answer must reach its continuation');return[{delta:{content:'TASKSPACE_ORIGINAL_INTERACTIONS_CONFIRMED'}},{finishReason:'stop'}]}
      if(shell){protocolReceipts.push({kind:'shell',result:JSON.stringify(shell).slice(0,3000)});assert.ok(JSON.stringify(shell).includes('TASKSPACE_APPROVAL_NATIVE_ALLOWED'),'Actual approved command must produce the original marker');shellExecuted=true;
        if(names.includes('AskUserQuestion'))return toolSteps('task-parent-question','AskUserQuestion',{questions:[{question:'Which source should the original parent task use?',header:'Original source',options:[{label:'Use approved source',description:'Continue with the original approved material'},{label:'Stop the original task',description:'Do not continue'}],multi_select:false}]});
        if(toolResult(body,'task-parent-question-discovery'))return toolSteps('task-parent-question','tool_execute',{tool_name:'AskUserQuestion',arguments:{questions:[{question:'Which source should the original parent task use?',header:'Original source',options:[{label:'Use approved source',description:'Continue with the original approved material'},{label:'Stop the original task',description:'Do not continue'}],multi_select:false}]}})
        return toolSteps('task-parent-question-discovery','tool_search',{query:'AskUserQuestion',limit:1})
      }
      if(names.includes('bash'))return toolSteps('task-parent-bash','bash',{command:'printf TASKSPACE_APPROVAL_NATIVE_ALLOWED',description:'Print a fixed marker for the owned task-space approval test'});
      if(toolResult(body,'task-parent-bash-discovery'))return toolSteps('task-parent-bash','tool_execute',{tool_name:'Bash',arguments:{command:'printf TASKSPACE_APPROVAL_NATIVE_ALLOWED',description:'Print a fixed marker for the owned task-space approval test'}})
      return toolSteps('task-parent-bash-discovery','tool_search',{query:'Bash',limit:1})
    }catch(error){protocolErrors.push(error.message);return[{delta:{content:'TASKSPACE_INTERACTION_PROTOCOL_FAILURE'}},{finishReason:'stop'}]}
  }});
  const {path:workspace}=await materializeWorkspace(context,'minimal',{instanceId:'task-parent-interactions'}),profile=context.pathInState('profile');
  await context.writeStateJson('profile/settings.json',{active_provider:'parent-interaction',model:'parent-interaction',permission_mode:'ask',max_retries:0,session_memory:{enabled:false},providers:{'parent-interaction':{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'parent-interaction',context_window_tokens:128000,max_output_tokens:4096,output_headroom_tokens:8192,no_proxy:true,discover_models:false}}});
  const serversFile=await context.writeStateJson('servers.json',[{id:'local',label:'Original parent interaction Native',transport:'local',command:binary,workspace}]);
  const gateway=await startGateway(context,{workspace,serversFile,kcoderBin:binary,auth:true,...(process.env.KCODER_E2E_GATEWAY_ROOT?{gatewayRoot:process.env.KCODER_E2E_GATEWAY_ROOT}:{}),env:{KCODER_CONFIG_DIR:profile}});
  const browser=await startChromium(context),page=await browser.newPage({viewport:{width:1400,height:1000}});
  page.on('pageerror',error=>browserErrors.push(error.message));
  page.on('requestfailed',request=>{const url=new URL(request.url());resourceErrors.push({path:url.pathname,error:request.failure()?.errorText})});
  page.on('response',response=>{if(response.status()>=400){const url=new URL(response.url());resourceErrors.push({path:url.pathname,status:response.status()})}});
  page.on('websocket',socket=>{socket.on('framesent',event=>{try{const frame=JSON.parse(String(event.payload));if(frame.method){wire.push({method:frame.method,...(frame.method==='interaction/status/read'?{selector:frame.params}:{})});if(frame.method==='interaction/status/read')selectors.push(frame.params)}}catch{}});socket.on('framereceived',event=>{try{const frame=JSON.parse(String(event.payload));if(frame.result?.thread?.id)originalThread=frame.result.thread.id;if(frame.method==='turn/started')nativeTurns.push({threadId:frame.params?.threadId,turnId:frame.params?.turnId??frame.params?.turn?.id,attemptId:frame.params?.attemptId??frame.params?.turn?.attemptId})}catch{}})});
  try{
    await page.goto(gateway.baseUrl,{waitUntil:'domcontentloaded'});await page.locator('input[name="token"]').fill(gateway.authToken);await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login')),page.locator('button[type="submit"]').click()]);
    const worker=page.getByRole('button',{name:'KWorker',exact:true});if(await worker.count())await worker.click();
    const input=page.getByTestId('chat-message-input');await input.waitFor({timeout:30000});await input.fill('Explicitly run the bounded original parent approval and source-question protocol test.');await waitFor(()=>page.getByTestId('send-message-button').isEnabled(),15000,'actual configured model');await page.getByTestId('send-message-button').click();
    await page.getByTestId('request-user-input-card').waitFor({timeout:30000});await waitFor(()=>originalThread,15000,'actual original thread receipt');
    const requestsBeforeRead=model.requests.length;assert.equal(shellExecuted,false,'Command must remain blocked before a real user approval');
    await page.getByTestId('task-workspace-button').click();await page.waitForURL(url=>url.pathname==='/tasks');
    const tasks=page.getByTestId('native-task-workspace'),select=tasks.getByTestId('task-workspace-thread-select');await select.waitFor();
    const selected=await waitFor(()=>select.locator('option').evaluateAll((values,id)=>values.find(value=>{try{return JSON.parse(value.value)[0]===id}catch{return false}})?.value,originalThread),30000,'original active task in task-space index');await select.selectOption(selected);await tasks.getByTestId('task-workspace-observation').waitFor({timeout:30000});
    const interactions=tasks.getByTestId('task-pending-interactions');await interactions.waitFor();
    const approval=interactions.getByTestId('request-user-input-card').filter({has:page.getByTestId('permission-approval-content')});await approval.waitFor({timeout:30000});
    assert.equal(model.requests.length,requestsBeforeRead,'Reading an approval must not call a model');
    const approvalSelector=await waitFor(()=>selectors.find(selector=>selector.kind==='approval'),15000,'actual original native approval receipt');assert.equal(approvalSelector.threadId,originalThread);assert.ok(approvalSelector.appServerEpoch);assert.ok(approvalSelector.turnId);
    const control=(method,params)=>page.evaluate(async({method,params})=>{
      const invoke=window.__ELECTRON_INTERNALS__?.invoke;if(typeof invoke!=='function')throw new Error('Actual LocalExecutor IPC missing');
      return await invoke('local_executor_request',{method,params});
    },{method,params});
    const listing=await control('runtime.tasks.list',{deviceId:'local'});
    const addresses=listing.workspaces.flatMap(workspace=>workspace.tasks.filter(task=>task.threadId===originalThread).map(task=>({deviceId:workspace.deviceId,taskId:task.taskId,threadId:task.threadId,workspacePath:task.workspacePath,...(task.runtimeHandle?{runtimeHandle:task.runtimeHandle}:{})})));
    assert.equal(addresses.length,1,'Only the actual original task address may be used');
    const address=addresses[0], originalView=await control('runtime.tasks.interactions.read',{address});
    const originalApproval=originalView.items.find(item=>item.reference.selector.requestId===approvalSelector.requestId);
    assert.ok(originalApproval&&originalApproval.state==='pending');
    const nativeTurn=nativeTurns.find(turn=>turn.threadId===originalThread&&turn.turnId===approvalSelector.turnId);
    assert.ok(nativeTurn?.attemptId);assert.equal(originalApproval.reference.attemptId,nativeTurn.attemptId,'The UI reference must retain the actual accepted native attempt');
    const wrongAttempt=structuredClone(originalApproval.reference);wrongAttempt.attemptId='invented-attempt';
    const answers=Object.fromEntries(originalApproval.presentation.questions.map(question=>[question.id,{answers:['Allow once']}]));
    await assert.rejects(control('runtime.tasks.interactions.respond',{address,response:{reference:wrongAttempt,answers}}));
    await assert.rejects(control('runtime.tasks.interactions.respond',{address:{...address,deviceId:'foreign-target'},response:{reference:originalApproval.reference,answers}}));
    assert.equal(shellExecuted,false,'Forged selectors cannot approve or execute a native tool');
    await page.screenshot({path:context.pathInArtifacts('native-task-original-approval.png'),fullPage:true});
    await approval.getByText('仅允许这一次',{exact:true}).click();
    await waitFor(()=>shellExecuted,30000,'actual approved native command execution');
    // Ask mode also requires explicit permission before the question tool runs.
    const askPermission=interactions.getByTestId('request-user-input-card').filter({has:page.getByTestId('permission-approval-content')}).filter({hasText:'AskUserQuestion'});
    await askPermission.waitFor({timeout:30000});await askPermission.getByText('仅允许这一次',{exact:true}).click();
    const question=interactions.getByTestId('request-user-input-card').filter({hasNot:page.getByTestId('permission-approval-content')}).filter({hasText:'Which source should the original parent task use?'});await question.waitFor({timeout:30000});
    const questionSelector=await waitFor(()=>selectors.find(selector=>selector.kind==='question'),15000,'actual original native question receipt');assert.equal(questionSelector.threadId,originalThread);assert.equal(questionSelector.turnId,approvalSelector.turnId);assert.equal(questionSelector.appServerEpoch,approvalSelector.appServerEpoch);assert.notEqual(questionSelector.requestId,approvalSelector.requestId);
    await page.screenshot({path:context.pathInArtifacts('native-task-original-question.png'),fullPage:true});
    await question.getByText('Use approved source',{exact:true}).click();await waitFor(()=>questionAnswered,30000,'original native question answer returned to Provider');
    await waitFor(async()=>{const rows=await interactions.getByTestId('task-original-interaction').all();return rows.length===3&&(await Promise.all(rows.map(row=>row.getAttribute('data-state')))).every(state=>state==='resolved')},30000,'both original native interaction receipts resolved');
    const finalReceipts=await control('runtime.tasks.interactions.read',{address});assert.equal(finalReceipts.items.length,3);assert.ok(finalReceipts.items.every(item=>item.state==='resolved'&&item.reference.attemptId===nativeTurn.attemptId));
    assert.deepEqual(protocolErrors,[]);assert.deepEqual(browserErrors,[]);assert.ok(wire.filter(value=>value.method==='turn/start').length===1,'The view must not start a replacement turn');
    const confirms=wire.filter(value=>value.method==='interaction/status/read');assert.ok(confirms.length>=2);
    await page.screenshot({path:context.pathInArtifacts('native-task-original-interactions-confirmed.png'),fullPage:true});
    await context.writeArtifactJson('native-task-parent-interaction-evidence.json',{originalThreadId:originalThread,acceptedAttemptId:nativeTurn.attemptId,approval:approvalSelector,question:questionSelector,actualReferences:finalReceipts.items.map(item=>item.reference),forgedAttemptRejected:true,foreignTargetRejected:true,actualCommandRanAfterUserApproval:true,actualQuestionAnswerReachedOriginalContinuation:true,nativeReceiptsResolved:true,providerCalls:model.requests.length,turnStarts:1,readExtraProviderCalls:0,
      limitations:['Fixed Provider tool choices prove the actual tool/RPC/UI round trip, not model behavior quality.','The view does not auto-resume a disconnected or historical request owner.','No Windows/Electron native acceptance is claimed.']});
    return{actualApproval:true,actualQuestion:true,exactOriginalOwner:true,nativeResolved:true};
  }catch(error){await context.writeArtifactJson('native-task-parent-interaction-failure.json',{error:error.message,protocolErrors,browserErrors,resourceErrors,wire,selectors,protocolReceipts,modelRequests:model.requests.length,shellExecuted,questionAnswered,body:(await page.locator('body').innerText().catch(()=>'')).slice(0,14000)});await page.screenshot({path:context.pathInArtifacts('native-task-parent-interaction-failure.png'),fullPage:true}).catch(()=>{});throw error}
  finally{await page.close()}
});
