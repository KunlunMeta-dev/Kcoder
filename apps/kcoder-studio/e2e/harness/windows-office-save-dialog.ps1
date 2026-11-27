param([Parameter(Mandatory=$true)][int]$ProcessId,[Parameter(Mandatory=$true)][string]$StartedUtc,[Parameter(Mandatory=$true)][string]$OwnedRoot,[Parameter(Mandatory=$true)][string]$Destination,[Parameter(Mandatory=$true)][string]$ExpectedFilename)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($OwnedRoot).TrimEnd('\')+'\'
$path=[IO.Path]::GetFullPath($Destination)
if(!$path.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($path) -ne '.docx'){throw 'Owned DOCX destination required'}
$marker=Get-Content -LiteralPath (Join-Path $OwnedRoot '.owner.json') -Raw|ConvertFrom-Json
if($marker.username -notmatch '^kc_e2e_[a-f0-9]{8}$' -or $marker.owner -notmatch '^[a-f0-9-]{36}$'){throw 'Owned fixture marker required'}
$process=Get-Process -Id $ProcessId
$heldProcess=$process.Handle
if($process.StartTime.ToUniversalTime().ToString('o') -ne $StartedUtc){throw 'Original App process changed'}
$cim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ProcessId)
$owner=Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid
if($owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'App SID differs from actual fixture caller'}
if(!$cim.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'App image escaped owned installation'}
Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class KcoderOwnedSaveDialogs {
 delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint id);
 [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desktop,Callback cb,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,Callback cb,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint id);
 [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
 [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr child);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process,uint milliseconds);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] static extern IntPtr SendText(IntPtr h,uint message,UIntPtr w,string text,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] static extern IntPtr SendClick(IntPtr h,uint message,UIntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 static string Class(IntPtr h){var s=new StringBuilder(128);GetClassName(h,s,128);return s.ToString();}
 public static long[] Read(uint originalPid,out string[] observation){
  var dialogs=new List<long>();var rows=new List<string>();
  EnumDesktopWindows(GetThreadDesktop(GetCurrentThreadId()),(window,p)=>{uint pid;GetWindowThreadProcessId(window,out pid);if(pid!=originalPid)return true;
   var type=Class(window);rows.Add("window class="+type);if(type!="#32770")return true;
   dialogs.Add(window.ToInt64());EnumChildWindows(window,(child,unused)=>{if(rows.Count<80)rows.Add("control="+GetDlgCtrlID(child)+" class="+Class(child));return rows.Count<80;},IntPtr.Zero);return rows.Count<80;
  },IntPtr.Zero);observation=rows.ToArray();return dialogs.ToArray();
 }
 static void Verify(IntPtr dialog,IntPtr control,uint pid,IntPtr process,string type,int id){
  uint actual;GetWindowThreadProcessId(control,out actual);
  if(WaitForSingleObject(process,0)!=258||actual!=pid||!IsChild(dialog,control)||Class(control)!=type||GetDlgCtrlID(control)!=id)throw new InvalidOperationException("Original native save control changed");
 }
 static string Text(IntPtr edit){
  var buffer=Marshal.AllocHGlobal(4096*2);
  try{Marshal.WriteInt16(buffer,0);UIntPtr count;if(SendClick(edit,13,new UIntPtr(4096),buffer,3,2000,out count)==IntPtr.Zero||count.ToUInt64()>=4096)throw new InvalidOperationException("Owned filename read failed");return Marshal.PtrToStringUni(buffer,(int)count.ToUInt64())??"";}
  finally{Marshal.FreeHGlobal(buffer);}
 }
 public static bool Invoke(long handle,uint pid,IntPtr process,string destination,string expectedFilename){
  var dialog=new IntPtr(handle);uint actual;GetWindowThreadProcessId(dialog,out actual);
  if(WaitForSingleObject(process,0)!=258||actual!=pid||Class(dialog)!="#32770")throw new InvalidOperationException("Original native save dialog changed");
  var edits=new List<IntPtr>();var saves=new List<IntPtr>();
  EnumChildWindows(dialog,(child,p)=>{if(GetDlgCtrlID(child)==1001&&Class(child)=="Edit")edits.Add(child);if(GetDlgCtrlID(child)==1&&Class(child)=="Button")saves.Add(child);return true;},IntPtr.Zero);
  if(edits.Count!=1||saves.Count!=1)return false;
  Verify(dialog,edits[0],pid,process,"Edit",1001);UIntPtr result;
  var before=System.IO.Path.GetFileName(Text(edits[0]).Trim('"'));
  if(!String.Equals(before,expectedFilename,StringComparison.OrdinalIgnoreCase)&&!String.Equals(before,System.IO.Path.GetFileNameWithoutExtension(expectedFilename),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Native filename field does not match the original export; characters="+before.Length);
  var parent=GetParent(edits[0]);
  if(Class(parent)=="ComboBox"&&IsChild(dialog,parent)){
   uint comboPid;GetWindowThreadProcessId(parent,out comboPid);if(comboPid!=pid)throw new InvalidOperationException("Owned filename combo changed");
   if(SendClick(parent,334,new UIntPtr(ulong.MaxValue),IntPtr.Zero,3,2000,out result)==IntPtr.Zero)throw new InvalidOperationException("Owned filename selection failed");
  }
  if(SendClick(edits[0],177,UIntPtr.Zero,new IntPtr(-1),3,2000,out result)==IntPtr.Zero||SendText(edits[0],194,new UIntPtr(1),destination,3,2000,out result)==IntPtr.Zero)throw new InvalidOperationException("Owned file name input failed");
  if(!String.Equals(Text(edits[0]),destination,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Owned filename readback changed");
  Verify(dialog,saves[0],pid,process,"Button",1);
  if(SendClick(saves[0],245,UIntPtr.Zero,IntPtr.Zero,3,2000,out result)==IntPtr.Zero)throw new InvalidOperationException("Owned save button input failed");
  return true;
 }
}
'@
$deadline=[DateTime]::UtcNow.AddSeconds(60)
while([DateTime]::UtcNow -lt $deadline){
 $process.Refresh();if($process.HasExited){throw 'Owned App exited before native save'}
 $observed=[string[]]@()
 $windows=[KcoderOwnedSaveDialogs]::Read([uint32]$ProcessId,[ref]$observed)
 @{originalPid=$ProcessId;originalProcessStart=$StartedUtc;nativeWindows=$observed;readOnlyObservation=$true}|ConvertTo-Json -Depth 4 -Compress|Set-Content -LiteralPath (Join-Path $OwnedRoot 'windows-office-save-dialog-observations.json') -Encoding UTF8
 foreach($handle in $windows){
  $invoked=[KcoderOwnedSaveDialogs]::Invoke($handle,[uint32]$ProcessId,$heldProcess,$path,$ExpectedFilename)
  if(!$invoked){continue}
  @{nativeDialogInvoked=$true;originalPid=$ProcessId;ownedDestination=$true;nativeWindowHandle=$handle;originalFilenameDisplayMatched=$true;destinationReadbackMatched=$true;driver='original_native_controls'}|ConvertTo-Json -Compress
  exit 0
 }
 Start-Sleep -Milliseconds 100
}
throw 'Owned native save dialog was not observed'
