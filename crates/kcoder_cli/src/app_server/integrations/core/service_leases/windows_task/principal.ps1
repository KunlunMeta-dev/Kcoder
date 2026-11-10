# Task Scheduler may return an account name after accepting an exact SID.
# Resolve only that original COM identity; it must still equal the actual caller SID.
function ResolveOriginalTaskSid([string]$identity) {
  if ([string]::IsNullOrWhiteSpace($identity)) { throw 'SERVICE_WINDOWS_TASK_SID_UNAVAILABLE' }
  try {
    if ($identity -match '^S-[0-9]+(?:-[0-9]+)+$') { return [Security.Principal.SecurityIdentifier]::new($identity).Value }
    return ([Security.Principal.NTAccount]::new($identity)).Translate([Security.Principal.SecurityIdentifier]).Value
  } catch { throw 'SERVICE_WINDOWS_TASK_SID_UNAVAILABLE' }
}
