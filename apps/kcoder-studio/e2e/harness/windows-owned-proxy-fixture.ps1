# Definitions only: importing this file never changes connection settings.
# https://learn.microsoft.com/windows/win32/api/wininet/ns-wininet-internet_per_conn_optionw
function Assert-OwnedProxyFixtureScope($Request) {
  if($Request.nativeBundledControlled -ne $true -or $Request.controlledPacConsent -cne '1'){throw 'Controlled own-SID proxy mutation requires its explicit fixture gate'}
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  $currentSid=$identity.User.Value
  if($currentSid -cne [string]$Request.sid -or $Request.username -notmatch '^kc_e2e_[a-f0-9]{8}$' -or $identity.Name.Split('\')[-1] -cne [string]$Request.username){throw 'Controlled proxy requires the exact ordinary request SID'}
  if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Controlled proxy actor must be unprivileged'}
  $marker=Get-Content -LiteralPath (Join-Path $Request.runRoot '.owner.json') -Raw|ConvertFrom-Json
  if($marker.owner -cne [string]$Request.owner -or $marker.username -cne [string]$Request.username -or !$marker.creatorSid -or $marker.creatorSid -ceq $currentSid){throw 'Controlled proxy owner/creator separation failed'}
  $account=Get-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($currentSid)) -ErrorAction Stop
  if($account.Description -cne ('KCoderE2E '+[string]$Request.owner)){throw 'Controlled proxy account nonce mismatch'}
  foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)){
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,$view)
    try{
      foreach($path in @('SOFTWARE\Policies\Microsoft\Windows\CurrentVersion\Internet Settings','SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings')){
        $key=$base.OpenSubKey($path,$false)
        try{if($key -and $null -ne $key.GetValue('ProxySettingsPerUser',$null) -and [int]$key.GetValue('ProxySettingsPerUser') -eq 0){throw 'Machine-wide proxy policy forbids this controlled fixture'}}finally{if($key){$key.Dispose()}}
      }
    }finally{$base.Dispose()}
  }
  return @{requestSidMatches=$true;ordinaryActor=$true;creatorSidDifferent=$true;nonceMatches=$true;machinePolicyChecked32And64=$true;machineProxySettingsForced=$false}
}

