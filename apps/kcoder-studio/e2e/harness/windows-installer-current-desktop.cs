// Explicit current-user installation on a private desktop, without passwords,
// scheduled tasks, or changes to the real interactive desktop permissions.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public sealed partial class KcoderInstallerDesktop {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string application, StringBuilder command,
    IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags,
    IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
  delegate bool OwnedWindowVisitor(IntPtr window, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)]
  static extern bool EnumDesktopWindows(IntPtr desktop, OwnedWindowVisitor visitor, IntPtr data);
  [DllImport("user32.dll")]
  static extern bool EnumChildWindows(IntPtr window, OwnedWindowVisitor visitor, IntPtr data);
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  static extern int GetWindowTextW(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)]
  static extern bool PostMessageW(IntPtr window, uint message, IntPtr word, IntPtr value);

  public string[] CurrentInstallerMessages { get; private set; }
  public uint CurrentInstallerPid { get; private set; }

  public uint RunCurrent(string executable, string arguments, string directory, uint timeout) {
    if (station==IntPtr.Zero || desktop==IntPtr.Zero)
      throw new ObjectDisposedException("Owned desktop");
    var startup=new StartupInfo { Size=Marshal.SizeOf(typeof(StartupInfo)),
      Desktop=desktopName, Flags=1, Show=0 };
    ProcessInfo process;
    if (!CreateProcessW(executable, new StringBuilder("\""+executable+"\" "+arguments),
      IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, directory, ref startup, out process))
      throw new Win32Exception();
    CurrentInstallerPid=process.ProcessId;
    System.IO.File.WriteAllText(System.IO.Path.Combine(directory, "process-current.json"),
      "{\"pid\":"+process.ProcessId+",\"desktop\":\""+desktopName.Replace("\\", "\\\\")+"\"}");
    CloseHandle(process.Thread);
    var messages=new HashSet<string>();
    var elapsed=Stopwatch.StartNew();
    try {
      for (;;) {
        uint wait=WaitForSingleObject(process.Process, 500);
        if (wait==0) break;
        if (wait!=258) throw new Win32Exception();
        IntPtr previous=GetProcessWindowStation();
        if (!SetProcessWindowStation(station)) throw new Win32Exception();
        try {
          EnumDesktopWindows(desktop, (window, data) => {
            uint owner; GetWindowThreadProcessId(window, out owner);
            if (owner!=process.ProcessId) return true;
            bool terminalFailure=false;
            EnumChildWindows(window, (child, unused) => {
              var text=new StringBuilder(2048);
              GetWindowTextW(child, text, text.Capacity);
              string value=text.ToString();
              if (value.Length>0 && messages.Count<64) messages.Add(value);
              if (value.StartsWith("Failed to uninstall old application files.", StringComparison.Ordinal))
                terminalFailure=true;
              return true;
            }, IntPtr.Zero);
            // Acknowledge only the known terminal NSIS error. The template quits
            // with its failure code after OK; this never retries an installation.
            if (terminalFailure) PostMessageW(window, 0x0111, new IntPtr(1), IntPtr.Zero);
            return true;
          }, IntPtr.Zero);
        } finally {
          if (!SetProcessWindowStation(previous)) throw new Win32Exception();
        }
        if (elapsed.ElapsedMilliseconds>=timeout) {
          // An observation deadline does not prove the installation stopped.
          // Keep its recorded PID/desktop for reconciliation instead of replay.
          throw new TimeoutException("Owned current-user installer observation expired; inspect its recorded process");
        }
      }
      uint code;
      if (!GetExitCodeProcess(process.Process, out code)) throw new Win32Exception();
      return code;
    } finally {
      CurrentInstallerMessages=new List<string>(messages).ToArray();
      CloseHandle(process.Process);
    }
  }
}
