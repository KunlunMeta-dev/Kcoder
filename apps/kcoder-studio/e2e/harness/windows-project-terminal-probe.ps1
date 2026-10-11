param([Parameter(Mandatory=$true)][string]$Binary, [Parameter(Mandatory=$true)][string]$GatewayDirectory, [string]$GatewayEntry)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$probeRoot = Join-Path ([IO.Path]::GetTempPath()) ('kcoder-project-terminal-' + [guid]::NewGuid().ToString('N'))
$process = $null
$result = $null
try {
    [IO.Directory]::CreateDirectory($probeRoot) | Out-Null
    $gateway = Join-Path $probeRoot 'gateway'
    Copy-Item -LiteralPath $GatewayDirectory -Destination $gateway -Recurse
    if ($GatewayEntry) { Copy-Item -LiteralPath $GatewayEntry -Destination (Join-Path $gateway 'dev-server.mjs') -Force }
    if ($GatewayEntry) {
        foreach ($name in @('ssh-terminal-store.js','ssh-credential-cipher.js','ssh-terminal.js')) {
            Copy-Item -LiteralPath (Join-Path (Split-Path $GatewayEntry -Parent) $name) -Destination (Join-Path $gateway ('src\' + $name)) -Force
        }
    }
    $code = @'
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs');const path=require('node:path');
const [binary,root,gateway]=process.argv.slice(2);
const workspace=path.join(root,'workspace');const config=path.join(root,'config');const web=path.join(root,'web');
for(const p of [workspace,config,web]) fs.mkdirSync(p,{recursive:true});
fs.writeFileSync(path.join(web,'index.html'),'<html><head></head><body>isolated gateway probe</body></html>');
const settings=path.join(config,'settings.json');
fs.writeFileSync(settings,JSON.stringify({active_provider:'probe',providers:{probe:{api_format:'openai_chat_completions',endpoint:'http://127.0.0.1:1/v1',default_model:'probe',context_window_tokens:128000,max_output_tokens:8192,output_headroom_tokens:8192}}}));
const env={};for(const k of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','COMSPEC'])if(process.env[k])env[k]=process.env[k];
Object.assign(env,{KCODER_CONFIG_DIR:config,KCODER_STUDIO_HOST:'127.0.0.1',KCODER_STUDIO_PORT:'0',KCODER_STUDIO_ALLOWED_HOSTS:'127.0.0.1,localhost',KCODER_STUDIO_WORKSPACE:workspace,KCODER_STUDIO_WEB_ROOT:web,KCODER_STUDIO_SCENARIO:'markdown-showcase',KCODER_STUDIO_KCODER_BIN:binary,KCODER_STUDIO_SERVERS:JSON.stringify([{id:'local',label:'Fixture',transport:'local',command:binary,workspace,settingsFile:settings}])});
const child=spawn(process.execPath,[path.join(gateway,'dev-server.mjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',b=>log=(log+b).slice(-10000));child.stderr.resume();
const sockets=[];let stage='gateway-start';let observedEvents=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const v=await f();if(v)return v;await delay(30)}throw Error('Timed out at '+stage)}
async function connect(base,token,workspacePath){
 const url=new URL('/rpc',base.replace('http:','ws:'));url.searchParams.set('token',token);url.searchParams.set('server','local');if(workspacePath)url.searchParams.set('workspace',workspacePath);
 const ws=new WebSocket(url);sockets.push(ws);let next=0;const pending=new Map(),events=[];
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error('RPC failed: '+p.method+': '+m.error.message)):p.resolve(m.result)}}else events.push(m)});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('WS timeout at '+stage)),15000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('WS failed at '+stage))},{once:true})});
 const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout: '+method))},15000);pending.set(id,{resolve,reject,timer,method});ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}))});
 await request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'windows-project-terminal-probe',version:'1'}});
 return {request,events,ws};
}
(async()=>{try{
 const port=await until(()=>log.match(/KCoder Studio: http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);const base='http://127.0.0.1:'+port;
 const html=await(await fetch(base)).text();const token=html.match(/name="kcoder-rpc-token" content="([^"]+)"/)?.[1];if(!token)throw Error('Missing private fixture token');
 const parent=await connect(base,token);stage='project-create';
 const prepared=await parent.request('runtime.workspaces.prepare',{workspacePath:path.join(workspace,'project with spaces'),action:'create',projectId:1,deviceId:'local'});
 const canonical=prepared.mapping.workspacePath;if(!canonical.startsWith('\\\\?\\'))throw Error('Expected a namespaced Windows path');
 stage='project-websocket';const project=await connect(base,token,canonical);
 const thread=(await project.request('thread/start')).thread.id;
 stage='project-turn';await project.request('turn/start',{threadId:thread,input:[{type:'text',text:'PROJECT_GATEWAY_PROBE'}]});
 await until(()=>project.events.find(e=>e.method==='turn/completed'&&e.params.turn?.status==='completed'));
 stage='usage-history';
 const usage=await project.request('usage/stats');
 if(usage.windowDays!==30||usage.timeZone!=='UTC'||!usage.history)throw Error('Missing Windows usage history');
 const usageRequests=Object.values(usage.history.days).flatMap(day=>Object.values(day)).reduce((sum,counter)=>sum+counter.requests,0);
 if(usageRequests<1)throw Error('Windows provider attempt was not recorded');
 const usageRaw=fs.readFileSync(path.join(config,'usage','usage.json'),'utf8');
 if(usageRaw.includes('PROJECT_GATEWAY_PROBE'))throw Error('Usage history contained a prompt');
 let badUsageRejected=false;try{await project.request('usage/stats',{path:workspace})}catch{badUsageRejected=true}
 if(!badUsageRejected)throw Error('Usage query accepted an arbitrary path');
 stage='project-cron';
 const scheduled=await project.request('cron/create',{prompt:'PRIVATE_FUTURE_SCHEDULE',schedule:{kind:'at',at:new Date(Date.now()+3600000).toISOString()},confirmed:true,jitterSeconds:0});
 if(!(await project.request('cron/list')).jobs.some(job=>job.id===scheduled.job.id))throw Error('Project schedule was not persisted');
 if(!(await project.request('cron/delete',{jobId:scheduled.job.id})).deleted)throw Error('Project schedule was not deleted');
 observedEvents=project.events;stage='terminal-start';const terminal=await project.request('terminal/start',{threadId:thread,rows:24,cols:80});
 const session_id=terminal.session_id;if(!session_id)throw Error('Missing terminal identity');
 // ConPTY asks the terminal emulator for its cursor position before reading input.
 await until(()=>project.events.filter(e=>e.method==='terminal/output').map(e=>e.params.data).join('').includes('\x1b[6n'));
 await project.request('terminal/write',{session_id,data:'\x1b[1;1R'});
 await until(()=>project.events.filter(e=>e.method==='terminal/output').map(e=>e.params.data).join('').includes('PS '));
 await project.request('terminal/write',{session_id,data:"Write-Output ('LOCAL_' + 'PTY_OK')\r"});
 stage='terminal-output';await until(()=>project.events.filter(e=>e.method==='terminal/output').map(e=>e.params.data).join('').includes('LOCAL_PTY_OK'));
 await project.request('terminal/resize',{session_id,rows:32,cols:100});
 const attached=await project.request('terminal/attach',{session_id,rows:32,cols:100});if(!attached.transcript.includes('LOCAL_PTY_OK'))throw Error('Missing terminal replay');
 await project.request('terminal/close',{session_id});
 stage='project-archive';await project.request('thread/metadata/update',{threadId:thread,archivedAt:new Date().toISOString()});
 stage='project-reconnect';const again=await connect(base,token,canonical);await again.request('thread/start');
 if(JSON.stringify((await again.request('usage/stats')).history)!==JSON.stringify(usage.history))throw Error('Usage changed after archive or reconnect');
 stage='ssh-password';
 const {pathToFileURL}=require('node:url');
 const {createSshConnectionStore}=await import(pathToFileURL(path.join(gateway,'src/ssh-terminal-store.js')).href);
 const {createSshTerminalSession}=await import(pathToFileURL(path.join(gateway,'src/ssh-terminal.js')).href);
 const ssh2=require(path.join(gateway,'node_modules/ssh2'));
 const {generateKeyPairSync,randomUUID}=require('node:crypto');
 const secret=randomUUID();const clients=new Set();const sessions=[];let authentications=0;
 const hostKey=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey;
 const ssh=new ssh2.Server({hostKeys:[hostKey]},client=>{clients.add(client);client.on('close',()=>clients.delete(client));client.on('error',()=>{});client.on('authentication',a=>{authentications++;a.method==='password'&&a.password===secret?a.accept():a.reject()});client.on('ready',()=>client.on('session',accept=>{const s=accept();s.on('pty',accept=>accept());s.on('shell',accept=>accept().write('ready'))}))});
 try {
  await new Promise(resolve=>ssh.listen(0,'127.0.0.1',resolve));
  const filePath=path.join(root,'ssh_connections.jsonc');const store=createSshConnectionStore({filePath});
  const profile=await store.upsert({id:'saved',label:'fixture',host:'127.0.0.1',port:ssh.address().port,username:'fixture',authMethod:'password',password:secret});
  const raw=fs.readFileSync(filePath,'utf8');if(raw.includes(secret)||JSON.stringify(await store.list()).includes(secret)||profile.credentials||profile.password)throw Error('SSH secret exposed');
  if(JSON.parse(raw).terminal.ssh.connections[0].credentials.password.scheme!=='dpapi-user-v1')throw Error('DPAPI was not used');
  const session=createSshTerminalSession({store:createSshConnectionStore({filePath}),send:()=>true});sessions.push(session);
  const challenge=await session.handle('ssh/connect',{profileId:profile.id});if(challenge.status!=='host-key-required'||authentications!==0)throw Error('SSH authenticated before trust');
  await session.handle('ssh/connect',{profileId:profile.id,acceptFingerprint:challenge.fingerprint});await session.handle('ssh/close');
  await session.handle('ssh/connect',{profileId:profile.id});await session.handle('ssh/close');
  await store.upsert({id:profile.id,label:profile.label,host:profile.host,port:profile.port,username:profile.username,authMethod:'password',password:null});
  if((await store.list())[0].passwordSaved)throw Error('Saved SSH password was not cleared');
 } finally {for(const session of sessions)session.dispose();for(const client of clients)client.destroy();await new Promise(resolve=>ssh.close(resolve));}
 console.log(JSON.stringify({passed:true,projectCreated:true,namespacedGatewayConnected:true,turnCompleted:true,terminalOutput:true,terminalReplay:true,archived:true,reconnected:true,dpapiPasswordSaved:true,savedPasswordReconnected:true,usageRecorded:true,usageMetadataOnly:true,usageRequests,usageSurvivedArchiveAndReconnect:true}));
}catch(error){console.log(JSON.stringify({passed:false,stage,error:error.message,terminalEvents:observedEvents.filter(e=>e.method.startsWith('terminal/')).slice(-15)}));process.exitCode=1}
finally{for(const s of sockets)s.close();if(child.exitCode===null)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await until(()=>child.exitCode!==null||child.signalCode!==null,5000).catch(()=>{process.exitCode=1})}})();
'@
    $scriptFile = Join-Path $probeRoot 'probe.cjs'
    [IO.File]::WriteAllText($scriptFile, $code, [Text.UTF8Encoding]::new($false))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command node).Source
    $start.Arguments = '"' + $scriptFile + '" "' + $Binary + '" "' + $probeRoot + '" "' + $gateway + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new()
    $process = [Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit(80000)) { throw 'Windows Gateway probe timed out' }
    $result = $stdout.Result | ConvertFrom-Json
    if (!$result) { throw 'Windows Gateway probe did not return a result' }
} finally {
    if ($process) {
        if (!$process.HasExited) { & taskkill /PID $process.Id /T /F | Out-Null; $process.WaitForExit(5000) | Out-Null }
        $process.Dispose()
    }
    if ([IO.Directory]::Exists($probeRoot)) { [IO.Directory]::Delete($probeRoot, $true) }
}
@{result=$result;cleaned=![IO.Directory]::Exists($probeRoot)} | ConvertTo-Json -Depth 10 -Compress
