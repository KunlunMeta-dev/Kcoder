param([Parameter(Mandatory=$true)][string]$Binary, [switch]$ShortPaths)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$probeRoot = Join-Path ([IO.Path]::GetTempPath()) ('kcoder-workspace-probe-' + [guid]::NewGuid().ToString('N'))
if ($ShortPaths) { $probeRoot = Join-Path ([IO.Path]::GetTempPath()) ('kcp-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
$process = $null
$results = [Collections.Generic.List[object]]::new()
try {
    $workspace = Join-Path $probeRoot 'workspace'
    $config = Join-Path $probeRoot 'config'
    [IO.Directory]::CreateDirectory($workspace) | Out-Null
    [IO.Directory]::CreateDirectory($config) | Out-Null
    & git -c init.templateDir= -C $workspace init --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create isolated probe repository' }
    $settings = Join-Path $config 'settings.json'
    [IO.File]::WriteAllText($settings, '{"active_provider":"probe","providers":{"probe":{"api_format":"openai_chat_completions","endpoint":"http://127.0.0.1:1/v1","default_model":"probe","context_window_tokens":128000,"max_output_tokens":8192,"output_headroom_tokens":8192}}}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $config 'credentials.json'), '{"probe":{"type":"api","key":"synthetic-native-protocol"}}', [Text.UTF8Encoding]::new($false))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Binary
    $start.Arguments = '--settings-file "' + $settings + '" --cwd "' + $workspace + '" app-server --scenario markdown-showcase'
    $start.WorkingDirectory = $workspace
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new()
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new()
    $start.EnvironmentVariables['KCODER_CONFIG_DIR'] = $config
    $start.EnvironmentVariables['KCODER_TUI_LAB_REQUEST_DIR'] = Join-Path $config 'probe-requests'
    $start.EnvironmentVariables['RUST_LOG'] = 'kcoder_engine=debug'
    $process = [Diagnostics.Process]::Start($start)
    $errors = $process.StandardError.ReadToEndAsync()
    $script:requestId = 0
    $script:notifications = [Collections.Generic.List[object]]::new()
    function Request($method, $parameters) {
        $script:requestId += 1
        $id = $script:requestId
        $process.StandardInput.WriteLine((@{jsonrpc='2.0';id=$id;method=$method;params=$parameters} | ConvertTo-Json -Depth 20 -Compress))
        $process.StandardInput.Flush()
        for ($index = 0; $index -lt 100; $index++) {
            $read = $process.StandardOutput.ReadLineAsync()
            if (!$read.Wait(15000)) { throw 'Probe protocol response timed out' }
            if ($null -eq $read.Result) { throw 'Probe process exited before response' }
            $response = $read.Result | ConvertFrom-Json
            if ($response.id -eq $id) { return $response }
            if ($response.method) { $script:notifications.Add($response) }
        }
        throw 'Probe notification bound exceeded'
    }
    $initialized = Request 'initialize' @{protocolVersion='2026-07-27';clientInfo=@{name='kcoder-windows-workspace-probe';version='1'}}
    $results.Add(@{step='initialize';success=($null -eq $initialized.error);error=$initialized.error})
    $child = Join-Path $workspace 'project with spaces'
    foreach ($action in @('create','select')) {
        $response = Request 'runtime.workspaces.prepare' @{workspacePath=$child;action=$action;projectId=17;deviceId='local'}
        $results.Add(@{step=('prepare-' + $action);response=$response})
        if ($null -ne $response.result.mapping.workspacePath) { $canonicalChild = $response.result.mapping.workspacePath }
    }
    $response = Request 'runtime.workspaces.list' @{deviceId='local'}
    $results.Add(@{step='workspace-list';response=$response})
    $response = Request 'thread/start' @{}
    $results.Add(@{step='thread-start';response=$response})
    $thread = $response.result.thread.id
    if ($thread) {
        $turnWatch = [Diagnostics.Stopwatch]::StartNew()
        $response = Request 'turn/start' @{threadId=$thread;input=@(@{type='text';text='WINDOWS_WORKSPACE_PROBE'})}
        $results.Add(@{step='turn-start';response=$response})
        if ($null -eq $response.error) {
            $completed = @($script:notifications | Where-Object {$_.method -eq 'turn/completed'} | Select-Object -Last 1).params.turn.status
            for ($index = 0; $index -lt 200 -and !$completed; $index++) {
                $read = $process.StandardOutput.ReadLineAsync()
                if (!$read.Wait(60000)) { throw 'Probe turn completion timed out' }
                if ($null -eq $read.Result) { throw 'Probe process exited during turn' }
                $event = $read.Result | ConvertFrom-Json
                if ($event.method) { $script:notifications.Add($event) }
                if ($event.method -eq 'turn/completed') { $completed = $event.params.turn.status; break }
            }
            $results.Add(@{step='turn-completed';status=$completed;elapsedMs=$turnWatch.ElapsedMilliseconds})
        }
        $response = Request 'thread/metadata/update' @{threadId=$thread;archivedAt=[DateTime]::UtcNow.ToString('o')}
        $results.Add(@{step='archive-thread';response=$response})
    }
    if ($canonicalChild -and (Get-Command node -ErrorAction SilentlyContinue)) {
        $code = @'
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const [binary,cwd,config]=process.argv.slice(1);
const request={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2026-07-27',clientInfo:{name:'windows-node-cwd-probe',version:'1'}}};
const child=spawn(binary,['--settings-file',config+'\\settings.json','--cwd',cwd,'app-server'],{cwd,env:{...process.env,KCODER_CONFIG_DIR:config},windowsHide:true,stdio:['pipe','pipe','pipe']});
let stderr=''; child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000)});
const pending=new Map(); const lines=createInterface({input:child.stdout});
lines.on('line',line=>{try{const message=JSON.parse(line);const receive=pending.get(message.id);if(receive){pending.delete(message.id);receive(message)}else if(message.error){for(const receive of pending.values())receive(message);pending.clear()}}catch{}});
const send=(message,timeoutMs=3000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(message.id);reject(Error(message.method+' response timed out'))},timeoutMs);pending.set(message.id,response=>{clearTimeout(timer);resolve(response)});child.stdin.write(JSON.stringify(message)+'\n')});
(async()=>{let initialized=false;let initializeElapsedMs=0;let largeFrames=0;let outcome;const started=Date.now();try{
initialized=Boolean((await send(request,12000)).result);initializeElapsedMs=Date.now()-started;
for(let id=2;id<22;id++){await new Promise(resolve=>setTimeout(resolve,75));const response=await send({jsonrpc:'2.0',id,method:'probe/large-frame',params:{padding:'X'.repeat(10600)}});if(response.id!==id)throw Error('large frame rejected: '+JSON.stringify(response.error));largeFrames++}
const concurrent=await Promise.all(Array.from({length:20},(_,index)=>send({jsonrpc:'2.0',id:index+22,method:'probe/large-frame',params:{padding:'X'.repeat(10600)}}).then(response=>{if(response.id!==index+22)throw Error('concurrent frame rejected: '+JSON.stringify(response.error));return true})));
outcome={initialized,initializeElapsedMs,largeFrames,concurrentFrames:concurrent.length};
}catch(error){outcome={initialized,initializeElapsedMs:initializeElapsedMs||Date.now()-started,largeFrames,error:error.message,stderr};}finally{child.stdin.end();lines.close();const timer=setTimeout(()=>child.kill(),1000);child.once('close',status=>{clearTimeout(timer);console.log(JSON.stringify({...outcome,status}))})}})();
'@
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($code))
        $nodeResult = & node -e "eval(Buffer.from('$encoded','base64').toString())" $Binary $canonicalChild $config
        $results.Add(@{step='node-canonical-workspace-start';response=($nodeResult | ConvertFrom-Json)})
    }
} catch {
    $results.Add(@{step='probe-error';error=$_.Exception.Message;providerRequestCount=@(Get-ChildItem (Join-Path $config 'probe-requests') -File -ErrorAction SilentlyContinue).Count;notificationMethods=@($script:notifications | ForEach-Object {$_.method});events=@($script:notifications | Where-Object {$_.method -eq 'item/event'})})
} finally {
    if ($null -ne $process) {
        if (!$process.HasExited) {
            $process.StandardInput.Close()
            if (!$process.WaitForExit(5000)) { $process.Kill(); $process.WaitForExit() }
        }
        if ($errors.Wait(2000)) { $results.Add(@{step='process-exit';code=$process.ExitCode;diagnostics=$errors.Result}) }
        $process.Dispose()
    }
    if ([IO.Directory]::Exists($probeRoot)) { [IO.Directory]::Delete($probeRoot, $true) }
}
@{results=$results;cleaned=![IO.Directory]::Exists($probeRoot)} | ConvertTo-Json -Depth 30
