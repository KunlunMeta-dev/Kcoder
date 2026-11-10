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
if ($definition.Triggers.Count -eq 0) {
  $trigger = $definition.Triggers.Create(9)
  $trigger.UserId = $inputData.sid
  $definition.Settings.RestartCount = 3
  $definition.Settings.RestartInterval = 'PT1M'
  AssertDefinition $definition
  # Update only this original definition. Do not Run, stop or replace its live instance.
  $existing = $folder.RegisterTaskDefinition($inputData.taskName, $definition, 4, $inputData.sid, $null, 3,
    ('D:P(A;;GA;;;SY)(A;;GA;;;' + $inputData.sid + ')'))
}
AssertDefinition $existing.Definition
