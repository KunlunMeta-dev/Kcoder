import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

/** Read Win32 identities only; this helper never sends desktop input. */
export function observeOwnedDesktopBoundary(powershell, fixture, stage, env, { requireForeground = true, requireTextbox = false } = {}) {
  assert.ok(Number.isSafeInteger(fixture.pid) && fixture.pid > 0);
  assert.ok(Number.isSafeInteger(fixture.hwnd) && fixture.hwnd > 0);
  assert.ok(Number.isSafeInteger(fixture.inputHwnd) && fixture.inputHwnd > 0);
  for (const point of [fixture.inputLoc, fixture.buttonLoc])
    assert.ok(Array.isArray(point) && point.length === 2 && point.every(Number.isSafeInteger));
  const script = `Add-Type -AssemblyName System.Windows.Forms;Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedDesktopObservation {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GuiThreadInfo { public uint Size,Flags; public IntPtr Active,Focus,Capture,MenuOwner,MoveSize,Caret; public Rect CaretRect; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window,uint flags);
  [DllImport("user32.dll",EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr window,int index);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread,ref GuiThreadInfo info);
  public static bool PointOwned(int x,int y,IntPtr expected) {
    return GetAncestor(WindowFromPoint(new Point {X=x,Y=y}),2)==expected;
  }
}
'@;[void][OwnedDesktopObservation]::SetProcessDPIAware();$expected=[IntPtr]${fixture.hwnd};[uint32]$ownerPid=0;$ownerThread=[OwnedDesktopObservation]::GetWindowThreadProcessId($expected,[ref]$ownerPid);$gui=New-Object OwnedDesktopObservation+GuiThreadInfo;$gui.Size=[Runtime.InteropServices.Marshal]::SizeOf($gui);$guiKnown=[OwnedDesktopObservation]::GetGUIThreadInfo($ownerThread,[ref]$gui);$rect=New-Object OwnedDesktopObservation+Rect;if(-not [OwnedDesktopObservation]::GetWindowRect($expected,[ref]$rect)){throw 'Owned fixture bounds unavailable'};$virtual=[Windows.Forms.SystemInformation]::VirtualScreen;$allDisplayPoints=$true;$displays=@([Windows.Forms.Screen]::AllScreens);foreach($screen in $displays){$b=$screen.Bounds;foreach($xy in @(@(($b.Left+2),($b.Top+2)),@(($b.Right-3),($b.Top+2)),@(($b.Left+2),($b.Bottom-3)),@(($b.Right-3),($b.Bottom-3)),@(($b.Left+[int]($b.Width/2)),($b.Top+[int]($b.Height/2))))){if(-not [OwnedDesktopObservation]::PointOwned($xy[0],$xy[1],$expected)){$allDisplayPoints=$false}}};$modifiersClear=$true;foreach($key in @(16,17,18,91,92)){if(([OwnedDesktopObservation]::GetAsyncKeyState($key)-band 32768)-ne 0){$modifiersClear=$false}};$foreground=[OwnedDesktopObservation]::GetForegroundWindow();[uint32]$foregroundPid=0;if($foreground-ne [IntPtr]::Zero){[void][OwnedDesktopObservation]::GetWindowThreadProcessId($foreground,[ref]$foregroundPid)};@{ownedTextboxFocused=($guiKnown-and $gui.Focus-eq [IntPtr]${fixture.inputHwnd});guiFocusKnown=$guiKnown;foregroundIsNull=($foreground-eq [IntPtr]::Zero);foregroundIsObserver=($foregroundPid-eq $PID);foregroundIsObserverConsole=($foreground-eq [OwnedDesktopObservation]::GetConsoleWindow());fixturePid=$ownerPid;fixtureHwnd=${fixture.hwnd};foregroundOwned=([OwnedDesktopObservation]::GetForegroundWindow()-eq $expected);visible=[OwnedDesktopObservation]::IsWindowVisible($expected);fullVirtualScreen=($rect.Left-eq $virtual.Left-and $rect.Top-eq $virtual.Top-and $rect.Right-eq $virtual.Right-and $rect.Bottom-eq $virtual.Bottom);opaqueNonTransparent=(([OwnedDesktopObservation]::GetWindowLong($expected,-20)-band 524320)-eq 0);allDisplayProbePointsOwned=$allDisplayPoints;displayCount=$displays.Count;inputPointOwned=[OwnedDesktopObservation]::PointOwned(${fixture.inputLoc[0]},${fixture.inputLoc[1]},$expected);verifyPointOwned=[OwnedDesktopObservation]::PointOwned(${fixture.buttonLoc[0]},${fixture.buttonLoc[1]},$expected);modifiersClear=$modifiersClear;sessionId=(Get-Process -Id ${fixture.pid}).SessionId}|ConvertTo-Json -Compress`;
  const value = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000, ...(env ? { env } : {}) }).trim());
  assert.equal(value.fixturePid, fixture.pid, 'owned fixture HWND changed process');
  assert.ok(value.sessionId > 0, 'real interactive fixture session required');
  const required = ['visible', 'fullVirtualScreen', 'opaqueNonTransparent',
    'allDisplayProbePointsOwned', 'inputPointOwned', 'verifyPointOwned', 'modifiersClear'];
  if (requireForeground) required.push('foregroundOwned');
  if (requireTextbox) required.push('ownedTextboxFocused');
  for (const key of required)
    if (value[key] !== true) {
      const error = new Error(`refusing ${stage}: owned desktop boundary ${key} failed`);
      error.observation = value;
      throw error;
    }
  return { stage, observedAt: Date.now(), ...value, desktopInputSentByObserver: false,
    otherWindowsEnumerated: false };
}
