$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__KCODER_FIXED_INPUT__')) | ConvertFrom-Json
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($current.User.Value -cne $inputData.sid) { throw 'SERVICE_WINDOWS_CURRENT_SID_CHANGED' }
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$existing = $folder.GetTask($inputData.taskName)
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
    if ($definition.Triggers.Item(1).Type -ne 9 -or (ResolveOriginalTaskSid $definition.Triggers.Item(1).UserId) -cne $inputData.sid -or $definition.Settings.RestartCount -ne 3) { throw 'SERVICE_WINDOWS_TASK_TRIGGER_CHANGED' }
  } else { throw 'SERVICE_WINDOWS_TASK_TRIGGER_CHANGED' }
}
AssertDefinition $existing.Definition
$definition = $existing.Definition
if ($inputData.action -ceq 'foreground') {
  # A fresh fixed foreground definition also removes RestartOnFailure itself.
  # Setting Count=0 on a durable definition can retain its interval and produce
  # invalid Task XML. Update this same task without Run or instance replacement.
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
  # Update the owned definition only. Existing Core/Main/SDK keep their instance.
  $existing = $folder.RegisterTaskDefinition($inputData.taskName, $definition, 4, $inputData.sid, $null, 3,
    ('D:P(A;;GA;;;SY)(A;;GA;;;' + $inputData.sid + ')'))
  AssertDefinition $existing.Definition
} elseif ($inputData.action -ceq 'delete') {
  # The native caller has already verified its original Job is empty. Removing
  # this exact definition does not stop or adopt any other running task.
  $folder.DeleteTask($inputData.taskName, 0)
  $remaining = $null
  try { $remaining = $folder.GetTask($inputData.taskName) }
  catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
  if ($null -ne $remaining) { throw 'SERVICE_WINDOWS_TASK_RETIREMENT_UNCONFIRMED' }
} else { throw 'SERVICE_WINDOWS_TASK_RETIREMENT_ACTION_INVALID' }
