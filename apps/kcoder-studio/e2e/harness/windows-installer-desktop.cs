// Test-only desktop ownership. Never edits shared window-station or Default permissions.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;

public sealed partial class KcoderInstallerDesktop : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public int Size; public string Reserved; public string Desktop; public string Title;
    public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public ushort Show,ReservedBytes;
    public IntPtr ReservedPointer,Input,Output,Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint ProcessId,ThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct UserObjectFlags { public int Inherit,Reserved; public uint Flags; }
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string descriptor,uint revision,out IntPtr result,out uint size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowStation(string name,uint flags,uint access,ref SecurityAttributes security);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr station);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,ref SecurityAttributes security);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenDesktop(string name,uint flags,bool inherit,uint access);
  [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",SetLastError=true)] static extern bool GetStationFlags(IntPtr station,int index,out UserObjectFlags flags,uint length,out uint needed);
  [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetStationName(IntPtr station,int index,StringBuilder name,uint length,out uint needed);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseWindowStation(IntPtr station);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithLogonW(string username,string domain,string password,uint flags,string application,StringBuilder command,uint creation,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid,out uint session);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  IntPtr station,desktop; readonly string desktopName;
  readonly uint? interactiveSession;
  public KcoderInstallerDesktop(string owner,string userSid,string adminSid)
    : this(owner,userSid,adminSid,(uint?)null) {}
  public KcoderInstallerDesktop(string owner,string userSid,string adminSid,uint interactiveSession)
    : this(owner,userSid,adminSid,(uint?)interactiveSession) {}
  private KcoderInstallerDesktop(string owner,string userSid,string adminSid,uint? interactiveSession) {
    if(interactiveSession.HasValue) {
      if(interactiveSession.Value==0)throw new ArgumentOutOfRangeException("interactiveSession");
      uint current;
      if(!ProcessIdToSessionId(GetCurrentProcessId(),out current))throw new Win32Exception();
      if(current!=interactiveSession.Value)throw new InvalidOperationException("Installer controller session changed");
    }
    this.interactiveSession=interactiveSession;
    Guid parsed; if(!Guid.TryParse(owner,out parsed))throw new ArgumentException("Invalid run owner");
    if(!userSid.StartsWith("S-1-5-21-")||!adminSid.StartsWith("S-1-5-21-"))throw new ArgumentException("Expected explicit local account SIDs");
    string name="KCoderE2E_"+parsed.ToString("N");
    IntPtr descriptor; uint bytes;
    string permissions="D:P(A;;GA;;;SY)"+(interactiveSession.HasValue?"":"(A;;GA;;;BA)")+"(A;;GA;;;"+userSid+")(A;;GA;;;"+adminSid+")";
    if(!ConvertStringSecurityDescriptorToSecurityDescriptor(permissions,1,out descriptor,out bytes))throw new Win32Exception();
    var security=new SecurityAttributes{Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=descriptor,Inherit=0};
    IntPtr previous=GetProcessWindowStation();
    try {
      string leaf="Default";
      if(interactiveSession.HasValue) {
        // Borrow the current station unchanged; only the new desktop is owned.
        station=previous;
        if(station==IntPtr.Zero)throw new Win32Exception();
        UserObjectFlags flags;uint needed;
        if(!GetStationFlags(station,1,out flags,(uint)Marshal.SizeOf(typeof(UserObjectFlags)),out needed))throw new Win32Exception();
        if((flags.Flags&1)==0)throw new InvalidOperationException("UNMET_PREREQUISITE: installer controller requires an interactive window station");
        var stationName=new StringBuilder(512);
        if(!GetStationName(station,2,stationName,(uint)(stationName.Capacity*2),out needed))throw new Win32Exception();
        leaf=name;name=stationName.ToString();
        IntPtr existing=OpenDesktop(leaf,0,false,0x00020001);
        if(existing!=IntPtr.Zero) {
          if(!CloseDesktop(existing))throw new Win32Exception();
          throw new InvalidOperationException("Owned installer desktop collision");
        }
        int error=Marshal.GetLastWin32Error();if(error!=2)throw new Win32Exception(error);
      } else {
        station=CreateWindowStation(name,0,0x000F037F,ref security);
        if(station==IntPtr.Zero)throw new Win32Exception();
        if(!SetProcessWindowStation(station))throw new Win32Exception();
      }
      desktopName=name+"\\"+leaf;
      try { desktop=CreateDesktop(leaf,IntPtr.Zero,IntPtr.Zero,0,0x000F01FF,ref security); if(desktop==IntPtr.Zero)throw new Win32Exception(); }
      finally { if(!interactiveSession.HasValue&&!SetProcessWindowStation(previous))throw new Win32Exception(); }
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
  static bool InJob(IntPtr process) { bool value;if(!IsProcessInJob(process,IntPtr.Zero,out value))throw new Win32Exception();return value; }
  static string Json(string value) { return "\""+value.Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r","\\r").Replace("\n","\\n")+"\""; }
  // The existing supervisor owns this normal-logon actor before its first instruction.
  // LOGON_WITH_PROFILE and a null environment ask CPWL for the target user's
  // profile environment. No manually held profile reference survives an EOF.
  public uint RunOwned(string user,string domain,string password,string executable,string arguments,string directory,uint timeout,string receipt) {
    if(station==IntPtr.Zero||desktop==IntPtr.Zero)throw new ObjectDisposedException("Owned desktop");
    if(!InJob(GetCurrentProcess()))throw new InvalidOperationException("Normal-logon actor requires the enclosing supervisor Job");
    if(File.Exists(receipt))throw new InvalidOperationException("Actor receipt already exists");
    ProcessInfo process=new ProcessInfo();bool started=false;
    try {
      var startup=new StartupInfo{Size=Marshal.SizeOf(typeof(StartupInfo)),Desktop=desktopName,Flags=1,Show=0};
      if(!CreateProcessWithLogonW(user,domain,password,1,executable,new StringBuilder("\""+executable+"\" "+arguments),0x08000000|0x4,IntPtr.Zero,directory,ref startup,out process))throw new Win32Exception();
      started=true;
      if(!InJob(process.Process))throw new InvalidOperationException("Normal-logon actor escaped the enclosing supervisor Job");
      long created,exited,kernel,cpu;uint session;
      if(!GetProcessTimes(process.Process,out created,out exited,out kernel,out cpu)||!ProcessIdToSessionId(process.ProcessId,out session))throw new Win32Exception();
      if(interactiveSession.HasValue&&session!=interactiveSession.Value)throw new InvalidOperationException("Normal-logon actor escaped the interactive session");
      string identity="\"pid\":"+process.ProcessId+",\"creationFileTime\":"+Json(created.ToString())+",\"sessionId\":"+session+",\"inJob\":true,\"imagePath\":"+Json(executable);
      File.WriteAllText(receipt,"{\"event\":\"born\","+identity+"}\n",new UTF8Encoding(false));
      if(ResumeThread(process.Thread)==UInt32.MaxValue)throw new Win32Exception();
      uint wait=WaitForSingleObject(process.Process,timeout);
      if(wait==258)throw new TimeoutException("Owned normal-logon actor timed out");
      if(wait!=0)throw new Win32Exception();
      uint code;if(!GetExitCodeProcess(process.Process,out code))throw new Win32Exception();
      File.AppendAllText(receipt,"{\"event\":\"exited\","+identity+",\"exitCode\":"+code+",\"exitAuthority\":\"original-process-handle\"}\n",new UTF8Encoding(false));
      started=false;return code;
    } finally {
      if(started){if(!TerminateProcess(process.Process,1)||WaitForSingleObject(process.Process,2000)!=0)throw new InvalidOperationException("Normal-logon actor cleanup is unconfirmed");}
      if(process.Thread!=IntPtr.Zero)CloseHandle(process.Thread);
      if(process.Process!=IntPtr.Zero)CloseHandle(process.Process);
    }
  }
  public void Dispose(){if(desktop!=IntPtr.Zero){CloseDesktop(desktop);desktop=IntPtr.Zero;}if(station!=IntPtr.Zero){if(!interactiveSession.HasValue)CloseWindowStation(station);station=IntPtr.Zero;}}
}
