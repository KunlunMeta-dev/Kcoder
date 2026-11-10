param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
$request=Get-Content -LiteralPath $RequestPath -Raw|ConvertFrom-Json
$root=[IO.Path]::GetFullPath([string]$request.runRoot).TrimEnd('\')+'\'
$install=[IO.Path]::GetFullPath([string]$request.installDirectory)
if(!$install.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Probe install escaped owned root'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -ne $request.sid){throw 'Probe SID mismatch'}
$cliSource=Join-Path $request.runRoot 'probe-cli.exe'
$supervisorSource=Join-Path $request.runRoot 'probe-supervisor.exe'
if((Get-FileHash -LiteralPath $request.installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $request.sha256){throw 'Probe uninstaller digest mismatch'}
if((Get-FileHash -LiteralPath $cliSource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $request.probeCliSha256){throw 'Probe CLI digest mismatch'}
if((Get-FileHash -LiteralPath $supervisorSource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $request.probeSupervisorSha256){throw 'Probe supervisor digest mismatch'}
[IO.Directory]::CreateDirectory((Join-Path $install 'resources\bin'))|Out-Null
[IO.Directory]::CreateDirectory((Join-Path $install 'resources\shell'))|Out-Null
Copy-Item -LiteralPath $cliSource -Destination (Join-Path $install 'resources\bin\kcoder.exe')
Copy-Item -LiteralPath $supervisorSource -Destination (Join-Path $install 'resources\bin\kcoder-process-supervisor.exe')
Copy-Item -LiteralPath (Join-Path $request.runRoot 'install-cli.ps1') -Destination (Join-Path $install 'resources\shell\install-cli.ps1')
Copy-Item -LiteralPath $request.installer -Destination (Join-Path $install 'Uninstall KCoder Studio.exe')
# This matches electron-builder 26.15.2 UUID.v5(dev.kcoder.studio, 50e065bc-3134-11e6-9bab-38c9862bdaf3).
# Only this newly created isolated account owns the registration.
$appGuid='dde41fb5-2370-5338-807d-3f5c37c73fa3'
$installKey='HKCU:\Software\'+$appGuid
$uninstallKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$appGuid
New-Item -Path $installKey -Force|Out-Null
Set-ItemProperty -LiteralPath $installKey -Name InstallLocation -Value $install
New-Item -Path $uninstallKey -Force|Out-Null
Set-ItemProperty -LiteralPath $uninstallKey -Name InstallLocation -Value $install
Set-ItemProperty -LiteralPath $uninstallKey -Name UninstallString -Value ('"'+(Join-Path $install 'Uninstall KCoder Studio.exe')+'" /currentuser')
$ownedData=Join-Path $env:LOCALAPPDATA ('KCoderCliUninstallProbe-'+$request.owner)
$workspace=Join-Path $ownedData 'workspace'
$profile=Join-Path $ownedData 'profile'
[IO.Directory]::CreateDirectory($workspace)|Out-Null
[IO.Directory]::CreateDirectory($profile)|Out-Null
$settings=Join-Path $profile 'settings.json'
$fixtureSettings=@{active_provider='fixture';max_retries=0;history_enabled=$false;session_memory=@{enabled=$false};providers=@{fixture=@{api_format='openai_chat_completions';endpoint='http://127.0.0.1:1';default_model='fixture-model';authentication=@{mode='none'};context_window_tokens=128000;output_headroom_tokens=8192;max_output_tokens=8192;request_timeout_secs=30;no_proxy=$true;extra_body=@{}}}}|ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($settings,$fixtureSettings,[Text.UTF8Encoding]::new($false))
$held=$null
$results=[Collections.Generic.List[object]]::new()
function Invoke-OwnedUninstall([string]$label) {
 $start=[Diagnostics.ProcessStartInfo]::new()
 $start.FileName=[string]$request.installer
 $start.Arguments='/S /currentuser --updated _?='+$install
 $start.WorkingDirectory=[string]$request.runRoot
 $start.UseShellExecute=$false
 $start.EnvironmentVariables['PSExecutionPolicyPreference']='Restricted'
 $child=[Diagnostics.Process]::new();$child.StartInfo=$start
 try {
  if(!$child.Start()){throw 'Actual uninstaller did not start'}
  $handle=$child.Handle
  if(!$child.WaitForExit(90000)){& taskkill /PID $child.Id /T /F 2>$null|Out-Null;throw 'Actual minimal uninstaller timed out'}
  $child.Refresh()
  $row=@{label=$label;exitCode=$child.ExitCode;heldCliAlive=($held -and !$held.HasExited);cliPresent=(Test-Path -LiteralPath (Join-Path $install 'resources\bin\kcoder.exe'));registrationPresent=(Test-Path -LiteralPath $installKey);processPolicy='Restricted';install=$install}
  $results.Add($row)
  return $row
 } finally {$child.Dispose()}
}
try {
 $start=[Diagnostics.ProcessStartInfo]::new()
 $start.FileName=Join-Path $install 'resources\bin\kcoder.exe'
 $start.Arguments='--settings-file "'+$settings+'" --cwd "'+$workspace+'" app-server'
 $start.WorkingDirectory=$workspace;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $start.EnvironmentVariables['KCODER_CONFIG_DIR']=$profile
 $start.EnvironmentVariables.Remove('KCODER_PRIVATE_RETENTION_PARENT_V1')
 $start.EnvironmentVariables.Remove('KCODER_NATIVE_OFFICE_BINDING_V1')
 foreach($name in @('SSH_CONNECTION','SSH_TTY','KCODER_ACCOUNT_PRINCIPAL_ID','KCODER_WIKI_WORKER_MANAGED','KCODER_HOME','KCODER_HISTORY_DIR','KCODER_MEMORY_DIR','HOME')){[void]$start.EnvironmentVariables.Remove($name)}
 $held=[Diagnostics.Process]::new();$held.StartInfo=$start
 if(!$held.Start()){throw 'Actual CLI app-server did not start'}
 $heldHandle=$held.Handle
 $errorDrain=$held.StandardError.ReadToEndAsync()
 $held.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-27","clientInfo":{"name":"owned-uninstall-lock-probe","version":"1"},"capabilities":{"experimental":{}}}}')
 $held.StandardInput.Flush()
 $line=$held.StandardOutput.ReadLineAsync()
 if(!$line.Wait(20000)){throw 'Actual CLI did not initialize within bound'}
 if([String]::IsNullOrWhiteSpace($line.Result)){
  if(!$held.WaitForExit(3000)){throw 'ACTUAL_CLI_STDOUT_CLOSED_WITHOUT_EXIT'}
  $diagnostic=$errorDrain.GetAwaiter().GetResult() -replace '[^\x20-\x7E]','?'
  throw ('ACTUAL_CLI_EOF_EXIT_'+$held.ExitCode+':'+$diagnostic.Substring(0,[Math]::Min(1200,$diagnostic.Length)))
 }
 $initialized=$line.Result|ConvertFrom-Json
 if($initialized.id -ne 1 -or $initialized.error -or !$initialized.result){throw 'Actual CLI initialize failed'}
 $fact=Get-CimInstance Win32_Process -Filter ('ProcessId='+$held.Id)
 $ownerSid=Invoke-CimMethod -InputObject $fact -MethodName GetOwnerSid
 if($ownerSid.Sid -ne $request.sid -or ![String]::Equals($fact.ExecutablePath,$start.FileName,[StringComparison]::OrdinalIgnoreCase)){throw 'Held CLI owner identity mismatch'}
 $holderFacts=$null
 $lockedPath=Join-Path $install 'resources\bin\probe.dat'
 if($request.probeTerminalHolder){
  [IO.File]::WriteAllText($lockedPath,'owned-atomic-uninstall-lock-'+$request.owner)
  $ready=Join-Path $ownedData 'holder-ready.json'
  $release=Join-Path $ownedData 'holder-release.txt'
  function Invoke-CliRpc([int]$id,[string]$method,$params){
   $held.StandardInput.WriteLine((@{jsonrpc='2.0';id=$id;method=$method;params=$params}|ConvertTo-Json -Depth 8 -Compress));$held.StandardInput.Flush()
   $deadline=[DateTime]::UtcNow.AddSeconds(20)
   while([DateTime]::UtcNow -lt $deadline){
    $next=$held.StandardOutput.ReadLineAsync();if(!$next.Wait(20000)){throw 'ACTUAL_TERMINAL_RPC_TIMEOUT'}
    if(!$next.Result){throw 'ACTUAL_TERMINAL_RPC_EOF'}
    $frame=$next.Result|ConvertFrom-Json
    if($frame.method -eq 'terminal/output' -and [string]$frame.params.data -match ([char]27+'\[6n')){
     $held.StandardInput.WriteLine((@{jsonrpc='2.0';id=39;method='terminal/write';params=@{session_id=$frame.params.session_id;data=([string][char]27+'[1;1R')}}|ConvertTo-Json -Depth 5 -Compress));$held.StandardInput.Flush()
    }
    if($frame.id -eq $id){if($frame.error){throw ('ACTUAL_TERMINAL_RPC_REJECTED_'+$id)};return $frame.result}
   }
   throw 'ACTUAL_TERMINAL_RPC_TIMEOUT'
  }
  $terminal=Invoke-CliRpc 2 'terminal/start' @{cwd=$workspace;rows=24;cols=80}
  $holderSource=@'
$lease=[IO.File]::Open('__LOCKED__',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
 [IO.File]::WriteAllText('__READY__',(@{pid=$PID;path='__LOCKED__'}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 while(!(Test-Path -LiteralPath '__RELEASE__')){Start-Sleep -Milliseconds 100}
} finally {$lease.Dispose()}
'@
  $holderSource=$holderSource.Replace('__LOCKED__',$lockedPath.Replace("'","''")).Replace('__READY__',$ready.Replace("'","''")).Replace('__RELEASE__',$release.Replace("'","''"))
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($holderSource))
  [void](Invoke-CliRpc 3 'terminal/write' @{session_id=$terminal.session_id;data=('powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+$encoded+"`r`n")})
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  $pendingLine=$held.StandardOutput.ReadLineAsync()
  while(!(Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline){
   if($pendingLine.Wait(100)){
    if(!$pendingLine.Result){throw 'ACTUAL_TERMINAL_OUTPUT_CLOSED'}
    $frame=$pendingLine.Result|ConvertFrom-Json
    if($frame.method -eq 'terminal/output' -and [string]$frame.params.data -match ([char]27+'\[6n')){
     $held.StandardInput.WriteLine((@{jsonrpc='2.0';id=40;method='terminal/write';params=@{session_id=$terminal.session_id;data=([string][char]27+'[1;1R')}}|ConvertTo-Json -Depth 5 -Compress));$held.StandardInput.Flush()
    }
    $pendingLine=$held.StandardOutput.ReadLineAsync()
   }
  }
  if(!(Test-Path -LiteralPath $ready)){
   $held.StandardInput.WriteLine((@{jsonrpc='2.0';id=41;method='terminal/attach';params=@{session_id=$terminal.session_id;rows=24;cols=80}}|ConvertTo-Json -Depth 5 -Compress));$held.StandardInput.Flush()
   for($attempt=0;$attempt -lt 40;$attempt++){
    if(!$pendingLine.Wait(1000)){break};if(!$pendingLine.Result){break};$frame=$pendingLine.Result|ConvertFrom-Json
    if($frame.id -eq 41){$transcript=([string]$frame.result.transcript -replace '[^\x20-\x7E]','?');throw ('ACTUAL_TERMINAL_HOLDER_NOT_READY:'+ $transcript.Substring(0,[Math]::Min(1800,$transcript.Length)))}
    $pendingLine=$held.StandardOutput.ReadLineAsync()
   }
   throw 'ACTUAL_TERMINAL_HOLDER_NOT_READY'
  }
  $holderFacts=Get-Content -LiteralPath $ready -Raw -Encoding UTF8|ConvertFrom-Json
  $chain=@();$cursor=[int]$holderFacts.pid
  for($n=0;$n -lt 16 -and $cursor -gt 0;$n++){
   $entry=Get-CimInstance Win32_Process -Filter ('ProcessId='+$cursor)
   if(!$entry){break};$entryOwner=Invoke-CimMethod -InputObject $entry -MethodName GetOwnerSid
   if($entryOwner.Sid -ne $request.sid){throw 'TERMINAL_DESCENDANT_OWNER_CHANGED'}
   $chain+=@{pid=$entry.ProcessId;parent=$entry.ParentProcessId;path=$entry.ExecutablePath;created=$entry.CreationDate}
   if($cursor -eq $held.Id){break};$cursor=[int]$entry.ParentProcessId
  }
  if($cursor -ne $held.Id){throw 'ACTUAL_TERMINAL_DESCENDANT_NOT_OWNED'}
  $holderFacts|Add-Member -NotePropertyName parentChain -NotePropertyValue $chain
  $renameDenied=$false
  try{[IO.File]::Move($lockedPath,$lockedPath+'.check');[IO.File]::Move($lockedPath+'.check',$lockedPath)}catch [IO.IOException]{$renameDenied=$true}
  if(!$renameDenied){throw 'ACTUAL_TERMINAL_HOLDER_DID_NOT_DENY_RENAME'}
 }
 $first=Invoke-OwnedUninstall $(if($request.probeTerminalHolder){'actual-kc-terminal-descendant-file-held'}else{'actual-cli-stdin-held'})
 $fixFacts=$null
 if($request.probeWithProductFix){
  if($first.exitCode -ne 2 -or !$holderFacts){throw 'Product fix control requires the actual locked-file exit2 first'}
  $fixFacts=@{}
  $unitStart=[Diagnostics.ProcessStartInfo]::new();$unitStart.FileName=$env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe'
  $unitStart.Arguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $request.runRoot 'close-processes.test.ps1')+'" -Helper "'+(Join-Path $request.runRoot 'close-installed-processes.ps1')+'"'
  $unitStart.UseShellExecute=$false;$unitStart.CreateNoWindow=$true;$unitStart.RedirectStandardOutput=$true;$unitStart.RedirectStandardError=$true
  $unit=[Diagnostics.Process]::new();$unit.StartInfo=$unitStart
  try{
   if(!$unit.Start()){throw 'Product mechanism tests did not start'};$unitHandle=$unit.Handle
   $unitOut=$unit.StandardOutput.ReadToEndAsync();$unitErr=$unit.StandardError.ReadToEndAsync()
   if(!$unit.WaitForExit(20000)){& taskkill /PID $unit.Id /T /F 2>$null|Out-Null;throw 'Product mechanism tests timed out'}
   $fixFacts.mechanismFences=@{exitCode=$unit.ExitCode;output=$unitOut.GetAwaiter().GetResult();error=$unitErr.GetAwaiter().GetResult()}
   if($unit.ExitCode -ne 0){throw ('PRODUCT_MECHANISM_FENCE_FAILED:'+($fixFacts.mechanismFences|ConvertTo-Json -Compress))}
  }finally{$unit.Dispose()}
  foreach($mode in @('Inspect','Close')){
   $fixStart=[Diagnostics.ProcessStartInfo]::new()
   $fixStart.FileName=$env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe'
   $fixStart.Arguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $request.runRoot 'close-installed-processes.ps1')+'" -InstallDir "'+$install+'" -Mode '+$mode+' -Scope User -AppGuid '+$appGuid+' -InstallerPid '+$PID+' -WaitSeconds 1'
   $fixStart.UseShellExecute=$false;$fixStart.CreateNoWindow=$true;$fixStart.RedirectStandardOutput=$true;$fixStart.RedirectStandardError=$true
   $fixStart.EnvironmentVariables['PSExecutionPolicyPreference']='Restricted'
   $fix=[Diagnostics.Process]::new();$fix.StartInfo=$fixStart
   try{
    if(!$fix.Start()){throw 'Product preflight did not start'};$fixHandle=$fix.Handle
    $fixOutput=$fix.StandardOutput.ReadToEndAsync();$fixError=$fix.StandardError.ReadToEndAsync()
    if(!$fix.WaitForExit(45000)){& taskkill /PID $fix.Id /T /F 2>$null|Out-Null;throw 'Product preflight timed out'}
    $fixFacts[$mode]=@{exitCode=$fix.ExitCode;output=$fixOutput.GetAwaiter().GetResult();error=$fixError.GetAwaiter().GetResult()}
    if($fix.ExitCode -ne $(if($mode -eq 'Inspect'){10}else{0})){throw ('PRODUCT_PREFLIGHT_'+$mode+'_FAILED:'+($fixFacts[$mode]|ConvertTo-Json -Compress))}
   }finally{$fix.Dispose()}
  }
  $fixFacts.cliStopped=$held.HasExited
  $fixFacts.holderStopped=(!(Get-Process -Id $holderFacts.pid -ErrorAction SilentlyContinue))
  if(!$fixFacts.cliStopped -or !$fixFacts.holderStopped){throw 'Product preflight left actual owned descendants alive'}
 }
 if($holderFacts -and !$request.probeWithProductFix){[IO.File]::WriteAllText($release,'release')}

 # The control case only follows this completed fixture action, after the owned
 # process exits. No failed external effect or unknown user task is replayed.
 $held.StandardInput.Close()
 if(!$held.WaitForExit(15000)){& taskkill /PID $held.Id /T /F 2>$null|Out-Null;if(!$held.WaitForExit(5000)){throw 'Owned CLI did not stop'}}
 [void]$errorDrain.GetAwaiter().GetResult()
 if($first.exitCode -ne 0){[void](Invoke-OwnedUninstall 'same-tree-after-owned-cli-exit')}
 @{sid=$identity.User.Value;heldPid=$held.Id;heldStartedAt=$fact.CreationDate;actualCliInitialized=$true;modelCalls=0;userDataUsed=$false;minimalFixture=$true;holder=$holderFacts;productFix=$fixFacts;cases=@($results);reproducedExit2=($first.exitCode -eq 2)}
} finally {
 if($held){if(!$held.HasExited){$held.StandardInput.Close();if(!$held.WaitForExit(5000)){& taskkill /PID $held.Id /T /F 2>$null|Out-Null}};$held.Dispose()}
}
