// Test-only extension of the existing private desktop. No console token is opened.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

public sealed class KcoderOwnedLogonBirth {
  public uint Pid;
  public string CreationTicks;
  public string Sid;
  public string AuthenticationId;
  public uint LogonType;
  public bool ProfileHiveLoaded;
  public bool Elevated;
}
public sealed class KcoderOwnedLogonResult {
  public KcoderOwnedLogonBirth Birth;
  public uint ExitCode;
  public bool JobEmpty;
}

public sealed partial class KcoderInstallerDesktop {
  public bool LastOwnedJobStopped { get; private set; }
  public static EventWaitHandle WatchOwnerInput() {
    var ended=new ManualResetEvent(false);
    var thread=new Thread(delegate(){try{Console.In.ReadLine();}catch{}finally{try{ended.Set();}catch(ObjectDisposedException){}}});
    thread.IsBackground=true;thread.Start();return ended;
  }
  [StructLayout(LayoutKind.Sequential)] struct KeyringLuid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct KeyringTokenStatistics {
    public KeyringLuid TokenId,AuthenticationId; public long ExpirationTime;
    public uint TokenType,ImpersonationLevel,DynamicCharged,DynamicAvailable,GroupCount,PrivilegeCount;
    public KeyringLuid ModifiedId;
  }
  [StructLayout(LayoutKind.Sequential)] struct KeyringSidAttributes { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct KeyringGroups { public uint Count; public KeyringSidAttributes First; }
  [StructLayout(LayoutKind.Sequential)] struct KeyringLsaString { public ushort Length,MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct KeyringLogonData {
    public uint Size; public KeyringLuid Id; public KeyringLsaString User,Domain,Package;
    public uint LogonType,Session; public IntPtr Sid;
  }
  [StructLayout(LayoutKind.Sequential)] struct KeyringFileTime { public uint Low,High; }
  [StructLayout(LayoutKind.Sequential)] struct KeyringJobBasicLimits {
    public long ProcessTime,JobTime; public uint Flags;
    public UIntPtr MinimumWorkingSet,MaximumWorkingSet; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority,Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct KeyringIoCounters { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct KeyringJobLimits {
    public KeyringJobBasicLimits Basic; public KeyringIoCounters Io;
    public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct KeyringJobAccounting {
    public long A,B,C,D; public uint Faults,TotalProcesses,ActiveProcesses,TerminatedProcesses;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,uint kind,ref KeyringJobLimits data,uint bytes);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,uint kind,out KeyringJobAccounting data,uint bytes,IntPtr length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out KeyringFileTime birth,out KeyringFileTime exit,out KeyringFileTime kernel,out KeyringFileTime user);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,uint kind,out KeyringTokenStatistics data,uint bytes,out uint required);
  [DllImport("advapi32.dll",EntryPoint="GetTokenInformation",SetLastError=true)] static extern bool KeyringTokenInformation(IntPtr token,uint kind,IntPtr data,uint bytes,out uint required);
  [DllImport("secur32.dll")] static extern uint LsaGetLogonSessionData(ref KeyringLuid id,out IntPtr data);
  [DllImport("secur32.dll")] static extern uint LsaFreeReturnBuffer(IntPtr data);

  static IntPtr KeyringTokenBuffer(IntPtr token,uint kind,out uint length) {
    uint required;KeyringTokenInformation(token,kind,IntPtr.Zero,0,out required);
    if(required==0||required>65536)throw new InvalidOperationException("Owned token query size is invalid");
    IntPtr data=Marshal.AllocHGlobal((int)required);
    if(!KeyringTokenInformation(token,kind,data,required,out length)||length>required){Marshal.FreeHGlobal(data);throw new Win32Exception();}
    return data;
  }
  static KeyringTokenStatistics KeyringStatistics(IntPtr process,out string sid,out bool admin) {
    IntPtr token;if(!OpenProcessToken(process,8,out token))throw new Win32Exception();
    try {
      uint bytes;IntPtr data=KeyringTokenBuffer(token,1,out bytes);
      try { if(bytes<(uint)Marshal.SizeOf(typeof(KeyringSidAttributes)))throw new InvalidOperationException("Owned TOKEN_USER is truncated");sid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; }
      finally { Marshal.FreeHGlobal(data); }
      data=KeyringTokenBuffer(token,2,out bytes);admin=false;
      try {
        uint count=unchecked((uint)Marshal.ReadInt32(data));int offset=(int)Marshal.OffsetOf(typeof(KeyringGroups),"First"),stride=Marshal.SizeOf(typeof(KeyringSidAttributes));
        if(count>4096||(long)offset+(long)count*stride>bytes)throw new InvalidOperationException("Owned TOKEN_GROUPS is truncated");
        for(uint i=0;i<count;i++) {
          var group=(KeyringSidAttributes)Marshal.PtrToStructure(IntPtr.Add(data,offset+(int)i*stride),typeof(KeyringSidAttributes));
          // Reject even a deny-only Administrators SID: this actor must be a new standard user.
          if(new SecurityIdentifier(group.Sid).Value=="S-1-5-32-544")admin=true;
        }
      } finally { Marshal.FreeHGlobal(data); }
      KeyringTokenStatistics value;uint size;
      if(!GetTokenInformation(token,10,out value,(uint)Marshal.SizeOf(typeof(KeyringTokenStatistics)),out size))throw new Win32Exception();
      return value;
    } finally { CloseHandle(token); }
  }
  static KcoderOwnedLogonBirth KeyringBirth(ProcessInfo process,string expectedSid) {
    string sid;bool admin;var stats=KeyringStatistics(process.Process,out sid,out admin);
    if(sid!=expectedSid||admin)throw new InvalidOperationException("Owned logon SID/admin mismatch");
    string callerSid;bool callerAdmin;var caller=KeyringStatistics(GetCurrentProcess(),out callerSid,out callerAdmin);
    if(caller.AuthenticationId.Low==stats.AuthenticationId.Low&&caller.AuthenticationId.High==stats.AuthenticationId.High)
      throw new InvalidOperationException("Owned logon reused the caller logon session");
    IntPtr raw;if(LsaGetLogonSessionData(ref stats.AuthenticationId,out raw)!=0||raw==IntPtr.Zero)
      throw new InvalidOperationException("Owned logon metadata unavailable");
    uint type;
    try {
      var value=(KeyringLogonData)Marshal.PtrToStructure(raw,typeof(KeyringLogonData));type=value.LogonType;
      if(type!=2||value.Sid==IntPtr.Zero||new SecurityIdentifier(value.Sid).Value!=expectedSid)
        throw new InvalidOperationException("Owned token is not the expected interactive-type logon");
    } finally { LsaFreeReturnBuffer(raw); }
    bool loaded;
    try { using(var hive=Microsoft.Win32.Registry.Users.OpenSubKey(expectedSid))loaded=hive!=null; }
    catch(Exception error){throw new InvalidOperationException("Owned profile hive observation failed",error);}
    if(!loaded)throw new InvalidOperationException("Owned logon profile hive not loaded");
    KeyringFileTime birth,exit,kernel,user;
    if(!GetProcessTimes(process.Process,out birth,out exit,out kernel,out user))throw new Win32Exception();
    long fileTime=unchecked((long)(((ulong)birth.High<<32)|birth.Low));
    return new KcoderOwnedLogonBirth{Pid=process.ProcessId,CreationTicks=DateTime.FromFileTimeUtc(fileTime).Ticks.ToString(),
      Sid=sid,AuthenticationId=stats.AuthenticationId.High.ToString()+":"+stats.AuthenticationId.Low.ToString(),
      LogonType=type,ProfileHiveLoaded=loaded,Elevated=admin};
  }
  static bool KeyringJobEmpty(IntPtr job) {
    KeyringJobAccounting value;
    if(!QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(KeyringJobAccounting)),IntPtr.Zero))throw new Win32Exception();
    return value.ActiveProcesses==0;
  }
  static void KeyringStopJob(IntPtr job) {
    if(!KeyringJobEmpty(job)&&!TerminateJobObject(job,1))throw new Win32Exception();
    var deadline=DateTime.UtcNow.AddSeconds(5);
    while(!KeyringJobEmpty(job)){if(DateTime.UtcNow>=deadline)throw new TimeoutException("Owned logon job termination unconfirmed");Thread.Sleep(25);}
  }
  public KcoderOwnedLogonResult RunObserved(string user,string domain,string password,string expectedSid,
      string executable,string arguments,string directory,uint timeout,WaitHandle cancel,Action<KcoderOwnedLogonBirth> publishBirth) {
    LastOwnedJobStopped=true;
    if(station==IntPtr.Zero||desktop==IntPtr.Zero)throw new ObjectDisposedException("Owned desktop");
    if(publishBirth==null)throw new ArgumentNullException("publishBirth");
    if(cancel!=null&&cancel.WaitOne(0))throw new OperationCanceledException("Owned caller ended before launch");
    IntPtr job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception();
    ProcessInfo process=new ProcessInfo();bool created=false;
    string stage="job_limits";
    try {
      var limits=new KeyringJobLimits();limits.Basic.Flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(KeyringJobLimits))))throw new Win32Exception();
      var startup=new StartupInfo{Size=Marshal.SizeOf(typeof(StartupInfo)),Desktop=desktopName,Flags=1,Show=0};
      stage="create_profile_logon";
      if(!CreateProcessWithLogonW(user,domain,password,1,executable,new StringBuilder("\""+executable+"\" "+arguments),
          0x08000004,IntPtr.Zero,directory,ref startup,out process))throw new Win32Exception();
      created=true;LastOwnedJobStopped=false;
      stage="assign_owned_job";
      if(!AssignProcessToJobObject(job,process.Process))throw new Win32Exception();
      stage="query_owned_birth";
      var birth=KeyringBirth(process,expectedSid);
      // The caller must durably record PID, creation time and actual SID before code runs.
      stage="publish_owned_birth";
      publishBirth(birth);
      if(cancel!=null&&cancel.WaitOne(0))throw new OperationCanceledException("Owned caller ended before resume");
      stage="resume_owned_actor";
      if(ResumeThread(process.Thread)==0xffffffff)throw new Win32Exception();
      stage="wait_owned_actor";
      var deadline=DateTime.UtcNow.AddMilliseconds(timeout);
      while(true) {
        uint wait=WaitForSingleObject(process.Process,25);
        if(wait==0)break;
        if(wait==0xffffffff)throw new Win32Exception();
        if(wait!=258)throw new InvalidOperationException("Unexpected owned process wait result");
        if((cancel!=null&&cancel.WaitOne(0))||DateTime.UtcNow>=deadline) {
          KeyringStopJob(job);throw new OperationCanceledException("Owned logon cancelled or timed out");
        }
      }
      uint code;if(!GetExitCodeProcess(process.Process,out code))throw new Win32Exception();
      var cleanupDeadline=DateTime.UtcNow.AddSeconds(5);
      while(!KeyringJobEmpty(job)){if(DateTime.UtcNow>=cleanupDeadline){KeyringStopJob(job);throw new TimeoutException("Owned logon descendants remained");}Thread.Sleep(25);}
      return new KcoderOwnedLogonResult{Birth=birth,ExitCode=code,JobEmpty=true};
    } catch(Exception error) {
      throw new InvalidOperationException("Owned logon stage "+stage+" failed ("+error.GetType().Name+")",error);
    } finally {
      try {
        if(created) {
          // Assignment can fail before ResumeThread: terminate the still-suspended root too.
          uint wait=WaitForSingleObject(process.Process,0);
          if(wait==0xffffffff)throw new Win32Exception();
          if(wait==258){
            TerminateProcess(process.Process,1);
            if(WaitForSingleObject(process.Process,5000)!=0)throw new TimeoutException("Owned root termination unconfirmed");
          } else if(wait!=0)throw new InvalidOperationException("Unexpected owned root wait result");
          KeyringStopJob(job);
        }
        LastOwnedJobStopped=true;
      } finally {
        if(created){CloseHandle(process.Thread);CloseHandle(process.Process);}CloseHandle(job);
      }
    }
  }
}
