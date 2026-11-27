param([Parameter(Mandatory=$true)][string]$Descriptor,[Parameter(Mandatory=$true)][string]$Node,[switch]$ReleaseOnly)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$inputData=Get-Content -LiteralPath $Descriptor -Raw -Encoding UTF8|ConvertFrom-Json
$root=$inputData.root
$installerStorage=$inputData.mode -ceq 'installer-storage'
if($inputData.mode -and !$installerStorage){throw 'Unknown interactive carrier mode'}
$runLevel=if($installerStorage){1}else{0}
if($installerStorage){
 if([IO.Path]::GetFileName($root) -cne ('kcoder-installer-'+$inputData.owner) -or $inputData.request.owner -cne $inputData.owner -or $inputData.request.directory -cne $root -or $inputData.request.node -cne $Node -or !$inputData.sessionId -or [int]$inputData.sessionId -lt 1){throw 'Original installer interactive scope mismatch'}
 if(!($inputData.request.profileQualificationOnly -or $inputData.request.storageOnly -or $inputData.request.storageUpgrade) -or $inputData.request.exerciseUI -or $inputData.request.nativeComponents -or $inputData.request.PSObject.Properties.Name -contains 'password'){throw 'Interactive installer requires a credential-free owned storage descriptor'}
}

if((Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw -Encoding UTF8|ConvertFrom-Json).owner -cne $inputData.owner){throw 'Owned UI task marker mismatch'}
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($current -cne $inputData.sid){throw 'Owned UI task current SID mismatch'}
$service=New-Object -ComObject Schedule.Service
$service.Connect()
$folder=$service.GetFolder('\')
$name='KCoder-E2E-Channel-'+$inputData.owner
$description='KCoder owned channel UI fixture '+$inputData.owner
$expectedArguments=if($installerStorage){'"'+(Join-Path $root 'controller.mjs')+'" "'+$root+'" --interactive-descriptor "'+$Descriptor+'"'}else{'"'+(Join-Path $root 'windows-widget-interactive-entry.mjs')+'" "'+$Descriptor+'"'}
function Remove-OwnedInteractiveTask {
 $currentTask=$null
 try{$currentTask=$folder.GetTask($name)}catch{if($_.Exception.HResult -ne -2147024894){throw}}
 if($currentTask){
  $d=$currentTask.Definition
  $principalSid=if($d.Principal.UserId -match '^S-1-'){[Security.Principal.SecurityIdentifier]::new($d.Principal.UserId).Value}else{[Security.Principal.NTAccount]::new($d.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value}
  if($d.RegistrationInfo.Description -cne $description -or $d.Actions.Count -ne 1 -or $d.Actions.Item(1).Path -cne $Node -or $d.Actions.Item(1).Arguments -cne $expectedArguments -or $principalSid -cne $current -or $d.Principal.LogonType -ne 3 -or $d.Principal.RunLevel -ne $runLevel -or $d.Triggers.Count -ne 0 -or $d.Settings.RestartCount -ne 0){throw 'Owned UI task changed; retain original receipt'}
  if($currentTask.GetInstances(0).Count -gt 0){$currentTask.Stop(0)}
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  while($currentTask.GetInstances(0).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
  if($currentTask.GetInstances(0).Count -gt 0){throw 'Original interactive worker stop unconfirmed'}
  $folder.DeleteTask($name,0)
 }
 @{taskAbsent=$true;owner=$inputData.owner;originalTaskReconciled=$true}
}
if($ReleaseOnly){Remove-OwnedInteractiveTask|ConvertTo-Json -Compress;exit 0}

$existing=$null
try{$existing=$folder.GetTask($name)}catch{if($_.Exception.HResult -ne -2147024894){throw}}
if($existing){throw 'Owned UI task must be exclusive'}
$definition=$service.NewTask(0)
$definition.RegistrationInfo.Description=$description
$definition.Principal.UserId=$current
$definition.Principal.LogonType=3
$definition.Principal.RunLevel=$runLevel
$definition.Settings.Enabled=$true
$definition.Settings.MultipleInstances=2
$definition.Settings.RestartCount=0
$definition.Settings.ExecutionTimeLimit='PT10M'
$definition.Settings.DisallowStartIfOnBatteries=$false
$definition.Settings.StopIfGoingOnBatteries=$false
$action=$definition.Actions.Create(0)
$action.Path=$Node
$action.Arguments=$expectedArguments
$action.WorkingDirectory=$root
@{owner=$inputData.owner;taskName=$name;node=$Node;arguments=$action.Arguments;description=$description}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $root 'channel-fixture-task.json') -Encoding UTF8
$task=$folder.RegisterTaskDefinition($name,$definition,2,$current,$null,3,('D:P(A;;GA;;;SY)(A;;GA;;;'+$current+')'))
try {
 if($task.Definition.Principal.LogonType -ne 3 -or $task.Definition.Principal.RunLevel -ne $runLevel -or $task.Definition.Triggers.Count -ne 0 -or $task.Definition.Settings.RestartCount -ne 0){throw 'Owned UI task is not the requested InteractiveToken/run-level zero-trigger carrier'}
 $null=$task.Run($null)
 $end=[DateTime]::UtcNow.AddSeconds(540)
 $result=Join-Path $root 'channel-scope-result.json'
 while(!(Test-Path -LiteralPath $result) -and [DateTime]::UtcNow -lt $end){
  Start-Sleep -Milliseconds 100
  if($task.GetInstances(0).Count -eq 0 -and $task.LastRunTime.ToUniversalTime() -gt [DateTime]::UtcNow.AddMinutes(-1)){
   if(!(Test-Path -LiteralPath $result)){throw ('Owned LUA worker exited before its result: '+$task.LastTaskResult)}
  }
 }
 if(!(Test-Path -LiteralPath $result)){throw 'Owned LUA channel case outcome unknown'}
 $settle=[DateTime]::UtcNow.AddSeconds(10)
 while($task.GetInstances(0).Count -gt 0 -and [DateTime]::UtcNow -lt $settle){Start-Sleep -Milliseconds 50}
 if($task.GetInstances(0).Count -gt 0){throw 'Owned LUA worker exit unconfirmed'}
 $outcome=Get-Content -LiteralPath $result -Raw -Encoding UTF8|ConvertFrom-Json
 if($outcome.passed -isnot [bool] -or !$outcome.passed -or $outcome.failure){throw 'Owned LUA worker reported a failed result'}
 @{uiFixtureTask='InteractiveToken';runLevel=$(if($installerStorage){'HighestAvailable'}else{'LeastPrivilege'});zeroTriggers=$true;workerExited=$true}|ConvertTo-Json -Compress
} finally {
 Remove-OwnedInteractiveTask|Out-Null
}
