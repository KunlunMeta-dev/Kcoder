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
await runE2E(import.meta.url,{testId:'task-original-multiselect-lossless-native-browser',tier:'full-integration',
  modelPolicy:'Two bounded deterministic Provider requests select a real AskUserQuestion only. The actual UI submits two values once, native Host derives lossless answer_lists, and the same parent Provider continuation consumes it. No model-quality or new permission claim.',retainSuccessEvidence:true},async context=>{
  const binary=await requireExecutable(process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'),'current Native with host answer_lists');
  const expected=['Budget, revised','Original source'],prompt='Which materials should the original task adopt?';
  const protocolErrors=[],browserErrors=[],wire=[],turns=[],completed=[],answers=[],selectors=[];
  let observedResult;
  const model=await startApprovalModelFixture(context,{responseSteps:({body,requestNumber})=>{
    try{
      assert.ok(requestNumber<=2,'One question and one original continuation only');
      let result=toolResult(body,'actual-multiselect-question');
      if(result?.text){try{result=JSON.parse(result.text)}catch{/* Require structured native output below. */}}
      if(result){
        assert.deepEqual(result.annotations?.answer_lists,{'question-1':expected},'Use the Host-derived original vectors, never split a comma-containing legacy answer');
        assert.equal(result.annotations?.source_note,'Original fixture annotation');
        assert.equal(result.questions?.[0]?.multi_select,true);
        assert.equal(result.answers?.[prompt],expected.join(', '),'The legacy output remains compatible');
        observedResult={answerLists:result.annotations.answer_lists,legacyAnswer:result.answers[prompt]};
        return[{delta:{content:'ORIGINAL_NATIVE_MULTIPLE_ANSWERS_CONFIRMED'}},{finishReason:'stop'}];
      }
      const names=(body.tools??[]).map(value=>value.function?.name??value.name);assert.ok(names.includes('AskUserQuestion'));
      return toolSteps('actual-multiselect-question','AskUserQuestion',{questions:[{header:'Materials',question:prompt,options:[{label:expected[0],description:'Use the revised source with a comma in its real label'},{label:'Reference only',description:'Keep this as a reference'},{label:expected[1],description:'Keep the original supporting material'}],multi_select:true}],
        annotations:{source_note:'Original fixture annotation',answer_lists:{'question-1':['MODEL_CANNOT_SELF_CERTIFY_ANSWERS']}}});
    }catch(error){protocolErrors.push(error.message);return[{delta:{content:'MULTISELECT_PROTOCOL_FAILURE'}},{finishReason:'stop'}]}
  }});
  const {path:workspace}=await materializeWorkspace(context,'minimal',{instanceId:'native-multiple-question'}),profile=context.pathInState('profile');
  await context.writeStateJson('profile/settings.json',{active_provider:'multiple-protocol',model:'multiple-protocol',permission_mode:'bypass',max_retries:0,session_memory:{enabled:false},providers:{'multiple-protocol':{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'multiple-protocol',context_window_tokens:128000,max_output_tokens:4096,output_headroom_tokens:8192,no_proxy:true,discover_models:false}}});
  const serversFile=await context.writeStateJson('servers.json',[{id:'local',label:'Original multi-select Native',transport:'local',command:binary,workspace}]);
  const gateway=await startGateway(context,{workspace,serversFile,kcoderBin:binary,auth:true,...(process.env.KCODER_E2E_GATEWAY_ROOT?{gatewayRoot:process.env.KCODER_E2E_GATEWAY_ROOT}:{}),env:{KCODER_CONFIG_DIR:profile}});
  const browser=await startChromium(context),page=await browser.newPage({viewport:{width:1400,height:1000}});
  page.on('pageerror',error=>browserErrors.push(error.message));
  page.on('websocket',socket=>{
    socket.on('framesent',event=>{try{const frame=JSON.parse(String(event.payload));if(frame.method){wire.push(frame.method);if(frame.method==='interaction/status/read')selectors.push(frame.params)}if(frame.result?.answers)answers.push({id:frame.id,response:frame.result})}catch{}});
    socket.on('framereceived',event=>{try{const frame=JSON.parse(String(event.payload));if(frame.method==='turn/started')turns.push({threadId:frame.params.threadId,turnId:frame.params.turnId??frame.params.turn?.id,attemptId:frame.params.attemptId??frame.params.turn?.attemptId});if(frame.method==='turn/completed')completed.push(frame.params)}catch{}});
  });
  const control=(method,params)=>page.evaluate(async({method,params})=>{const invoke=window.__ELECTRON_INTERNALS__?.invoke;if(typeof invoke!=='function')throw Error('Actual LocalExecutor IPC unavailable');return await invoke('local_executor_request',{method,params})},{method,params});
  try{
    await page.goto(gateway.baseUrl,{waitUntil:'domcontentloaded'});await page.locator('input[name="token"]').fill(gateway.authToken);await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login')),page.locator('button[type="submit"]').click()]);
    const worker=page.getByRole('button',{name:'KWorker',exact:true});if(await worker.count())await worker.click();
    const input=page.getByTestId('chat-message-input');await input.waitFor({timeout:30000});await input.fill('Ask one actual multiple-choice question for this original task and wait for its user response.');await waitFor(()=>page.getByTestId('send-message-button').isEnabled(),15000,'explicit fixture model');await page.getByTestId('send-message-button').click();
    await page.getByTestId('request-user-input-card').waitFor({timeout:30000});await waitFor(()=>turns.length===1,15000,'actual original accepted turn');assert.equal(model.requests.length,1);
    const original=turns[0];
    await page.getByTestId('task-workspace-button').click();await page.waitForURL(url=>url.pathname==='/tasks');
    const tasks=page.getByTestId('native-task-workspace'),select=tasks.getByTestId('task-workspace-thread-select');await select.waitFor();const choice=await waitFor(()=>select.locator('option').evaluateAll((values,id)=>values.find(value=>{try{return JSON.parse(value.value)[0]===id}catch{return false}})?.value,original.threadId),30000,'original task index');await select.selectOption(choice);await tasks.getByTestId('task-workspace-observation').waitFor();
    const interactions=tasks.getByTestId('task-pending-interactions'),card=interactions.getByTestId('request-user-input-card');await card.waitFor({timeout:30000});
    const first=card.getByRole('button',{name:new RegExp(expected[0])}),second=card.getByRole('button',{name:new RegExp(expected[1])});
    assert.equal(await card.getByTestId('request-user-input-submit-button').isEnabled(),false);
    await first.click();await second.click();assert.equal(await first.getAttribute('aria-pressed'),'true');assert.equal(await second.getAttribute('aria-pressed'),'true');assert.equal(answers.length,0);assert.equal(model.requests.length,1,'Selecting options must not submit or resume the Provider');
    const nativeSelector=await waitFor(()=>selectors.find(value=>value.kind==='question'),15000,'actual original native request');assert.equal(nativeSelector.threadId,original.threadId);assert.equal(nativeSelector.turnId,original.turnId);
    await card.scrollIntoViewIfNeeded();await page.screenshot({path:context.pathInArtifacts('native-task-multiple-original-selection.png'),fullPage:true});
    await card.getByTestId('request-user-input-submit-button').click();await waitFor(()=>observedResult,30000,'actual Provider lossless answer lists');assert.deepEqual(protocolErrors,[]);
    await waitFor(()=>completed.some(value=>(value.turnId??value.turn?.id)===original.turnId&&value.turn?.status==='completed'),30000,'same original native turn completed');
    assert.equal(answers.length,1,'Only one original native QuestionResponse is sent');assert.deepEqual(answers[0].response.answers,{'question-1':{answers:expected}});assert.equal(answers[0].response.questionId,nativeSelector.questionId);assert.equal(answers[0].response.turnId,original.turnId);assert.equal(answers[0].response.threadId,original.threadId);
    const listing=await control('runtime.tasks.list',{deviceId:'local'}),addresses=listing.workspaces.flatMap(group=>group.tasks.filter(task=>task.threadId===original.threadId).map(task=>({deviceId:group.deviceId,taskId:task.taskId,threadId:task.threadId,workspacePath:task.workspacePath,...(task.runtimeHandle?{runtimeHandle:task.runtimeHandle}:{})})));assert.equal(addresses.length,1);const address=addresses[0];
    const receipt=await control('runtime.tasks.interactions.read',{address});assert.equal(receipt.items.length,1);assert.equal(receipt.items[0].reference.attemptId,original.attemptId);assert.equal(receipt.items[0].reference.selector.appServerEpoch,nativeSelector.appServerEpoch);assert.equal(receipt.items[0].state,'resolved');
    const duplicate=await control('runtime.tasks.interactions.respond',{address,response:{reference:receipt.items[0].reference,answers:{'question-1':{answers:expected}}}});assert.equal(duplicate.state,'resolved');assert.equal(answers.length,1,'Reconciliation never replays a resolved response');
    assert.equal(wire.filter(method=>method==='turn/start').length,1);assert.equal(model.requests.length,2);assert.deepEqual(browserErrors,[]);
    await interactions.scrollIntoViewIfNeeded();await page.screenshot({path:context.pathInArtifacts('native-task-multiple-original-confirmed.png'),fullPage:true});
    await interactions.getByTestId('task-interaction-open-parent').click();await page.waitForURL(url=>url.pathname==='/runtime-tasks');
    await context.writeArtifactJson('native-task-multiple-evidence.json',{original,selector:nativeSelector,originalReference:receipt.items[0].reference,nativeResponses:1,nativeAnswerVector:expected,providerAnswerLists:observedResult.answerLists,legacyAnswerPreserved:observedResult.legacyAnswer,modelAnnotationSpoofOverridden:true,turnStarts:1,providerRequests:2,duplicateReplayEffects:0,originalParentNavigation:true,limitations:['Fixed Provider choices establish native/tool/UI composition, not model quality.','No secret or source-agent request was fabricated to claim additional native support.','No Windows/Electron host acceptance is claimed.']});return{multipleNativeAnswers:true,losslessCommaLabel:true,singleOriginalResponse:true,sameNativeTurn:true};
  }catch(error){await context.writeArtifactJson('native-task-multiple-failure.json',{error:error.message,protocolErrors,browserErrors,turns,completed,answers,selectors,wire,modelRequests:model.requests.length,body:(await page.locator('body').innerText().catch(()=>'')).slice(0,14000)});await page.screenshot({path:context.pathInArtifacts('native-task-multiple-failure.png'),fullPage:true}).catch(()=>{});throw error}
  finally{await page.close()}
});
