import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,open} from 'node:fs/promises';
import {startChromium} from './chromium.mjs';
import {waitFor} from './run-context.mjs';
import {businessCases} from './application-business-protocol.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export async function createBusinessAcceptance(context,{gateway,workspace,rpc,scope,protocol,readOnlyProbe=false,lookupProbe=false,hardDrop=false}){
 const browser=await startChromium(context,{label:'application-business-approval-browser'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 context.addCleanup('close original application business UI page',()=>page.close());
 const frames=[],pageErrors=[],resumeReceipts=[],workspaceReadReceipts=[];
 const passiveFile=await open(context.pathInArtifacts('application-business-passive.json'),'wx',0o600);
 context.addCleanup('close original application business passive artifact',()=>passiveFile.close());
 page.on('pageerror',error=>pageErrors.push(String(error.message).slice(0,400)));
 page.on('websocket',socket=>{
  const resumes=new Map(),workspaceReads=new Map();
  socket.on('framesent',({payload})=>{try{const frame=JSON.parse(String(payload));if(frame.method==='thread/resume'&&frame.id!=null)resumes.set(frame.id,frame.params?.threadId);if(frame.method==='integrations/tasks/readWorkspace'&&frame.id!=null&&workspaceReads.size<8)workspaceReads.set(frame.id,frame.params);}catch{}});
  socket.on('framereceived',({payload})=>{try{const frame=JSON.parse(String(payload));if(frame.method==='approval/request')frames.push(frame);if(resumes.has(frame.id)){const threadId=resumes.get(frame.id);resumes.delete(frame.id);resumeReceipts.push({threadId,returnedThreadId:frame.result?.thread?.id??null,confirmed:!frame.error&&frame.result?.thread?.id===threadId});}if(workspaceReads.has(frame.id)){const params=workspaceReads.get(frame.id);workspaceReads.delete(frame.id);if(workspaceReadReceipts.length<8)workspaceReadReceipts.push({params,response:frame});}}catch{}});
 });
 await page.goto(gateway.baseUrl,{waitUntil:'domcontentloaded'});
 await page.locator('input[name="token"]').fill(gateway.authToken);
 await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login')),page.locator('button[type="submit"]').click()]);
 assert.equal(await page.evaluate(()=>typeof window.__KCODER_STUDIO_E2E__?.invokeRuntimeCommand),'function','UNMET_PREREQUISITE: build the owned renderer with VITE_KCODER_STUDIO_E2E=true');
 const control=(method,params)=>page.evaluate(async({method,params})=>window.__KCODER_STUDIO_E2E__.invokeRuntimeCommand('local_executor_request',{method,params}),{method,params});
 const browserScope=await control('runtime.integrations.request',{serverId:'local',workspacePath:workspace,method:'integrations/scope/read',params:{}});
 assert.deepEqual(browserScope,scope,'Actual authenticated browser and fixed target use the original scope');
 const call=(method,params)=>control('runtime.integrations.request',{serverId:'local',workspacePath:workspace,method,params});
 let serial=0,currentRecord=null;
 const port=async(method,payload,operationId)=>{
  const result=await call(method,{contractVersion:'parallel-v1',requestId:`business-ui-${++serial}`,scope,timeoutMs:30000,payload,...(operationId?{operationId}:{})});
  if(result.status!=='completed'&&currentRecord){
   currentRecord.portFailure={method,status:result.status,errorCode:result.error?.code??null,selector:payload.reference??payload.threadId??null};
   try{const history=await rpc.request('thread/read',{threadId:currentRecord.threadId},5000);currentRecord.threadDiagnostic={status:history.thread?.status,recentError:history.thread?.runSummary?.recentError??null,mainTurn:history.thread?.runSummary?.mainTurn??null};}catch(error){currentRecord.threadDiagnostic={code:'ORIGINAL_THREAD_READ_UNAVAILABLE'};}
  }
  assert.equal(result.status,'completed',result.error?.code??JSON.stringify(result));return result.result;
 };
 const outcomes=[];
 async function run(item,connection,refs){
  for(const scenario of businessCases(item.kind).filter(scenario=>lookupProbe?scenario.phase==='effect':!readOnlyProbe||scenario.phase==='read')){
   const operationId=`${connection.id}-${scenario.phase}-original`;
   protocol.select(scenario,operationId);
   const taskText=`${scenario.marker}\nRead only the selected resource. ${scenario.phase==='effect'?'Perform the explicitly requested action: '+scenario.action+'.':'Perform only the requested read operation.'}\n${scenario.kind==='tencent_docs'&&scenario.phase==='effect'?'Create title Owned review and exact body "Owned approved document: 37 units."; then read the original created document back and verify its complete saved title/body.':''}\n${scenario.kind==='agent_mail'&&scenario.phase==='effect'?'Send exactly one message to owned-recipient@example.invalid, subject Owned review, exact body "Owned approved send: 37 units.". This is an explicit send to the owned .invalid fixture only.':''}\n${scenario.kind==='agent_mail'&&scenario.phase==='read'?'List one message, read its complete original body and actual CSV attachment.':''}\n${scenario.kind==='feishu_bitable'?'Use region owned-east and limit 1 only; export exactly those bounded rows when export was requested.':''}\nUse the original operationId; never replay an unknown effect.`;
   const reply=await call('integrations/connectivity/prepareConnectionAction',{contractVersion:'parallel-v1',requestId:`business-run-${++serial}`,scope,timeoutMs:30000,operationId,expectedRevision:connection.revision,payload:{action:'runOfficeTask',connectionId:connection.id,businessAction:scenario.action,resourceRefs:refs,taskText}});
   assert.equal(reply.status,'completed',reply.error?.code??JSON.stringify(reply));
   const accepted=reply.result;assert.ok(accepted.threadId&&accepted.turnId);
   const record={kind:item.kind,phase:scenario.phase,action:scenario.action,operationId,threadId:accepted.threadId,turnId:accepted.turnId};outcomes.push(record);currentRecord=record;
   if(scenario.phase==='effect'){
    const openExactTask=async task=>{
     const project=task.locator('xpath=ancestor::*[@data-testid="project-item"][1]');
     if(await project.count()){
      const toggle=project.getByTestId('project-item-button');
      if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
     }
     await task.scrollIntoViewIfNeeded();await task.click();
    };
    const list=await control('runtime.tasks.list',{});
    const matches=(list.workspaces??[]).flatMap(workspace=>(workspace.tasks??[])).filter(task=>task.threadId===accepted.threadId&&task.serverId==='local');
    record.originalTaskList={matches:matches.map(task=>({taskId:task.taskId,threadId:task.threadId,workspacePath:task.workspacePath})),workspaceCount:list.workspaces?.length??null};
    assert.equal(matches.length,1,'The exact accepted original task must exist in the real target task list');
    const task=page.getByTestId(`runtime-local-task-row-kcoder:local:${accepted.threadId}`);
    try{
     if(await task.count())await openExactTask(task);
     else {
      await page.getByTestId('task-workspace-button').click();await page.waitForURL(url=>url.pathname==='/tasks');
      const refresh=page.getByTestId('task-workspace-refresh-tasks');
      await waitFor(async()=>await refresh.getAttribute('aria-busy')!=='true',15000,'original task-list refresh settled');
      await refresh.click();
      await waitFor(()=>task.count(),15000,'the exact accepted sidebar task after original task-list refresh');
      await openExactTask(task);
      record.originalTaskNavigation='exact_sidebar_conversation_after_original_task_list_refresh';
     }
    }
    catch(error){
     try{record.rowFailureState=await rpc.request('integrations/runtime/readTaskState',{requestId:'original-ui-row-failure',scope,reference:{threadId:accepted.threadId,turnId:accepted.turnId}},5000);}catch{record.rowFailureState={code:'ORIGINAL_STATE_UNAVAILABLE'};}
     try{const history=await rpc.request('thread/read',{threadId:accepted.threadId},5000);record.threadDiagnostic={status:history.thread?.status,recentError:history.thread?.runSummary?.recentError??null,messages:(history.messages??[]).map(message=>({role:message.role,status:message.status,errorType:message.errorType,content:String(message.content??'').slice(0,600)}))};}catch{record.threadDiagnostic={code:'ORIGINAL_THREAD_UNAVAILABLE'};}
     record.rowDom=await page.evaluate(()=>({text:document.body.innerText.slice(0,7000),testIds:[...document.querySelectorAll('[data-testid]')].map(node=>node.getAttribute('data-testid')).slice(0,150)}));
     await page.screenshot({path:context.pathInArtifacts('application-original-task-row-failure.png'),fullPage:true});throw error;
    }
    await page.waitForURL(url=>url.pathname==='/runtime-tasks'&&url.searchParams.get('deviceId')==='local'&&url.searchParams.get('taskId')===matches[0].taskId);
    const resumed=await waitFor(()=>resumeReceipts.find(receipt=>receipt.threadId===accepted.threadId&&receipt.confirmed),15000,'original exact conversation resume and connected owner');
    record.originalConversation={taskId:matches[0].taskId,...resumed};
    protocol.releaseEffect(operationId);
    const card=page.getByTestId('request-user-input-card');await card.waitFor({state:'visible',timeout:30000});
    await card.getByText('权限请求',{exact:true}).waitFor();
    const approval=await waitFor(()=>frames.find(frame=>frame.params?.threadId===accepted.threadId&&frame.params?.turnId===accepted.turnId),30000,'original application final tool approval');
    assert.equal(approval.params.action.type,'tool');
    assert.equal(approval.params.action.input.operationId,operationId);
    if(item.kind==='agent_mail'){
     assert.equal(approval.params.action.input.to,'owned-recipient@example.invalid');
     assert.equal(approval.params.action.input.body,'Owned approved send: 37 units.');
     await card.getByText('owned-recipient@example.invalid',{exact:false}).first().waitFor();
     await page.screenshot({path:context.pathInArtifacts('application-original-mail-send-approval.png'),fullPage:true});
    }
    record.approval={realBrowser:true,threadId:approval.params.threadId,turnId:approval.params.turnId,toolCallId:approval.params.toolCallId??null,toolName:approval.params.action.name,inputSha256:sha(Buffer.from(JSON.stringify(approval.params.action.input)))};
    await card.getByText('仅允许这一次',{exact:true}).click();await card.waitFor({state:'detached',timeout:30000});
   }
   const terminal=await waitFor(async()=>{
    const state=await rpc.request('integrations/runtime/readTaskState',{requestId:`business-state-${++serial}`,scope,reference:{threadId:accepted.threadId,turnId:accepted.turnId}});
    assert.equal(state.operationId,operationId);
    if(['failed','cancelled','outcome_unknown'].includes(state.state)){record.terminalFailure={state:state.state,revision:state.revision,snapshot:state.snapshot};try{const history=await rpc.request('thread/read',{threadId:accepted.threadId},5000);record.threadDiagnostic={status:history.thread?.status,recentError:history.thread?.runSummary?.recentError??null};}catch{}throw new Error(`Actual application task ${scenario.marker} ended ${state.state}`);}
    return state.state==='completed'?state:null;
   },60000,'original application canonical task terminal',100,context.abortSignal);
   record.canonical={state:terminal.state,revision:terminal.revision,operationId:terminal.operationId};
   if(readOnlyProbe){
    const workspaceSnapshot=await port('integrations/tasks/readWorkspace',{threadId:accepted.threadId});
    assert.equal(workspaceSnapshot.thread.reference.kind,'thread');
    assert.equal(workspaceSnapshot.thread.reference.threadId,accepted.threadId);
    record.originalWorkspaceSnapshotRead={snapshotId:workspaceSnapshot.snapshotId,threadId:accepted.threadId};
   }
   assert.deepEqual(protocol.errors,[],'Actual controlled Provider accepted the original native tool/result protocol');
   if(lookupProbe){
    const initial=protocol.observations.find(item=>item.stage==='original_unknown').receipt;
    const observed=await port('integrations/operation/read',{operationId:initial.operationId});
    assert.equal(observed.receipt.operationId,initial.operationId);assert.equal(observed.receipt.phase,hardDrop?'unknown':'completed');
    record.originalEffectSnapshot=observed.receipt;
   }
   const artifacts=await port('integrations/artifact/list',{threadId:accepted.threadId,turnId:accepted.turnId,limit:10});
   if(lookupProbe&&hardDrop){assert.equal(artifacts.items.length,0);record.unknownEffectNotReplayed=true;continue;}
   assert.ok(artifacts.items.length>0,'Actual business calls publish original canonical artifacts');
   record.artifacts=artifacts.items.map(manifest=>({id:manifest.id,revision:manifest.revision,format:manifest.format,bytes:manifest.bytes,sha256:manifest.sha256,sourceRefs:manifest.sourceRefs}));
   if(lookupProbe){record.reconciledOriginalOperation=true;record.lookup=protocol.observations.find(item=>item.stage==='original_reconciled');}
   if(!lookupProbe&&item.kind==='tencent_docs'&&scenario.phase==='effect'){
    const created=artifacts.items.find(manifest=>manifest.kind==='operation_receipt');assert.ok(created);
    assert.ok(created.verification.pendingChecks.includes('saved_document_readback'));
    const observation=await port('integrations/artifact/verification',{reference:{id:created.id,revision:created.revision}});
    assert.ok(!observation.verification.pendingChecks.includes('saved_document_readback'));
    assert.ok(observation.verification.completedChecks.some(check=>check.startsWith('saved_document_readback_sha256:')));
    record.savedDocumentReadback=true;
   }
   const files=artifacts.items.filter(manifest=>manifest.format==='csv');
   for(const manifest of files){
    const exported=await port('integrations/artifact/export',{task:{threadId:accepted.threadId,turnId:accepted.turnId},reference:{id:manifest.id,revision:manifest.revision},format:'csv'},`business-download-${manifest.id}`);
    const receipt=exported.export;
    assert.ok(receipt&&typeof receipt.exportId==='string'&&typeof receipt.leaseRevision==='string','The original export response contains its nested export receipt');
    assert.deepEqual(receipt.reference,{id:manifest.id,revision:manifest.revision});assert.equal(receipt.bytes,manifest.bytes);assert.equal(receipt.sha256,manifest.sha256);
    const bytesReply=await page.evaluate(async params=>window.__KCODER_STUDIO_E2E__.invokeRuntimeCommand('read_local_attachment_file',params),{deviceId:'local',workspacePath:workspace,threadId:accepted.threadId,path:`office-export:${receipt.exportId}:${receipt.leaseRevision}`});
    const bytes=Buffer.from(bytesReply.contentBase64,'base64');assert.equal(bytes.length,receipt.bytes);assert.equal(sha(bytes),manifest.sha256);
    if(item.kind==='agent_mail')assert.equal(bytes.toString(),'item,units\nowned,37\n');
    if(item.kind==='feishu_bitable')assert.equal(bytes.toString(),'id,region,reviewedUnits\nrow-1,owned-east,37\n');
    (record.downloads??=[]).push({artifactId:manifest.id,bytes:bytes.length,sha256:sha(bytes),actualOriginalAttachmentBytes:item.kind==='agent_mail'});
   }
   const repeated=await call('integrations/connectivity/prepareConnectionAction',{contractVersion:'parallel-v1',requestId:`business-repeat-${++serial}`,scope,timeoutMs:30000,operationId,expectedRevision:connection.revision,payload:{action:'runOfficeTask',connectionId:connection.id,businessAction:scenario.action,resourceRefs:refs,taskText}});
   assert.equal(repeated.status,'completed');assert.deepEqual([repeated.result.threadId,repeated.result.turnId],[accepted.threadId,accepted.turnId]);
  }
 }
 async function finish(logs,binarySha256,providerRequests){
  const business=[];let registeredSchemas=0;
  for(const item of logs){
   const rows=(await readFile(item.path,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
   registeredSchemas+=rows.find(row=>row.event==='businessInventory').tools.length;
   const effects=rows.filter(row=>row.event==='businessEffect');assert.equal(effects.length,readOnlyProbe?0:1,'Only the exact requested owned business effects');
   const reads=rows.filter(row=>row.event==='businessRead');assert.ok(reads.length>=(lookupProbe?0:readOnlyProbe?1:{tencent_docs:2,agent_mail:3,feishu_bitable:1}[item.kind]));
   const lookups=rows.filter(row=>row.event==='businessLookup');
   if(lookupProbe){assert.equal(effects.length,1);assert.equal(rows.filter(row=>row.event==='businessAckSuppressed').length,1);assert.equal(lookups.length,hardDrop?0:1);}
   business.push({kind:item.kind,reads,effects,lookups});
  }
  assert.equal(outcomes.length,readOnlyProbe||lookupProbe?1:6);assert.equal(outcomes.filter(record=>record.approval?.realBrowser).length,readOnlyProbe?0:lookupProbe?1:3);assert.deepEqual(pageErrors,[]);assert.deepEqual(protocol.errors,[]);
  await context.writeArtifactJson('application-original-business-positive.json',{binarySha256,actualGateway:true,actualNativeMain:true,actualOriginalMcpClients:true,originalRegisteredBusinessSchemas:registeredSchemas,independentTasks:outcomes.length,originalUiApprovals:outcomes.filter(record=>record.approval?.realBrowser).length,readOnlyProbe,lookupProbe,hardDrop,providerRequests,paidCalls:0,externalBrandAccountVerified:false,modelQualityClaim:false,outcomes,business,modelProtocol:protocol.observations,pageErrors});
 }
 context.addCleanup('retain original application business passive diagnostics',async()=>{await passiveFile.writeFile(JSON.stringify(context.redactValue({outcomes,resumeReceipts,workspaceReadReceipts,modelProtocol:protocol.observations,modelErrors:protocol.errors,pageErrors,approvals:frames.map(frame=>({threadId:frame.params?.threadId,turnId:frame.params?.turnId,toolName:frame.params?.action?.name,inputSha256:sha(Buffer.from(JSON.stringify(frame.params?.action?.input??null)))}))}),null,2)+'\n');await passiveFile.sync();});
 return {run,finish};
}
