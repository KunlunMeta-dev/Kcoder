// Test-only desktop ownership. Never opens or edits WinSta0/Default permissions.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class KcoderInstallerDesktop : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public int Size; public string Reserved; public string Desktop; public string Title;
    public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public ushort Show,ReservedBytes;
    public IntPtr ReservedPointer,Input,Output,Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint ProcessId,ThreadId; }
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string descriptor,uint revision,out IntPtr result,out uint size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowStation(string name,uint flags,uint access,ref SecurityAttributes security);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr station);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,ref SecurityAttributes security);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseWindowStation(IntPtr station);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithLogonW(string username,string domain,string password,uint flags,string application,StringBuilder command,uint creation,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  IntPtr station,desktop; readonly string desktopName;
  public KcoderInstallerDesktop(string owner,string userSid,string adminSid) {
    Guid parsed; if(!Guid.TryParse(owner,out parsed))throw new ArgumentException("Invalid run owner");
    if(!userSid.StartsWith("S-1-5-21-")||!adminSid.StartsWith("S-1-5-21-"))throw new ArgumentException("Expected explicit local account SIDs");
    string name="KCoderE2E_"+parsed.ToString("N"); desktopName=name+"\\Default";
    IntPtr descriptor; uint bytes;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;"+userSid+")(A;;GA;;;"+adminSid+")",1,out descriptor,out bytes))throw new Win32Exception();
    var security=new SecurityAttributes{Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=descriptor,Inherit=0};
    IntPtr previous=GetProcessWindowStation();
    try {
      station=CreateWindowStation(name,0,0x000F037F,ref security);
      if(station==IntPtr.Zero)throw new Win32Exception();
      if(!SetProcessWindowStation(station))throw new Win32Exception();
      try { desktop=CreateDesktop("Default",IntPtr.Zero,IntPtr.Zero,0,0x000F01FF,ref security); if(desktop==IntPtr.Zero)throw new Win32Exception(); }
      finally { if(!SetProcessWindowStation(previous))throw new Win32Exception(); }
    } catch { Dispose();throw; }
    finally { LocalFree(descriptor); }
  }
  public uint Run(string user,string domain,string password,string executable,string arguments,string directory,uint timeout) {
    if(station==IntPtr.Zero||desktop==IntPtr.Zero)throw new ObjectDisposedException("Owned desktop");
    var startup=new StartupInfo{Size=Marshal.SizeOf(typeof(StartupInfo)),Desktop=desktopName,Flags=1,Show=0};
    ProcessInfo process;
    if(!CreateProcessWithLogonW(user,domain,password,1,executable,new StringBuilder("\""+executable+"\" "+arguments),0x08000000,IntPtr.Zero,directory,ref startup,out process))throw new Win32Exception();
    CloseHandle(process.Thread);
    try {
      uint wait=WaitForSingleObject(process.Process,timeout);
      if(wait==258){TerminateProcess(process.Process,1);throw new TimeoutException("Owned installer process timed out");}
      if(wait!=0)throw new Win32Exception();
      uint code;if(!GetExitCodeProcess(process.Process,out code))throw new Win32Exception();return code;
    } finally { CloseHandle(process.Process); }
  }
  public void Dispose(){if(desktop!=IntPtr.Zero){CloseDesktop(desktop);desktop=IntPtr.Zero;}if(station!=IntPtr.Zero){CloseWindowStation(station);station=IntPtr.Zero;}}
}
