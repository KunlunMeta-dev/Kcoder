param([Parameter(Mandatory=$true)][string]$Configuration)
$config=Get-Content -LiteralPath $Configuration -Raw|ConvertFrom-Json
$Root=[string]$config.root;$Owner=[string]$config.owner;$Sid=[string]$config.sid;$Node=[string]$config.node
$ErrorActionPreference='Stop'
$marker=Get-Content -LiteralPath (Join-Path $Root '.owner.json') -Raw|ConvertFrom-Json
if($marker.owner -cne $Owner){throw 'Widget actor owner mismatch'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -cne $Sid){throw 'Widget actor SID mismatch'}
if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Widget actor must be ordinary'}
$source=Join-Path $Root 'source'
foreach($entry in (Get-Content -LiteralPath (Join-Path $Root 'source-inputs.json') -Raw|ConvertFrom-Json)){
 $path=Join-Path $source $entry.path
 if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256){throw 'Widget source hash mismatch'}
}
$env:HOME=Join-Path $Root 'actor-profile';$env:USERPROFILE=$env:HOME
$env:APPDATA=Join-Path $env:HOME 'AppData\Roaming';$env:LOCALAPPDATA=Join-Path $env:HOME 'AppData\Local'
$env:TEMP=Join-Path $Root 'actor-temp';$env:TMP=$env:TEMP
foreach($path in @($env:HOME,$env:APPDATA,$env:LOCALAPPDATA,$env:TEMP)){[IO.Directory]::CreateDirectory($path)|Out-Null}
# Match the existing source-desktop known-folder prerequisite without touching the real profile.
foreach($leaf in @('Downloads','Desktop','Documents')){[IO.Directory]::CreateDirectory((Join-Path $env:USERPROFILE $leaf))|Out-Null}
$env:KCODER_E2E_ELECTRON_BIN=Join-Path $Root 'electron\electron.exe'
$env:KCODER_E2E_PROCESS_SUPERVISOR_BIN=Join-Path $Root 'supervisor.exe'
Remove-Item Env:ELECTRON_RUN_AS_NODE,Env:NODE_OPTIONS,Env:KCODER_E2E_CHROMIUM_NO_SANDBOX -ErrorAction SilentlyContinue
Push-Location $source
try {
 $suite=if($config.suite){[string]$config.suite}else{'suites/browser/electron-widget-controller.e2e.mjs'}
 if($suite -cnotin @('suites/browser/electron-widget-controller.e2e.mjs','suites/browser/desktop-session-renewal.e2e.mjs','native-storage-unit','native-stream-self-test')){throw 'Unregistered owned suite'}
 $env:KCODER_E2E_KCODER_BIN=Join-Path $source 'bin\kcoder.exe'
 Add-Type -Path (Join-Path $source 'apps/kcoder-studio/e2e/harness/windows-native-stream.cs')
 if($suite -ceq 'native-storage-unit'){$arguments=@('--test','--test-concurrency=1','--test-reporter=tap','apps/kcoder-studio/src/mobile-device-private-storage.test.mjs','apps/kcoder-studio/src/mobile-device-storage-worker.test.mjs')}
 elseif($suite -ceq 'native-stream-self-test'){$env:KCODER_E2E_NATIVE_STREAM_ROOT=Join-Path $Root 'native-stream-self-test';$arguments=@('--test','--test-concurrency=1','--test-reporter=tap','apps/kcoder-studio/e2e/harness/windows-native-stream.test.mjs')}
 else{$arguments=@('apps/kcoder-studio/e2e/'+$suite)}
 $capture=[KcoderOwnedNativeStreams]::Run($Node,$arguments,$source,(Join-Path $Root 'suite.stdout.log'),(Join-Path $Root 'suite.stderr.log'),480000,4194304)
 [IO.File]::WriteAllText((Join-Path $Root 'native-stream-exit.json'),(@{owner=$Owner;sid=$Sid;capture=$capture}|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
 if($capture.TimedOut -or $capture.OutputLimitExceeded -or !$capture.DrainsCompleted){throw 'Owned native output or lifetime bound was not confirmed'}
 $code=$capture.ExitCode
 if($suite -ceq 'native-storage-unit'){
  [IO.File]::WriteAllText((Join-Path $Root 'native-storage-unit-exit.json'),(@{exitCode=$code;owner=$Owner;sid=$Sid;exactTarget='native-storage-unit'}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 }
} finally {Pop-Location}
exit $code
