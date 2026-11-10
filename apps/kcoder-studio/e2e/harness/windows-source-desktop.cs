// Test-only same-token desktop owner. The enclosing RunContext supervisor owns the Job.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public sealed class KcoderSourceDesktopOwner : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
    public int Length; public IntPtr Descriptor; public int Inherit;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public int Size; public string Reserved,Desktop,Title;
    public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags;
    public ushort Show,ReservedBytes; public IntPtr ReservedPointer,Input,Output,Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
    public StartupInfo Startup; public IntPtr Attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process,Thread; public uint ProcessId,ThreadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential)] struct UserObjectFlags { public int Inherit,Reserved; public uint Flags; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint Size,Usage,ProcessId; public UIntPtr Heap;
    public uint Module,Threads,ParentId; public int Priority; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Executable;
  }
  delegate bool EnumWindow(IntPtr window,IntPtr data);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string descriptor,uint revision,out IntPtr result,out uint size);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowStation(string name,uint flags,uint access,ref SecurityAttributes security);
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr station);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,ref SecurityAttributes security);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenDesktop(string name,uint flags,bool inherit,uint access);
  [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",SetLastError=true)] static extern bool GetStationFlags(IntPtr handle,int index,out UserObjectFlags flags,uint length,out uint needed);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll",SetLastError=true)] static extern bool CloseWindowStation(IntPtr station);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder value,uint length,out uint needed);
  [DllImport("user32.dll",SetLastError=true)] static extern bool EnumDesktopWindows(IntPtr desktop,EnumWindow callback,IntPtr state);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int length);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll",SetLastError=true)] static extern bool ShowWindowAsync(IntPtr window,int command);
  [DllImport("user32.dll",SetLastError=true)] static extern bool PostMessage(IntPtr window,uint message,IntPtr first,IntPtr second);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr needed);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid,out uint session);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FileTime creation,out FileTime exit,out FileTime kernel,out FileTime user);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder value,ref uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32First(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32Next(IntPtr snapshot,ref ProcessEntry entry);

  readonly string owner,stationName,desktopName;
  readonly bool ownsStation;
  bool inheritedStationVisible;
  readonly uint wrapperPid,wrapperParent,ownerSession;
  IntPtr station,desktop,process,window;
  uint electronPid,electronSession; string electronImage,creationTicks;
  bool electronInJob,windowVisible,windowRestoreRequested; string windowClass;
  readonly List<Dictionary<string,object>> observedWindows=new List<Dictionary<string,object>>();

  public KcoderSourceDesktopOwner(string identity,uint expectedSession) {
    Guid parsed;
    if(!Guid.TryParseExact(identity,"D",out parsed))throw new ArgumentException("Invalid desktop owner");
    owner=parsed.ToString("D"); stationName="KCoderSourceE2E_"+parsed.ToString("N");
    wrapperPid=GetCurrentProcessId(); wrapperParent=ParentPid(wrapperPid);
    ownerSession=expectedSession;
    ownsStation=ownerSession==0;
    if(Session(wrapperPid)!=ownerSession||!InJob(GetCurrentProcess()))throw new InvalidOperationException("Owned source desktop requires the launching session and enclosing supervisor Job");
    string sid;using(var identityToken=WindowsIdentity.GetCurrent()){sid=identityToken.User.Value;}
    IntPtr descriptor; uint bytes;
    if(!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;"+sid+")",1,out descriptor,out bytes))throw new Win32Exception();
    var security=new SecurityAttributes{Length=Marshal.SizeOf(typeof(SecurityAttributes)),Descriptor=descriptor,Inherit=0};
    IntPtr previous=GetProcessWindowStation();
    if(previous==IntPtr.Zero){LocalFree(descriptor);throw new Win32Exception();}
    try {
      string leaf="Default";
      if(ownsStation) {
        // CREATE_ONLY rejects collisions in the SSH diagnostic session.
        station=CreateWindowStation(stationName,1,0x000F037F,ref security);
        if(station==IntPtr.Zero)throw new Win32Exception();
        if(!SetProcessWindowStation(station))throw new Win32Exception();
      } else {
        // Borrow the caller's station unchanged; create only a new private desktop.
        station=previous;stationName=ObjectName(station);leaf="KCoderSourceE2E_"+parsed.ToString("N");
        UserObjectFlags flags;uint needed;
        if(!GetStationFlags(station,1,out flags,(uint)Marshal.SizeOf(typeof(UserObjectFlags)),out needed))throw new Win32Exception();
        inheritedStationVisible=(flags.Flags&1)!=0;
        if(!inheritedStationVisible)throw new InvalidOperationException("Run the test from the logged-in desktop session");
        IntPtr existing=OpenDesktop(leaf,0,false,0x00020001);
        if(existing!=IntPtr.Zero){CloseDesktop(existing);throw new InvalidOperationException("Private desktop owner collision");}
        int error=Marshal.GetLastWin32Error();if(error!=2)throw new Win32Exception(error);
      }
      desktopName=stationName+"\\"+leaf;
      try {desktop=CreateDesktop(leaf,IntPtr.Zero,IntPtr.Zero,0,0x000F01FF,ref security);if(desktop==IntPtr.Zero)throw new Win32Exception();}
      finally {if(ownsStation&&!SetProcessWindowStation(previous))throw new Win32Exception();}
      if(ObjectName(station)!=stationName||ObjectName(desktop)!=leaf)throw new InvalidOperationException("Private desktop identity mismatch");
    } catch { Dispose();throw; }
    finally { if(LocalFree(descriptor)!=IntPtr.Zero)throw new Win32Exception(); }
  }

  static uint Session(uint pid) {uint session;if(!ProcessIdToSessionId(pid,out session))throw new Win32Exception();return session;}
  static bool InJob(IntPtr target) {bool result;if(!IsProcessInJob(target,IntPtr.Zero,out result))throw new Win32Exception();return result;}
  static string ObjectName(IntPtr target) {
    uint needed;var text=new StringBuilder(512);
    if(!GetUserObjectInformation(target,2,text,(uint)(text.Capacity*2),out needed))throw new Win32Exception();
    return text.ToString();
  }
  static uint ParentPid(uint pid) {
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1))throw new Win32Exception();
    try {
      var entry=new ProcessEntry{Size=(uint)Marshal.SizeOf(typeof(ProcessEntry))};
      if(Process32First(snapshot,ref entry))do{if(entry.ProcessId==pid)return entry.ParentId;}while(Process32Next(snapshot,ref entry));
      throw new InvalidOperationException("Owned wrapper parent was not observed");
    } finally {if(!CloseHandle(snapshot))throw new Win32Exception();}
  }
  static string Quote(string value) {
    if(value==null||value.IndexOf('\0')>=0)throw new ArgumentException("Invalid process argument");
    var result=new StringBuilder("\"");int slashes=0;
    foreach(char item in value) {
      if(item=='\\'){slashes++;continue;}
      if(item=='\"'){result.Append('\\',slashes*2+1);result.Append(item);slashes=0;continue;}
      result.Append('\\',slashes);slashes=0;result.Append(item);
    }
    result.Append('\\',slashes*2);return result.Append('"').ToString();
  }

  public void Start(string executable,string[] args,string directory) {
    if(station==IntPtr.Zero||desktop==IntPtr.Zero||process!=IntPtr.Zero)throw new InvalidOperationException("Invalid owned desktop lifecycle");
    var command=new StringBuilder(Quote(executable));foreach(string argument in args)command.Append(' ').Append(Quote(argument));
    IntPtr attributes=IntPtr.Zero,handles=IntPtr.Zero,size=IntPtr.Zero;
    var stdio=new List<IntPtr>();bool initialized=false;
    try {
      foreach(int kind in new int[]{-10,-11,-12}) {
        IntPtr source=GetStdHandle(kind),duplicate;
        if(source==IntPtr.Zero||source==new IntPtr(-1)||!DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),out duplicate,0,true,2))throw new Win32Exception();
        stdio.Add(duplicate);
      }
      InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
      if(size==IntPtr.Zero)throw new Win32Exception();
      attributes=Marshal.AllocHGlobal(size);
      if(!InitializeProcThreadAttributeList(attributes,1,0,ref size))throw new Win32Exception();
      initialized=true;handles=Marshal.AllocHGlobal(IntPtr.Size*stdio.Count);
      for(int i=0;i<stdio.Count;i++)Marshal.WriteIntPtr(handles,i*IntPtr.Size,stdio[i]);
      if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*stdio.Count),IntPtr.Zero,IntPtr.Zero))throw new Win32Exception();
      var startup=new StartupInfoEx{Startup=new StartupInfo{Size=Marshal.SizeOf(typeof(StartupInfoEx)),Desktop=desktopName,Flags=0x100,Input=stdio[0],Output=stdio[1],Error=stdio[2]},Attributes=attributes};
      ProcessInfo child;
      // No breakaway flags or token change: the enclosing Job owns this suspended child too.
      if(!CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x400|0x80000,IntPtr.Zero,directory,ref startup,out child))throw new Win32Exception();
      process=child.Process;electronPid=child.ProcessId;
      try {
        electronInJob=InJob(process);electronSession=Session(electronPid);
        if(electronSession!=ownerSession||!electronInJob)throw new InvalidOperationException("Electron escaped the owned session or Job");
        var image=new StringBuilder(32768);uint length=(uint)image.Capacity;
        if(!QueryFullProcessImageName(process,0,image,ref length))throw new Win32Exception();
        electronImage=image.ToString();
        if(!String.Equals(System.IO.Path.GetFullPath(executable),electronImage,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Electron image changed");
        FileTime created,exited,kernel,user;
        if(!GetProcessTimes(process,out created,out exited,out kernel,out user))throw new Win32Exception();
        creationTicks=(((ulong)created.High<<32)|created.Low).ToString(System.Globalization.CultureInfo.InvariantCulture);
        if(ResumeThread(child.Thread)==UInt32.MaxValue)throw new Win32Exception();
      } finally {if(!CloseHandle(child.Thread))throw new Win32Exception();}
    } finally {
      if(initialized)DeleteProcThreadAttributeList(attributes);
      if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);
      if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);
      var failures=new List<Exception>();
      foreach(IntPtr handle in stdio)if(!CloseHandle(handle))failures.Add(new Win32Exception());
      if(failures.Count>0)throw new AggregateException("Owned stdio handle release failed",failures);
    }
  }

  public bool IsRunning() {
    if(process==IntPtr.Zero)return false;
    uint wait=WaitForSingleObject(process,0);
    if(wait==0)return false;if(wait==258)return true;throw new Win32Exception();
  }
  public bool ObserveWindow() {
    if(desktop==IntPtr.Zero||!IsRunning())return false;
    // An empty startup enumeration may leave last error untouched. Do not
    // report a stale error from an earlier file or process observation.
    SetLastError(0);
    observedWindows.Clear();
    int restoreError=0;
    bool enumerated=EnumDesktopWindows(desktop,(candidate,state)=> {
      uint pid;GetWindowThreadProcessId(candidate,out pid);
      if(pid!=electronPid)return true;
      var text=new StringBuilder(256);GetClassName(candidate,text,text.Capacity);
      bool visible=IsWindowVisible(candidate);
      if(observedWindows.Count<32)observedWindows.Add(Data("hwnd","0x"+candidate.ToInt64().ToString("x"),"className",text.ToString(),"visible",visible));
      if(text.ToString()=="Chrome_WidgetWin_1"&&!visible&&!windowRestoreRequested) {
        uint currentOwner;
        if(IsRunning()&&GetWindowThreadProcessId(candidate,out currentOwner)!=0&&currentOwner==electronPid) {
          // One explicit fixture restore affects only this process's private window.
          // A later observation must still prove real visibility before readiness.
          windowRestoreRequested=true;
          if(!ShowWindowAsync(candidate,1)) { restoreError=Marshal.GetLastWin32Error();if(restoreError==0)restoreError=31; }
        }
      }
      if(text.ToString()!="Chrome_WidgetWin_1"||!visible)return true;
      window=candidate;windowClass=text.ToString();windowVisible=true;return false;
    },IntPtr.Zero);
    int error=Marshal.GetLastWin32Error();
    if(restoreError!=0)throw new Win32Exception(restoreError);
    if(!enumerated&&window==IntPtr.Zero&&error!=0)throw new Win32Exception(error);
    return window!=IntPtr.Zero;
  }
  public void Stop() {
    if(!IsRunning())return;
    uint pid;
    if(window!=IntPtr.Zero&&GetWindowThreadProcessId(window,out pid)!=0&&pid==electronPid)
      PostMessage(window,0x10,IntPtr.Zero,IntPtr.Zero);
    uint wait=WaitForSingleObject(process,1500);
    if(wait==258) {
      if(!TerminateProcess(process,1))throw new Win32Exception();
      if(WaitForSingleObject(process,1000)!=0)throw new InvalidOperationException("Owned Electron did not stop");
    } else if(wait!=0)throw new Win32Exception();
  }
  static Dictionary<string,object> Data(params object[] pairs) {
    var result=new Dictionary<string,object>();for(int i=0;i<pairs.Length;i+=2)result.Add((string)pairs[i],pairs[i+1]);return result;
  }
  public Dictionary<string,object> Snapshot() {
    return Data("version",1,"owner",owner,"windowStation",stationName,"desktop",desktopName,
      "observedOwnerWindows",observedWindows,
      "windowRestoreRequested",windowRestoreRequested,
      "inheritedWindowStation",!ownsStation,"inheritedStationVisible",inheritedStationVisible,
      "wrapper",Data("pid",wrapperPid,"parentPid",wrapperParent,"sessionId",Session(wrapperPid),"inJob",InJob(GetCurrentProcess())),
      "electron",Data("pid",electronPid,"sessionId",electronSession,"inJob",electronInJob,"imagePath",electronImage,"creationTicks",creationTicks),
      "nativeWindow",Data("hwnd","0x"+window.ToInt64().ToString("x"),"pid",electronPid,"className",windowClass,"visible",windowVisible),
      "handles",Data("station",ownsStation&&station!=IntPtr.Zero,"desktop",desktop!=IntPtr.Zero,"process",process!=IntPtr.Zero));
  }
  public void Dispose() {
    var failures=new List<Exception>();
    try{Stop();}catch(Exception error){failures.Add(error);}
    if(process!=IntPtr.Zero){if(CloseHandle(process))process=IntPtr.Zero;else failures.Add(new Win32Exception());}
    if(desktop!=IntPtr.Zero){if(CloseDesktop(desktop))desktop=IntPtr.Zero;else failures.Add(new Win32Exception());}
    if(station!=IntPtr.Zero){if(!ownsStation||CloseWindowStation(station))station=IntPtr.Zero;else failures.Add(new Win32Exception());}
    if(failures.Count>0)throw new AggregateException("Owned desktop release was incomplete",failures);
  }
}
