param([Parameter(Mandatory=$true)]$Request,[switch]$PreflightOnly)
$ErrorActionPreference='Stop'
. (Join-Path $Request.runRoot 'owned-proxy-fixture.ps1')
$scope=Assert-OwnedProxyFixtureScope $Request
Initialize-OwnedProxyFixtureType
if($PreflightOnly){
  $networkReads=@();for($read=0;$read -lt 3;$read++){$networkReads+=,(Read-OwnedNetworkFlags)}
  foreach($flags in $networkReads){foreach($name in @('apiSucceeded','autoDetect','pacUrlConfigured','staticProxyConfigured','proxyEnvironmentPresent')){if($flags[$name] -ne $networkReads[0][$name]){throw 'Controlled preflight flag reads were inconsistent'}}}
  $capture=[OwnedPerUserProxyLease]::Capture()
  return @{passed=$true;phase='controlled_preinstall_readonly';scope=$scope;captured=$true;networkFlagReadCount=3;networkFlagReadsConsistent=$true;ordinaryAccountNetwork=$networkReads[0];settings=$capture.SafeReceipt();ownSidHkcuWriteCalls=0;machineRegistryWrites=0;personalRegistryWrites=0;certificateStoreWrites=0;installed=$false;queries=0}
}
$root=[string]$Request.runRoot
$certificates=Get-Content -LiteralPath (Join-Path $root 'managed-pac-certificates.json') -Raw|ConvertFrom-Json
if($certificates.fixtureId -cne [string]$Request.controlledFixtureId){throw 'Controlled certificate fixture identity mismatch'}
if((Get-FileHash -LiteralPath (Join-Path $root 'managed-ca.pem') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $certificates.caSha256){throw 'Controlled process CA bytes changed'}
if((Get-FileHash -LiteralPath (Join-Path $root 'managed-job-launcher.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$Request.managedJobLauncherSha256){throw 'Original controlled Job launcher changed'}
$launcher=Join-Path $root 'managed-launcher'
if(Test-Path -LiteralPath $launcher){throw 'Controlled launcher collision'}
[IO.Directory]::CreateDirectory($launcher)|Out-Null
$profileOwner=Join-Path $root 'managed-authority-profile'
$authorityProfile=Join-Path $profileOwner 'state';[IO.Directory]::CreateDirectory($authorityProfile)|Out-Null
$secured=& (Join-Path $root 'private-state-directory.ps1') -StateDirectory $authorityProfile -RunRoot $profileOwner|ConvertFrom-Json
[IO.File]::WriteAllBytes((Join-Path $launcher 'program.txt'),[Text.Encoding]::Unicode.GetBytes([string]$Request.node))
[IO.File]::WriteAllBytes((Join-Path $launcher 'profile.txt'),[Text.Encoding]::Unicode.GetBytes($authorityProfile))
[IO.File]::WriteAllBytes((Join-Path $launcher 'owner.txt'),[Text.Encoding]::Unicode.GetBytes([string]$Request.owner))
Copy-Item -LiteralPath (Join-Path $root 'managed-job-launcher.exe') -Destination (Join-Path $launcher 'launcher.exe')
$requestFile=Join-Path $root 'managed-session-input.json'
[IO.File]::WriteAllText($requestFile,($Request|ConvertTo-Json -Depth 10 -Compress),[Text.UTF8Encoding]::new($false))
$networkBefore=Read-OwnedNetworkFlags
$networkAfter=$null;$networkRestored=$false
$previousCa=[Environment]::GetEnvironmentVariable('SSL_CERT_FILE','Process')
$nativeChildrenSettled=$false;$started=$false;$process=[Diagnostics.Process]::new();$context=$null;$native=$null;$fixtureStopped=$null;$restoration=$null;$failure=$null;$restoredEnv=$false
function Receive-ControlledFrame([string]$kind,[int]$timeoutMs){
  $next=$process.StandardOutput.ReadLineAsync()
  if(!$next.Wait($timeoutMs)){throw 'Controlled owner observation deadline'}
  $line=$next.GetAwaiter().GetResult();if(!$line -or $line.Length -gt 1048576){throw 'Controlled owner frame absent or oversized'}
  try{$value=$line|ConvertFrom-Json}catch{throw 'Controlled owner frame invalid'}
  if($value.kind -cne $kind -or $value.owner -cne [string]$Request.owner){throw 'Controlled owner frame identity mismatch'}
  return $value
}
try{
  [Environment]::SetEnvironmentVariable('SSL_CERT_FILE',(Join-Path $root 'managed-ca.pem'),'Process')
  $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=Join-Path $launcher 'launcher.exe'
  $start.Arguments='"'+(Join-Path $root 'windows-managed-pac-session.mjs')+'" "'+$requestFile+'"'
  $start.WorkingDirectory=$root;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
  $process.StartInfo=$start;if(!$process.Start()){throw 'Controlled owned Job did not start'};$started=$true;$held=$process.Handle
  $discardedError=$process.StandardError.ReadToEndAsync()
  $ready=Receive-ControlledFrame 'ready' 20000
  if($ready.fixture.fixtureId -cne $certificates.fixtureId -or $ready.fixture.caSha256 -cne $certificates.caSha256 -or $ready.fixture.externalForwarding -ne $false){throw 'Controlled fixture ready contract mismatch'}
  $context=Start-OwnedProxyFixture $Request ([string]$ready.fixture.pacUrl)
  $network=Read-OwnedNetworkFlags
  if(!$network.apiSucceeded -or $network.autoDetect -or !$network.pacUrlConfigured -or $network.staticProxyConfigured -or $network.proxyEnvironmentPresent){throw 'Controlled own-SID PAC flags did not apply'}
  $process.StandardInput.WriteLine((@{owner=$Request.owner;command='run'}|ConvertTo-Json -Compress));$process.StandardInput.Flush()
  $native=Receive-ControlledFrame 'query-result' 180000
  $limit=[DateTime]::UtcNow.AddSeconds(5)
  do{$installedWorkers=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith(([string]$Request.installDirectory).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)});if(!$installedWorkers.Count){break};Start-Sleep -Milliseconds 100}while([DateTime]::UtcNow -lt $limit)
  if($installedWorkers.Count){throw 'Controlled installed workers remained after native receipt'}
  $nativeChildrenSettled=$true
}catch{$failure=@{phase='controlled-native';errorType=$_.Exception.GetType().Name}}
finally{
  if(!$nativeChildrenSettled -and $started -and !$process.HasExited){$process.StandardInput.Close();if(!$process.WaitForExit(5000)){$process.Kill();if(!$process.WaitForExit(5000)){throw 'Original controlled cancellation did not settle'}}}
  try{if($context){$restoration=Stop-OwnedProxyFixture $Request $context;$networkAfter=Read-OwnedNetworkFlags;$networkRestored=$true;foreach($flag in @('apiSucceeded','autoDetect','pacUrlConfigured','staticProxyConfigured','proxyEnvironmentPresent')){if($networkBefore[$flag] -ne $networkAfter[$flag]){$networkRestored=$false}}}}catch{$failure=@{phase='controlled-proxy-restore';errorType=$_.Exception.GetType().Name}}
  [Environment]::SetEnvironmentVariable('SSL_CERT_FILE',$previousCa,'Process')
  $restoredEnv=[Environment]::GetEnvironmentVariable('SSL_CERT_FILE','Process') -ceq $previousCa
  if($started -and !$process.HasExited){
    try{
      $process.StandardInput.WriteLine((@{owner=$Request.owner;command='stop'}|ConvertTo-Json -Compress));$process.StandardInput.Flush()
      $fixtureStopped=Receive-ControlledFrame 'stopped' 10000
    }catch{$failure=@{phase='controlled-fixture-stop';errorType=$_.Exception.GetType().Name}}
    $process.StandardInput.Close()
    if(!$process.WaitForExit(5000)){$process.Kill();if(!$process.WaitForExit(5000)){throw 'Original controlled Job did not settle'}}
  }
  $originalExitCode=if($started -and $process.HasExited){$process.ExitCode}else{$null}
  $process.Dispose()
}
$passed=(!$failure -and $native -and $native.passed -and $restoration.settings.originalPerConnectionReadbackEqual -and $networkRestored -and $restoredEnv -and $fixtureStopped.stats.closed -and $fixtureStopped.stats.activeSockets -eq 0 -and $originalExitCode -eq 0)
return @{passed=[bool]$passed;scope='actual-installed-native-managed-search-with-owned-valid-pac';realDefaultPublicAcceptance=$false;native=$native;fixtureStopped=$fixtureStopped;proxyRestoration=$restoration;initialNetwork=$networkBefore;controlledNetwork=$network;restoredNetwork=$networkAfter;networkFlagsRestored=$networkRestored;ownSidWriteReceipt=(Get-OwnedProxyFixtureWriteReceipt);installedOwnedWorkersAbsent=($native -and !$installedWorkers.Count);processCaEnvironmentRestored=$restoredEnv;certificateStoreWrites=0;machineRegistryWrites=0;personalRegistryWrites=0;ownedJobExitCode=$originalExitCode;failure=$failure;privateActorProfile=@{ownerMatchesCurrentSid=($secured.ownerSid -ceq $secured.currentSid);protected=$secured.protected;aceCount=$secured.aceCount}}
