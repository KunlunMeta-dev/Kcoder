import { spawn } from 'node:child_process';
import { createWindowsStorageGuardClient } from './mobile-device-storage-worker.js';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// Existing roots belong to this user. An elevated token may create a new root
// owned by Administrators; accept that only during initialization when the
// token's default owner matches and the directory is empty, then assign the user.
// Keep an Administrators-owned child only when its existing ACL is already private.
const script = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false);
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);
try {
$parent=[Diagnostics.Process]::GetProcessById(__NODE_PARENT_PID__);$null=$parent.Handle;
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class MobileDeviceFileId {
 const uint FILE_READ_ATTRIBUTES=0x80,FILE_LIST_DIRECTORY=0x1,READ_CONTROL=0x20000,WRITE_DAC=0x40000,WRITE_OWNER=0x80000;
 const uint FILE_SHARE_READ=0x1,FILE_SHARE_WRITE=0x2,FILE_SHARE_DELETE=0x4,OPEN_EXISTING=3;
 const uint FILE_ATTRIBUTE_DIRECTORY=0x10,FILE_ATTRIBUTE_REPARSE_POINT=0x400;
 const uint FILE_FLAG_BACKUP_SEMANTICS=0x02000000,FILE_FLAG_OPEN_REPARSE_POINT=0x00200000;
 const uint DACL_SECURITY_INFORMATION=0x4,OWNER_SECURITY_INFORMATION=0x1,PROTECTED_DACL_SECURITY_INFORMATION=0x80000000;
 const uint FILE_OPEN=1,FILE_OPEN_REPARSE_POINT=0x00200000,OBJ_CASE_INSENSITIVE=0x40;
 const uint MAX_DIRECT_ENTRIES=128,MAX_NAME_CHARS=255;
 const string SYSTEM_SID="S-1-5-18",ADMINISTRATORS_SID="S-1-5-32-544";
 const int SE_FILE_OBJECT=1,FileIdBothDirectoryInfo=10,FileIdBothDirectoryRestartInfo=11;

 [StructLayout(LayoutKind.Sequential)] public struct Info {
  public uint Attributes;
  public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;
  public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct DirectoryInfo {
  public uint NextEntryOffset,FileIndex;
  public long CreationTime,LastAccessTime,LastWriteTime,ChangeTime,EndOfFile,AllocationSize;
  public uint FileAttributes,FileNameLength,EaSize;
  public byte ShortNameLength;
  [MarshalAs(UnmanagedType.ByValArray,SizeConst=12,ArraySubType=UnmanagedType.U2)] public char[] ShortName;
  public long FileId;
  public char FileName;
 }
 [StructLayout(LayoutKind.Sequential)] struct UnicodeString {
  public ushort Length,MaximumLength;
  public IntPtr Buffer;
 }
 [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
  public int Length;
  public IntPtr RootDirectory,ObjectName;
  public uint Attributes;
  public IntPtr SecurityDescriptor,SecurityQualityOfService;
 }
 [StructLayout(LayoutKind.Sequential)] struct IoStatusBlock {
  public IntPtr Status,Information;
 }
 sealed class Node : IDisposable {
  public string Owner,Identity;
  public SafeFileHandle Handle,OwnerWriteHandle;
  public bool Directory,NeedsRepair;
  public long EnumeratedFileId;
  public uint EnumeratedVolume;
  public SafeFileHandle SecurityHandle{get{return OwnerWriteHandle??Handle;}}
  public void Dispose(){if(OwnerWriteHandle!=null)OwnerWriteHandle.Dispose();if(Handle!=null)Handle.Dispose();}
 }
 sealed class DirectoryEntry {
  public string Name;
  public uint Attributes,Volume;
  public long FileId;
 }
 sealed class SecurityState {
  public string Owner;
  public bool Protected,BroadInherited,BroadExplicit;
  public bool HasBroad{get{return BroadInherited||BroadExplicit;}}
 }

 [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)]
 static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,IntPtr buffer,uint size);
 [DllImport("kernel32.dll",EntryPoint="GetFinalPathNameByHandleW",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder path,uint size,uint flags);
 [DllImport("kernel32.dll",EntryPoint="GetVolumePathNameW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumePathName(string path,StringBuilder volume,uint size);
 [DllImport("kernel32.dll",EntryPoint="GetDriveTypeW",CharSet=CharSet.Unicode)] static extern uint GetDriveType(string root);
 [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle handle,uint desiredAccess,ref ObjectAttributes attributes,out IoStatusBlock ioStatus,IntPtr allocationSize,uint fileAttributes,uint shareAccess,uint disposition,uint options,IntPtr eaBuffer,uint eaLength);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle handle,int objectType,uint securityInfo,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint SetSecurityInfo(SafeFileHandle handle,int objectType,uint securityInfo,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint size);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string text,out IntPtr sid);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

 static Exception Fail(string message){return new Exception(message);}
 static string FileIdentity(Info info){return info.Volume.ToString("X8")+":"+info.IndexHigh.ToString("X8")+info.IndexLow.ToString("X8");}
 static long FileNumber(Info info){return unchecked((long)(((ulong)info.IndexHigh<<32)|info.IndexLow));}
 static Info ReadInfo(SafeFileHandle handle){Info info;if(handle==null||handle.IsInvalid||!GetFileInformationByHandle(handle,out info))throw Fail("Device storage identity unavailable");return info;}
 static Info ReadInfo(Node node){return ReadInfo(node.Handle);}
 static void CurrentSids(out string user,out string tokenOwner){using(WindowsIdentity identity=WindowsIdentity.GetCurrent()){user=identity.User==null?null:identity.User.Value;tokenOwner=identity.Owner==null?null:identity.Owner.Value;}}
 static SafeFileHandle OpenRootHandle(string path,bool writeOwner){
  uint access=FILE_READ_ATTRIBUTES|FILE_LIST_DIRECTORY|READ_CONTROL|WRITE_DAC;
  if(writeOwner)access|=WRITE_OWNER;
  SafeFileHandle handle=CreateFile(path,access,FILE_SHARE_READ|FILE_SHARE_WRITE,IntPtr.Zero,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,IntPtr.Zero);
  if(handle.IsInvalid){handle.Dispose();throw Fail("Device storage identity unavailable");}
  return handle;
 }
 static Node OpenRoot(string path){
  Node node=new Node();node.Directory=true;node.Handle=OpenRootHandle(path,false);
  try{
   Info info=ReadInfo(node);
   if((info.Attributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0)throw Fail("Reparse device storage rejected");
   if((info.Attributes&FILE_ATTRIBUTE_DIRECTORY)==0)throw Fail("Device storage identity unavailable");
   node.Identity=FileIdentity(info);
   return node;
  }catch{node.Dispose();throw;}
 }
 static Node OpenRootIdentity(string path){
  Node node=new Node();node.Directory=true;
  node.Handle=CreateFile(path,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,IntPtr.Zero,OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,IntPtr.Zero);
  if(node.Handle.IsInvalid){node.Dispose();throw Fail("Device storage identity unavailable");}
  try{
   Info info=ReadInfo(node);
   if((info.Attributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0)throw Fail("Reparse device storage rejected");
   if((info.Attributes&FILE_ATTRIBUTE_DIRECTORY)==0)throw Fail("Device storage identity unavailable");
   node.Identity=FileIdentity(info);EnsureLocalRoot(node);return node;
  }catch{node.Dispose();throw;}
 }
 static Socket AcquireStoreLease(string identity){
  byte[] digest;
  using(SHA256 sha=SHA256.Create())digest=sha.ComputeHash(Encoding.UTF8.GetBytes("windows-volume-file:"+identity));
  uint prefix=((uint)digest[0]<<24)|((uint)digest[1]<<16)|((uint)digest[2]<<8)|digest[3];
  int port=49152+(int)(prefix%16384);Stopwatch wait=Stopwatch.StartNew();
  while(true){
   Socket socket=null;
   try{
    socket=new Socket(AddressFamily.InterNetwork,SocketType.Stream,ProtocolType.Tcp);
    socket.ExclusiveAddressUse=true;
    socket.Bind(new IPEndPoint(IPAddress.Loopback,port));
    return socket;
   }catch(SocketException error){
    if(socket!=null)socket.Dispose();
    if(error.SocketErrorCode!=SocketError.AddressAlreadyInUse&&error.SocketErrorCode!=SocketError.AccessDenied)throw;
    if(wait.ElapsedMilliseconds>=5000)throw Fail("Device storage lock unavailable");
    Thread.Sleep(25);
   }catch{if(socket!=null)socket.Dispose();throw;}
  }
 }
 static SafeFileHandle OpenRootOwnerHandle(string path,Node expected,string user,string admin){
  SafeFileHandle handle=OpenRootHandle(path,true);
  try{
   Info info=ReadInfo(handle),original=ReadInfo(expected);
   if((info.Attributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0)throw Fail("Reparse device storage rejected");
   if((info.Attributes&FILE_ATTRIBUTE_DIRECTORY)==0||FileIdentity(info)!=expected.Identity||FileIdentity(original)!=expected.Identity)
    throw Fail("Device storage identity unavailable");
   Node probe=new Node();probe.Handle=handle;probe.Directory=true;
   SecurityState state=ReadSecurity(probe,user);
   if(state.Owner!=admin)throw Fail("Device storage owner mismatch");
   EnsureLocalRoot(probe);
   return handle;
  }catch{handle.Dispose();throw;}
 }
 static SecurityState ReadSecurity(Node node,string user){return ReadSecurity(node.SecurityHandle,user);}
 static SecurityState ReadSecurity(SafeFileHandle handle,string user){
  IntPtr owner,group,dacl,sacl,descriptor;
  uint status=GetSecurityInfo(handle,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,out owner,out group,out dacl,out sacl,out descriptor);
  if(status!=0)throw Fail("Device storage identity unavailable");
  try{
   uint size=GetSecurityDescriptorLength(descriptor);if(size<20||size>1048576)throw Fail("Device storage ACL is not private");
   byte[] bytes=new byte[(int)size];Marshal.Copy(descriptor,bytes,0,bytes.Length);
   RawSecurityDescriptor raw;
   try{raw=new RawSecurityDescriptor(bytes,0);}catch{throw Fail("Device storage ACL is not private");}
   SecurityState state=new SecurityState();state.Owner=raw.Owner==null?null:raw.Owner.Value;
   state.Protected=(raw.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0;
   if(raw.DiscretionaryAcl==null){state.BroadExplicit=true;return state;}
   for(int index=0;index<raw.DiscretionaryAcl.Count;index++){
    GenericAce ace=raw.DiscretionaryAcl[index];QualifiedAce qualified=ace as QualifiedAce;
    if(qualified==null){state.BroadExplicit=true;continue;}
    if(qualified.AceQualifier!=AceQualifier.AccessAllowed)continue;
    string sid=qualified.SecurityIdentifier.Value;
    if(sid==user||sid==SYSTEM_SID)continue;
    if((ace.AceFlags&AceFlags.Inherited)!=0)state.BroadInherited=true;else state.BroadExplicit=true;
   }
   return state;
  }finally{LocalFree(descriptor);}
 }
 static string EnsureLocalRoot(Node root){
  StringBuilder finalBuffer=new StringBuilder(32768);
  uint length=GetFinalPathNameByHandle(root.Handle,finalBuffer,(uint)finalBuffer.Capacity,0);
  if(length==0||length>=finalBuffer.Capacity)throw Fail("Device storage identity unavailable");
  string finalPath=finalBuffer.ToString();
  if(finalPath.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)||
     (finalPath.StartsWith(@"\\",StringComparison.OrdinalIgnoreCase)&&!finalPath.StartsWith(@"\\?\",StringComparison.OrdinalIgnoreCase)))
   throw Fail("Network device storage is unsupported");
  StringBuilder volume=new StringBuilder(32768);
  if(!GetVolumePathName(finalPath,volume,(uint)volume.Capacity))throw Fail("Device storage identity unavailable");
  string volumePath=volume.ToString();
  if(volumePath.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)||
     (volumePath.StartsWith(@"\\",StringComparison.OrdinalIgnoreCase)&&!volumePath.StartsWith(@"\\?\",StringComparison.OrdinalIgnoreCase)))
   throw Fail("Network device storage is unsupported");
  string driveRoot=volumePath;
  if(volumePath.Length>=7&&volumePath.StartsWith(@"\\?\",StringComparison.OrdinalIgnoreCase)&&volumePath[5]==':')
   driveRoot=volumePath.Substring(4,3);
  uint drive=GetDriveType(driveRoot);
  if(drive==4)throw Fail("Network device storage is unsupported");
  if(drive==0||drive==1)throw Fail("Device storage identity unavailable");
  return finalPath;
 }
 static bool AllowedChildName(string name){
  if(name==".key"||name=="devices.json")return true;
  const string prefix="devices.json.",suffix=".tmp";
  if(name.Length!=prefix.Length+36+suffix.Length||!name.StartsWith(prefix,StringComparison.Ordinal)||!name.EndsWith(suffix,StringComparison.Ordinal))return false;
  string value=name.Substring(prefix.Length,36);Guid id;
  return Guid.TryParseExact(value,"D",out id)&&id.ToString("D")==value&&value[14]=='4'&&"89ab".IndexOf(value[19])>=0;
 }
 static List<DirectoryEntry> EnumerateChildren(Node root,uint volume){
  const int bufferSize=65536;
  List<DirectoryEntry> entries=new List<DirectoryEntry>();
  IntPtr buffer=Marshal.AllocHGlobal(bufferSize);
  try{
   int infoClass=FileIdBothDirectoryRestartInfo;
   int nameLengthOffset=Marshal.OffsetOf(typeof(DirectoryInfo),"FileNameLength").ToInt32();
   int fileAttributesOffset=Marshal.OffsetOf(typeof(DirectoryInfo),"FileAttributes").ToInt32();
   int fileIdOffset=Marshal.OffsetOf(typeof(DirectoryInfo),"FileId").ToInt32();
   int nameOffset=Marshal.OffsetOf(typeof(DirectoryInfo),"FileName").ToInt32();
   while(true){
    if(!GetFileInformationByHandleEx(root.Handle,infoClass,buffer,bufferSize)){
     int error=Marshal.GetLastWin32Error();
     if(error==18||error==38)return entries;
     throw Fail("Device storage identity unavailable");
    }
    infoClass=FileIdBothDirectoryInfo;
    int position=0;
    while(true){
     if(position<0||position+nameOffset>bufferSize)throw Fail("Unsafe device storage file");
     IntPtr item=IntPtr.Add(buffer,position);
     uint next=(uint)Marshal.ReadInt32(item,0),nameBytes=(uint)Marshal.ReadInt32(item,nameLengthOffset);
     if((nameBytes&1)!=0||nameBytes==0||nameBytes>(MAX_NAME_CHARS*2)||nameOffset+(int)nameBytes>bufferSize-position)
      throw Fail("Unsafe device storage file");
     string name=Marshal.PtrToStringUni(IntPtr.Add(item,nameOffset),(int)nameBytes/2);
     if(name!="."&&name!=".."){
      if(name.Length>MAX_NAME_CHARS||name.IndexOf('\\')>=0||name.IndexOf('/')>=0||name.IndexOf('\0')>=0||!AllowedChildName(name))
       throw Fail("Unsafe device storage file");
      if(entries.Count>=MAX_DIRECT_ENTRIES)throw Fail("Unsafe device storage file");
      DirectoryEntry entry=new DirectoryEntry();entry.Name=name;entry.Attributes=(uint)Marshal.ReadInt32(item,fileAttributesOffset);
      entry.FileId=Marshal.ReadInt64(item,fileIdOffset);entry.Volume=volume;entries.Add(entry);
     }
     if(next==0)break;
     int minimum=nameOffset+(int)nameBytes;
     if(next<(uint)minimum||next>(uint)(bufferSize-position))throw Fail("Unsafe device storage file");
     position+=(int)next;
    }
   }
  }finally{Marshal.FreeHGlobal(buffer);}
 }
 static void EnsureSameChildren(List<DirectoryEntry> expected,List<DirectoryEntry> actual){
  if(expected.Count!=actual.Count)throw Fail("Unsafe device storage file");
  bool[] matched=new bool[expected.Count];
  for(int actualIndex=0;actualIndex<actual.Count;actualIndex++){
   DirectoryEntry current=actual[actualIndex];bool found=false;
   for(int expectedIndex=0;expectedIndex<expected.Count;expectedIndex++){
    DirectoryEntry original=expected[expectedIndex];
    if(!String.Equals(original.Name,current.Name,StringComparison.Ordinal))continue;
    if(matched[expectedIndex]||original.FileId!=current.FileId||original.Volume!=current.Volume)
     throw Fail("Unsafe device storage file");
    matched[expectedIndex]=true;found=true;break;
   }
   if(!found)throw Fail("Unsafe device storage file");
  }
  for(int index=0;index<matched.Length;index++)if(!matched[index])throw Fail("Unsafe device storage file");
 }
 static Node OpenChildRelative(Node root,DirectoryEntry entry){
  IntPtr text=IntPtr.Zero,namePointer=IntPtr.Zero;SafeFileHandle handle=null;
  try{
   text=Marshal.StringToHGlobalUni(entry.Name);
   UnicodeString name=new UnicodeString();name.Length=(ushort)(entry.Name.Length*2);name.MaximumLength=(ushort)(name.Length+2);name.Buffer=text;
   namePointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));Marshal.StructureToPtr(name,namePointer,false);
   ObjectAttributes attributes=new ObjectAttributes();attributes.Length=Marshal.SizeOf(typeof(ObjectAttributes));
   attributes.RootDirectory=root.Handle.DangerousGetHandle();attributes.ObjectName=namePointer;attributes.Attributes=OBJ_CASE_INSENSITIVE;
   IoStatusBlock ioStatus;
   int status=NtCreateFile(out handle,FILE_READ_ATTRIBUTES|READ_CONTROL|WRITE_DAC,ref attributes,out ioStatus,IntPtr.Zero,0,
      FILE_SHARE_READ|FILE_SHARE_WRITE,FILE_OPEN,FILE_OPEN_REPARSE_POINT,IntPtr.Zero,0);
   if(status<0||handle==null||handle.IsInvalid)throw Fail("Device storage identity unavailable");
   Node node=new Node();node.Handle=handle;handle=null;node.Directory=false;
   try{
    Info info=ReadInfo(node);
    if((info.Attributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0)throw Fail("Reparse device storage rejected");
    if((info.Attributes&FILE_ATTRIBUTE_DIRECTORY)!=0||info.Links!=1)throw Fail("Unsafe device storage file");
    if(info.Volume!=entry.Volume||FileNumber(info)!=entry.FileId)throw Fail("Device storage identity unavailable");
    node.Identity=FileIdentity(info);node.EnumeratedFileId=entry.FileId;node.EnumeratedVolume=entry.Volume;
    return node;
   }catch{node.Dispose();throw;}
  }finally{
   if(handle!=null)handle.Dispose();
   if(namePointer!=IntPtr.Zero)Marshal.FreeHGlobal(namePointer);
   if(text!=IntPtr.Zero)Marshal.FreeHGlobal(text);
  }
 }
 static void ValidateRoot(Node root,string user,string admin,bool rootAdminInitialization){
  Info info=ReadInfo(root);
  if((info.Attributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0)throw Fail("Reparse device storage rejected");
  if((info.Attributes&FILE_ATTRIBUTE_DIRECTORY)==0||FileIdentity(info)!=root.Identity)throw Fail("Device storage identity unavailable");
  SecurityState state=ReadSecurity(root,user);
  if(state.Owner!=root.Owner)throw Fail("Device storage owner mismatch");
  if(state.Owner!=user&&!(rootAdminInitialization&&state.Owner==admin))throw Fail("Device storage owner mismatch");
  if(state.BroadExplicit)throw Fail("Device storage ACL is not private");
  root.NeedsRepair=root.NeedsRepair||!state.Protected||state.BroadInherited||rootAdminInitialization;
 }
 static void ValidateChild(Node child,string user,string admin){
  Info info=ReadInfo(child);
  if((info.Attributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0)throw Fail("Reparse device storage rejected");
  if((info.Attributes&FILE_ATTRIBUTE_DIRECTORY)!=0||info.Links!=1||
     info.Volume!=child.EnumeratedVolume||FileNumber(info)!=child.EnumeratedFileId)
   throw Fail("Unsafe device storage file");
  SecurityState state=ReadSecurity(child,user);child.Owner=state.Owner;
  if(state.Owner!=user&&state.Owner!=admin)throw Fail("Device storage owner mismatch");
  if(state.Owner==admin){if(state.HasBroad)throw Fail("Device storage owner mismatch");child.NeedsRepair=false;return;}
  if(state.BroadExplicit)throw Fail("Device storage ACL is not private");
  child.NeedsRepair=!state.Protected||state.BroadInherited;
 }
 static void ValidateRepairedRoot(Node root,string user){
  Info info=ReadInfo(root);
  if((info.Attributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0)throw Fail("Reparse device storage rejected");
  if((info.Attributes&FILE_ATTRIBUTE_DIRECTORY)==0||FileIdentity(info)!=root.Identity)throw Fail("Device storage identity unavailable");
  SecurityState state=ReadSecurity(root,user);
  if(state.Owner!=user)throw Fail("Device storage owner mismatch");
  if(!state.Protected||state.HasBroad)throw Fail("Device storage ACL is not private");
 }
 static void ApplyPrivateDacl(Node node,string user,bool setOwner){
  string flags=node.Directory?"OICI":"";
  string sddl="D:P(A;"+flags+";FA;;;"+user+")(A;"+flags+";FA;;;"+SYSTEM_SID+")";
  IntPtr descriptor=IntPtr.Zero,ownerSid=IntPtr.Zero,dacl=IntPtr.Zero;bool present,defaulted;
  try{
   uint size;if(!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl,1,out descriptor,out size)||!GetSecurityDescriptorDacl(descriptor,out present,out dacl,out defaulted)||!present||dacl==IntPtr.Zero)throw Fail("Device storage ACL is not private");
   uint info=DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION;
   if(setOwner){if(!ConvertStringSidToSid(user,out ownerSid)||ownerSid==IntPtr.Zero)throw Fail("Device storage owner mismatch");info|=OWNER_SECURITY_INFORMATION;}
   uint status=SetSecurityInfo(node.SecurityHandle,SE_FILE_OBJECT,info,ownerSid,IntPtr.Zero,dacl,IntPtr.Zero);
   if(status!=0)throw Fail(setOwner?"Device storage owner mismatch":"Device storage ACL is not private");
  }finally{if(ownerSid!=IntPtr.Zero)LocalFree(ownerSid);if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
 }
 public static string ValidateAndRepair(string path,bool initialize){
  string user,tokenOwner;CurrentSids(out user,out tokenOwner);string admin=ADMINISTRATORS_SID;
  bool rootAdminInitialization=false,changeRootOwner=false;List<Node> nodes=new List<Node>();Node identityRoot=null;Socket lease=null;
  try{
   identityRoot=OpenRootIdentity(path);Info identityInfo=ReadInfo(identityRoot);
   lease=AcquireStoreLease(identityRoot.Identity);
   Node root=OpenRoot(path);nodes.Add(root);
   Info rootInfo=ReadInfo(root);
   if(FileIdentity(rootInfo)!=identityRoot.Identity||rootInfo.Volume!=identityInfo.Volume)throw Fail("Device storage identity unavailable");
   identityRoot.Dispose();identityRoot=null;root.Owner=null;
   SecurityState rootSecurity=ReadSecurity(root,user);root.Owner=rootSecurity.Owner;
   EnsureLocalRoot(root);
   if(root.Owner!=user){
    if(initialize&&root.Owner==admin&&tokenOwner==admin){rootAdminInitialization=true;changeRootOwner=true;}
    else throw Fail("Device storage owner mismatch");
   }
   if(rootSecurity.BroadExplicit)throw Fail("Device storage ACL is not private");
   root.NeedsRepair=initialize||!rootSecurity.Protected||rootSecurity.BroadInherited||changeRootOwner;
   List<DirectoryEntry> entries=EnumerateChildren(root,rootInfo.Volume);
   for(int index=0;index<entries.Count;index++){
    DirectoryEntry entry=entries[index];
    if((entry.Attributes&FILE_ATTRIBUTE_REPARSE_POINT)!=0)throw Fail("Reparse device storage rejected");
    if((entry.Attributes&FILE_ATTRIBUTE_DIRECTORY)!=0)throw Fail("Unsafe device storage file");
    Node child=OpenChildRelative(root,entry);nodes.Add(child);ValidateChild(child,user,admin);
   }
   if(rootAdminInitialization&&entries.Count!=0)throw Fail("Device storage owner mismatch");
   EnsureLocalRoot(root);
   ValidateRoot(root,user,admin,rootAdminInitialization);
   for(int index=1;index<nodes.Count;index++)ValidateChild(nodes[index],user,admin);
   if(changeRootOwner)root.OwnerWriteHandle=OpenRootOwnerHandle(path,root,user,admin);
   if(changeRootOwner){
    Node ownerProbe=new Node();ownerProbe.Handle=root.OwnerWriteHandle;ownerProbe.Directory=true;
    SecurityState ownerState=ReadSecurity(ownerProbe,user);
    if(ownerState.Owner!=root.Owner||ownerState.BroadExplicit)throw Fail("Device storage owner mismatch");
   }
   // Root and child ACL changes are not one transaction. Preflight every child
   // before the first mutation, then harden the container before repairing
   // children. A later failure may leave a hardened root or some hardened
   // children; recovery never deletes entries or reads credential contents.
   if(root.NeedsRepair){ApplyPrivateDacl(root,user,changeRootOwner);if(changeRootOwner)root.Owner=user;}
   List<DirectoryEntry> afterRootRepair=EnumerateChildren(root,rootInfo.Volume);
   EnsureSameChildren(entries,afterRootRepair);
   for(int index=1;index<nodes.Count;index++)ValidateChild(nodes[index],user,admin);
   ValidateRepairedRoot(root,user);
   for(int index=1;index<nodes.Count;index++)if(nodes[index].NeedsRepair)ApplyPrivateDacl(nodes[index],user,false);
   Info finalInfo=ReadInfo(root);
   return FileIdentity(finalInfo);
  }finally{
   for(int index=nodes.Count-1;index>=0;index--)nodes[index].Dispose();
   if(identityRoot!=null)identityRoot.Dispose();
   if(lease!=null)lease.Dispose();
  }
 }

 [StructLayout(LayoutKind.Sequential)]struct Basic {public IntPtr Reserved1,Peb,Reserved2,Reserved3,Pid,Parent;}
 [DllImport("ntdll.dll")]static extern int NtQueryInformationProcess(IntPtr process,int kind,out Basic info,int size,out int returned);
 [DllImport("kernel32.dll")]static extern uint GetProcessId(IntPtr process);
 [DllImport("kernel32.dll")]static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")]static extern bool GetProcessTimes(IntPtr handle,out System.Runtime.InteropServices.ComTypes.FILETIME creation,out System.Runtime.InteropServices.ComTypes.FILETIME exit,out System.Runtime.InteropServices.ComTypes.FILETIME kernel,out System.Runtime.InteropServices.ComTypes.FILETIME user);
 static ulong Stamp(System.Runtime.InteropServices.ComTypes.FILETIME time){return ((ulong)(uint)time.dwHighDateTime<<32)|(uint)time.dwLowDateTime;}
 public static void WatchParent(int expected,IntPtr parent){
  var self=System.Diagnostics.Process.GetCurrentProcess();Basic info;int length;
  System.Runtime.InteropServices.ComTypes.FILETIME pc,pe,pk,pu,sc,se,sk,su;
  if(NtQueryInformationProcess(self.Handle,0,out info,Marshal.SizeOf(typeof(Basic)),out length)!=0||info.Parent.ToInt64()!=expected||GetProcessId(parent)!=(uint)expected||WaitForSingleObject(parent,0)!=258||!GetProcessTimes(parent,out pc,out pe,out pk,out pu)||!GetProcessTimes(self.Handle,out sc,out se,out sk,out su)||Stamp(pc)>Stamp(sc))throw new Exception("Guard parent identity unavailable");
  var watcher=new System.Threading.Thread(()=>{WaitForSingleObject(parent,0xffffffff);Environment.Exit(0);});watcher.IsBackground=true;watcher.Start();
 }
 public static string ReadLine(){var line=new System.Text.StringBuilder();for(;;){int value=Console.In.Read();if(value<0){if(line.Length==0)return null;throw new Exception("Guard protocol incomplete");}if(value==10)return line.ToString();if(line.Length>=131072)throw new Exception("Guard protocol limit");line.Append((char)value);}}
}
'@;

[MobileDeviceFileId]::WatchParent(__NODE_PARENT_PID__,$parent.Handle);
while($true){
 $line=[MobileDeviceFileId]::ReadLine();if($null -eq $line){break};
 $j=$line|ConvertFrom-Json;
 $keys=@($j.PSObject.Properties.Name);
 if($keys.Count -ne 3 -or @($keys|Where-Object{$_ -notin @('id','path','initialize')}).Count -ne 0 -or !($j.id -is [int] -or $j.id -is [long]) -or $j.id -lt 1 -or $j.id -gt 9007199254740991 -or !($j.path -is [string]) -or $j.path.Length -lt 1 -or $j.path.Length -gt 32767 -or !($j.initialize -is [bool])){throw 'Guard protocol invalid'};
 try {
$p=$j.path;
if($p.StartsWith('\\')){throw 'Network device storage is unsupported'};
$d=New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($p));
if($d.DriveType -eq [System.IO.DriveType]::Network){throw 'Network device storage is unsupported'};
$identity=[MobileDeviceFileId]::ValidateAndRepair($p,[bool]$j.initialize);
$response=@{id=[long]$j.id;identity=$identity};

 } catch {

$codes=@{'Network device storage is unsupported'='network_storage';'Reparse device storage rejected'='reparse_point';'Device storage owner mismatch'='owner_mismatch';'Device storage ACL is not private'='acl_not_private';'Unsafe device storage file'='unsafe_file';'Device storage identity unavailable'='identity_unavailable';'Device storage lock unavailable'='store_busy'};
 $failure=$_.Exception;$code=$null;while($failure -and !$code){$code=$codes[$failure.Message];$failure=$failure.InnerException};if(!$code){$code='validation_failed'};
 $response=@{id=[long]$j.id;error=$code};

 }
 [Console]::Out.WriteLine(($response|ConvertTo-Json -Compress));
}
$parent.Dispose();
} catch {[Console]::Error.Write('KCODER_MOBILE_STORAGE_ERROR:validation_failed');exit 1;}
`;

let worker;

const commandForParent = parentPid => {
  const compressed = gzipSync(Buffer.from(script.replaceAll('__NODE_PARENT_PID__', String(parentPid)), 'utf8')).toString('base64');
  const bootstrap = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$payload=[Convert]::FromBase64String('${compressed}');$memory=[IO.MemoryStream]::new($payload);$gzip=[IO.Compression.GZipStream]::new($memory,[IO.Compression.CompressionMode]::Decompress);$reader=[IO.StreamReader]::new($gzip,[Text.UTF8Encoding]::new($false));$source=$reader.ReadToEnd();$reader.Dispose();[ScriptBlock]::Create($source).Invoke()|Out-Null`;
  const encoded = Buffer.from(bootstrap, 'utf16le').toString('base64');
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
  const commandLineLength = executable.length + args.reduce((total, argument) => total + argument.length + 1, 0) + 2;
  if (commandLineLength >= 30_000) throw new RangeError('Windows storage guard command exceeds its launch budget');
  return { executable, args, commandLineLength };
};

export function windowsPrivateStorageCommandLineLength(parentPid = process.pid) {
  return commandForParent(parentPid).commandLineLength;
}

export function windowsPrivateDeviceStorage(path, initialize) {
  if (process.platform !== 'win32') return Promise.reject(Object.assign(
    new Error('Private Windows mobile device storage unavailable (powershell_unavailable)'),
    {code:'MOBILE_DEVICE_STORAGE_UNAVAILABLE',reason:'powershell_unavailable'}));
  if (!worker) {
    try {
      const { executable, args } = commandForParent(process.pid);
      worker = createWindowsStorageGuardClient(spawn(executable, args,
        {windowsHide:true,stdio:['pipe','pipe','pipe']}));
    } catch {
      return Promise.reject(Object.assign(new Error('Private Windows mobile device storage unavailable (execution_failed)'),
        {code:'MOBILE_DEVICE_STORAGE_UNAVAILABLE',reason:'execution_failed'}));
    }
    process.once('exit', () => worker.close());
  }
  return worker.check(path, initialize);
}
