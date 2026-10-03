param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][string]$OwnedRoot,
  [Parameter(Mandatory=$true)][ValidateSet('focus','text','pinyin','space','enter','toggle-ime','backspace','escape','restore')][string]$Action,
  [int]$X=0,[int]$Y=0,[string]$Text=''
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$process=Get-Process -Id $ProcessId
$root=[IO.Path]::GetFullPath($OwnedRoot).TrimEnd('\')+'\'
if(-not $process.Path.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Input target is outside the owned app directory'}
if($process.SessionId -ne (Get-Process -Id $PID).SessionId){throw 'Input target is in another Windows logon session'}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OwnedWindowsInput {
  public delegate bool EnumProc(IntPtr window, IntPtr state);
  [DllImport("user32.dll")]static extern bool EnumWindows(EnumProc proc,IntPtr state);
  [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr window,EnumProc proc,IntPtr state);
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr window,StringBuilder name,int count);
  [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr window,int state);
  [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
  public static uint Owner(IntPtr window) {uint pid;GetWindowThreadProcessId(window,out pid);return pid;}
  public static bool Restore(IntPtr window,uint expectedPid) {return Owner(window)==expectedPid&&SetForegroundWindow(window);}
  [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")]static extern IntPtr SetFocus(IntPtr window);
  [DllImport("user32.dll")]static extern bool AttachThreadInput(uint first,uint second,bool attach);
  [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")]static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr wparam,IntPtr lparam);
  [DllImport("user32.dll")]static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")]static extern int GetKeyboardLayoutList(int count,[Out] IntPtr[] layouts);
  [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
  [StructLayout(LayoutKind.Sequential)]struct KEYBDINPUT {public ushort key,scan;public uint flags,time;public UIntPtr extra;}
  [StructLayout(LayoutKind.Sequential)]struct MOUSEINPUT {public int x,y;public uint data,flags,time;public UIntPtr extra;}
  [StructLayout(LayoutKind.Explicit)]struct INPUTUNION {[FieldOffset(0)]public KEYBDINPUT keyboard;[FieldOffset(0)]public MOUSEINPUT mouse;}
  [StructLayout(LayoutKind.Sequential)]struct INPUT {public uint type;public INPUTUNION data;}
  [DllImport("user32.dll",SetLastError=true)]static extern uint SendInput(uint count,INPUT[] input,int size);
  [StructLayout(LayoutKind.Sequential)]public struct POINT {public int x,y;}
  [DllImport("user32.dll")]public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")]static extern bool ClientToScreen(IntPtr window,ref POINT point);
  [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr window,uint flag);
  public static POINT Pointer(){POINT point;GetCursorPos(out point);return point;}
  public static IntPtr LastLayout,LastTarget;
  public static uint LastTargetOwner;
  public static void RestoreLayout(IntPtr target,uint owner,IntPtr layout) {if(layout!=IntPtr.Zero&&Owner(target)==owner)SendMessage(target,0x50,IntPtr.Zero,layout);}
  static void Keys(uint pid,string text) {
    if(Owner(GetForegroundWindow())!=pid)throw new Exception("Foreground changed; no keyboard input was sent");
    foreach(int key in new int[]{16,17,18,91,92})if((GetAsyncKeyState(key)&0x8000)!=0)throw new Exception("User modifier key is held; no input was sent");
    var inputs=new List<INPUT>();
    foreach(char c in text){ushort key=(ushort)Char.ToUpperInvariant(c);inputs.Add(new INPUT{type=1,data=new INPUTUNION{keyboard=new KEYBDINPUT{key=key}}});inputs.Add(new INPUT{type=1,data=new INPUTUNION{keyboard=new KEYBDINPUT{key=key,flags=2}}});}
    if(SendInput((uint)inputs.Count,inputs.ToArray(),Marshal.SizeOf(typeof(INPUT)))!=inputs.Count)throw new Exception("Native keyboard input was refused");
  }
  public static string Run(uint pid,string action,int x,int y,string text) {
    IntPtr top=IntPtr.Zero,render=IntPtr.Zero;
    var ownedClasses=new List<string>();
    EnumWindows((window,state)=> {uint owner;GetWindowThreadProcessId(window,out owner);if(owner==pid){var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);ownedClasses.Add(name.ToString());if(name.ToString()=="Chrome_WidgetWin_1"){top=window;return false;}}return true;},IntPtr.Zero);
    if(top==IntPtr.Zero)throw new Exception("Owned app has no native widget: "+String.Join(",",ownedClasses));
    if(!IsWindowVisible(top))ShowWindow(top,9);
    if(!IsWindowVisible(top))throw new Exception("Owned native widget cannot be shown");
    EnumChildWindows(top,(window,state)=>{var name=new StringBuilder(256);GetClassName(window,name,name.Capacity);if(name.ToString()=="Chrome_RenderWidgetHostHWND"){render=window;return false;}return true;},IntPtr.Zero);
    if(render==IntPtr.Zero)throw new Exception("Owned Chromium native input window is unavailable");
    uint ownerPid;uint targetThread=GetWindowThreadProcessId(render,out ownerPid);
    LastLayout=GetKeyboardLayout(targetThread);LastTarget=render;LastTargetOwner=ownerPid;
    uint current=GetCurrentThreadId();bool attached=action=="focus"&&current!=targetThread&&AttachThreadInput(current,targetThread,true);
    try {
      if(action=="focus"){SetForegroundWindow(top);SetFocus(render);}
      if(Owner(GetForegroundWindow())!=pid)throw new Exception("Owned app could not obtain foreground input; no input was sent");
      if(action=="focus") {
        var point=new POINT{x=x,y=y};
        if(!ClientToScreen(render,ref point))throw new Exception("Cannot locate owned input point");
        if(GetAncestor(WindowFromPoint(point),2)!=top)throw new Exception("Input point is not inside the owned foreground window");
        if(!SetCursorPos(point.x,point.y))throw new Exception("Cannot move pointer to owned window");
        var click=new INPUT[]{new INPUT{type=0,data=new INPUTUNION{mouse=new MOUSEINPUT{flags=2}}},new INPUT{type=0,data=new INPUTUNION{mouse=new MOUSEINPUT{flags=4}}}};
        if(Owner(GetForegroundWindow())!=pid||SendInput(2,click,Marshal.SizeOf(typeof(INPUT)))!=2)throw new Exception("Owned native mouse input was refused");
      } else if(action=="enter") {
        Keys(pid,"\r");
      } else if(action=="toggle-ime") {
        Keys(pid, new string((char)16,1));
      } else if(action=="backspace") {
        int count=String.IsNullOrEmpty(text)?5:Int32.Parse(text);if(count<1||count>16)throw new Exception("Invalid owned backspace count");Keys(pid, new string((char)8,count));
      } else if(action=="escape") {
        Keys(pid, new string((char)27,1));
      } else if(action=="space") {
        Keys(pid," ");
      } else if(action=="text") {
        foreach(char c in text)SendMessage(render,0x102,new IntPtr(c),IntPtr.Zero);
      } else if(action=="pinyin") {
        int count=GetKeyboardLayoutList(0,null);var layouts=new IntPtr[count];GetKeyboardLayoutList(count,layouts);
        IntPtr chinese=IntPtr.Zero;foreach(var layout in layouts)if((layout.ToInt64()&65535)==0x804){chinese=layout;break;}
        if(chinese==IntPtr.Zero)throw new Exception("UNMET_PREREQUISITE: no installed Chinese input locale in the interactive session");
        if(GetKeyboardLayout(targetThread)!=chinese)SendMessage(render,0x50,IntPtr.Zero,chinese);
        if((GetKeyboardLayout(targetThread).ToInt64()&65535)!=0x804)throw new Exception("Owned window rejected Chinese input locale");
        foreach(char c in text)if(c<'a'||c>'z')throw new Exception("Pinyin fixture accepts only lowercase letters");
        Keys(pid,text);
      }
    } finally {if(attached)AttachThreadInput(current,targetThread,false);}
    return action;
  }
}
'@
$focusFile=Join-Path $root 'native-input-foreground.json'
if($Action -eq 'restore'){
  $restored=$true
  if(Test-Path -LiteralPath $focusFile){$saved=Get-Content -Raw -LiteralPath $focusFile|ConvertFrom-Json;if($saved.imeToggled){[void][OwnedWindowsInput]::Run([uint32]$ProcessId,'escape',0,0,'');[void][OwnedWindowsInput]::Run([uint32]$ProcessId,'toggle-ime',0,0,'')};if($saved.layout){[OwnedWindowsInput]::RestoreLayout([IntPtr][long]$saved.target,[uint32]$saved.targetOwner,[IntPtr][long]$saved.layout)};$restored=[OwnedWindowsInput]::Restore([IntPtr][long]$saved.handle,[uint32]$saved.owner);if($null -ne $saved.pointerX){[void][OwnedWindowsInput]::SetCursorPos([int]$saved.pointerX,[int]$saved.pointerY)};Remove-Item -LiteralPath $focusFile}
  [pscustomobject]@{restored=$restored;action='restore'}|ConvertTo-Json -Compress
  exit 0
}
if(-not(Test-Path -LiteralPath $focusFile)){
  $foreground=[OwnedWindowsInput]::GetForegroundWindow();$pointer=[OwnedWindowsInput]::Pointer()
  [IO.File]::WriteAllText($focusFile,([pscustomobject]@{handle=$foreground.ToInt64();owner=[OwnedWindowsInput]::Owner($foreground);pointerX=$pointer.x;pointerY=$pointer.y}|ConvertTo-Json -Compress))
}
$result=[OwnedWindowsInput]::Run([uint32]$ProcessId,$Action,$X,$Y,$Text)
if($Action -eq 'toggle-ime'){$saved=Get-Content -Raw -LiteralPath $focusFile|ConvertFrom-Json;$saved|Add-Member -NotePropertyName imeToggled -NotePropertyValue $true -Force;[IO.File]::WriteAllText($focusFile,($saved|ConvertTo-Json -Compress))}
if($Action -eq 'focus'){$saved=Get-Content -Raw -LiteralPath $focusFile|ConvertFrom-Json;if(-not $saved.layout){$saved|Add-Member -NotePropertyName layout -NotePropertyValue ([OwnedWindowsInput]::LastLayout.ToInt64());$saved|Add-Member -NotePropertyName target -NotePropertyValue ([OwnedWindowsInput]::LastTarget.ToInt64());$saved|Add-Member -NotePropertyName targetOwner -NotePropertyValue ([OwnedWindowsInput]::LastTargetOwner)};[IO.File]::WriteAllText($focusFile,($saved|ConvertTo-Json -Compress))}
[pscustomobject]@{ownedProcess=$true;nativeWindowsInput=$true;action=$result}|ConvertTo-Json -Compress
