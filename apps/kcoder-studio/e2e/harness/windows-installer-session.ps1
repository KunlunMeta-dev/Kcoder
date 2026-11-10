param([Parameter(Mandatory=$true)][string]$RunRoot)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
$username=[string]$request.username;$owner=[string]$request.owner
if($null -ne $request.mechanismOnlyUpgrade -and $request.mechanismOnlyUpgrade -isnot [bool]){throw 'Mechanism-only upgrade must be an explicit boolean'}
if($request.mechanismOnlyUpgrade -and ($request.exerciseUI -or $request.smokeOnly -or $request.directoryTrust -or [string]$request.newSha256 -notmatch '^[a-f0-9]{64}$')){throw 'Invalid mechanism-only upgrade scope'}
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
 $index=0;$retentionIndex=0
 # Mechanism-only certifies installed bytes/version without an installed UI profile.
 # The doctor build-identity probe is reserved for the original full UI modes.
 function Run-OwnedUserAction([string]$action,[string]$installer,[string]$sha256,[string]$uiLabel='',[bool]$verify=$false) {
   if($action -eq 'profileDigest'){$script:retentionIndex++;$step='retention-'+$script:retentionIndex}
   else{$script:index++;$step=[string]$script:index}
   $path=Join-Path $RunRoot ('request-'+$step+'.json')
   $result=Join-Path $RunRoot ('result-'+$step+'.json')
   @{nativeBundledControlled=$request.nativeBundledControlled;controlledPacConsent=$request.controlledPacConsent;controlledFixtureId=$request.controlledFixtureId;managedJobLauncherSha256=$request.managedJobLauncherSha256;zeroBusinessMode=$request.zeroBusinessMode;diagnosticSourceCommit=$request.diagnosticSourceCommit;runtimeArchiveSha256=$request.runtimeArchiveSha256;action=$action;sid=$sid;username=$username;owner=$owner;runRoot=$RunRoot;installDirectory=(Join-Path $RunRoot 'Installed Studio');installer=$installer;sha256=$sha256;expectedCommit=$(if($request.mechanismOnlyUpgrade){''}else{$(if($action -in @('nativeWebSearch','nativeBundledSearch') -or $action -eq 'officeUI' -or ($action -eq 'installedUI' -and $verify) -or $installer -eq (Join-Path $RunRoot 'new.exe')){[string]$request.expectedCommit}else{''})});expectedCliSha256=$(if($action -in @('nativeWebSearch','nativeBundledSearch') -or $action -eq 'officeUI' -or ($action -eq 'installedUI' -and $verify) -or $installer -eq (Join-Path $RunRoot 'new.exe')){[string]$request.expectedCliSha256}else{''});resultPath=$result;probeCliSha256=$request.probeCliSha256;probeSupervisorSha256=$request.probeSupervisorSha256;probeTerminalHolder=$request.probeTerminalHolder;probeWithProductFix=$request.probeWithProductFix;node=$request.node;uiLabel=$uiLabel;verify=$verify;officeUpgradeOnly=[bool]$request.officeUpgradeOnly;startupWindowExpected=[bool]$request.startupWindowExpected;nativeWebSearch=[bool]$request.nativeWebSearch;nativeConsent=$request.nativeConsent;externalConsent=$request.externalConsent;currentFeatures=($verify -and [bool]$request.newSha256);smokeOnly=[bool]$request.smokeOnly;directoryTrust=($verify -and [bool]$request.directoryTrust);lifecycleModelUrl=$env:KCODER_E2E_LIFECYCLE_MODEL_URL;nativeImageOnly=$request.nativeImageOnly;nativeGateway=$request.nativeGateway;browserProfileNative=$request.browserProfileNative;browserProfileNativeMode=$request.browserProfileNativeMode;desktopArchiveSha256=$request.desktopArchiveSha256;chromiumArchiveSha256=$request.chromiumArchiveSha256;sourceTreeSha256=$request.sourceTreeSha256}|ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8
   $childArguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $RunRoot 'user.ps1')+'" -RequestPath "'+$path+'"'
   $exitCode=$ownedDesktop.Run($username,$env:COMPUTERNAME,[string]$request.password,($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe'),$childArguments,$RunRoot,$(if($action -eq 'install'){660000}elseif($action -eq 'officeUI'){360000}elseif($action -eq 'installedUI'){300000}else{240000}))
   if(!(Test-Path -LiteralPath $result)){throw ('Owned user did not publish result, code '+$exitCode)}
   $value=Get-Content -LiteralPath $result -Raw -Encoding UTF8|ConvertFrom-Json
   if(!$value.ok -and $action -ne 'nativeBundledSearch'){throw ('Owned '+$action+' failed: '+$value.error)}
   $script:lastUserResult=$value
   if($action -notin @('installedUI','profileDigest')){$steps.Add($value)}
 }
 function Start-OwnedLoopbackModel {
   $ready=Join-Path $RunRoot 'model-ready.json'
   $modelArguments=@(('"'+(Join-Path $RunRoot 'model.cjs')+'"'),('"'+$ready+'"'))
   if($request.officeNative){$modelArguments+='--office-native'}
   $script:modelProcess=Start-Process -FilePath $request.node -ArgumentList $modelArguments -WorkingDirectory $RunRoot -PassThru -WindowStyle Hidden
   $deadline=[DateTime]::UtcNow.AddSeconds(15)
   while(!(Test-Path -LiteralPath $ready) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
   if(!(Test-Path -LiteralPath $ready)){throw 'Owned model fixture did not start'}
   $port=(Get-Content -LiteralPath $ready -Raw|ConvertFrom-Json).port
   $env:KCODER_E2E_LIFECYCLE_MODEL_URL='http://127.0.0.1:'+$port+'/v1'
 }
 if($request.nativeComponents){
  if($request.exerciseUI -or $request.newSha256 -or $request.smokeOnly -or $request.directoryTrust -or $request.minimalUninstallProbe){throw 'Native component probe scope conflict'}
  if($request.browserProfileNativeMode -eq 'electron-ui'){Start-OwnedLoopbackModel}
  Run-OwnedUserAction 'nativeComponents' '' ''
  @{passed=$true;verificationScope='actual_native_windows_components';steps=$steps;ui=@();buildIdentity=$null;directoryTrust='not_requested'}|ConvertTo-Json -Depth 16 -Compress
  return
 }
 if($request.nativeBundledControlled){
  if(!$request.nativeWebSearch -or !$request.nativeWebFreshOnly -or !$request.nativeBundledParentRoute -or $request.controlledPacConsent -cne '1'){throw 'Controlled package scope conflict'}
  Run-OwnedUserAction 'controlledPacPreflight' '' ''
  Run-OwnedUserAction 'install' (Join-Path $RunRoot 'old.exe') ([string]$request.oldSha256)
  try{Run-OwnedUserAction 'nativeBundledSearch' '' ''; $controlled=$script:lastUserResult}
  finally{Run-OwnedUserAction 'uninstall' '' ''}
  @{passed=[bool]$controlled.ok;mechanismOnly=$false;upgraded=$false;steps=$steps;ui=@();controlledManagedSearch=$controlled.probe;buildIdentity=$controlled.probe.native.native.buildIdentity;verificationScope='installed_owned_controlled_pac_managed_search';realDefaultPublicAcceptance=$false;directoryTrust='not_requested'}|ConvertTo-Json -Depth 30 -Compress
  return
 }
 Run-OwnedUserAction 'inspect' '' ''
 if($request.minimalUninstallProbe){
  if($request.exerciseUI -or $request.newSha256 -or $request.smokeOnly -or $request.directoryTrust){throw 'Minimal uninstaller probe scope conflict'}
  Run-OwnedUserAction 'uninstallProbe' (Join-Path $RunRoot 'old.exe') ([string]$request.oldSha256)
  @{passed=$true;minimalUninstallProbe=$true;mechanismOnly=$true;upgraded=$false;steps=$steps;ui=@();buildIdentity=$null;buildIdentityProbeOwner='not_requested';verificationScope='actual_uninstaller_minimal_tree';directoryTrust='not_requested'}|ConvertTo-Json -Depth 14 -Compress
  return
 }
 Run-OwnedUserAction 'install' (Join-Path $RunRoot 'old.exe') ([string]$request.oldSha256)
 $uiResults=[Collections.Generic.List[object]]::new()
 $installedBuildIdentity=$null
 # This opt-in tests NSIS replacement only. It never starts the installed UI,
 # reads personal model configuration, or certifies a clean source build.
 if($request.mechanismOnlyUpgrade){Run-OwnedUserAction 'install' (Join-Path $RunRoot 'new.exe') ([string]$request.newSha256)}
 if($request.nativeWebSearch){
   if($request.nativeConsent -cne '1' -or $request.externalConsent -cne '1' -or !$request.newSha256){throw 'Native default web gate missing'}
   if(!$request.nativeWebFreshOnly){Run-OwnedUserAction 'install' (Join-Path $RunRoot 'new.exe') ([string]$request.newSha256)}
   Run-OwnedUserAction 'nativeWebSearch' '' ''
   $nativeResult=$script:lastUserResult.probe
   $bundledParentResult=$null
   if($request.nativeBundledParentRoute){
     Run-OwnedUserAction 'nativeBundledSearch' '' ''
     $bundledParentResult=if($script:lastUserResult.ok){$script:lastUserResult.probe}else{@{passed=$false;observation=$script:lastUserResult}}
   }
   Run-OwnedUserAction 'uninstall' '' ''
   $nativePassed=(!$request.nativeBundledParentRoute -or [bool]$bundledParentResult.passed)
   @{passed=$nativePassed;mechanismOnly=$false;upgraded=(!$request.nativeWebFreshOnly);steps=$steps;ui=@();nativeWebSearch=$nativeResult;bundledParentRoute=$bundledParentResult;buildIdentity=$nativeResult.buildIdentity;buildIdentityProbeOwner='ordinary-native-web-profile-owner';verificationScope=$(if($request.nativeWebFreshOnly){'installed_native_default_web_fresh'}else{'installed_native_default_web'});directoryTrust='not_requested'}|ConvertTo-Json -Depth 20 -Compress
   return
 }
 if($request.exerciseUI) {
   if(!(Test-Path -LiteralPath $request.node)){throw 'Explicit Windows Node runtime missing'}
   Start-OwnedLoopbackModel
   if($request.officeUpgradeOnly){
     if(!$request.officeNative -or !$request.newSha256 -or $request.directoryTrust){throw 'Invalid installed Office upgrade scope'}
     if(!$request.officeFreshInstallOnly){Run-OwnedUserAction 'install' (Join-Path $RunRoot 'new.exe') ([string]$request.newSha256)}
     Run-OwnedUserAction 'officeUI' '' ''
     $officeResult=$script:lastUserResult.probe
     $installedBuildIdentity=$script:lastUserResult.buildIdentity
     Run-OwnedUserAction 'uninstall' '' ''
     @{passed=$true;mechanismOnly=$false;upgraded=(!$request.officeFreshInstallOnly);steps=$steps;ui=@();office=$officeResult;buildIdentity=$installedBuildIdentity;buildIdentityProbeOwner='ordinary-office-profile-owner';verificationScope=$(if($request.officeFreshInstallOnly){'installed_office_fresh'}else{'installed_office_upgrade'});historyRestored=$false;oldUiStartupVerified=$false;directoryTrust='not_requested'}|ConvertTo-Json -Depth 18 -Compress
     return
   }
   function Run-InstalledUI([string]$label,[bool]$verify) {
     Run-OwnedUserAction 'installedUI' '' '' $label $verify
     $value=$script:lastUserResult.probe
     if(!$value.result.passed -or !$value.cleaned -or !$value.fixtureStateRetained){throw ('Installed UI incomplete '+$label)}
     $uiResults.Add(@{label=$label;sid=$script:lastUserResult.sid;isAdmin=$false;result=$value.result})
   }
   function Confirm-FixtureDataRetention([string]$label,[bool]$verify) {
     Run-OwnedUserAction 'profileDigest' '' '' $label $verify
     $value=$script:lastUserResult
     if($value.sid -ne $sid -or $value.isAdmin -ne $false -or $value.digestLabel -cne $label){throw 'Owned profile digest identity mismatch'}
     if($verify){if($value.unchanged -ne $true){throw 'Owned profile retention was not confirmed'}}
     elseif($value.recorded -ne $true){throw 'Owned profile baseline was not recorded'}
   }
   Run-InstalledUI 'seed' $false
   Confirm-FixtureDataRetention 'upgrade' $false
   if($request.newSha256) {
     Run-OwnedUserAction 'install' (Join-Path $RunRoot 'new.exe') ([string]$request.newSha256)
     $installedBuildIdentity=$script:lastUserResult.buildIdentity
     Confirm-FixtureDataRetention 'upgrade' $true
   }
   Run-InstalledUI 'restored' $true
   if(!$request.newSha256 -and $request.expectedCommit){$installedBuildIdentity=$script:lastUserResult.buildIdentity}
   if(!$request.smokeOnly){Run-InstalledUI 'restarted' $true}
   if($request.officeNative){
     Run-OwnedUserAction 'officeUI' '' ''
     $officeResult=$steps[$steps.Count-1].probe
   }
   Confirm-FixtureDataRetention 'uninstall' $false
 }
 Run-OwnedUserAction 'uninstall' '' ''
 if($request.exerciseUI){Confirm-FixtureDataRetention 'uninstall' $true}
 @{passed=$true;mechanismOnly=(!$request.exerciseUI);upgraded=[bool]$request.newSha256;steps=$steps;ui=$uiResults;office=$officeResult;buildIdentity=$installedBuildIdentity;buildIdentityProbeOwner=$(if($request.mechanismOnlyUpgrade){'not_requested'}else{'ui-profile-owner'});verificationScope=$(if($request.exerciseUI){'installed_ui'}else{'nsis_mechanism'});directoryTrust=$(if($request.directoryTrust){'verified'}else{'not_requested'})}|ConvertTo-Json -Depth 10 -Compress
} finally {
 if($modelProcess -and !$modelProcess.HasExited){Stop-Process -Id $modelProcess.Id -Force -ErrorAction SilentlyContinue}
 if($ownedDesktop){$ownedDesktop.Dispose()}
 $secure.Dispose()
}
