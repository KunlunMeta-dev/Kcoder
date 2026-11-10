param([Parameter(Mandatory=$true)][string]$RunRoot,[Parameter(Mandatory=$true)][string]$Owner)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$raw=[Console]::In.ReadLine()
if(!$raw -or $raw.Length -gt 8192){throw 'Owned logon input budget'}
$request=$raw|ConvertFrom-Json;$raw=$null
if(!$request.scenario){$request|Add-Member -NotePropertyName scenario -NotePropertyValue 'raw' -Force}
if($request.scenario -notin @('raw','config-core','host-rpc','private-rpc')){throw 'Unknown owned credential scenario'}
$username=[string]$request.username
if($Owner -notmatch '^[a-f0-9-]{36}$' -or $username -notmatch '^kc_e2e_[a-f0-9]{8}$' -or [string]$request.owner -ne $Owner){throw 'Invalid owned account identity'}
if([IO.Path]::GetFileName($RunRoot) -ne ('kcoder-package-'+$Owner)){throw 'Invalid owned directory'}
$marker=Get-Content -LiteralPath (Join-Path $RunRoot '.owner.json') -Raw|ConvertFrom-Json
if($marker.owner -ne $Owner){throw 'Wrong owned directory marker'}
$intentPath=Join-Path $RunRoot 'account-owner-intent.json'
function Get-OwnedDescription {param([string]$Value);return ('KCKeyring '+$Value)}
$description=Get-OwnedDescription $Owner
$controller=[Diagnostics.Process]::GetCurrentProcess()
$script:intent=$null
function Save-Intent {
 $temporary=$intentPath+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 [IO.File]::WriteAllText($temporary,($script:intent|ConvertTo-Json -Depth 12 -Compress),[Text.UTF8Encoding]::new($false))
 if(Test-Path -LiteralPath $intentPath){[IO.File]::Replace($temporary,$intentPath,[System.Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($temporary,$intentPath)}
}
function Set-IntentField([string]$Name,$Value) {
 if($script:intent -is [Collections.IDictionary]){$script:intent[$Name]=$Value}else{$script:intent|Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force}
}
function Assert-Account {
 $current=Get-LocalUser -Name $username -ErrorAction SilentlyContinue
 if(!$current -or $current.SID.Value -ne $script:intent.sid -or $current.Description -ne $description){throw 'Original owned account identity changed'}
 return $current
}
function Assert-OriginalJobsStopped {
 if(!$script:intent.lastLaunchStopped -or @($script:intent.jobs|Where-Object{!$_.stopped}).Count){throw 'Original worker stop is unconfirmed; retain the account'}
}
function Has-SufficientCleanupReceipt {
 return ($script:intent.cleanupReceipt -and $script:intent.privateRootAbsent -and
  ($script:intent.cleanupReceipt.systemEntryAbsenceVerified -or
   ($script:intent.cleanupReceipt.noVaultWriteDispatched -and !$script:intent.writesMayHaveRun -and !$script:intent.bootstrapPid) -or
   ($script:intent.scenario -eq 'config-core' -and $script:intent.cleanupReceipt.noBackendWriteDispatched -and
    $script:intent.cleanupReceipt.referenceCount -eq 0 -and $script:intent.cleanupReceipt.coreCaseNotCompleted) -or
   ($script:intent.scenario -eq 'host-rpc' -and $script:intent.cleanupReceipt.noHostWriteDispatched -and
    $script:intent.cleanupReceipt.referenceCount -eq 0 -and $script:intent.cleanupReceipt.hostCaseNotCompleted) -or
   ($script:intent.scenario -eq 'private-rpc' -and $script:intent.cleanupReceipt.noPrivateWriteDispatched -and
    $script:intent.cleanupReceipt.referenceCount -eq 0 -and $script:intent.cleanupReceipt.privateCaseNotCompleted)))
}
function Ensure-Handoff {
 & icacls $RunRoot /grant ('*'+$script:intent.sid+':(OI)(CI)RX')|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Owned account handoff access unavailable'}
 foreach($leaf in @('user-data','exchange')) {
  $directory=Join-Path $RunRoot $leaf
  [IO.Directory]::CreateDirectory($directory)|Out-Null
  & icacls $directory /grant ('*'+$script:intent.sid+':(OI)(CI)M')|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Owned actor write access unavailable'}
 }
}
function Recover-OriginalSid {
 if(!$script:intent.accountWasAbsent -or !$script:intent.creationAttempted -or !$script:intent.creationStartedAt){throw 'Original account creation evidence is missing'}
 $candidate=Get-LocalUser -Name $username -ErrorAction SilentlyContinue
 $started=[DateTime]::Parse([string]$script:intent.creationStartedAt).ToUniversalTime()
 if(!$candidate -or $candidate.Description -ne $description -or !$candidate.PasswordLastSet -or
    $candidate.PasswordLastSet.ToUniversalTime() -lt $started.AddSeconds(-3) -or
    $candidate.PasswordLastSet.ToUniversalTime() -gt $started.AddMinutes(5)){throw 'Original account birth cannot be reconciled'}
 $candidateSid=$candidate.SID.Value
 $recoveryDesktop=[KcoderInstallerDesktop]::new($Owner,$candidateSid,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
 $publish=[Action[KcoderOwnedLogonBirth]]{
  param($birth)
  $same=Get-LocalUser -Name $username -ErrorAction Stop
  if($same.SID.Value -ne $birth.Sid -or $same.Description -ne $description -or $script:intent.sid){throw 'Recovered account identity changed'}
  $script:intent.sid=$birth.Sid
  Set-IntentField 'recoveredByOriginalPassword' $true
  $script:intent.jobs+=@(@{action='prove-account';pid=$birth.Pid;creationTicks=$birth.CreationTicks;sid=$birth.Sid;logonLuid=$birth.AuthenticationId;logonType=$birth.LogonType;profileHiveLoaded=$birth.ProfileHiveLoaded;elevated=$birth.Elevated;stopped=$false})
  Save-Intent
  Ensure-Handoff
 }
 $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $RunRoot 'actor.ps1')+'" -RunRoot "'+$RunRoot+'" -Owner '+$Owner+' -Sid '+$candidateSid+' -Action prove-account -HelperSha256 '+$script:intent.helperSha256
 try {
  $script:intent.lastLaunchStopped=$false;Save-Intent
  # Profile/password authentication binds the actual SID before any actor code runs.
  $value=$recoveryDesktop.RunObserved($username,$env:COMPUTERNAME,[string]$request.password,$candidateSid,($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe'),$arguments,$env:SystemRoot,60000,$watch,$publish)
  $script:intent.lastLaunchStopped=$value.JobEmpty;$script:intent.jobs[-1].stopped=$value.JobEmpty;Save-Intent
  if($value.ExitCode -ne 0){throw 'Original account authentication actor failed'}
 } catch {
  $script:intent.lastLaunchStopped=$recoveryDesktop.LastOwnedJobStopped
  if($recoveryDesktop.LastOwnedJobStopped -and $script:intent.jobs.Count -gt 0 -and $script:intent.jobs[-1].action -eq 'prove-account'){$script:intent.jobs[-1].stopped=$true}
  Save-Intent;throw
 } finally {$recoveryDesktop.Dispose()}
}
function Invoke-Actor([string]$Action) {
 [void](Assert-Account)
 $path=Join-Path (Join-Path $RunRoot 'exchange') ($Action+'-result.json')
 if($Action -eq 'cleanup' -and (Test-Path -LiteralPath $path)){
  $old=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
  if($old.status -eq 'passed' -and $old.owner -eq $Owner -and $old.sid -eq $script:intent.sid -and $old.rootIdentity -eq $script:intent.rootIdentity -and $old.privateRootAbsent -and $old.value.safeToRemoveRoot -and $old.value.systemEntryAbsenceVerified){return $old}
 }
 $script:phase=$Action
 $arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $RunRoot 'actor.ps1')+'" -RunRoot "'+$RunRoot+'" -Owner '+$Owner+' -Sid '+$script:intent.sid+' -Action '+$Action+' -HelperSha256 '+$script:intent.helperSha256
 $arguments+=' -Scenario '+$request.scenario
 if($script:intent.rootIdentity){$arguments+=' -RootIdentity "'+$script:intent.rootIdentity+'"'}
 if($script:intent.bootstrapPid){$arguments+=' -BootstrapPid '+$script:intent.bootstrapPid+' -BootstrapCreationTicks '+$script:intent.bootstrapCreationTicks}
 $script:intent.lastLaunchStopped=$false;Save-Intent
 $publish=[Action[KcoderOwnedLogonBirth]]{
  param($birth)
  $entry=@{action=$script:phase;pid=$birth.Pid;creationTicks=$birth.CreationTicks;sid=$birth.Sid;logonLuid=$birth.AuthenticationId;logonType=$birth.LogonType;profileHiveLoaded=$birth.ProfileHiveLoaded;elevated=$birth.Elevated;stopped=$false}
  $script:intent.jobs+=@($entry)
  if($script:phase -eq 'bootstrap'){$script:intent.bootstrapPid=[string]$birth.Pid;$script:intent.bootstrapCreationTicks=$birth.CreationTicks}
  Save-Intent
 }
 try {
  $value=$desktop.RunObserved($username,$env:COMPUTERNAME,[string]$request.password,$script:intent.sid,($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe'),$arguments,$RunRoot,60000,$watch,$publish)
  $script:intent.jobs[-1].stopped=$value.JobEmpty
  $script:intent.lastLaunchStopped=$value.JobEmpty;Save-Intent
  if($value.ExitCode -ne 0){throw 'Owned actor did not complete'}
 } catch {
  if($desktop.LastOwnedJobStopped -and $script:intent.jobs.Count -gt 0 -and $script:intent.jobs[-1].action -eq $Action){$script:intent.jobs[-1].stopped=$true}
  $script:intent.lastLaunchStopped=$desktop.LastOwnedJobStopped;Save-Intent
  throw
 }
 $result=Get-Content -LiteralPath $path -Raw|ConvertFrom-Json
 if($result.status -ne 'passed' -or $result.action -ne $Action){throw 'Owned actor result is unconfirmed'}
 return $result
}
$desktop=$null;$watch=$null;$secure=$null
try {
 if($request.action -notin @('run','cleanup')){throw 'Invalid controller action'}
 if($request.password.Length -lt 32 -or $request.password.Length -gt 128){throw 'Invalid synthetic account password'}
 $env:TEMP=Join-Path $RunRoot 'compiler-temp';$env:TMP=$env:TEMP
 [IO.Directory]::CreateDirectory($env:TEMP)|Out-Null
 Add-Type -Path @((Join-Path $RunRoot 'desktop.cs'),(Join-Path $RunRoot 'logon.cs'))
 $watch=[KcoderInstallerDesktop]::WatchOwnerInput()
 if($request.action -eq 'run') {
  if((Test-Path -LiteralPath $intentPath) -or (Get-LocalUser -Name $username -ErrorAction SilentlyContinue)){throw 'Original request requires reconciliation; account creation is never replayed'}
  $script:intent=@{version=1;owner=$Owner;username=$username;description=$description;scenario=[string]$request.scenario;sid=$null;helperSha256=[string]$request.helperSha256;rootIdentity=$null;bootstrapPid=$null;bootstrapCreationTicks=$null;jobs=@();lastLaunchStopped=$true;writesMayHaveRun=$false;accountWasAbsent=$true;creationAttempted=$false;creationStartedAt=$null;phase='account_creation_intent';controllerPid=$PID;controllerBirth=$controller.StartTime.ToUniversalTime().Ticks.ToString()}
  Save-Intent
  if($watch.WaitOne(0)){throw 'Owner ended before account creation'}
  $secure=ConvertTo-SecureString ([string]$request.password) -AsPlainText -Force
  $script:intent.creationAttempted=$true;$script:intent.creationStartedAt=[DateTime]::UtcNow.ToString('o');Save-Intent
  $creationDescription=$description
  if($request.fault -eq 'prebinding-reject'){$creationDescription='x'*49;Set-IntentField 'testFaultReached' 'prebinding-reject';Save-Intent}
  try{$user=New-LocalUser -Name $username -Password $secure -Description $creationDescription -AccountNeverExpires -PasswordNeverExpires}catch [Management.Automation.ParameterBindingException]{
   Set-IntentField 'creationRejectedBeforeInvocation' $true
   Set-IntentField 'creationRejectionCode' 'parameter_binding'
   $script:intent.phase='account_creation_rejected';Save-Intent;throw
  }
  if($request.fault -eq 'sid-ack'){Set-IntentField 'testFaultReached' 'sid-ack';Save-Intent;throw 'Owned fixture injected lost SID acknowledgement'}
  $script:intent.sid=$user.SID.Value;$script:intent.phase='account_born';Save-Intent
  $group=Get-LocalGroup -SID 'S-1-5-32-545'
  if(!(Get-LocalGroupMember -Group $group.Name|Where-Object{$_.SID.Value -eq $user.SID.Value})){Add-LocalGroupMember -Group $group.Name -Member $username -ErrorAction Stop}
  Ensure-Handoff
 } else {
  if(!(Test-Path -LiteralPath $intentPath)){
   if(Get-LocalUser -Name $username -ErrorAction SilentlyContinue){throw 'Untracked account is never adopted'}
   @{cleaned=$true;owner=$Owner;ownedSid=$script:intent.sid;accountAbsent=$true;profileAbsent=$true;disposition='never_created'}|ConvertTo-Json -Compress;return
  }
  $script:intent=Get-Content -LiteralPath $intentPath -Raw|ConvertFrom-Json
  if($script:intent.owner -ne $Owner -or $script:intent.username -ne $username){throw 'Original account intent changed'}
  if(($script:intent.scenario -and $script:intent.scenario -ne $request.scenario) -or (!$script:intent.scenario -and $request.scenario -ne 'raw')){throw 'Original credential scenario changed'}
  if(!$script:intent.sid){
   if($script:intent.accountWasAbsent -and $script:intent.creationRejectedBeforeInvocation -and $script:intent.creationRejectionCode -eq 'parameter_binding' -and
      !$script:intent.writesMayHaveRun -and !$script:intent.bootstrapPid -and $script:intent.jobs.Count -eq 0 -and $script:intent.lastLaunchStopped -and
      !(Get-LocalUser -Name $username -ErrorAction SilentlyContinue)){
    @{cleaned=$true;owner=$Owner;ownedSid=$script:intent.sid;accountAbsent=$true;profileAbsent=$true;disposition='never_created';reason='parameter_binding_rejected_before_invoke'}|ConvertTo-Json -Compress;return
   }
   if(!$script:intent.creationAttempted -and !(Get-LocalUser -Name $username -ErrorAction SilentlyContinue)){
    @{cleaned=$true;owner=$Owner;ownedSid=$script:intent.sid;accountAbsent=$true;profileAbsent=$true;disposition='never_created'}|ConvertTo-Json -Compress;return
   }
   Recover-OriginalSid
  }
  $current=Get-LocalUser -Name $username -ErrorAction SilentlyContinue
  if(!$current -and (Has-SufficientCleanupReceipt) -and $script:intent.lastLaunchStopped -and
     $script:intent.cleanupReceipt.safeToRemoveRoot -and
     !(Get-CimInstance Win32_UserProfile -Filter ("SID='"+$script:intent.sid+"'"))){
   Assert-OriginalJobsStopped
   $script:intent.phase='cleaned';Save-Intent
   @{cleaned=$true;owner=$Owner;ownedSid=$script:intent.sid;accountAbsent=$true;profileAbsent=$true;vault=$script:intent.cleanupReceipt;allJobsStopped=$true;disposition='already_absent_after_original_cleanup'}|ConvertTo-Json -Depth 8 -Compress;return
  }
  if($script:intent.phase -eq 'cleaned'){
   Assert-OriginalJobsStopped
   if(!(Has-SufficientCleanupReceipt)){throw 'Original cleanup receipt is incomplete'}
   if((Get-LocalUser -Name $username -ErrorAction SilentlyContinue) -or (Get-CimInstance Win32_UserProfile -Filter ("SID='"+$script:intent.sid+"'"))){throw 'Completed owned cleanup identity changed'}
   @{cleaned=$true;owner=$Owner;ownedSid=$script:intent.sid;accountAbsent=$true;profileAbsent=$true;vault=$script:intent.cleanupReceipt;allJobsStopped=$true;noVaultWriteDispatched=(!$script:intent.writesMayHaveRun)}|ConvertTo-Json -Depth 8 -Compress;return
  }
  [void](Assert-Account)
  Assert-OriginalJobsStopped
 }
 $desktop=[KcoderInstallerDesktop]::new($Owner,$script:intent.sid,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
 if($request.action -eq 'run') {
  $root=Invoke-Actor 'bootstrap'
  if($request.fault -eq 'root-ack'){Set-IntentField 'testFaultReached' 'root-ack';Save-Intent;throw 'Owned fixture injected lost root acknowledgement'}
  $script:intent.rootIdentity=[string]$root.value.rootIdentity;$script:intent.phase='root_born';Save-Intent
  $script:intent.writesMayHaveRun=$true;Save-Intent
  $written=Invoke-Actor 'write';$reopened=Invoke-Actor 'reopen'
  $script:intent.phase='vault_reopened_deleted';Save-Intent
  @{passed=$true;scope=$(if($request.scenario -eq 'config-core'){'config_core_keyring'}elseif($request.scenario -eq 'host-rpc'){'native_migration_host_keyring'}elseif($request.scenario -eq 'private-rpc'){'native_private_transfer_keyring'}else{'os_backend_only'});owner=$Owner;username=$username;ownedSid=$script:intent.sid;written=$written.value;reopened=$reopened.value;jobs=$script:intent.jobs;coreStoreVerified=($request.scenario -eq 'config-core');coreMigrationVerified=$false;hostMigrationVerified=($request.scenario -in @('host-rpc','private-rpc'));privateTransferVerified=($request.scenario -eq 'private-rpc');gatewayMigrationVerified=$false}|ConvertTo-Json -Depth 10 -Compress
 } else {
  if(!$script:intent.rootIdentity -and $script:intent.bootstrapPid){
   $observed=Invoke-Actor 'observe';$script:intent.rootIdentity=[string]$observed.value.rootIdentity;Save-Intent
  }
  if($script:intent.rootIdentity){$cleaned=Invoke-Actor 'cleanup'}elseif($script:intent.writesMayHaveRun -or $script:intent.bootstrapPid){throw 'Original vault write/root identity is unconfirmed'}else{
   $private=Join-Path (Join-Path $RunRoot 'user-data') ('kcoder-package-'+$Owner)
   foreach($candidate in @($private,(Join-Path $RunRoot 'exchange\root-bootstrap-plan.json'),(Join-Path $RunRoot 'exchange\root-birth.json'))){if(Test-Path -LiteralPath $candidate){throw 'An untracked private root is never removed'}}
   $cleaned=@{privateRootAbsent=$true;value=@{safeToRemoveRoot=$true;systemEntryAbsenceVerified=$false;noVaultWriteDispatched=$true}}
  }
  if($desktop){$desktop.Dispose();$desktop=$null}
  Assert-OriginalJobsStopped
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do {
   $profile=Get-CimInstance Win32_UserProfile -Filter ("SID='"+$script:intent.sid+"'")
   if(!$profile){break}
   if(!$profile.Loaded){$profile|Remove-CimInstance;break}
   Start-Sleep -Milliseconds 100
  }while([DateTime]::UtcNow -lt $deadline)
  if(Get-CimInstance Win32_UserProfile -Filter ("SID='"+$script:intent.sid+"'")){throw 'Original owned profile remains loaded'}
  Set-IntentField 'cleanupReceipt' $cleaned.value;Save-Intent
  Set-IntentField 'privateRootAbsent' ([bool]$cleaned.privateRootAbsent);Save-Intent
  if(!(Has-SufficientCleanupReceipt)){throw 'Original cleanup facts are incomplete; retain the account'}
  [void](Assert-Account);Remove-LocalUser -SID ([Security.Principal.SecurityIdentifier]$script:intent.sid)
  if(Get-LocalUser -Name $username -ErrorAction SilentlyContinue){throw 'Original account removal is unconfirmed'}
  if($request.fault -eq 'cleanup-ack' -and $script:intent.testFaultReached -ne 'cleanup-ack'){Set-IntentField 'testFaultReached' 'cleanup-ack';Save-Intent;throw 'Owned fixture injected lost cleanup acknowledgement'}
  $script:intent.phase='cleaned';Save-Intent
  @{cleaned=$true;owner=$Owner;ownedSid=$script:intent.sid;accountAbsent=$true;profileAbsent=$true;vault=$cleaned.value;allJobsStopped=$true;noVaultWriteDispatched=(!$script:intent.writesMayHaveRun)}|ConvertTo-Json -Depth 8 -Compress
 }
} finally {
 if($desktop){$desktop.Dispose()}
 if($watch){$watch.Dispose()}
 if($secure){$secure.Dispose()}
 $request.password=$null
}
