$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$kcoderTaskStage = 'decode'
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__KCODER_FIXED_INPUT__')) | ConvertFrom-Json
$kcoderTaskStage = 'current_sid'
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($current.User.Value -cne $inputData.sid) { throw 'SERVICE_WINDOWS_CURRENT_SID_CHANGED' }
$kcoderTaskStage = 'service_connect'
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$kcoderTaskStage = 'folder_open'
$folder = $service.GetFolder('\')
$existing = $null
$kcoderTaskStage = 'read_existing'
try { $existing = $folder.GetTask($inputData.taskName) }
catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
$existing = UpdateHiddenOriginalTask $folder $existing $inputData
function AssertDefinition($definition) {
  if ((ResolveOriginalTaskSid $definition.Principal.UserId) -cne $inputData.sid -or $definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0) { throw 'SERVICE_WINDOWS_TASK_PRINCIPAL_CHANGED' }
  if ($definition.Actions.Count -ne 1 -or $definition.Settings.MultipleInstances -ne 2) { throw 'SERVICE_WINDOWS_TASK_ACTION_CHANGED' }
  $action = $definition.Actions.Item(1)
  if ($action.Path -cne $inputData.image -or $action.Arguments -cne $inputData.arguments -or $action.WorkingDirectory -cne $inputData.workspace) { throw 'SERVICE_WINDOWS_TASK_ACTION_CHANGED' }
  if ($definition.RegistrationInfo.Description -cne $inputData.sourceIdentity) { throw 'SERVICE_WINDOWS_TASK_IDENTITY_CHANGED' }
  if ($definition.Triggers.Count -eq 0) {
    if ($definition.Settings.RestartCount -ne 0) { throw 'SERVICE_WINDOWS_FOREGROUND_RESTART_FORBIDDEN' }
  } elseif ($definition.Triggers.Count -eq 1) {
    if ($definition.Triggers.Item(1).Type -ne 9 -or (ResolveOriginalTaskSid $definition.Triggers.Item(1).UserId) -cne $inputData.sid) { throw 'SERVICE_WINDOWS_TASK_TRIGGER_CHANGED' }
  } else { throw 'SERVICE_WINDOWS_TASK_TRIGGER_CHANGED' }
}
if ($null -eq $existing) {
  $kcoderTaskStage = 'construct'
  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.Description = $inputData.sourceIdentity
  $definition.Principal.UserId = $inputData.sid
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $definition.Settings.Enabled = $true
  $definition.Settings.MultipleInstances = 2
  $definition.Settings.ExecutionTimeLimit = 'PT0S'
  $definition.Settings.DisallowStartIfOnBatteries = $false
  $definition.Settings.StopIfGoingOnBatteries = $false
  $definition.Settings.RestartCount = 0
  $action = $definition.Actions.Create(0)
  $action.Path = $inputData.image
  $action.Arguments = $inputData.arguments
  $action.WorkingDirectory = $inputData.workspace
  $kcoderTaskStage = 'assert_before_register'
  AssertDefinition $definition
  $kcoderTaskStage = 'register'
  $existing = $folder.RegisterTaskDefinition($inputData.taskName, $definition, 2, $inputData.sid, $null, 3,
    ('D:P(A;;GA;;;SY)(A;;GA;;;' + $inputData.sid + ')'))
}
$kcoderTaskStage = 'assert_registered'
AssertDefinition $existing.Definition
$kcoderTaskStage = 'run'
$null = $existing.Run($null)