function Initialize-OwnedProxyFixtureType {
  if('OwnedPerUserProxyLease' -as [type]){return}
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public sealed class OwnedPerUserProxyLease {
  [StructLayout(LayoutKind.Explicit)] private struct Value {
    [FieldOffset(0)] public uint Number;
    [FieldOffset(0)] public IntPtr Text;
    [FieldOffset(0)] public long Time;
  }
  [StructLayout(LayoutKind.Sequential)] private struct Option { public uint Kind; public Value Data; }
  [StructLayout(LayoutKind.Sequential)] private struct List {
    public uint Size; public IntPtr Connection; public uint Count; public uint Error; public IntPtr Options;
  }
  private sealed class Snapshot {
    public uint Flags; public string Proxy, Bypass, Pac;
    public int Difference(Snapshot other) {
      return (Flags==other.Flags?0:1)+(Proxy==other.Proxy?0:1)+(Bypass==other.Bypass?0:1)+(Pac==other.Pac?0:1);
    }
  }
  [DllImport("wininet.dll", EntryPoint="InternetQueryOptionW", SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)] private static extern bool Query(IntPtr internet,uint option,ref List list,ref uint size);
  [DllImport("wininet.dll", EntryPoint="InternetSetOptionW", SetLastError=true)]
  [return:MarshalAs(UnmanagedType.Bool)] private static extern bool Set(IntPtr internet,uint option,ref List list,uint size);
  [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr value);
  private readonly Snapshot before;
  private int writeCalls,successfulCalls,duringDifference;
  private bool restored;
  private OwnedPerUserProxyLease(Snapshot value) { before=value; }
  private static IntPtr At(IntPtr start,int index) { return IntPtr.Add(start,index*Marshal.SizeOf(typeof(Option))); }
  private static Snapshot Read() {
    IntPtr memory=Marshal.AllocHGlobal(4*Marshal.SizeOf(typeof(Option)));
    int initialized=0;
    try {
      // Windows7+ requires FLAGS_UI for capture, FLAGS for restoration.
      for(int i=0;i<4;i++){
        Marshal.StructureToPtr(new Option { Kind=i==0?10u:(uint)(i+1),Data=new Value() },At(memory,i),false);
        initialized++;
      }
      List list=new List { Size=(uint)Marshal.SizeOf(typeof(List)),Count=4,Options=memory };
      uint size=list.Size;
      if(!Query(IntPtr.Zero,75,ref list,ref size))throw new InvalidOperationException("Per-user proxy query failed code="+Marshal.GetLastWin32Error());
      Option flags=(Option)Marshal.PtrToStructure(At(memory,0),typeof(Option));
      string[] text=new string[3];
      for(int i=1;i<4;i++){
        Option option=(Option)Marshal.PtrToStructure(At(memory,i),typeof(Option));
        text[i-1]=option.Data.Text==IntPtr.Zero?null:Marshal.PtrToStringUni(option.Data.Text);
        if(String.IsNullOrEmpty(text[i-1]))text[i-1]=null;
      }
      return new Snapshot { Flags=flags.Data.Number,Proxy=text[0],Bypass=text[1],Pac=text[2] };
    } finally {
      for(int i=1;i<initialized;i++){
        Option option=(Option)Marshal.PtrToStructure(At(memory,i),typeof(Option));
        if(option.Data.Text!=IntPtr.Zero)GlobalFree(option.Data.Text);
      }
      Marshal.FreeHGlobal(memory);
    }
  }
  private void Write(Snapshot value) {
    IntPtr memory=Marshal.AllocHGlobal(4*Marshal.SizeOf(typeof(Option)));
    IntPtr[] text=new IntPtr[3];
    try {
      string[] values={value.Proxy,value.Bypass,value.Pac};
      for(int i=0;i<3;i++)text[i]=values[i]==null?IntPtr.Zero:Marshal.StringToHGlobalUni(values[i]);
      Marshal.StructureToPtr(new Option { Kind=1,Data=new Value { Number=value.Flags } },At(memory,0),false);
      for(int i=1;i<4;i++)Marshal.StructureToPtr(new Option { Kind=(uint)(i+1),Data=new Value { Text=text[i-1] } },At(memory,i),false);
      List list=new List { Size=(uint)Marshal.SizeOf(typeof(List)),Count=4,Options=memory };
      writeCalls++;
      if(!Set(IntPtr.Zero,75,ref list,list.Size))throw new InvalidOperationException("Per-user proxy write failed code="+Marshal.GetLastWin32Error());
      successfulCalls++;
    } finally {
      foreach(IntPtr valuePointer in text)if(valuePointer!=IntPtr.Zero)Marshal.FreeHGlobal(valuePointer);
      Marshal.FreeHGlobal(memory);
    }
  }
  public static OwnedPerUserProxyLease Capture() { return new OwnedPerUserProxyLease(Read()); }
  public void ApplyFixture(string pac) {
    Snapshot target=new Snapshot { Flags=5,Proxy=null,Bypass=null,Pac=pac };
    Write(target);
    Snapshot actual=Read();
    if(actual.Difference(target)!=0)throw new InvalidOperationException("Controlled per-user proxy readback differs");
    duringDifference=before.Difference(actual);
  }
  public void Restore() {
    if(writeCalls==0){restored=true;return;}
    Write(before);
    restored=Read().Difference(before)==0;
    if(!restored)throw new InvalidOperationException("Original per-user proxy settings did not restore");
  }
  public object SafeReceipt() {
    return new { ownSidHkcuWriteCalls=writeCalls,ownSidHkcuSuccessfulSetCalls=successfulCalls,
      writeCountUnit="InternetSetOption per-connection transactions",writeScope="owned proxy fixture settings",duringValueDifference=duringDifference,afterRestoreValueDifference=restored?(int?)0:null,
      originalPerConnectionReadbackEqual=restored,machineRegistryWrites=0,personalRegistryWrites=0,
      certificateStoreWrites=0,globalCacheResetCalls=0 };
  }
}
"@
}

function Start-OwnedProxyFixture($Request,[string]$PacUrl) {
  $scope=Assert-OwnedProxyFixtureScope $Request
  try{$uri=[Uri]$PacUrl}catch{throw 'Controlled PAC URI is invalid'}
  if(!$uri.IsAbsoluteUri -or $uri.Scheme -cne 'http' -or $uri.Host -cne '127.0.0.1' -or $uri.Port -le 0 -or $uri.UserInfo -or $uri.Fragment){throw 'Controlled PAC must be the owned loopback HTTP fixture'}
  Initialize-OwnedProxyFixtureType
  $lease=[OwnedPerUserProxyLease]::Capture()
  $script:OwnedProxyFixtureLastReceipt=$lease.SafeReceipt()
  try{$lease.ApplyFixture($PacUrl)}catch{try{Assert-OwnedProxyFixtureScope $Request|Out-Null;$lease.Restore()}finally{$script:OwnedProxyFixtureLastReceipt=$lease.SafeReceipt()};throw}
  $script:OwnedProxyFixtureLastReceipt=$lease.SafeReceipt()
  return @{lease=$lease;scope=$scope}
}

function Stop-OwnedProxyFixture($Request,$Context) {
  Assert-OwnedProxyFixtureScope $Request|Out-Null
  try{$Context.lease.Restore()}finally{$script:OwnedProxyFixtureLastReceipt=$Context.lease.SafeReceipt()}
  return @{scope=$Context.scope;settings=$Context.lease.SafeReceipt()}
}

function Get-OwnedProxyFixtureWriteReceipt { return $script:OwnedProxyFixtureLastReceipt }
