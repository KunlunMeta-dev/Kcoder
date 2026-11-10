param([Parameter(Mandatory=$true)][string]$Descriptor,[Parameter(Mandatory=$true)][string]$Node)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$inputData=Get-Content -LiteralPath $Descriptor -Raw -Encoding UTF8|ConvertFrom-Json
$root=$inputData.root
if((Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json).owner -cne $inputData.owner){throw 'Owned UI task marker mismatch'}
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($current -cne $inputData.sid){throw 'Owned UI task current SID mismatch'}
$service=New-Object -ComObject Schedule.Service
$service.Connect()
$folder=$service.GetFolder('\')
$name='KCoder-E2E-Channel-'+$inputData.owner
$description='KCoder owned channel UI fixture '+$inputData.owner
$existing=$null
try{$existing=$folder.GetTask($name)}catch{if($_.Exception.HResult -ne -2147024894){throw}}
if($existing){throw 'Owned UI task must be exclusive'}
$definition=$service.NewTask(0)
$definition.RegistrationInfo.Description=$description
$definition.Principal.UserId=$current
$definition.Principal.LogonType=3
$definition.Principal.RunLevel=0
$definition.Settings.Enabled=$true
$definition.Settings.MultipleInstances=2
$definition.Settings.RestartCount=0
$definition.Settings.ExecutionTimeLimit='PT10M'
$definition.Settings.DisallowStartIfOnBatteries=$false
$definition.Settings.StopIfGoingOnBatteries=$false
$action=$definition.Actions.Create(0)
$action.Path=$Node
$action.Arguments='"'+(Join-Path $root 'windows-widget-interactive-entry.mjs')+'" "'+$Descriptor+'"'
$action.WorkingDirectory=$root
@{owner=$inputData.owner;taskName=$name;node=$Node;arguments=$action.Arguments;description=$description}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $root 'channel-fixture-task.json') -Encoding UTF8
$task=$folder.RegisterTaskDefinition($name,$definition,2,$current,$null,3,('D:P(A;;GA;;;SY)(A;;GA;;;'+$current+')'))
try {
 if($task.Definition.Principal.LogonType -ne 3 -or $task.Definition.Principal.RunLevel -ne 0 -or $task.Definition.Triggers.Count -ne 0 -or $task.Definition.Settings.RestartCount -ne 0){throw 'Owned UI task is not the requested InteractiveToken/LeastPrivilege zero-trigger carrier'}
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
 @{uiFixtureTask='InteractiveToken';runLevel='LeastPrivilege';zeroTriggers=$true;workerExited=$true}|ConvertTo-Json -Compress
} finally {
 $now=$folder.GetTask($name)
 $d=$now.Definition
 if($d.RegistrationInfo.Description -cne $description -or $d.Actions.Item(1).Path -cne $Node -or $d.Actions.Item(1).Arguments -cne $action.Arguments){throw 'Owned UI task changed; retain original receipt'}
 if($now.GetInstances(0).Count -gt 0){$now.Stop(0)}
 $folder.DeleteTask($name,0)
}
