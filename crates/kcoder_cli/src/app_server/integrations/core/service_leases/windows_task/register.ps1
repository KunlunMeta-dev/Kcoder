$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__KCODER_FIXED_INPUT__')) | ConvertFrom-Json
$current = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($current.User.Value -cne $inputData.sid) { throw 'SERVICE_WINDOWS_CURRENT_SID_CHANGED' }
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$existing = $null
try { $existing = $folder.GetTask($inputData.taskName) }
catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
$existing = UpdateHiddenOriginalTask $folder $existing $inputData

function AssertOriginalDefinition($definition) {
  if ((ResolveOriginalTaskSid $definition.Principal.UserId) -cne $inputData.sid -or $definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0) {
    throw 'SERVICE_WINDOWS_ORIGINAL_TASK_PRINCIPAL_CHANGED'
  }
  if ($definition.Actions.Count -ne 1) { throw 'SERVICE_WINDOWS_ORIGINAL_TASK_ACTION_CHANGED' }
  $action = $definition.Actions.Item(1)
  if ($action.Path -cne $inputData.image -or $action.Arguments -cne $inputData.arguments -or $action.WorkingDirectory -cne $inputData.workspace) {
    throw 'SERVICE_WINDOWS_ORIGINAL_TASK_ACTION_CHANGED'
  }
  if ($definition.RegistrationInfo.Description -cne $inputData.sourceIdentity -or $definition.Settings.MultipleInstances -ne 2) {
    throw 'SERVICE_WINDOWS_ORIGINAL_TASK_IDENTITY_CHANGED'
  }
  if ($definition.Triggers.Count -ne 1 -or $definition.Triggers.Item(1).Type -ne 9 -or (ResolveOriginalTaskSid $definition.Triggers.Item(1).UserId) -cne $inputData.sid) {
    throw 'SERVICE_WINDOWS_ORIGINAL_TASK_TRIGGER_CHANGED'
  }
}

if ($null -ne $existing) {
  AssertOriginalDefinition $existing.Definition
} else {
  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.Description = $inputData.sourceIdentity
  $definition.Principal.UserId = $inputData.sid
  $definition.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN: no password is retained.
  $definition.Principal.RunLevel = 0 # TASK_RUNLEVEL_LUA: this never asks for elevation.
  $definition.Settings.Enabled = $true
  $definition.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW.
  $definition.Settings.ExecutionTimeLimit = 'PT0S'
  $definition.Settings.DisallowStartIfOnBatteries = $false
  $definition.Settings.StopIfGoingOnBatteries = $false
  $definition.Settings.RestartCount = 3
  $definition.Settings.RestartInterval = 'PT1M'
  $trigger = $definition.Triggers.Create(9) # TASK_TRIGGER_LOGON.
  $trigger.UserId = $inputData.sid
  $action = $definition.Actions.Create(0) # TASK_ACTION_EXEC.
  $action.Path = $inputData.image
  $action.Arguments = $inputData.arguments
  $action.WorkingDirectory = $inputData.workspace
  AssertOriginalDefinition $definition
  # CREATE only. Existing tasks are never replaced, repaired or re-owned.
  $existing = $folder.RegisterTaskDefinition($inputData.taskName, $definition, 2, $inputData.sid, $null, 3,
    ('D:P(A;;GA;;;SY)(A;;GA;;;' + $inputData.sid + ')'))
  AssertOriginalDefinition $existing.Definition
}
# Repeated starts are handled by Task Scheduler's same-task IgnoreNew policy.
# Native still requires the actual manager peer/owner proof before reporting Running.
$null = $existing.Run($null)
