import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {startApprovalModelFixture} from './approval-model.mjs';
import {startGateway} from './gateway.mjs';
import {startChromium} from './chromium.mjs';
import {requireExecutable,waitFor} from './run-context.mjs';
import {materializeWorkspace} from './workspace-fixture.mjs';

export async function verifyNativeTaskResourceBindingsUi(context){
 const binary=await requireExecutable(process.env.KCODER_E2E_KCODER_BIN,'explicit frozen Native resource UI candidate');
 const sha=createHash('sha256').update(await readFile(binary)).digest('hex');assert.equal(sha,process.env.KCODER_E2E_KCODER_BIN_SHA256);
 const {path:workspace}=await materializeWorkspace(context,'minimal');
 const model=await startApprovalModelFixture(context,{responseSteps:({requestNumber})=>{assert.equal(requestNumber,1);return[{delta:{content:'ORIGINAL_TASK_RESOURCE_SETTINGS_READY'}},{finishReason:'stop'}];}});
 const script=fileURLToPath(new URL('./application-resource-mcp.cjs',import.meta.url));
 await context.writeStateJson('profile/settings.json',{active_provider:'fixture',model:'owned-resource-ui',permission_mode:'bypass',credential_store:'file',max_retries:0,session_memory:{enabled:false},memory:{observer_mode:'disabled',structured_enabled:false,legacy_prompt_enabled:false},
  providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'owned-resource-ui',context_window_tokens:128000,max_output_tokens:256,output_headroom_tokens:256,discover_models:false,no_proxy:true}},
  integrations:{connectivity:{enabled:true}},mcp_servers:[{name:'owned-resource-ui',transport:'stdio',command:process.execPath,args:[script,'tencent_docs',context.pathInState('mcp-ui.jsonl')]}]});
 await context.writeStateJson('profile/trusted-folders.json',{trusted:[workspace],never:[]});
 const serversFile=await context.writeStateJson('servers.json',[{id:'local',label:'Owned task resource UI target',transport:'local',command:binary,workspace}]);
 const gateway=await startGateway(context,{auth:true,workspace,serversFile,kcoderBin:binary,startTimeoutMs:60000,gatewayRoot:process.env.KCODER_E2E_GATEWAY_ROOT,env:{KCODER_CONFIG_DIR:context.pathInState('profile')}});
 const browser=await startChromium(context),page=await browser.newPage({viewport:{width:1400,height:1000}});
 const turns=[],completed=[],writes=[],errors=[];
 let lastScope=null;
 page.on('pageerror',()=>errors.push('PAGE_SCRIPT_ERROR'));
 page.on('websocket',socket=>{
  const pending=new Map();
  socket.on('framesent',({payload})=>{try{const frame=JSON.parse(String(payload));if(frame.method)pending.set(String(frame.id),{method:frame.method,params:frame.params});}catch{}});
  socket.on('framereceived',({payload})=>{try{const frame=JSON.parse(String(payload)),request=pending.get(String(frame.id));pending.delete(String(frame.id));
   if(frame.method==='turn/started')turns.push({threadId:frame.params.threadId,turnId:frame.params.turnId,attemptId:frame.params.attemptId});
   if(frame.method==='turn/completed')completed.push(frame.params);
   if(request?.method==='integrations/tasks/setTaskSources')writes.push({request:request.params,result:frame.result});
  }catch{}});
 });
 const control=(method,params)=>page.evaluate(async({method,params})=>window.__ELECTRON_INTERNALS__.invoke('local_executor_request',{method,params}),{method,params});
 try{
  await page.goto(gateway.baseUrl,{waitUntil:'domcontentloaded'});await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login')),page.locator('button[type="submit"]').click()]);
  const scope=await control('runtime.integrations.request',{serverId:'local',workspacePath:workspace,method:'integrations/scope/read',params:{}});lastScope=scope;let serial=0;
  const call=async(method,payload,operationId,revision)=>{
   const result=await control('runtime.integrations.request',{serverId:'local',workspacePath:workspace,method,params:{contractVersion:'parallel-v1',requestId:`ui-resource-${++serial}`,scope,timeoutMs:30000,payload,...(operationId?{operationId}:{}),...(revision?{expectedRevision:String(revision)}:{})}});
   assert.equal(result.status,'completed',result.error?.code);return result.result;
  };
  let connection=await call('integrations/connectivity/prepareConnectionAction',{action:'save',connectionId:'approved-ui-application',kind:'tencent_docs',label:'Owned approved application',configuration:{mcpServerName:'owned-resource-ui'},resourceGrants:[]},'ui-application-save');
  connection=await call('integrations/connectivity/prepareConnectionAction',{action:'enable',connectionId:connection.id},'ui-application-enable',connection.revision);
  const discovered=await call('integrations/connectivity/readResourceGrant',{connectionId:connection.id,discover:true,limit:10});assert.equal(discovered.items.length,1);
  const {id,revision,kind}=discovered.items[0],reference={id,revision,kind};
  connection=await call('integrations/connectivity/prepareConnectionAction',{action:'setResources',connectionId:connection.id,resourceGrants:[reference]},'ui-application-select',connection.revision);
  const input=page.getByTestId('chat-message-input');await input.waitFor({timeout:30000});
  await waitFor(async()=>await page.getByTestId('model-selector-button').isEnabled()&&(await page.getByTestId('model-selector-loading').count())===0,15000,'original UI model ready');
  await input.fill('Create one original task for its application resource setting. Return one sentence.');await page.getByTestId('send-message-button').click();
  await waitFor(()=>turns.length===1&&completed.some(item=>item.turnId===turns[0].turnId),30000,'one original UI task terminal');
  const original=turns[0];assert.equal(typeof original.attemptId,'string');
  await page.getByTestId('task-workspace-button').click();await page.waitForURL(url=>url.pathname==='/tasks');
  const tasks=page.getByTestId('native-task-workspace'),select=tasks.getByTestId('task-workspace-thread-select');await select.waitFor();
  const selected=await waitFor(()=>select.locator('option').evaluateAll((options,id)=>options.find(option=>{try{return JSON.parse(option.value)[0]===id;}catch{return false;}})?.value,original.threadId),30000,'original task in real index');
  await select.selectOption(selected);const records=tasks.getByTestId('task-capability-scope-records');
  await records.getByRole('button',{name:new RegExp(original.turnId)}).click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="task-capability-scope-selected-record"]')?.getAttribute('data-state')==='current',undefined,{timeout:30000});
  const settings=records.getByTestId('native-task-capability-scope-settings');await settings.getByRole('button',{name:'设置任务工具与资源范围',exact:true}).click();
  const resources=settings.getByRole('region',{name:'本任务应用资料'}),checkbox=resources.getByRole('checkbox');await checkbox.waitFor({timeout:30000});
  assert.equal(await checkbox.isChecked(),false,'Existing App grants must not be silently granted to this task');assert.equal(writes.length,0);
  await checkbox.check();await resources.getByRole('button',{name:'保存本任务资料范围',exact:true}).click();
  const saved=await waitFor(()=>writes.find(item=>item.result?.status==='completed'&&item.result.result?.operation?.phase==='completed'),15000,'explicit resource UI save');
  const submitted=saved.request.payload.params.resourceBindings;assert.equal(submitted.length,1);
  assert.deepEqual(submitted[0].connectionRef,{id:connection.id,revision:connection.revision});assert.deepEqual(submitted[0].resourceRefs,[reference]);
  const target=saved.request.payload.target;assert.deepEqual(target.initialAttempt,original);
  const read=await call('integrations/tasks/readTaskSources',{target,params:{threadId:original.threadId}});
  assert.deepEqual(read.resourceBindings,submitted);assert.deepEqual(read.effectiveResourceBindings,submitted);
  const operation=await call('integrations/tasks/readTaskSourceOperation',{target,operationId:saved.request.operationId});assert.equal(operation.operation.operationId,saved.request.operationId);
  await waitFor(()=>checkbox.isChecked(),15000,'current saved checkbox');await checkbox.uncheck();await resources.getByRole('button',{name:'保存本任务资料范围',exact:true}).click();
  await waitFor(()=>writes.filter(item=>item.result?.status==='completed'&&item.result.result?.operation?.phase==='completed').length===2,15000,'explicit empty resource UI save');
  const empty=await call('integrations/tasks/readTaskSources',{target,params:{threadId:original.threadId}});assert.deepEqual(empty.effectiveResourceBindings,[]);
  assert.equal(model.requests.length,1);assert.deepEqual(errors,[]);
  const mcp=(await readFile(context.pathInState('mcp-ui.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(mcp.filter(row=>row.event==='resourceRead').length,0);
  await resources.scrollIntoViewIfNeeded();await page.screenshot({path:context.pathInArtifacts('task-resource-explicit-empty.png'),fullPage:true});
  await context.writeArtifactJson('task-resource-actual-ui.json',{binarySha256:sha,originalTuple:original,existingAppGrantInitiallyUnchecked:true,explicitResourceBindingSaved:submitted,originalOperationReadBack:true,explicitEmptySaved:true,writes:2,providerRequests:1,resourceBodyReads:0,paidModelCalls:0,browserErrors:errors});
 }catch(error){
  let originalRead=null;
  const last=writes.at(-1);
  if(last?.request?.payload?.target&&lastScope){
   try{const value=await control('runtime.integrations.request',{serverId:'local',workspacePath:workspace,method:'integrations/tasks/readTaskSourceOperation',params:{contractVersion:'parallel-v1',requestId:'original-resource-failure-observe',scope:lastScope,timeoutMs:5000,payload:{target:last.request.payload.target,operationId:last.request.operationId}}});originalRead={status:value.status,code:value.error?.code,phase:value.result?.operation?.phase,snapshotBoundary:value.result?.snapshot?.effectiveFrom};}catch{originalRead={code:'ORIGINAL_RECEIPT_READ_FAILED'};}
  }
  await context.writeArtifactJson('task-resource-ui-passive-failure.json',{providerRequests:model.requests.length,turns,completed:completed.map(value=>({threadId:value.threadId,turnId:value.turnId,status:value.turn?.status,code:value.error?.code})),writes:writes.map(value=>({operationId:value.request?.operationId,status:value.result?.status,code:value.result?.error?.code,phase:value.result?.result?.operation?.phase,target:value.request?.payload?.target,params:value.request?.payload?.params})),originalRead,browserErrors:errors,resourceNotice:await page.getByRole('region',{name:'本任务应用资料'}).getByRole('status').count()});
  throw error;
 }finally{await page.close();}
}
