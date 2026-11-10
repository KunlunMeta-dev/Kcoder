param(
  [Parameter(Mandatory=$true)][string]$SourcePath,
  [Parameter(Mandatory=$true)][string]$StateDirectory,
  [Parameter(Mandatory=$true)][string]$RunRoot
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class KcoderStateAuditPrivilegeFixture {
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low;public int High; }
  [StructLayout(LayoutKind.Sequential)] struct Privilege { public uint Count;public Luid Id;public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PrivilegeSet { public uint Count,Control;public Luid Id;public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr value);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out Luid id);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool all,ref Privilege value,uint length,IntPtr previous,IntPtr returned);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool PrivilegeCheck(IntPtr token,ref PrivilegeSet required,out bool result);
  public static void RemoveAuditPrivilege() {
    IntPtr token;if(!OpenProcessToken(GetCurrentProcess(),0x28,out token))throw new Win32Exception();
    try {
      Luid id;if(!LookupPrivilegeValue(null,"SeSecurityPrivilege",out id))throw new Win32Exception();
      var change=new Privilege{Count=1,Id=id,Attributes=4};
      if(!AdjustTokenPrivileges(token,false,ref change,0,IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();
      int error=Marshal.GetLastWin32Error();if(error!=0&&error!=1300)throw new Win32Exception(error);
      var required=new PrivilegeSet{Count=1,Control=1,Id=id,Attributes=2};bool enabled;
      if(!PrivilegeCheck(token,ref required,out enabled))throw new Win32Exception();
      if(enabled)throw new InvalidOperationException("Audit privilege was not removed from the test process");
    } finally {CloseHandle(token);}
  }
}
'@
# Lower only this disposable test process's token; no account or policy changes.
[KcoderStateAuditPrivilegeFixture]::RemoveAuditPrivilege()
& $SourcePath -StateDirectory $StateDirectory -RunRoot $RunRoot
Write-Output 'PASS: private state setup without SeSecurityPrivilege'
