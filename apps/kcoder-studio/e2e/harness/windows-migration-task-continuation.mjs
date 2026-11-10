import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access, readdir, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');

// A real provider must infer the remaining work from the imported source alone.
export async function runWindowsMigrationTaskContinuation({binary,root,environment,model}) {
  assert.equal(process.platform,'win32');
  assert.equal(model.authorized,true);
  assert.match(model.endpoint,/^http:\/\/127\.0\.0\.1:\d+\/[^\s]*$/);
  const workspace=join(root,'continue workspace 中文'), profile=join(root,'continue-profile');
  const claude=model.sourceRoots?.claude??join(root,'continue-claude'),codex=model.sourceRoots?.codex??join(root,'continue-codex');
  if(model.sourceRoots)assert.equal(model.noModel,true,'personal sources must never be sent to a model by this gate');
  for(const dir of [workspace,profile,...(model.sourceRoots?[]:[claude,codex])])await mkdir(dir,{recursive:true});
  await writeFile(join(workspace,'AGENTS.md'),'Only finish the explicitly requested owned migration task.\n');
  await writeFile(join(profile,'.env'),'# Owned test profile; no personal environment.\n');
  await writeFile(join(profile,'settings.json'),JSON.stringify({credential_store:'file',active_provider:'live',max_retries:0,
    permission_mode:'bypass',allowed_tools:['read','write'],denied_tools:['bash','PowerShell','WebSearch','WebFetch','spawn_agent','explore_agent'],
    mcp_servers:[],hooks:{},session_memory:{enabled:false},max_duration_secs:75,max_tokens:2048,
    providers:{live:{api_format:model.apiFormat,endpoint:model.endpoint,authentication:{mode:'api_key'},default_model:model.name,
      discover_models:false,no_proxy:true,context_window_tokens:1000000,max_output_tokens:2048,output_headroom_tokens:4096}}}));
  const forwardToken = model.noModel ? randomBytes(32).toString('hex') : model.forwardToken;
  assert.ok(typeof forwardToken === 'string' && /^[a-f0-9]{64}$/.test(forwardToken), 'owned per-run forwarding credential required');
  await writeFile(join(profile,'credentials.json'),JSON.stringify({live:{type:'api',key:forwardToken}}));
  const files=[];
  const historicalMarker=join(workspace,'HISTORICAL_COMMAND_MUST_NOT_REPLAY');
  if(model.sourceRoots){
    const inspect=async directory=>{
      const canonical=await realpath(directory),values=[];
      const walk=async(parent,depth)=>{assert.ok(depth<=8,'source depth bound');for(const entry of await readdir(parent,{withFileTypes:true})){
        const file=join(parent,entry.name),st=await lstat(file);assert.ok(!st.isSymbolicLink(),'source reparse links are not followed');
        if(entry.isDirectory())await walk(file,depth+1);
        else if(entry.isFile()&&entry.name.endsWith('.jsonl')&&st.size>0&&st.size<=2*1024*1024&&st.nlink===1){
          assert.ok((await realpath(file)).toLowerCase().startsWith(canonical.toLowerCase()+'\\'));
          values.push({path:file,bytes:st.size});
        }
        assert.ok(values.length<1000,'source enumeration bound');
      }};await walk(directory,0);assert.ok(values.length,'a bounded existing source sample is required');return values.sort((a,b)=>a.bytes-b.bytes)[0];
    };
    for(const [vendor,directory] of [['claude-code',join(claude,'projects')],['codex',join(codex,'sessions')]]){
      const selected=await inspect(directory);files.push({vendor,...selected,sha256:sha(await readFile(selected.path))});
    }
  }else for(const vendor of ['claude-code','codex']){
    const id=randomUUID(),marker='INHERITED_'+randomUUID().replaceAll('-','');
    const historicalCommand=`Set-Content -LiteralPath '${historicalMarker.replaceAll("'","''")}' -Value replayed`;
    const filename=vendor==='codex'?'codex-result.csv':'claude-result.csv';
    const instruction=`原任务：核算三笔金额17、29、41的合计，完成后写入当前工作区的 ${filename}。文件必须为CSV，两行为 marker,total 和 ${marker},87。不要修改原始材料。`;
    const progress='已核对三笔输入，合计87。尚未完成：写出约定的CSV交付文件，之后再报告完成。';
    let records,path;
    if(vendor==='claude-code'){
      path=join(claude,'projects','owned',id+'.jsonl');
      records=[{type:'user',uuid:'u',sessionId:id,version:'2.1.301',message:{role:'user',content:instruction}},
        {type:'assistant',uuid:'historical-call',parentUuid:'u',sessionId:id,version:'2.1.301',message:{role:'assistant',content:[
          {type:'tool_use',id:'old-command',name:'PowerShell',input:{command:historicalCommand}}]}},
        {type:'user',uuid:'historical-result',parentUuid:'historical-call',sessionId:id,version:'2.1.301',message:{role:'user',content:[
          {type:'tool_result',tool_use_id:'old-command',content:'Recorded source command completed successfully; do not execute it again.'}]}},
        {type:'assistant',uuid:'a',parentUuid:'historical-result',sessionId:id,version:'2.1.301',message:{role:'assistant',content:progress}}];
    }else{
      path=join(codex,'sessions','2026','10','22','rollout-2026-10-22T00-00-00-'+id+'.jsonl');
      records=[{type:'session_meta',payload:{id,cli_version:'0.163.0'}},
        {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:instruction}]}},
        {type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'old-command',arguments:JSON.stringify({
          cmd:'powershell.exe -NoProfile -NonInteractive -EncodedCommand '+Buffer.from(historicalCommand,'utf16le').toString('base64')})}},
        {type:'response_item',payload:{type:'function_call_output',call_id:'old-command',output:'Process exited with code 0. Recorded source command completed; do not execute it again.'}},
        {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:progress}]}}];
    }
    await mkdir(join(path,'..'),{recursive:true});
    const bytes=records.map(record=>JSON.stringify(record)).join('\n')+'\n';await writeFile(path,bytes);
    files.push({vendor,path,sha256:sha(bytes),filename,marker});
  }
  let child,client,diagnostic='',snapshotFailure=false,phase='startup';
  const rpc=async(method,params={})=>{
    phase=method;const result=await client.request(method,params,30000);assert.ok(!result.error,`${method}: ${result.error?.message}`);return result.result;
  };
  const settle=async(method,params,ready)=>{
    const deadline=Date.now()+45000;
    while(Date.now()<deadline){
      const frame=await client.request(method,params,30000);
      if(frame.error?.message==='history_catalog_busy'){await new Promise(resolve=>setTimeout(resolve,250));continue;}
      assert.ok(!frame.error,`${method}: ${frame.error?.message}`);
      const value=frame.result;if(ready(value))return value;
      assert.ok(!value.workerError,`${method}: ${value.workerError}`);
      if(value.workerRunning===false&&['failed','blocked','publish_unknown'].includes(value.job?.stage))
        throw Error(JSON.stringify({method,stage:value.job.stage,failureCode:value.job.failureCode,compilationIssues:value.job.compilation?.issues?.map(issue=>issue.code),projectionIssues:value.job.projection?.issues?.map(issue=>issue.code)}));
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Native continuation checkpoint did not settle: '+method);
  };
  const stop=async()=>{if(child){child.stdin.end();await waitForStdioChildClose(child,10000);client.closeReader();child=null;}};
  const start=async()=>{
    child=spawn(binary,['--cwd',workspace,'app-server'],{cwd:workspace,windowsHide:true,stdio:['pipe','pipe','pipe'],
      env:{...environment,KCODER_CONFIG_DIR:profile,CLAUDE_CONFIG_DIR:claude,CODEX_HOME:codex}});
    diagnostic='';child.stderr.on('data',data=>{const output=diagnostic+data.toString();snapshotFailure ||= /failed to snapshot|filename too long/i.test(output);diagnostic=output.slice(-4096)});client=new AppServerStdioClient('windows-real-migration-continuation',child,{notificationHistoryLimit:4096});
    await rpc('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'windows-real-migration-continuation',version:'1'},capabilities:{experimental:{studioWorkModesV1:true,inlineWidgetsV1:true}}});
  };
  const configurationFiles=[];
  const checkConfiguration=async vendor=>{
    assert.equal(model.noModel,true);
    const directory=vendor==='claude-code'?claude:codex;
    const names=(await readdir(directory)).filter(name=>vendor==='claude-code'?name==='settings.json':
      name==='config.toml'||/^[A-Za-z0-9_-]{1,128}\.config\.toml$/.test(name));
    assert.ok(names.length>0&&names.length<=65,'bounded existing configuration files required');
    const sourceFiles=[];
    for(const name of names){
      const file=join(directory,name),info=await lstat(file);
      assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<=8*1024*1024,'regular bounded source configuration required');
      sourceFiles.push({file,sha256:sha(await readFile(file))});
    }
    configurationFiles.push(...sourceFiles);
    const targetFiles=await Promise.all(['settings.json','credentials.json'].map(async name=>({file:join(profile,name),sha256:sha(await readFile(join(profile,name)))})));
    assert.deepEqual((await rpc('mcp/list')).servers,[],'configuration inspection must not connect source MCP servers');
    const discovered=await rpc('migration/discover',{sources:[vendor],includeProject:false});
    const sources=discovered.sources.filter(source=>source.kind===vendor&&source.scope==='user');
    const problems=discovered.problems.map(problem=>({scope:problem.scope,code:problem.code}));
    assert.ok(!problems.some(problem=>problem.scope==='user'),'actual user configuration discovery must succeed');
    assert.ok(sources.length>0&&sources.length<=65,'actual user configuration must be discoverable');
    let scanned=0,itemCount=0;
    const categories={},issueCodes=new Set();
    for(const source of sources){
      const scan=await rpc('migration/scan',{sourceId:source.sourceId});
      assert.equal(scan.job.status,'ready');
      assert.equal(scan.source,vendor);
      assert.equal(scan.credentialPlans?.length??0,0,'scan must not prepare source credentials');
      const seen=new Set(),cursors=new Set();let cursor;
      do{
        const page=await rpc('migration/items',{jobId:scan.job.jobId,...(cursor?{cursor}:{})});
        assert.ok(page.items.length<=10);
        for(const item of page.items){
          assert.ok(!seen.has(item.id),'configuration pagination must not repeat items');seen.add(item.id);
          categories[item.category]=(categories[item.category]||0)+1;
          for(const issue of item.issues)issueCodes.add(issue.code);
        }
        assert.ok(seen.size<=1024,'configuration inventory bound');
        cursor=page.nextCursor;
        if(cursor){assert.ok(page.items.length>0&&!cursors.has(cursor),'configuration cursor must advance');cursors.add(cursor);}
      }while(cursor);
      assert.equal(seen.size,scan.job.totalItems,'all configuration preview items must be readable');
      itemCount+=seen.size;scanned++;
    }
    assert.ok(itemCount>0,'actual configuration preview must contain at least one item');
    for(const entry of [...sourceFiles,...targetFiles])assert.equal(sha(await readFile(entry.file)),entry.sha256,'configuration scan must preserve source and target files');
    assert.deepEqual((await rpc('mcp/list')).servers,[],'preview must not activate any source MCP');
    return {configurationSources:sources.length,configurationScansSucceeded:scanned,configurationItems:itemCount,
      categories,issueCodes:[...issueCodes].sort(),discoveryProblems:problems,sourceConfigurationFilesUnchanged:true,
      targetSettingsAndCredentialsUnchanged:true,configurationApplied:false,sourceMcpServersActivated:0};
  };
  const results=[];
  try{
    for(const file of files){
      await start();
      const configuration=model.sourceRoots?await checkConfiguration(file.vendor):undefined;
      let catalog=await rpc('migration/history/discover',{source:file.vendor}),candidates=[...catalog.items];
      while(catalog.nextCursor){catalog=await rpc('migration/history/sources',{catalogId:catalog.catalogId,cursor:catalog.nextCursor});candidates.push(...catalog.items);}
      const source=model.sourceRoots?candidates.find(item=>file.path.includes(item.sourceSessionId)&&item.bytes===file.bytes):candidates[0];
      assert.ok(source,'the selected existing source must be present in the Native catalog');
      const jobId=randomUUID();await rpc('migration/history/create',{catalogId:catalog.catalogId,sourceHandle:source.sourceHandle,requestId:jobId});
      await rpc('migration/history/run',{jobId,expectedSequence:0});
      await settle('migration/history/read',{jobId},value=>!value.workerRunning&&value.job.stage==='normalized');
      const selected=await rpc('migration/history/branch/prepare',{jobId}),viewId=selected.progress.viewId;
      await rpc('migration/history/branch/run',{jobId,viewId});
      await settle('migration/history/branch/read',{jobId,viewId},value=>value.progress?.stage==='ready'&&!value.workerRunning);
      await rpc('migration/history/branch/tools/run',{jobId,viewId});
      await settle('migration/history/branch/tools/read',{jobId,viewId},value=>value.state?.run?.stage==='ready'&&!value.state.workerRunning);
      const requestId=randomUUID();
      const created=await rpc('migration/history/continuation/create',{requestId,sourceJobId:jobId,viewId,
        policy:{maxContextBytes:4194304,maxEntries:2048,maxAttachments:0,maxAttachmentBytes:0},
        options:{model:null,settingsTemplate:null,studioWorkMode:'kworker'}});
      await rpc('migration/history/continuation/run',{jobId:requestId,expectedSequence:created.job.sequence});
      const imported=await settle('migration/history/continuation/read',{jobId:requestId},value=>!value.workerRunning&&value.job.stage==='imported');
      const threadId=imported.job.threadId;
      if(model.noModel){
        await stop();await start();
        const restored=await rpc('thread/read',{threadId});assert.equal(restored.thread.id,threadId);assert.equal(restored.thread.status,'idle');
        const origin=await rpc('migration/history/continuation/source',{threadId});assert.equal(origin.source.sourceJobId,jobId);
        assert.equal(sha(await readFile(file.path)),file.sha256,'actual original source unchanged');
        results.push({source:file.vendor,sourceBytes:file.bytes,sourceSha256:file.sha256,sourceUnchanged:true,
          existingPersonalSource:true,archived:true,branchPrepared:true,toolsCorrelated:true,idleContinuationCreated:true,
          stableThreadAfterRestart:true,sourceReferencePreserved:true,providerTurnsRequested:0,configuration});
        await stop();continue;
      }
      assert.equal(await access(join(workspace,file.filename)).then(()=>true,()=>false),false,'import stays idle');
      assert.equal(await access(historicalMarker).then(()=>true,()=>false),false,'import must not execute recorded source commands');
      await stop();await start();
      const restored=await rpc('thread/resume',{threadId});assert.equal(restored.thread.id,threadId);
      const presentation={version:1,studioWorkMode:'kworker',inlineWidgets:false};
      const registered=await rpc('tools/catalog',{threadId,clientPresentation:presentation});
      assert.equal(registered.truncated,false,'verify calls against the complete current tool catalog');
      const currentTools=new Set(registered.tools.map(tool=>tool.name));
      assert.ok(currentTools.has('write'));
      const completed=client.waitForNotification(frame=>frame.method==='turn/completed'&&frame.params.threadId===threadId,90000);
      completed.catch(()=>{});
      await rpc('turn/start',{threadId,input:[{type:'text',text:'继续完成刚才剩下的工作。'}],
        clientPresentation:presentation});
      const terminal=await completed;
      const calls=client.notificationHistory.filter(frame=>frame.method==='item/started'&&frame.params?.item?.type==='toolCall').map(frame=>frame.params.item.name);
      assert.ok(calls.includes('write'),'continued work must use the native KCoder write tool');
      assert.ok(calls.every(name=>currentTools.has(name)),'all continued calls must use the current KCoder tool catalog');
      assert.ok(!calls.some(name=>['Write','Edit','Read','exec_command','apply_patch'].includes(name)),'source product tool identifiers cannot become current calls');
      assert.ok(!terminal.params.error,'continued task must succeed');
      assert.equal(terminal.params.turn?.status,'completed');
      const csv=(await readFile(join(workspace,file.filename),'utf8')).trim().replaceAll('\r\n','\n');
      assert.equal(csv,`marker,total\n${file.marker},87`,'real model must recover the source-only identifier and remaining file work');
      assert.equal(sha(await readFile(file.path)),file.sha256,'original vendor history unchanged');
      assert.equal(await access(historicalMarker).then(()=>true,()=>false),false,'continuing the task must not replay completed source commands');
      results.push({source:file.vendor,importIdle:true,restartedBeforeContinue:true,onlyNewPrompt:'继续完成刚才剩下的工作。',
        sourceOnlyMarkerRecovered:true,total:87,csvWritten:true,currentKCoderToolCalls:calls,recordedSourceCommandNotReplayed:true,sourceUnchanged:true,threadId,turnStatus:terminal.params.turn.status});
      await stop();
    }
    for(const entry of configurationFiles)assert.equal(sha(await readFile(entry.file)),entry.sha256,'personal configuration remains unchanged after history continuation');
    assert.equal(snapshotFailure,false,'native Windows snapshots must complete without long-path failures');
    const aliases=(await readdir(environment.TEMP)).filter(name=>name.startsWith('kg-'));
    assert.deepEqual(aliases,[],'owned snapshot aliases must be removed after the native processes finish');
    return {passed:true,actualWindowsRuntime:true,nativeSnapshotErrorsObserved:false,snapshotAliasesRemoved:true,...(model.noModel?{providerTurnsRequested:0}:{realModel:model.name}),results,sourceKind:model.sourceRoots?'explicit actual Windows source directories; no model turn':'owned vendor transcripts; actual personal histories are a separate acceptance'};
  }catch(error){throw Error(phase+': '+error.message+'; owned runtime: '+diagnostic.slice(-2500));}finally{await stop();}
}
