param(
 [Parameter(Mandatory=$true)][string]$RunRoot,[Parameter(Mandatory=$true)][string]$Owner,
 [Parameter(Mandatory=$true)][string]$Sid,[Parameter(Mandatory=$true)][string]$Action,
 [Parameter(Mandatory=$true)][string]$HelperSha256,[string]$RootIdentity='',
 [string]$BootstrapPid='',[string]$BootstrapCreationTicks='',[string]$Scenario='raw'
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($Owner -notmatch '^[a-f0-9-]{36}$' -or $Action -notin @('prove-account','bootstrap','observe','write','reopen','cleanup')){throw 'Invalid owned actor request'}
if($Scenario -notin @('raw','config-core','host-rpc','private-rpc')){throw 'Unknown owned credential scenario'}
if([IO.Path]::GetFileName($RunRoot) -ne ('kcoder-package-'+$Owner)){throw 'Invalid owned handoff root'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -ne $Sid -or ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Owned actor must use its exact unprivileged SID'}
$private=Join-Path (Join-Path $RunRoot 'user-data') ('kcoder-package-'+$Owner)
$exchange=Join-Path $RunRoot 'exchange'
$birthPath=Join-Path $exchange 'root-birth.json'
$resultPath=Join-Path (Join-Path $RunRoot 'exchange') ($Action+'-result.json')
if($Action -eq 'prove-account'){
 @{status='passed';action=$Action;owner=$Owner;sid=$Sid;value=@{identityOnly=$true;vaultCalls=0}}|ConvertTo-Json -Depth 4 -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
 return
}
$helper=Join-Path $RunRoot 'security-helper.exe'
if((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $HelperSha256){throw 'Owned helper bytes changed'}
function Invoke-OwnedHost([string]$Mode) {
 $runtime=Get-Content -LiteralPath (Join-Path $RunRoot 'host-runtime.json') -Raw|ConvertFrom-Json
 if($runtime.owner -ne $Owner -or $runtime.helperSha256 -ne $HelperSha256){throw 'Original Host runtime identity changed'}
 if($Scenario -eq 'private-rpc'){
  if($runtime.version -ne 2 -or $runtime.scenario -ne 'private-rpc' -or $runtime.sources.Count -lt 10 -or $runtime.sources.Count -gt 16){throw 'Original private runtime changed'}
  $leaves=@{}
  foreach($row in $runtime.sources){
   if($row.leaf -notmatch '^[a-z0-9.-]+\.(mjs|exe)$' -or $row.sha256 -notmatch '^[a-f0-9]{64}$' -or $leaves.ContainsKey($row.leaf)){throw 'Invalid private runtime proof'}
   $leaves[$row.leaf]=$true
   if((Get-FileHash -LiteralPath (Join-Path $RunRoot $row.leaf) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $row.sha256){throw 'Original private runtime bytes changed'}
  }
  foreach($leaf in @('host-node.exe','host-cli.exe','host-probe.mjs','security-helper.exe')){if(!$leaves.ContainsKey($leaf)){throw 'Required private runtime proof missing'}}
 }else{
  if($runtime.version -ne 1){throw 'Original Host runtime version changed'}
  foreach($pair in @(@('host-node.exe',$runtime.nodeSha256),@('host-cli.exe',$runtime.cliSha256),@('host-probe.mjs',$runtime.probeSha256),@('app-server-stdio.mjs',$runtime.stdioSha256))){
   if($pair[1] -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath (Join-Path $RunRoot $pair[0]) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]){throw 'Original Host runtime bytes changed'}
  }
 }
 $phase=switch($Mode){'--vault-write'{'write'}'--vault-reopen'{'reopen'}'--vault-cleanup'{'cleanup'}default{throw 'Unknown Host phase'}}
 $raw=@(& (Join-Path $RunRoot 'host-node.exe') (Join-Path $RunRoot 'host-probe.mjs') $phase $private $Owner $RootIdentity $RunRoot 2>$null)
 if($LASTEXITCODE -ne 0){throw 'Owned Native Host action failed'}
 $text=$raw -join "`n"
 if($text.Length -gt 65536){throw 'Owned Host result exceeded budget'}
 return ($text|ConvertFrom-Json)
}
function Invoke-OwnedVault([string]$Mode) {
 if($Scenario -in @('host-rpc','private-rpc') -and $Mode -ne '--vault-root'){return (Invoke-OwnedHost $Mode)}
 if($Scenario -eq 'config-core' -and $Mode -ne '--vault-root'){
  $Mode=switch($Mode){'--vault-write'{'--core-publish'}'--vault-reopen'{'--core-reopen-undo'}'--vault-cleanup'{'--core-cleanup'}default{throw 'Unknown Core phase'}}
 }
 $arguments=@($Mode,$private,$Owner)
 if($Mode -ne '--vault-root'){$arguments+=,$RootIdentity}
 $raw=@(& $helper @arguments 2>$null)
 if($LASTEXITCODE -ne 0){throw 'Owned native vault action failed'}
 $text=$raw -join "`n"
 if($text.Length -gt 65536){throw 'Owned vault output exceeded budget'}
 return ($text|ConvertFrom-Json)
}
function Save-NewRecord([string]$Path,$Value) {
 $temporary=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 [IO.File]::WriteAllText($temporary,($Value|ConvertTo-Json -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
 [IO.File]::Move($temporary,$Path)
}
function Observe-OriginalRoot {
 if(!(Test-Path -LiteralPath $birthPath)){throw 'Original root birth receipt missing'}
 $birth=Get-Content -LiteralPath $birthPath -Raw|ConvertFrom-Json
 if($birth.owner -ne $Owner -or $birth.sid -ne $Sid -or $birth.helperSha256 -ne $HelperSha256 -or
    [string]$birth.pid -ne $BootstrapPid -or [string]$birth.creationTicks -ne $BootstrapCreationTicks -or
    $birth.stagingName -notmatch '^bootstrap-[a-f0-9]{32}$'){throw 'Original root birth proof changed'}
 $staged=Join-Path (Join-Path (Join-Path $RunRoot 'user-data') $birth.stagingName) ('kcoder-package-'+$Owner)
 $finalExists=Test-Path -LiteralPath $private
 $stagedExists=Test-Path -LiteralPath $staged
 if($finalExists -eq $stagedExists){throw 'Original private root is missing or ambiguous'}
 if($stagedExists){$script:private=$staged}
 $current=Invoke-OwnedVault '--vault-root'
 if($current.rootIdentity -ne $birth.rootIdentity){throw 'Original private root identity changed'}
 if($stagedExists -and $current.parentIdentity -ne $birth.stagingParentIdentity){throw 'Original staging parent identity changed'}
 if($RootIdentity -and $RootIdentity -ne $birth.rootIdentity){throw 'Requested private root identity changed'}
 $script:RootIdentity=[string]$birth.rootIdentity
 return @{rootIdentity=$birth.rootIdentity;published=$finalExists;originalBirthVerified=$true}
}
try {
 if($Action -eq 'bootstrap') {
  $planPath=Join-Path $exchange 'root-bootstrap-plan.json'
  if((Test-Path -LiteralPath $private) -or (Test-Path -LiteralPath $planPath) -or (Test-Path -LiteralPath $birthPath)){throw 'A prior bootstrap must be observed, never repeated'}
  $birthProcess=[Diagnostics.Process]::GetCurrentProcess()
  $stageName='bootstrap-'+[guid]::NewGuid().ToString('N')
  Save-NewRecord $planPath @{owner=$Owner;sid=$Sid;stagingName=$stageName;pid=$PID;creationTicks=$birthProcess.StartTime.ToUniversalTime().Ticks.ToString();helperSha256=$HelperSha256}
  $staging=Join-Path (Join-Path $RunRoot 'user-data') $stageName
  if(Test-Path -LiteralPath $staging){throw 'Staging directory collision'}
  [IO.Directory]::CreateDirectory($staging)|Out-Null
  $final=$private
  $script:private=Join-Path $staging ('kcoder-package-'+$Owner)
  [IO.Directory]::CreateDirectory($private)|Out-Null
  & icacls $private /inheritance:r /grant:r ('*'+$Sid+':(OI)(CI)F')|Out-Null
  if($LASTEXITCODE -ne 0){throw 'Owned actor root ACL unavailable'}
  [IO.File]::WriteAllText((Join-Path $private '.owner.json'),(@{owner=$Owner}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  $value=Invoke-OwnedVault '--vault-root'
  Save-NewRecord $birthPath @{owner=$Owner;sid=$Sid;stagingName=$stageName;pid=$PID;creationTicks=$birthProcess.StartTime.ToUniversalTime().Ticks.ToString();helperSha256=$HelperSha256;rootIdentity=$value.rootIdentity;stagingParentIdentity=$value.parentIdentity}
  [IO.Directory]::Move($private,$final)
  $script:private=$final
 } elseif($Action -eq 'observe') {
  $value=Observe-OriginalRoot
 } else {
  if(!$RootIdentity){throw 'Original private root identity is required'}
  $original=Observe-OriginalRoot
  if(!$original.published -and $Action -ne 'cleanup'){throw 'Original root publication is unconfirmed; no vault write allowed'}
  $value=Invoke-OwnedVault $(if($Action -eq 'write'){'--vault-write'}elseif($Action -eq 'reopen'){'--vault-reopen'}else{'--vault-cleanup'})
  if($Action -eq 'cleanup') {
   $noCoreWrite=($Scenario -eq 'config-core' -and $value.noBackendWriteDispatched -and $value.referenceCount -eq 0 -and $value.coreCaseNotCompleted)
   $noHostWrite=($Scenario -eq 'host-rpc' -and $value.noHostWriteDispatched -and $value.referenceCount -eq 0 -and $value.hostCaseNotCompleted)
   $noPrivateWrite=($Scenario -eq 'private-rpc' -and $value.noPrivateWriteDispatched -and $value.referenceCount -eq 0 -and $value.privateCaseNotCompleted)
   if(!$value.safeToRemoveRoot -or (!$value.systemEntryAbsenceVerified -and !$noCoreWrite -and !$noHostWrite -and !$noPrivateWrite)){throw 'Owned vault cleanup is unconfirmed'}
   [IO.Directory]::Delete($private,$true)
   if(Test-Path -LiteralPath $private){throw 'Owned private root remained'}
  }
 }
 @{status='passed';action=$Action;owner=$Owner;sid=$Sid;rootIdentity=$RootIdentity;value=$value;privateRootAbsent=!(Test-Path -LiteralPath $private)}|ConvertTo-Json -Depth 8 -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
} catch {
 # No exception/raw source or credential values enter result files.
 @{status='failed';action=$Action;errorCode='owned_vault_action_failed'}|ConvertTo-Json -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
 exit 2
}
