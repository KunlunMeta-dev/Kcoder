param([Parameter(Mandatory=$true)][string]$RunRoot,[Parameter(Mandatory=$true)][string]$ExpectedSha256)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($ExpectedSha256 -cne '2c72a4ccd5a1835d9a9a5b5132df304fb7580605c8ae6e2ad4f2faa29205b3f1'){throw 'Only the fixed initial V1 baseline may be secured'}
$root=[IO.Path]::GetFullPath($RunRoot).TrimEnd('\')
$manifest=Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($manifest.status -cne 'running' -or $manifest.source -cne 'apps/kcoder-studio/e2e/suites/gateway/project-knowledge-publication.e2e.mjs'){throw 'Expected the current project knowledge scenario run'}
$state=Join-Path $root 'state'
$workspace=Join-Path $state 'workspaces\project-knowledge'
$relative='.kcoder\specs\specs\core\spec.md'
$path=Join-Path $workspace $relative
$entry=Get-Item -LiteralPath $path -Force
$cursor=$entry
while($cursor){if($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Baseline path cannot follow a reparse point'};$cursor=if($cursor.PSIsContainer){$cursor.Parent}else{$cursor.Directory}}
if($entry.PSIsContainer -or $entry.Length -ne 216){throw 'Expected the exact initial V1 regular file'}
# Only the newly prepared source chain may exist; no Native initialization or candidate has run.
$expected=@('specs','specs\specs','specs\specs\core','specs\specs\core\spec.md')
$pending=[Collections.Generic.Queue[string]]::new();$pending.Enqueue((Join-Path $workspace '.kcoder'))
$observed=@()
while($pending.Count){
  foreach($item in @(Get-ChildItem -LiteralPath $pending.Dequeue() -Force)){
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Baseline fixture contains a reparse point'}
    $name=$item.FullName.Substring((Join-Path $workspace '.kcoder').Length+1)
    if($expected -notcontains $name){throw 'Only the initial baseline chain may exist'}
    $observed+=$name
    if($item.PSIsContainer){$pending.Enqueue($item.FullName)}
  }
}
if($observed.Count -ne $expected.Count){throw 'Incomplete baseline fixture chain'}
$assembly=Join-Path $state 'windows-project-knowledge-baseline.dll'
if(Test-Path -LiteralPath $assembly){throw 'Baseline helper output already exists'}
# Compilation output belongs to this run; no user token, session or global policy changes.
Add-Type -OutputAssembly $assembly -OutputType Library -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OwnedKnowledgeBaseline {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes,CreationLow,CreationHigh,AccessLow,AccessHigh,WriteLow,WriteHigh;
    public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint sharing,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
  public static string Identity(FileStream file) {
    Info info;if(!GetFileInformationByHandle(file.SafeFileHandle,out info))throw new Win32Exception();
    if((info.Attributes&0x410)!=0||info.Links!=1)throw new IOException("Baseline must be ordinary, single-link and non-reparse");
    return info.Volume+":"+info.IndexHigh+":"+info.IndexLow+":"+info.SizeHigh+":"+info.SizeLow;
  }
  public static FileStream Open(string path) {
    if(!path.StartsWith(@"\\?\"))path=@"\\?\"+path;
    var handle=CreateFile(path,0x1f01ff,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
    if(handle.IsInvalid){handle.Dispose();throw new Win32Exception();}
    try{return new FileStream(handle,FileAccess.Read);}catch{handle.Dispose();throw;}
  }
}
'@
$null=[Reflection.Assembly]::LoadFrom($assembly)
$file=[OwnedKnowledgeBaseline]::Open($path)
$hasher=[Security.Cryptography.SHA256]::Create()
try {
  $identity=[OwnedKnowledgeBaseline]::Identity($file)
  $before=([BitConverter]::ToString($hasher.ComputeHash($file))).Replace('-','').ToLowerInvariant()
  if($before -cne $ExpectedSha256){throw 'Baseline bytes differ from the fixed fixture'}
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $originalOwner=$file.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value
  $acl=[Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
  $acl.SetOwner($sid)
  $file.SetAccessControl($acl)
  $checked=$file.GetAccessControl()
  $rules=@($checked.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  $owner=$checked.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($owner -ne $sid.Value -or !$checked.AreAccessRulesProtected -or $rules.Count -ne 1){throw 'Baseline private ownership verification failed'}
  $rule=$rules[0]
  if($rule.IdentityReference.Value -ne $sid.Value -or $rule.IsInherited -or $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'Baseline must grant exclusive current-user FullControl'}
  $file.Position=0
  $after=([BitConverter]::ToString($hasher.ComputeHash($file))).Replace('-','').ToLowerInvariant()
  if($after -cne $before -or [OwnedKnowledgeBaseline]::Identity($file) -cne $identity){throw 'Baseline identity or bytes changed'}
  [ordered]@{path=$path;relative=$relative;beforeOwnerSid=$originalOwner;ownerSid=$owner;currentSid=$sid.Value;protected=$true;aceCount=1;singleLink=$true;nonReparse=$true;identityBefore=$identity;identityAfter=$identity;sha256Before=$before;sha256After=$after;bytes=216}|ConvertTo-Json -Compress
} finally {$hasher.Dispose();$file.Dispose()}
