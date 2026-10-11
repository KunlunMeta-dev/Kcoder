import { execFile } from 'node:child_process';
import { join } from 'node:path';

// Windows modes/uid are not an ACL. Provision a newly-created directory for
// this user and SYSTEM, then validate its existing ACL and children before I/O.
// File ID, rather than casing/8.3 path spelling, defines local lock identity.
const script = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
$j=[Console]::In.ReadToEnd()|ConvertFrom-Json;$p=$j.path;
if($p.StartsWith('\\')){throw 'Network device storage is unsupported'};
$d=New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($p));
if($d.DriveType -eq [System.IO.DriveType]::Network){throw 'Network device storage is unsupported'};
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;
$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18');
if($j.initialize){
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetOwner($me);$acl.SetAccessRuleProtection($true,$false);
 foreach($id in @($me,$system)){$rule=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)};
 Set-Acl -LiteralPath $p -AclObject $acl;
};
foreach($path in @($p,(Join-Path $p '.key'),(Join-Path $p 'devices.json'))){
 if(!(Test-Path -LiteralPath $path)){continue};$item=Get-Item -LiteralPath $path -Force;
 if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse device storage rejected'};
 $acl=Get-Acl -LiteralPath $path;
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $me.Value){throw 'Device storage owner mismatch'};
 foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow'){$id=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($id -ne $me.Value -and $id -ne $system.Value){throw 'Device storage ACL is not private'}}};
};
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public static class MobileDeviceFileId {
 [StructLayout(LayoutKind.Sequential)]public struct Info {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
 public static string Read(string path){using(var h=CreateFile(path,0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)){Info i;if(h.IsInvalid||!GetFileInformationByHandle(h,out i))throw new Exception("Device storage identity unavailable");return i.Volume.ToString("X8")+":"+i.IndexHigh.ToString("X8")+i.IndexLow.ToString("X8");}}
}
'@;
[Console]::Out.Write([MobileDeviceFileId]::Read($p));`;

export function windowsPrivateDeviceStorage(path, initialize) {
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10_000, maxBuffer: 8192 }, (error, stdout) => {
      if (error || !/^[A-F0-9]{8}:[A-F0-9]{16}$/.test(stdout.trim())) reject(new Error('Private Windows mobile device storage unavailable'));
      else resolve(`windows-volume-file:${stdout.trim()}`);
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ path, initialize }));
  });
}
