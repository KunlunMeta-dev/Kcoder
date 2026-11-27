// Read-only test fixture. Authority is the already-held process handle, never a PID lookup.
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public sealed class KcoderProtocolProcessFacts {
  public uint Pid, ParentPid;
  public string ImagePath, CreationTicks;
}

public static class KcoderProtocolKernel {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint Size, Usage, ProcessId; public UIntPtr Heap;
    public uint Module, Threads, ParentId; public int Priority; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Executable;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder value,ref uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FileTime creation,out FileTime exit,out FileTime kernel,out FileTime user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32First(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32Next(IntPtr snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);

  public static KcoderProtocolProcessFacts InspectHeld(IntPtr process) {
    uint pid=GetProcessId(process);
    if(pid==0)throw new Win32Exception();
    var image=new StringBuilder(32768);uint length=(uint)image.Capacity;
    if(!QueryFullProcessImageName(process,0,image,ref length))throw new Win32Exception();
    FileTime creation,exit,kernel,user;
    if(!GetProcessTimes(process,out creation,out exit,out kernel,out user))throw new Win32Exception();
    long fileTime=unchecked((long)(((ulong)creation.High<<32)|creation.Low));
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1))throw new Win32Exception();
    uint parent=0;bool found=false;
    try {
      var entry=new ProcessEntry{Size=(uint)Marshal.SizeOf(typeof(ProcessEntry))};
      if(!Process32First(snapshot,ref entry))throw new Win32Exception();
      do {
        // The original paused process remains held, so this identity cannot be reused here.
        if(entry.ProcessId==pid){parent=entry.ParentId;found=true;break;}
      } while(Process32Next(snapshot,ref entry));
    } finally {if(!CloseHandle(snapshot))throw new Win32Exception();}
    if(!found)throw new InvalidOperationException("Held original process was absent from kernel snapshot");
    return new KcoderProtocolProcessFacts{Pid=pid,ParentPid=parent,ImagePath=image.ToString(),
      CreationTicks=DateTime.FromFileTimeUtc(fileTime).Ticks.ToString(CultureInfo.InvariantCulture)};
  }
}
