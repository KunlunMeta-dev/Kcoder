// Actual Windows task-host RPC with an owned profile and bounded loopback provider.
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {spawn,spawnSync}=require('node:child_process');
const {createInterface}=require('node:readline');
const {randomUUID,createHash}=require('node:crypto');
const [binary,,,artifacts]=process.argv.slice(2);
const root=fs.mkdtempSync(path.join(artifacts,'studio-ui-'));
const profile=path.join(root,'profile'),workspace=path.join(root,'workspace');
for(const directory of [profile,workspace])fs.mkdirSync(directory);
let modelRequests=0,child,sequence=0,terminal,finished,replyObserved=false;
let providerFirstAt,providerLastAt,providerFinishedAt,firstDeltaAt,lastDeltaAt,binarySha256;
const imageCaptures=[];
const stages=[],pending=new Map();
const completion=new Promise(resolve=>{finished=resolve});
const server=http.createServer((request,response)=>{
  request.resume();
  if(request.method==='GET'){response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
  modelRequests++;
  response.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk={id:'owned',object:'chat.completion.chunk',created:1,model:'fixture'};
  providerFirstAt=Date.now();
  response.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{role:'assistant',content:'WINDOWS_STREAM_FIRST'},finish_reason:null}]})}\n\n`);
  for(let i=1;i<=40;i++)setTimeout(()=>response.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{content:` part${i}`},finish_reason:null}]})}\n\n`),i*20);
  setTimeout(()=>{providerLastAt=Date.now();response.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{content:' WINDOWS_HISTORY_REPLY'},finish_reason:null}]})}\n\n`)},1000);
  setTimeout(()=>{providerFinishedAt=Date.now();response.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`);response.end('data: [DONE]\n\n')},3000);
});
const call=(method,params)=>new Promise((resolve,reject)=>{
  const id=++sequence,started=Date.now();
  const timer=setTimeout(()=>{pending.delete(id);reject(Error(`${method}: response timed out`))},45000);
  pending.set(id,{resolve:result=>{clearTimeout(timer);stages.push({method,elapsedMs:Date.now()-started});resolve(result)},reject:error=>{clearTimeout(timer);reject(error)}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
});
(async()=>{
  let result;
  const deadline=setTimeout(()=>{for(const waiter of pending.values())waiter.reject(Error('Owned probe deadline exceeded'));finished({error:{message:'Owned probe deadline exceeded'}})},110000);
  try{
    const hash=createHash('sha256');for await(const part of fs.createReadStream(binary))hash.update(part);binarySha256=hash.digest('hex');
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({active_provider:'fixture',max_retries:0,integrations:{knowledge:{memory_center_enabled:true}},providers:{fixture:{api_format:'openai_chat_completions',endpoint:`http://127.0.0.1:${server.address().port}/v1`,no_proxy:true,default_model:'fixture',context_window_tokens:128000,max_output_tokens:8192,output_headroom_tokens:8192}}}));
    fs.writeFileSync(path.join(profile,'credentials.json'),JSON.stringify({fixture:{type:'api',key:'synthetic-windows-history-fixture'}}));
    require('./windows-probe-config.cjs')(profile,root);
    const ownedBinary=path.join(root,'kcoder.exe');fs.copyFileSync(binary,ownedBinary);
    const env={};
    for(const key of ['SystemRoot','WINDIR','PATH','Path','USERPROFILE','HOME','TEMP','TMP','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
    env.KCODER_CONFIG_DIR=profile;
    child=spawn(ownedBinary,['--cwd',workspace,'app-server'],{cwd:workspace,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stderrPending='';
    child.stderr.on('data',bytes=>{stderrPending+=bytes.toString('utf8');const lines=stderrPending.split('\n');stderrPending=lines.pop();for(const line of lines){try{const event=JSON.parse(line);if(event.event==='native_channel_original_image_capture_observed'&&event.currentProcess===true)imageCaptures.push(event.elapsedMs)}catch{}}});
    createInterface({input:child.stdout}).on('line',line=>{
      let frame;try{frame=JSON.parse(line)}catch{return;}
      if(line.includes('WINDOWS_HISTORY_REPLY'))replyObserved=true;
      if(frame.method?.startsWith('item/')&&line.includes('WINDOWS_STREAM_FIRST'))firstDeltaAt??=Date.now();
      if(frame.method?.startsWith('item/')&&line.includes('WINDOWS_HISTORY_REPLY'))lastDeltaAt??=Date.now();
      const waiter=pending.get(frame.id);
      if(waiter){pending.delete(frame.id);frame.error?waiter.reject(Error(`${frame.error.code}: ${frame.error.message}`)):waiter.resolve(frame.result);}
      if(frame.method==='item/event'&&frame.params?.event?.type==='error')terminal=frame.params.event.error;
      if(frame.method==='turn/completed')finished(frame.params);
    });
    child.on('error',error=>{for(const waiter of pending.values())waiter.reject(error);finished({error:{message:error.message}})});
    child.on('exit',()=>{for(const waiter of pending.values())waiter.reject(Error('Owned frontend exited'));finished({error:{message:'Owned frontend exited'}})});
    await call('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'owned-windows-task-host',version:'1'},capabilities:{experimental:{integrationScopeV1:true,taskSourcesV1:true,threadRuntimeHandoffV1:true,interactionBindingV1:true,threadCreationReceiptsV1:true}}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const started=await call('thread/start',{cwd:workspace,clientRequestId:randomUUID()});
    await call('thread/metadata/update',{threadId:started.thread.id,title:'Owned Windows task host'});
    await call('turn/start',{threadId:started.thread.id,clientMessageId:randomUUID(),input:[{type:'text',text:'Reply briefly.'}]});
    const read=call('thread/read',{threadId:started.thread.id,limit:10}).then(()=>null,error=>error.message);
    const ended=await completion;
    const readError=await read;
    const error=ended.error||terminal;
    const firstDeltaBeforeProviderFinished=firstDeltaAt!=null&&providerFinishedAt!=null&&firstDeltaAt<providerFinishedAt;
    result={passed:!error&&!readError&&ended.turn?.status==='completed'&&modelRequests===1&&replyObserved&&firstDeltaBeforeProviderFinished,stages,binarySha256,imageCaptureCount:imageCaptures.length,imageCaptureElapsedMs:imageCaptures.reduce((a,b)=>a+b,0),firstDeltaDelayMs:firstDeltaAt==null?null:firstDeltaAt-providerFirstAt,lastDeltaDelayMs:lastDeltaAt==null?null:lastDeltaAt-providerLastAt,firstDeltaBeforeProviderFinished,readError,modelRequests,paidModelRequests:0,replyObserved,status:ended.turn?.status,error};
  }catch(error){result={passed:false,stages,modelRequests,error:error.message};}
  finally{
    clearTimeout(deadline);
    if(child&&child.exitCode===null){child.stdin.end();await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve()},3000);child.once('exit',()=>{clearTimeout(timer);resolve()})});}
    const cleanup=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-task-host-cleanup.ps1'),'-OwnedRoot',root],{windowsHide:true,encoding:'utf8',timeout:20000});
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    let cleaned=false;try{fs.rmSync(root,{recursive:true});cleaned=!fs.existsSync(root)}catch{}
    result={...result,cleaned:cleaned&&cleanup.status===0};
    console.log(JSON.stringify({result,cleaned:result.cleaned}));
    if(!result.passed||!result.cleaned)process.exitCode=1;
  }
})();
