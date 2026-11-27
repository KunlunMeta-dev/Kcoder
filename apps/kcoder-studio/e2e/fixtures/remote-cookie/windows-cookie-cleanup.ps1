param(
 [Parameter(Mandatory=$true)][string]$Root,
 [Parameter(Mandatory=$true)][string]$Owner,
 [Parameter(Mandatory=$true)][string]$RootDev,
 [Parameter(Mandatory=$true)][string]$RootIno,
 [Parameter(Mandatory=$true)][string]$Node,
 [Parameter(Mandatory=$true)][string]$SupervisorSha256,
 [switch]$NeverLaunched
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($Owner -notmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw 'Invalid original owner'}
if([IO.Path]::GetFileName($Root) -cne ('kcoder-package-'+$Owner)){throw 'Original root name mismatch'}
$marker=Get-Content -LiteralPath (Join-Path $Root '.owner.json') -Raw|ConvertFrom-Json
if($marker.owner -cne $Owner){throw 'Original owner changed'}
$identityScript="const fs=require('node:fs');const s=fs.lstatSync(process.argv[1],{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe root');console.log(JSON.stringify({dev:String(s.dev),ino:String(s.ino)}));"
$identity=(& $Node -e $identityScript $Root)|ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or $identity.dev -cne $RootDev -or $identity.ino -cne $RootIno){throw 'Original root file identity changed'}
function Assert-OriginalExited($Birth){
 $held=$null
 try{
  $held=[Diagnostics.Process]::GetProcessById([int]$Birth.pid)
  $handle=$held.Handle
  if($held.StartTime.ToUniversalTime().Ticks.ToString() -ceq [string]$Birth.creationTicks -and !$held.HasExited){throw 'Original process remains active'}
 }catch [ArgumentException]{}finally{if($held){$held.Dispose()}}
}
if($NeverLaunched){
 if((Test-Path -LiteralPath (Join-Path $Root 'controller-birth.json')) -or (Test-Path -LiteralPath (Join-Path $Root 'supervisor-birth.json'))){throw 'Unexpected launch authority exists'}
}else{
 $receipt=Get-Content -LiteralPath (Join-Path $Root 'job-empty-receipt.json') -Raw|ConvertFrom-Json
 $birth=Get-Content -LiteralPath (Join-Path $Root 'controller-birth.json') -Raw|ConvertFrom-Json
 $helper=Get-Content -LiteralPath (Join-Path $Root 'supervisor-birth.json') -Raw|ConvertFrom-Json
 if($receipt.owner -cne $Owner -or $birth.owner -cne $Owner -or $helper.owner -cne $Owner -or !$receipt.jobEmpty -or !$receipt.originalHandleClosed -or $receipt.supervisorSha256 -cne $SupervisorSha256){throw 'Original Job cleanup authority missing'}
 foreach($record in @($receipt,$birth,$helper)){if($record.rootIdentity.dev -cne $RootDev -or $record.rootIdentity.ino -cne $RootIno){throw 'Receipt root identity mismatch'}}
 if($receipt.nonce -cne $helper.nonce -or $receipt.heartbeatCount -lt 1 -or $receipt.controllerBirth.sessionId -ne 0 -or $receipt.supervisorBirth.sessionId -ne 0){throw 'Original owner control authority missing'}
 foreach($key in @('pid','creationTicks')){
  if($receipt.controllerBirth.$key -cne $birth.controllerBirth.$key -or $receipt.supervisorBirth.$key -cne $helper.supervisorBirth.$key){throw 'Original birth identity mismatch'}
 }
 $events=@($receipt.statusEvents)
 if($events[0].event -cne 'READY' -or $events[0].nonce -cne $receipt.nonce -or $events[-1].event -cne 'EXIT' -or $events[-1].code -ne $receipt.helperCloseCode -or @($events|Where-Object{$_.event -eq 'ERROR'}).Count){throw 'Original native Job lacks terminal proof'}
 Assert-OriginalExited $receipt.controllerBirth
 Assert-OriginalExited $receipt.supervisorBirth
}
[IO.Directory]::Delete($Root,$true)
if(Test-Path -LiteralPath $Root){throw 'Owned root deletion incomplete'}
@{version=1;owner=$Owner;directoryAbsent=$true;rootIdentity=$identity;originalProcessesExited=$true;nativeJobReceiptRequired=(!$NeverLaunched)}|ConvertTo-Json -Depth 5 -Compress
