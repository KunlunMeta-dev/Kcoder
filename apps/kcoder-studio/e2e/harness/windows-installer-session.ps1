param([Parameter(Mandatory=$true)][string]$RunRoot)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
$username=[string]$request.username;$owner=[string]$request.owner
if($username -notmatch '^kc_e2e_[a-f0-9]{8}$' -or $owner -notmatch '^[a-f0-9-]{36}$'){throw 'Invalid fixture identity'}
if(([IO.Path]::GetFileName($RunRoot)) -ne ('kcoder-installer-'+$owner)){throw 'Invalid fixture directory'}
if(Test-Path -LiteralPath $RunRoot){
 $marker=Get-Content -LiteralPath (Join-Path $RunRoot '.owner.json') -Raw|ConvertFrom-Json
 if($marker.owner -ne $owner -or $marker.username -ne $username){throw 'Run ownership marker mismatch'}
}
if(Get-LocalUser -Name $username -ErrorAction SilentlyContinue){throw 'Fixture account already exists'}
$secure=ConvertTo-SecureString ([string]$request.password) -AsPlainText -Force
$credential=[Management.Automation.PSCredential]::new(('.\'+$username),$secure)
$steps=[Collections.Generic.List[object]]::new()
try {
 $user=New-LocalUser -Name $username -Password $secure -Description ('KCoderE2E '+$owner) -AccountNeverExpires -PasswordNeverExpires
 $users=Get-LocalGroup -SID 'S-1-5-32-545';if(!(Get-LocalGroupMember -Group $users.Name | Where-Object {$_.SID.Value -eq $user.SID.Value})){Add-LocalGroupMember -Group $users.Name -Member $username}
 $sid=$user.SID.Value
 & icacls $RunRoot /grant ('*'+$sid+':(OI)(CI)F') | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Could not grant the temporary account access to its run'}
 Add-Type -Path (Join-Path $RunRoot 'desktop.cs')
 $ownedDesktop=[KcoderInstallerDesktop]::new($owner,$sid,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
 $index=0
 function Run-OwnedUserAction([string]$action,[string]$installer,[string]$sha256) {
   $script:index++
   $path=Join-Path $RunRoot ('request-'+$script:index+'.json')
   $result=Join-Path $RunRoot ('result-'+$script:index+'.json')
   @{action=$action;sid=$sid;username=$username;owner=$owner;runRoot=$RunRoot;installDirectory=(Join-Path $RunRoot 'Installed Studio');installer=$installer;sha256=$sha256;expectedCommit=$(if($installer -eq (Join-Path $RunRoot 'new.exe')){[string]$request.expectedCommit}else{''});expectedCliSha256=$(if($installer -eq (Join-Path $RunRoot 'new.exe')){[string]$request.expectedCliSha256}else{''});resultPath=$result}|ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8
   $childArguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $RunRoot 'user.ps1')+'" -RequestPath "'+$path+'"'
   $exitCode=$ownedDesktop.Run($username,$env:COMPUTERNAME,[string]$request.password,($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe'),$childArguments,$RunRoot,240000)
   if(!(Test-Path -LiteralPath $result)){throw ('Owned user did not publish result, code '+$exitCode)}
   $value=Get-Content -LiteralPath $result -Raw|ConvertFrom-Json
   if(!$value.ok){throw ('Owned '+$action+' failed: '+$value.error)}
   $steps.Add($value)
 }
 function Read-InstalledBuildIdentity {
    $install=Join-Path $RunRoot 'Installed Studio'
    $privateProfile=Join-Path $RunRoot 'installed-ui-profile\profile'
    if(!(Test-Path -LiteralPath (Join-Path $privateProfile 'settings.json'))){throw 'Owned upgrade profile is required for the identity probe'}
    $env:KCODER_CONFIG_DIR=$privateProfile
    $buildIdentity=@{}
    # Doctor is read-only. Capture privately in memory; only the three whitelisted
    # fields below reach the result. Native stderr never enters PowerShell errors.
    $doctorStart=[Diagnostics.ProcessStartInfo]::new()
    $doctorStart.FileName=Join-Path $install 'resources\bin\kcoder.exe'
    $doctorStart.Arguments='doctor'
    $doctorStart.WorkingDirectory=[string]$RunRoot
    $doctorStart.UseShellExecute=$false;$doctorStart.CreateNoWindow=$true
    $doctorStart.RedirectStandardOutput=$true;$doctorStart.RedirectStandardError=$true
    $doctor=[Diagnostics.Process]::new();$doctor.StartInfo=$doctorStart
    try {
      if(!$doctor.Start()){throw 'Installed CLI identity command could not start'}
      $doctorHandle=$doctor.Handle
      $doctorOutput=$doctor.StandardOutput.ReadToEndAsync()
      $doctorError=$doctor.StandardError.ReadToEndAsync()
      if(!$doctor.WaitForExit(60000)){& taskkill /PID $doctor.Id /T /F 2>$null|Out-Null;throw 'Installed CLI identity command timed out'}
      if($doctor.ExitCode -ne 0){throw 'Installed CLI identity command failed'}
      [void]$doctorError.GetAwaiter().GetResult()
      $doctorOutput.GetAwaiter().GetResult().Split("`n") | ForEach-Object {
        if($_ -match '^build commit:\s*([a-f0-9]{40})\s*$'){$buildIdentity.build_commit=$Matches[1].ToLowerInvariant()}
        elseif($_ -match '^build dirty:\s*(true|false)\s*$'){$buildIdentity.build_dirty=($Matches[1] -eq 'true')}
        elseif($_ -match '^executable sha256:\s*([a-f0-9]{64})\s*$'){$buildIdentity.executable_sha256=$Matches[1].ToLowerInvariant()}
      }
    } finally { $doctor.Dispose() }
    [IO.File]::WriteAllText((Join-Path $RunRoot 'windows-installed-build-identity.json'),($buildIdentity|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    if($buildIdentity.Count -ne 3){throw 'Installed CLI identity fields are missing'}
    if($buildIdentity.build_commit -cne [string]$request.expectedCommit){throw 'Installed CLI source commit mismatch'}
    if($buildIdentity.build_dirty -ne $false){throw 'Installed CLI was built from a dirty source tree'}
    if($buildIdentity.executable_sha256 -cne [string]$request.expectedCliSha256){throw 'Installed CLI self-reported file hash mismatch'}
    if((Get-FileHash -LiteralPath (Join-Path $install 'resources\bin\kcoder.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$request.expectedCliSha256){throw 'Installed CLI file bytes mismatch'}
    return $buildIdentity
 }
 Run-OwnedUserAction 'inspect' '' ''
 Run-OwnedUserAction 'install' (Join-Path $RunRoot 'old.exe') ([string]$request.oldSha256)
 $uiResults=[Collections.Generic.List[object]]::new()
 if($request.exerciseUI) {
   if(!(Test-Path -LiteralPath $request.node)){throw 'Explicit Windows Node runtime missing'}
   $ready=Join-Path $RunRoot 'model-ready.json'
   $modelProcess=Start-Process -FilePath $request.node -ArgumentList @(('"'+(Join-Path $RunRoot 'model.cjs')+'"'),('"'+$ready+'"')) -WorkingDirectory $RunRoot -PassThru -WindowStyle Hidden
   $deadline=[DateTime]::UtcNow.AddSeconds(15)
   while(!(Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
   if(!(Test-Path -LiteralPath $ready)){throw 'Owned model fixture did not start'}
   $port=(Get-Content -LiteralPath $ready -Raw|ConvertFrom-Json).port
   $env:KCODER_E2E_LIFECYCLE_MODEL_URL='http://127.0.0.1:'+$port+'/v1'
   function Run-InstalledUI([string]$label,[bool]$verify) {
     $install=Join-Path $RunRoot 'Installed Studio'
     $probeArguments=@(('"'+(Join-Path $RunRoot 'probe.cjs')+'"'),('"'+(Join-Path $install 'resources\bin\kcoder.exe')+'"'),('"'+$install+'"'),('"'+$RunRoot+'"'),('"'+$RunRoot+'"'),'--direct-install')
     if($verify){$probeArguments+='--lifecycle-verify'}
     if($request.smokeOnly){$probeArguments+='--lifecycle-smoke'}
     if($verify -and $request.newSha256){$probeArguments+='--lifecycle-current-features'}
     $stdout=Join-Path $RunRoot ($label+'-stdout.json');$stderr=Join-Path $RunRoot ($label+'-stderr.log')
     $probe=Start-Process -FilePath $request.node -ArgumentList $probeArguments -WorkingDirectory $RunRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden
     $probeHandle=$probe.Handle
     if(!$probe.WaitForExit(240000)){& taskkill /PID $probe.Id /T /F|Out-Null;throw ('Installed UI timeout '+$label)}
     $probe.Refresh()
     if($null -eq $probe.ExitCode -or $probe.ExitCode -ne 0){throw ('Installed UI failed '+$label+' code='+$probe.ExitCode+': '+(Get-Content -LiteralPath $stderr -Raw))}
     $value=Get-Content -LiteralPath $stdout -Raw|ConvertFrom-Json
     if(!$value.result.passed -or !$value.cleaned -or !$value.fixtureStateRetained){throw ('Installed UI incomplete '+$label)}
     $uiResults.Add(@{label=$label;result=$value.result})
   }
   function Get-FixtureDataDigest {
     $data=Join-Path $RunRoot 'installed-ui-profile'
     $hashes=@{}
     Get-ChildItem -LiteralPath $data -Recurse -File | Where-Object {$_.FullName -notmatch '\\(Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache)\\'} | ForEach-Object {$hashes[$_.FullName.Substring($data.Length)]=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
     return ($hashes.GetEnumerator()|Sort-Object Name|ForEach-Object {$_.Name+'='+$_.Value}) -join "`n"
   }
   Run-InstalledUI 'seed' $false
   $dataBefore=Get-FixtureDataDigest
   if($request.newSha256) {
     Run-OwnedUserAction 'install' (Join-Path $RunRoot 'new.exe') ([string]$request.newSha256)
     $installedBuildIdentity=Read-InstalledBuildIdentity
     if((Get-FixtureDataDigest) -ne $dataBefore){throw 'Actual upgrade changed stopped fixture user data'}
   }
   if(!$request.newSha256 -and $request.expectedCommit){$installedBuildIdentity=Read-InstalledBuildIdentity}
   Run-InstalledUI 'restored' $true
   if(!$request.smokeOnly){Run-InstalledUI 'restarted' $true}
   $dataBeforeUninstall=Get-FixtureDataDigest
 }
 Run-OwnedUserAction 'uninstall' '' ''
 if($request.exerciseUI -and (Get-FixtureDataDigest) -ne $dataBeforeUninstall){throw 'Uninstall changed retained fixture profile'}
 @{passed=$true;mechanismOnly=(!$request.exerciseUI);upgraded=[bool]$request.newSha256;steps=$steps;ui=$uiResults;buildIdentity=$installedBuildIdentity;buildIdentityProbeOwner='ui-profile-owner'}|ConvertTo-Json -Depth 10 -Compress
} finally {
 if($modelProcess -and !$modelProcess.HasExited){Stop-Process -Id $modelProcess.Id -Force -ErrorAction SilentlyContinue}
 if($ownedDesktop){$ownedDesktop.Dispose()}
 $secure.Dispose()
}
