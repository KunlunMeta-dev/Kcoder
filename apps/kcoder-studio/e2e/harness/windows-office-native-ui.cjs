// Native UI scenario only. The existing Windows host harness owns all processes.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
function createOfficeTelemetry(){
 const pending=new Map(),turns=[],exports=[],chunks=[],protocol=[],readiness=[];
 return {
  observe(socket,direction,frame){
   const key=socket+':'+frame.id;
   if(direction==='sent'&&['integrations/artifact/export','attachment/read/chunk','integrations/office/readiness'].includes(frame.method))pending.set(key,{method:frame.method,params:frame.params});
   if(direction==='received'){
    if(frame.method==='turn/completed'){
     const error=frame.params?.error;
     turns.push({threadId:frame.params?.threadId,turnId:frame.params?.turnId??frame.params?.turn?.id,status:frame.params?.status??frame.params?.turn?.status,...(error?{error:{code:typeof error.code==='number'?error.code:null,nativeCodes:[...new Set(String(error.message??'').match(/\b[A-Z][A-Z0-9_]{2,100}\b/g)??[])].slice(0,20),providerDetailsPresent:error.details!==null&&error.details!==undefined}}:{})});
    }
    const request=pending.get(key);if(request){pending.delete(key);
     if(request.method==='integrations/artifact/export'){
      const value=frame.result,receipt=value?.result?.export;
      exports.push({...Object.fromEntries(Object.entries(value??{}).filter(([key])=>['contractVersion','requestId','status','operationId','entityRevision','observedAt'].includes(key))),result:receipt?{export:Object.fromEntries(Object.entries(receipt).filter(([key])=>['reference','bytes','sha256','filename','mediaType','format','generatorSha256'].includes(key)))}:null});
     }
     else if(request.method==='integrations/office/readiness'){const reply=frame.result;readiness.push({status:reply?.status,errorCode:reply?.error?.code??frame.error?.code,result:reply?.result?Object.fromEntries(Object.entries(reply.result).filter(([key,value])=>['status','available','nodeVersion','componentVersion','runtimeMode','reason','code'].includes(key)&&['string','number','boolean'].includes(typeof value))):null,resultKeys:reply?.result?Object.keys(reply.result):[]})}
     else chunks.push({offset:request.params?.offset,length:request.params?.length});
    }
    if(frame.result?.capabilities)protocol.push({office:frame.result.capabilities.experimental?.officeWorkspaceV1===true,connectivity:frame.result.capabilities.experimental?.connectivityV1===true});
   }
  },turns,exports,chunks,protocol,readiness,
 };
}
async function runWindowsOfficeNative({evaluate,until,navigate,click,screenshot,workspace,artifacts,app,modelUrl,telemetry,setStage}){
 assert.equal(await evaluate('Boolean(window.kcoderDesktopHost)'),true,'Actual Electron preload required');
 const protocol=await import(require('node:url').pathToFileURL(path.join(__dirname,'native-download-model.mjs')).href);
 const rpc=(method,params)=>evaluate(`window.__KCODER_STUDIO_E2E__.invokeRuntimeCommand('local_executor_request',${JSON.stringify({method,params})})`);
 const mark=value=>setStage('office-'+value);
 const query=id=>`document.querySelector('[data-testid="${id}"]')`;
 mark('enabled-through-ui');
 await evaluate(`(()=>{const worker=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='KWorker');worker?.click();return true})()`);
 await navigate('/office','native-office-workspace');
 await until(()=>evaluate(`${query('office-settings')}?.getAttribute('data-status')==='ready'`),30000);
 const enabled=await evaluate(`${query('office-enabled-state')}?.getAttribute('data-enabled')`);
 if(enabled==='false')await click('office-enabled-toggle');else assert.equal(enabled,'true');
 const settingState=await until(()=>evaluate(`(()=>{const section=${query('office-settings')};if(section?.getAttribute('data-status')==='unavailable')return 'unavailable';return ${query('office-enabled-state')}?.getAttribute('data-enabled')==='true'&&!${query('office-settings-pending')}?'enabled':null})()`),45000);
 if(settingState==='unavailable'){
  mark('settings-read-reconcile');
  const observed=[];
  await until(async()=>{try{const status=await evaluate(`window.__KCODER_STUDIO_E2E__.invokeRuntimeCommand('local_executor_status')`);observed.push({ready:status?.ready===true,running:status?.running===true});return status?.ready===true}catch(error){observed.push({error:/restart is in progress/.test(error.message)?'restart_in_progress':'read_unavailable'});return false}},20000);
  fs.writeFileSync(path.join(artifacts,'windows-office-settings-reconcile.json'),JSON.stringify({readOnlyStatus:observed.slice(-20),mutationReplayed:false}));
  await evaluate(`(()=>{const section=${query('office-settings')};const refresh=[...section.querySelectorAll('button')].find(e=>/刷新|Refresh/i.test(e.textContent));if(!refresh)throw Error('Original settings read refresh missing');refresh.click();return true})()`);
  await until(()=>evaluate(`${query('office-enabled-state')}?.getAttribute('data-enabled')==='true'&&!${query('office-settings-pending')}`),30000);
 }

 mark('native-readiness');
 try{await until(()=>evaluate(`${query('office-native-readiness')}?.getAttribute('data-status')==='ready'`),45000)}finally{fs.writeFileSync(path.join(artifacts,'windows-office-native-readiness.json'),JSON.stringify({observations:telemetry.readiness,providerNotSubmittedYet:true}))}
 let metrics=await(await fetch(modelUrl.replace(/\/v1$/,'')+'/metrics')).json();assert.equal(metrics.office?.requests??0,0);
 mark('original-native-task');
 const creationRequestId='windows-office-'+randomUUID(),clientMessageId=randomUUID();
 const created=await rpc('runtime.tasks.create',{deviceId:'local',workspacePath:workspace,taskId:creationRequestId,clientMessageId,studioWorkMode:'kworker',executionRequest:{prompt:protocol.claimPrompt}});
 assert.equal(created.accepted,true);assert.ok(created.taskId);assert.ok(created.runtimeHandle?.threadId);
 const threadId=created.runtimeHandle.threadId;
 fs.writeFileSync(path.join(artifacts,'windows-office-task-acceptance.json'),JSON.stringify({creationRequestId,clientMessageId,taskId:created.taskId,threadId,accepted:created.accepted,studioWorkMode:created.runtimeHandle.studioWorkMode}));
 const complete=await until(()=>telemetry.turns.find(item=>item.threadId===threadId),120000);
 metrics=await(await fetch(modelUrl.replace(/\/v1$/,'')+'/metrics')).json();
 fs.writeFileSync(path.join(artifacts,'windows-office-original-turn-result.json'),JSON.stringify({taskId:created.taskId,threadId,turn:complete,providerRequests:metrics.office?.requests??null,totalControlledProviderRequests:metrics.requests?.length??null,controlledProtocolErrors:metrics.office?.errors??null,externalModelCalls:0}));
 assert.ok(complete.turnId);assert.equal(complete.status,'completed');assert.deepEqual(metrics.office?.errors,[]);
 assert.equal(metrics.office.requests,3);const generated=metrics.office.generated;assert.ok(generated?.artifactRef?.id);assert.equal(generated.format,'docx');
 await rpc('runtime.tasks.rename',{deviceId:'local',workspacePath:workspace,taskId:created.taskId,title:protocol.claimTitle});
 mark('artifact-collection');
 await navigate('/office','native-office-workspace');await click('office-section-artifacts');
 await until(()=>evaluate(`(()=>{const e=${query('office-task-select')};return e&&[...e.options].some(o=>o.textContent===${JSON.stringify(protocol.claimTitle)})})()`),30000);
 await evaluate(`(()=>{const e=${query('office-task-select')};const option=[...e.options].find(o=>o.textContent===${JSON.stringify(protocol.claimTitle)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,option.value);e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
 await until(()=>evaluate(`[...document.querySelectorAll('li[data-office-kind="document"]')].some(e=>e.querySelector('h3')?.textContent===${JSON.stringify(protocol.claimTitle)})`),30000);
 assert.equal(await evaluate(`Boolean(${query('office-export-unavailable')})`),false);
 await screenshot('windows-office-before-native-download.png');
 const destination=path.join(artifacts,'claimed-native-office.docx');
 const identity=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${app.pid}).StartTime.ToUniversalTime().ToString('o')`],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(identity.status,0);
 let saver;
 try{
  mark('native-download');
  await evaluate(`(()=>{const row=[...document.querySelectorAll('li[data-office-kind="document"]')].find(e=>e.querySelector('h3')?.textContent===${JSON.stringify(protocol.claimTitle)});const button=[...row.querySelectorAll('button')].find(e=>/下载|Download/i.test(e.textContent));if(!button)throw Error('Actual download action missing');button.click();return true})()`);
  const receipt=await until(()=>telemetry.exports.find(item=>item?.status==='completed')?.result?.export,15000);
  assert.ok(typeof receipt.filename==='string'&&receipt.filename.length>0&&!/[\\/\x00-\x1f]/.test(receipt.filename));
  saver=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-office-save-dialog.ps1'),'-ProcessId',String(app.pid),'-StartedUtc',identity.stdout.trim(),'-OwnedRoot',artifacts,'-Destination',destination,'-ExpectedFilename',receipt.filename],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let savedOutput='',savedError='';saver.stdout.on('data',data=>{savedOutput+=data});saver.stderr.on('data',data=>{savedError=(savedError+data).slice(-2000)});
  const saved=new Promise((resolve,reject)=>{saver.once('error',reject);saver.once('close',code=>code===0?resolve(JSON.parse(savedOutput)):reject(Error('Owned native save failed '+savedError)))});saved.catch(()=>{});
  const dialog=await saved;assert.equal(dialog.nativeDialogInvoked,true);
  fs.writeFileSync(path.join(artifacts,'windows-office-save-action.json'),JSON.stringify(dialog));
  await until(()=>evaluate(`${query('office-download-status')}?.getAttribute('data-status')==='completed'`),60000);
  const bytes=fs.readFileSync(destination),sha256=createHash('sha256').update(bytes).digest('hex');
  assert.ok(bytes.length>256*1024);assert.deepEqual([...bytes.subarray(0,2)],[80,75]);assert.equal(sha256,receipt.sha256);assert.equal(bytes.length,receipt.bytes);
  const archive=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-office-docx-reader.ps1'),'-OwnedRoot',artifacts,'-Document',destination],{encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(archive.status,0,'Actual Windows ZIP reader must accept the claimed document');const structure=JSON.parse(archive.stdout);assert.equal(structure.structuralZipRead,true);
  assert.equal(receipt.reference.id,generated.artifactRef.id);assert.equal(receipt.reference.revision,generated.artifactRef.revision);assert.equal(generated.sha256,sha256);assert.ok(telemetry.chunks.length>0);
  const after=await(await fetch(modelUrl.replace(/\/v1$/,'')+'/metrics')).json();assert.equal(after.office.requests,metrics.office.requests);
  await screenshot('windows-office-native-download-completed.png');
  const result={passed:true,actualInstalledElectron:true,actualNativeOfficeGeneration:true,actualArtifactCollection:true,originalTaskId:created.taskId,originalThreadId:threadId,originalTurnId:complete.turnId,artifactRef:receipt.reference,bytes:bytes.length,sha256,nativeDownloadStatus:'completed',nativeDialogInvoked:true,attachmentChunkReads:telemetry.chunks,controlledProviderRequests:metrics.office.requests,additionalDownloadProviderRequests:0,externalModelCalls:0,platformCalls:0,qualityClaim:false,actualWindowsZipRead:structure};
  fs.writeFileSync(path.join(artifacts,'windows-office-native-claim.json'),JSON.stringify(result));return result;
 }finally{
  fs.writeFileSync(path.join(artifacts,'windows-office-native-download-observation.json'),JSON.stringify({taskId:created.taskId,threadId,originalTurnId:complete.turnId,exports:telemetry.exports,chunks:telemetry.chunks,dom:await evaluate(`(()=>{const e=${query('office-download-status')};return {status:e?.getAttribute('data-status')??null,text:e?.textContent?.slice(0,300)??null,desktopHost:Boolean(window.kcoderDesktopHost),nativeDownload:typeof window.kcoderDesktopHost?.download==='function'}})()`).catch(()=>({unavailable:true}))}));
  if(saver?.exitCode===null)saver.kill();
 }
}
module.exports={createOfficeTelemetry,runWindowsOfficeNative};
