param(
  [Parameter(Mandatory=$true)][string]$StateDirectory,
  [Parameter(Mandatory=$true)][string]$RunRoot
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$statePath=[IO.Path]::GetFullPath($StateDirectory).TrimEnd('\')
$runPath=[IO.Path]::GetFullPath($RunRoot).TrimEnd('\')
if(![String]::Equals($statePath,(Join-Path $runPath 'state'),[StringComparison]::OrdinalIgnoreCase)){throw 'Only the new run state directory may be secured'}
$entry=Get-Item -LiteralPath $statePath -Force
if(!$entry.PSIsContainer -or @(Get-ChildItem -LiteralPath $statePath -Force).Count){throw 'Run state must be an empty directory before securing it'}
$cursor=$entry
while($cursor){if($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Run state cannot follow reparse points'};$cursor=$cursor.Parent}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
# Grant the creating user WRITE_OWNER before normalizing an elevated token's owner.
Set-Acl -LiteralPath $statePath -AclObject $acl
$current=Get-Acl -LiteralPath $statePath
if($current.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){
  # A fresh descriptor avoids persisting audit sections returned by Get-Acl.
  $ownerAcl=[Security.AccessControl.DirectorySecurity]::new()
  $ownerAcl.SetAccessRuleProtection($true,$false)
  $ownerAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  $ownerAcl.SetOwner($sid)
  Set-Acl -LiteralPath $statePath -AclObject $ownerAcl
}
$checked=Get-Acl -LiteralPath $statePath
$rules=@($checked.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
$owner=$checked.GetOwner([Security.Principal.SecurityIdentifier]).Value
if($owner -ne $sid.Value -or !$checked.AreAccessRulesProtected -or $rules.Count -ne 1){throw 'Run state owner or protected DACL verification failed'}
$rule=$rules[0]
if($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rule.InheritanceFlags -ne $inherit){throw 'Run state must grant inheritable full control only to its creating user'}
[ordered]@{path=$statePath;ownerSid=$owner;currentSid=$sid.Value;protected=$true;aceCount=1;inheritableFullControl=$true}|ConvertTo-Json -Compress
