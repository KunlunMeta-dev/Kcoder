param(
 [Parameter(Mandatory=$true)][string]$OwnedRoot,
 [Parameter(Mandatory=$true)][int]$ProcessId,
 [Parameter(Mandatory=$true)][string]$StartedFileTime,
 [Parameter(Mandatory=$true)][string]$ExpectedTitle,
 [ValidateSet('observe','button','folder','quit')][string]$Action='observe',
 [string]$ButtonText,[string]$Folder,[string]$OperationId
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$marker=Get-Content -LiteralPath (Join-Path $OwnedRoot '.owner.json') -Raw -Encoding UTF8|ConvertFrom-Json
$qualification=$marker.scope -ceq 'storage-native-dialog-qualification'
$source=$marker.scope -ceq 'storage-source-migration'
$currentDebug=$marker.scope -ceq 'current-user-debug-storage'
$readOnlyStartupError=$currentDebug -and $Action -ceq 'observe' -and $ExpectedTitle -ceq 'Error'
$currentInstalled=$marker.scope -ceq 'current-user-installed-storage' -or $currentDebug
if($marker.owner -cnotmatch '^[a-f0-9-]{36}$' -or (!$qualification -and !$source -and !$currentInstalled -and $marker.username -cnotmatch '^kc_e2e_[a-f0-9]{8}$')){throw 'Owned storage fixture marker required'}
if($currentInstalled){
 if([IO.Path]::GetFullPath($OwnedRoot).TrimEnd('\') -cne ('C:\kcqa-'+$marker.owner.Substring(0,12)) -or $marker.sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or ![Environment]::UserInteractive){throw 'Current-user installed acceptance requires its original interactive owner'}
 if($currentDebug -and [IO.Path]::GetFullPath($marker.installDirectory).TrimEnd('\') -cne (Join-Path ([IO.Path]::GetFullPath($OwnedRoot)) 'debug-runtime')){throw 'Debug host must stay in its original owned runtime'}
 if($marker.expectedHostSha256 -cnotmatch '^[a-f0-9]{64}$' -or (!$readOnlyStartupError -and $ExpectedTitle -cnotin @('KCoder storage relocation picker','KCoder storage relocation confirm','KCoder Studio'))){throw 'Current-user acceptance may address only its pinned storage dialogs'}
}
if($source){
 $fixture=[IO.Path]::GetFullPath([string]$marker.fixtureRoot).TrimEnd('\')
 if($fixture -cne ('C:\kcoder-widget-'+$marker.owner) -or ![IO.Path]::GetFullPath($OwnedRoot).StartsWith(($fixture+'\s\target\e2e\'),[StringComparison]::OrdinalIgnoreCase) -or $marker.sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or ![Environment]::UserInteractive){throw 'Source migration requires its original interactive owner'}
 if($ExpectedTitle -cnotin @('KCoder storage relocation picker','KCoder storage relocation confirm','KCoder Studio')){throw 'Source migration may address only its storage dialogs or Quit'}
}
if($qualification){
 $fixture=[IO.Path]::GetFullPath([string]$marker.fixtureRoot).TrimEnd('\')
 if($fixture -cne ('C:\kcoder-widget-'+$marker.owner) -or ![IO.Path]::GetFullPath($OwnedRoot).StartsWith(($fixture+'\source\target\e2e\'),[StringComparison]::OrdinalIgnoreCase) -or $marker.sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or ![Environment]::UserInteractive){throw 'Native qualification requires its original interactive owner'}
 if($Action -notin @('observe','button') -or $ExpectedTitle -cne 'KCoder storage folders' -or ($Action -eq 'button' -and $ButtonText -cne 'Exit')){throw 'Native qualification may only cancel its original dialog'}
}
if(!$readOnlyStartupError -and $ExpectedTitle -cnotin @('KCoder storage folders','KCoder 数据位置','Configuration and data folder','配置与数据目录','Temporary files and cache folder','临时与缓存目录','KCoder storage folders|KCoder 数据位置','Configuration and data folder|配置与数据目录','Temporary files and cache folder|临时与缓存目录','KCoder storage relocation picker','KCoder storage relocation confirm','KCoder Studio')){throw 'Unexpected storage dialog title'}
$process=Get-Process -Id $ProcessId;$held=$process.Handle
if($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $StartedFileTime){throw 'Original storage host birth changed'}
$original=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ProcessId)
$sid=(Invoke-CimMethod -InputObject $original -MethodName GetOwnerSid).Sid
if($sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Storage host does not belong to the normal-logon actor'}
$installed=if($currentDebug){Join-Path $marker.installDirectory 'electron\electron.exe'}elseif($currentInstalled){Join-Path $marker.installDirectory 'kcoder-studio.exe'}elseif($qualification -or $source){Join-Path $fixture 'electron\electron.exe'}else{Join-Path $OwnedRoot 'Installed Studio\kcoder-studio.exe'}
if(![String]::Equals($original.ExecutablePath,$installed,[StringComparison]::OrdinalIgnoreCase)){throw 'Storage host is not the owned installed executable'}
if($currentInstalled -and (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant() -cne $marker.expectedHostSha256){throw 'Current-user installed host bytes changed'}
if($Action -ne 'observe'){
 if($OperationId -cnotmatch '^[a-z0-9][a-z0-9._-]{0,80}$'){throw 'Stable native input operation required'}
 $receipt=Join-Path $OwnedRoot ('windows-storage-native-'+$OperationId+'.json')
 if(Test-Path -LiteralPath $receipt){throw 'Native input already has an intent or receipt; reconcile it instead of replaying'}
}
if($Action -eq 'folder'){
 $base=[IO.Path]::GetFullPath($OwnedRoot).TrimEnd('\')+'\';$Folder=[IO.Path]::GetFullPath($Folder)
 $shortOwned=$false
 if($source){
  if($marker.runOwner -cnotmatch '^[a-f0-9]{16}$'){throw 'Original short-target owner required'}
  $shortRoot=Join-Path $fixture ('m-'+$marker.runOwner)
  if($marker.targetData -cne (Join-Path $shortRoot 'data') -or $marker.targetCache -cne (Join-Path $shortRoot 'cache')){throw 'Original short-target paths changed'}
  $shortMarker=Get-Content -LiteralPath (Join-Path $shortRoot '.owner.json') -Raw -Encoding UTF8|ConvertFrom-Json
  if($shortMarker.owner -cne $marker.runOwner -or $shortMarker.sid -cne $sid){throw 'Original short-target identity changed'}
  $shortOwned=$Folder -ceq $marker.targetData -or $Folder -ceq $marker.targetCache
 }
 if(!$shortOwned -and !$Folder.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){
  $volumeFile=Get-Item -LiteralPath (Join-Path $OwnedRoot 'windows-storage-owned-volume.json') -Force
  if($volumeFile.PSIsContainer -or ($volumeFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $volumeFile.Length -gt 8192){throw 'Owned volume receipt is unsafe'}
  $volume=Get-Content -LiteralPath $volumeFile.FullName -Raw -Encoding UTF8|ConvertFrom-Json
  if($volume.version -ne 1 -or $volume.owner -cne $marker.owner -or $volume.qaSid -cne $sid -or $volume.root -cnotmatch '^[A-Z]:\\$' -or $volume.volumeSerialNumber -cnotmatch '^[a-fA-F0-9]{8}$'){throw 'Owned volume receipt identity mismatch'}
  $volumeOwner=Join-Path $volume.root ('kcoder-storage-'+$marker.owner)
  if($volume.dataRoot -cne (Join-Path $volumeOwner 'data') -or $volume.cacheRoot -cne (Join-Path $volumeOwner 'cache') -or
    $volume.root -ieq [IO.Path]::GetPathRoot($OwnedRoot) -or ($Folder -ine $volume.dataRoot -and $Folder -ine $volume.cacheRoot)){throw 'Storage picker destination is not an exact owned volume target'}
  Add-Type -TypeDefinition @'
using System;using System.ComponentModel;using System.Runtime.InteropServices;
public static class KcoderOwnedStorageVolume {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool GetVolumeInformation(string root,IntPtr name,uint nameLength,out uint serial,out uint componentLength,out uint flags,IntPtr fileSystem,uint fileSystemLength);
 public static string Serial(string root){uint serial,length,flags;if(!GetVolumeInformation(root,IntPtr.Zero,0,out serial,out length,out flags,IntPtr.Zero,0))throw new Win32Exception();return serial.ToString("x8");}
}
'@
  if([KcoderOwnedStorageVolume]::Serial([string]$volume.root) -cne ([string]$volume.volumeSerialNumber).ToLowerInvariant()){throw 'Original owned volume serial changed'}
 }
 $entry=Get-Item -LiteralPath $Folder -Force;if(!$entry.PSIsContainer){throw 'Storage picker destination missing'}
 while($entry){if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Storage picker destination follows reparse point'};$entry=$entry.Parent}
}
Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class KcoderOwnedStorageDialog {
 delegate bool Callback(IntPtr h,IntPtr data);
 [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
 [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr h,uint timeout);
 [DllImport("user32.dll")]static extern IntPtr GetThreadDesktop(uint thread);
 [DllImport("user32.dll")]static extern bool EnumDesktopWindows(IntPtr desktop,Callback cb,IntPtr data);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr parent,Callback cb,IntPtr data);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsChild(IntPtr parent,IntPtr child);
 [StructLayout(LayoutKind.Sequential)]struct Rect{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out Rect rect);
 [DllImport("user32.dll")]static extern IntPtr GetMenu(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr GetSubMenu(IntPtr h,int position);
 [DllImport("user32.dll")]static extern int GetMenuItemCount(IntPtr h);
 [DllImport("user32.dll")]static extern uint GetMenuItemID(IntPtr h,int position);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetMenuString(IntPtr h,uint position,StringBuilder text,int length,uint flags);
 [DllImport("user32.dll")]static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder text,int length);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder text,int length);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode)]static extern IntPtr SendText(IntPtr h,uint message,UIntPtr w,string value,uint flags,uint timeout,out UIntPtr result);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")]static extern IntPtr Send(IntPtr h,uint message,UIntPtr w,IntPtr value,uint flags,uint timeout,out UIntPtr result);
 static string Text(IntPtr h){var s=new StringBuilder(1024);GetWindowText(h,s,s.Capacity);return s.ToString();}
 static string Class(IntPtr h){var s=new StringBuilder(128);GetClassName(h,s,s.Capacity);return s.ToString();}
 public static long[] Find(uint[] owners,string title){var found=new List<long>();EnumDesktopWindows(GetThreadDesktop(GetCurrentThreadId()),(h,d)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(Array.IndexOf(owners,pid)>=0&&IsWindowVisible(h)&&Class(h)=="#32770"&&Array.IndexOf(title.Split('|'),Text(h))>=0)found.Add(h.ToInt64());return true;},IntPtr.Zero);return found.ToArray();}
 public static string Title(long handle){return Text(new IntPtr(handle));}
 public static string[] Observe(uint[] owners){var rows=new List<string>();EnumDesktopWindows(GetThreadDesktop(GetCurrentThreadId()),(h,d)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(Array.IndexOf(owners,pid)>=0)rows.Add(String.Format("{0}|{1}|{2}|{3}|{4}|{5}",pid,h.ToInt64(),Class(h),IsWindowVisible(h),IsWindowEnabled(h),Text(h)));return true;},IntPtr.Zero);return rows.ToArray();}
 public static long[] FindApplication(uint pid){var found=new List<long>();EnumDesktopWindows(GetThreadDesktop(GetCurrentThreadId()),(h,d)=>{uint owner;GetWindowThreadProcessId(h,out owner);Rect rect;if(owner==pid&&IsWindowVisible(h)&&IsWindowEnabled(h)&&Class(h)=="Chrome_WidgetWin_1"&&Text(h).Contains("KCoder Studio")&&GetWindowRect(h,out rect)&&rect.Right>rect.Left&&rect.Bottom>rect.Top)found.Add(h.ToInt64());return true;},IntPtr.Zero);return found.ToArray();}
 static void QuitCommands(IntPtr menu,List<uint> commands){for(int i=0;i<GetMenuItemCount(menu);i++){var sub=GetSubMenu(menu,i);if(sub!=IntPtr.Zero){QuitCommands(sub,commands);continue;}var text=new StringBuilder(512);GetMenuString(menu,(uint)i,text,text.Capacity,0x400);var label=text.ToString().Replace("&","").Split('\t')[0];if(label=="Quit KCoder Studio"||label=="退出 KCoder Studio")commands.Add(GetMenuItemID(menu,i));}}
 public static void Quit(long handle,uint pid,IntPtr process){var window=new IntPtr(handle);uint owner;GetWindowThreadProcessId(window,out owner);if(WaitForSingleObject(process,0)!=258||owner!=pid||Class(window)!="Chrome_WidgetWin_1"||!IsWindowVisible(window))throw new InvalidOperationException("Original restarted application HWND changed");var menu=GetMenu(window);var commands=new List<uint>();if(menu!=IntPtr.Zero)QuitCommands(menu,commands);if(commands.Count!=1||commands[0]==UInt32.MaxValue)throw new InvalidOperationException("Actual restarted native Quit menu is unavailable or ambiguous");UIntPtr result;if(Send(window,0x111,new UIntPtr(commands[0]),IntPtr.Zero,3,2000,out result)==IntPtr.Zero)throw new InvalidOperationException("Native Quit command outcome unknown");}
 public static object[] Controls(long handle,uint pid){
  var root=new IntPtr(handle);var rows=new List<object>();
  EnumChildWindows(root,(h,d)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==pid&&IsChild(root,h))rows.Add(new{hwnd=h.ToInt64().ToString(),id=GetDlgCtrlID(h),className=Class(h),text=Text(h),visible=IsWindowVisible(h),enabled=IsWindowEnabled(h)});return true;},IntPtr.Zero);
  return rows.ToArray();
 }
 public static uint Owner(long handle){uint pid;GetWindowThreadProcessId(new IntPtr(handle),out pid);return pid;}
 static void Verify(IntPtr dialog,uint pid,string title){uint actual;GetWindowThreadProcessId(dialog,out actual);if(actual!=pid||Class(dialog)!="#32770"||Text(dialog)!=title||!IsWindowVisible(dialog))throw new InvalidOperationException("Original storage HWND changed");}
 public static void Invoke(long handle,uint pid,IntPtr process,string title,string button,string folder){
  if(WaitForSingleObject(process,0)!=258)throw new InvalidOperationException("Original dialog process exited");
  var dialog=new IntPtr(handle);Verify(dialog,pid,title);var buttons=new List<IntPtr>();var edits=new List<IntPtr>();
  EnumChildWindows(dialog,(h,d)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid||!IsChild(dialog,h)||!IsWindowVisible(h)||!IsWindowEnabled(h))return true;var type=Class(h);if(type=="Button"&&(folder!=null?GetDlgCtrlID(h)==1:Array.IndexOf(button.Split('|'),Text(h).Replace("&",""))>=0))buttons.Add(h);if(folder!=null&&type=="Edit"&&GetDlgCtrlID(h)==1152)edits.Add(h);return true;},IntPtr.Zero);
  if(buttons.Count!=1||(folder!=null&&edits.Count!=1))throw new InvalidOperationException("Native storage controls are ambiguous or unsupported");
  UIntPtr result;if(folder!=null){
   if(SendText(edits[0],12,UIntPtr.Zero,folder,3,2000,out result)==IntPtr.Zero)throw new InvalidOperationException("Native folder input outcome unknown");
   var buffer=Marshal.AllocHGlobal(65536);try{Marshal.WriteInt16(buffer,0);if(Send(edits[0],13,new UIntPtr(32768),buffer,3,2000,out result)==IntPtr.Zero||result.ToUInt64()>=32768||Marshal.PtrToStringUni(buffer,(int)result.ToUInt64())!=folder)throw new InvalidOperationException("Native folder input readback mismatch");}finally{Marshal.FreeHGlobal(buffer);}
  }
  if(WaitForSingleObject(process,0)!=258)throw new InvalidOperationException("Original dialog process exited");
  Verify(dialog,pid,title);if(Send(buttons[0],245,UIntPtr.Zero,IntPtr.Zero,3,2000,out result)==IntPtr.Zero)throw new InvalidOperationException("Native storage button outcome unknown");
 }
}
'@
$pendingControls=@();$controlFailure=$null
$deadline=[DateTime]::UtcNow.AddSeconds(30)
do{
 $process.Refresh();if($process.HasExited){throw 'Original storage host exited before native dialog'}
 $owners=[Collections.Generic.List[uint32]]::new();$owners.Add([uint32]$ProcessId)
 $observedOwners=[Collections.Generic.List[uint32]]::new();$observedOwners.Add([uint32]$ProcessId);$observedChildren=@()
 # First-launch selection is an actual program child, before the main window.
 foreach($child in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$ProcessId))){
  try{$childSid=(Invoke-CimMethod -InputObject $child -MethodName GetOwnerSid -ErrorAction Stop).Sid}catch{continue}
  if($childSid -ceq $sid){
   $observedOwners.Add([uint32]$child.ProcessId)
   $observedChildren+=@{pid=$child.ProcessId;creationFileTime=$child.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString();sameSid=$true;executablePath=$child.ExecutablePath;pathReadable=[bool]$child.ExecutablePath;startupFlag=([string]$child.CommandLine).Contains('--prepare-windows-startup');firstLaunchFlag=([string]$child.CommandLine).Contains('--storage-first-launch-user-data')}
  }
  if([String]::Equals($child.ExecutablePath,$installed,[StringComparison]::OrdinalIgnoreCase) -and $child.CommandLine.Contains('--prepare-windows-startup') -and $child.CommandLine.Contains('--storage-first-launch-user-data')){
   if($childSid -cne $sid){throw 'First-launch dialog child SID changed'}
   $owners.Add([uint32]$child.ProcessId)
  }
 }
 $windows=if($Action -eq 'quit'){[KcoderOwnedStorageDialog]::FindApplication([uint32]$ProcessId)}else{[KcoderOwnedStorageDialog]::Find($owners.ToArray(),$ExpectedTitle)}
 if($windows.Count -gt 1){throw 'More than one owned storage dialog matched'}
 if($windows.Count -eq 1){
  $dialogOwner=[KcoderOwnedStorageDialog]::Owner($windows[0]);$dialogProcess=Get-Process -Id $dialogOwner;$dialogHeld=$dialogProcess.Handle;$birth=$dialogProcess.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
  $title=[KcoderOwnedStorageDialog]::Title($windows[0])
  if($title -ceq 'KCoder 数据位置'){$translations=@{'Use these folders'='使用这些目录';'Change data folder…'='更改数据目录…';'Change cache folder…'='更改缓存目录…';'Exit'='退出'};if($ButtonText -and $translations.ContainsKey($ButtonText)){$ButtonText=$translations[$ButtonText]}}
  $pendingControls=@([KcoderOwnedStorageDialog]::Controls($windows[0],$dialogOwner))
  if($Action -eq 'button'){
   $buttons=@($pendingControls|Where-Object {$_.className -ceq 'Button' -and $_.visible -and $_.enabled -and ($ButtonText.Split('|') -ccontains $_.text.Replace('&',''))})
   if($buttons.Count -gt 1){$controlFailure='ambiguous-owned-buttons';break}
   if($buttons.Count -eq 0){Start-Sleep -Milliseconds 100;continue}
  }
  $value=@{owner=$marker.owner;action=$Action;title=$title;hwnd=$windows[0].ToString();pid=$dialogOwner;creationFileTime=$birth;originalHostPid=$ProcessId;originalHostBirth=$StartedFileTime;driver='original-owned-hwnd-controls';controls=$pendingControls;invoked=$false}
  if($readOnlyStartupError){
   Add-Type -AssemblyName UIAutomationClient
   $element=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$windows[0])
   $nodes=$element.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
   $value.accessibility=@(for($index=0;$index -lt [Math]::Min($nodes.Count,128);$index++){$entry=$nodes.Item($index).Current;if($entry.ProcessId -eq $dialogOwner){@{className=[string]$entry.ClassName;name=([string]$entry.Name).Substring(0,[Math]::Min(([string]$entry.Name).Length,4096))}}})
  }
  if($Action -ne 'observe'){
   $value.phase='intent';[IO.File]::WriteAllText($receipt,($value|ConvertTo-Json -Depth 6 -Compress),[Text.UTF8Encoding]::new($false))
   if($Action -eq 'quit'){[KcoderOwnedStorageDialog]::Quit($windows[0],$dialogOwner,$dialogHeld)}
   else{[KcoderOwnedStorageDialog]::Invoke($windows[0],$dialogOwner,$dialogHeld,$title,$ButtonText,$(if($Action -eq 'folder'){$Folder}else{[NullString]::Value}))}
   $value.phase='invoked';$value.invoked=$true;[IO.File]::WriteAllText($receipt,($value|ConvertTo-Json -Depth 6 -Compress),[Text.UTF8Encoding]::new($false))
  }
  $value|ConvertTo-Json -Depth 6 -Compress;exit 0
 }
 Start-Sleep -Milliseconds 100
}while([DateTime]::UtcNow -lt $deadline)
@{owner=$marker.owner;originalHostPid=$ProcessId;originalHostBirth=$StartedFileTime;expectedTitle=$ExpectedTitle;owners=$owners.ToArray();children=$observedChildren;ownedWindowFields=@('pid','hwnd','class','visible','enabled','title');ownedWindows=[KcoderOwnedStorageDialog]::Observe($observedOwners.ToArray());controls=$pendingControls;controlFailure=$controlFailure;actionInvoked=$false}|ConvertTo-Json -Depth 5 -Compress|Set-Content -LiteralPath (Join-Path $OwnedRoot 'windows-storage-native-timeout.json') -Encoding UTF8
throw 'Owned storage native dialog was not observed'
