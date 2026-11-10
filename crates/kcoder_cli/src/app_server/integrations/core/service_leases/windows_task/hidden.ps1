# Preserve the exact current-user carrier; definition updates never stop or Run it.
function UpdateHiddenOriginalTask($folder, $existing, $inputData) {
  if ($null -eq $existing) { return $null }
  $definition = $existing.Definition
  if ((ResolveOriginalTaskSid $definition.Principal.UserId) -cne $inputData.sid -or $definition.Principal.LogonType -ne 3 -or $definition.Principal.RunLevel -ne 0) { throw 'SERVICE_WINDOWS_TASK_PRINCIPAL_CHANGED' }
  if ($definition.Actions.Count -ne 1 -or $definition.Settings.MultipleInstances -ne 2) { throw 'SERVICE_WINDOWS_TASK_ACTION_CHANGED' }
  $action = $definition.Actions.Item(1)
  if ($action.WorkingDirectory -cne $inputData.workspace) { throw 'SERVICE_WINDOWS_TASK_ACTION_CHANGED' }
  $hidden = $action.Path -ceq $inputData.image -and $action.Arguments -ceq $inputData.arguments
  $direct = $action.Path -ceq $inputData.nativeImage -and $action.Arguments -ceq $inputData.nativeArguments
  $legacy = $action.Path -ceq $inputData.legacyImage -and $action.Arguments -ceq $inputData.legacyArguments
  if (-not $hidden -and -not $direct -and -not $legacy) { throw 'SERVICE_WINDOWS_TASK_ACTION_CHANGED' }
  $foreground = $definition.Triggers.Count -eq 0 -and $definition.Settings.RestartCount -eq 0
  if (-not $foreground -and ($definition.Triggers.Count -ne 1 -or $definition.Triggers.Item(1).Type -ne 9 -or (ResolveOriginalTaskSid $definition.Triggers.Item(1).UserId) -cne $inputData.sid -or $definition.Settings.RestartCount -ne 3)) { throw 'SERVICE_WINDOWS_TASK_TRIGGER_CHANGED' }
  if ($definition.RegistrationInfo.Description -cne $inputData.sourceIdentity) {
    # An executable update may refresh a grant-free foreground carrier only.
    # Logon triggers and restart/background consent can never be inferred here.
    if (-not $foreground -or $definition.RegistrationInfo.Description -cnotmatch '^kcoder-native-user-service-v1:[a-f0-9]{64}$') { throw 'SERVICE_WINDOWS_TASK_IDENTITY_CHANGED' }
  } elseif ($hidden) { return $existing }
  $definition.Actions.Clear()
  $action = $definition.Actions.Create(0)
  $action.Path = $inputData.image
  $action.Arguments = $inputData.arguments
  $action.WorkingDirectory = $inputData.workspace
  $definition.RegistrationInfo.Description = $inputData.sourceIdentity
  return $folder.RegisterTaskDefinition($inputData.taskName, $definition, 4, $inputData.sid, $null, 3,
    ('D:P(A;;GA;;;SY)(A;;GA;;;' + $inputData.sid + ')'))
}
