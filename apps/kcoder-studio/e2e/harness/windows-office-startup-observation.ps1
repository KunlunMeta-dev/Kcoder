param([Parameter(Mandatory=$true)][int]$ProcessId,[Parameter(Mandatory=$true)][long]$StartedAtMilliseconds,[Parameter(Mandatory=$true)][string]$OwnedRoot)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($OwnedRoot).TrimEnd('\')+'\'
$marker=Get-Content -LiteralPath (Join-Path $OwnedRoot '.owner.json') -Raw|ConvertFrom-Json
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($marker.owner -notmatch '^[a-f0-9-]{36}$' -or $marker.username -notmatch '^kc_e2e_[a-f0-9]{8}$' -or $identity.Name.Split('\')[-1] -ne $marker.username){throw 'Original ordinary fixture identity required'}
$process=Get-Process -Id $ProcessId
$started=([DateTimeOffset]$process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
if([Math]::Abs($started-$StartedAtMilliseconds) -gt 5000){throw 'Original App creation time changed'}
$cim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ProcessId)
if((Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid).Sid -ne $identity.User.Value -or !$cim.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Original App SID/image required'}

# This observer sends no window messages or input and never suspends a thread.
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;
public static class KcoderOwnedStartupWindows {
  delegate bool Callback(IntPtr handle,IntPtr argument);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint id);
  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desktop,Callback callback,IntPtr argument);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,Callback callback,IntPtr argument);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle,out uint processId);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle,StringBuilder value,int length);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr handle,StringBuilder value,int length);
  static string Text(IntPtr handle,bool type){var value=new StringBuilder(512);if(type)GetClassName(handle,value,512);else GetWindowText(handle,value,512);return value.ToString();}
  public static string[] Read(uint originalPid){
    var result=new List<string>();
    EnumDesktopWindows(GetThreadDesktop(GetCurrentThreadId()),(window,arg)=>{
      uint pid;GetWindowThreadProcessId(window,out pid);if(pid!=originalPid)return true;
      var type=Text(window,true);result.Add(type+" | "+Text(window,false));
      if(type=="#32770")EnumChildWindows(window,(child,ignored)=>{
        uint owner;GetWindowThreadProcessId(child,out owner);
        if(owner==originalPid&&Text(child,true)=="Static"&&result.Count<24)result.Add("Static | "+Text(child,false));
        return true;
      },IntPtr.Zero);
      return result.Count<24;
    },IntPtr.Zero);
    return result.ToArray();
  }
}
'@
$threads=@($process.Threads|ForEach-Object{@{id=$_.Id;state=[string]$_.ThreadState;wait=$(if($_.ThreadState -eq 'Wait'){[string]$_.WaitReason}else{''})}})
$windows=@([KcoderOwnedStartupWindows]::Read($ProcessId)|ForEach-Object{$_ -replace '([?&](?:token|password|key)=)[^&\s]+','$1[redacted]'})
@{pid=$ProcessId;sessionId=$process.SessionId;cpuSeconds=$process.CPU;workingSetBytes=$process.WorkingSet64;windows=$windows;threads=$threads;readOnly=$true;originalOrdinaryOwner=$true}|ConvertTo-Json -Depth 5 -Compress
