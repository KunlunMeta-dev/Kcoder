param([switch]$CompileOnly)
$phase='bootstrap'
try {
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$phase='compile'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OwnedWpadDiscovery {
  [DllImport("winhttp.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool WinHttpDetectAutoProxyConfigUrl(uint flags, out IntPtr url);
  [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr memory);
  public static object Observe() {
    IntPtr pointer = IntPtr.Zero;
    const uint DHCP = 1, DNS_A = 2;
    bool success = WinHttpDetectAutoProxyConfigUrl(DHCP | DNS_A, out pointer);
    int code = success ? 0 : Marshal.GetLastWin32Error();
    string scheme = null, hostClass = null;
    try {
      if (success && pointer != IntPtr.Zero) {
        Uri uri;
        if (Uri.TryCreate(Marshal.PtrToStringUni(pointer), UriKind.Absolute, out uri)) {
          scheme = uri.Scheme == "http" || uri.Scheme == "https" || uri.Scheme == "file" ? uri.Scheme : "other";
          hostClass = String.IsNullOrEmpty(uri.Host) ? "none" : uri.IsLoopback ? "loopback" : uri.HostNameType == UriHostNameType.IPv4 || uri.HostNameType == UriHostNameType.IPv6 ? "ip-literal" : uri.Host.IndexOf('.') < 0 ? "single-label" : "qualified-host";
        } else { scheme = "invalid"; hostClass = "invalid"; }
      }
      return new { mode="wpad-discovery-only", discoverySucceeded=success,
        discovered=success && pointer != IntPtr.Zero, nativeCode=code,
        scheme=scheme, hostClass=hostClass, discoveryFlags=3,
        pacDownloaded=false, logicalQueries=0, modelCalls=0, registryWrites=0 };
    } finally { if(pointer != IntPtr.Zero) GlobalFree(pointer); }
  }
}
"@
if($CompileOnly){
  $policies=@{};foreach($scope in @('MachinePolicy','UserPolicy','Process','CurrentUser','LocalMachine')){$policies[$scope]=[string](Get-ExecutionPolicy -Scope $scope)}
  @{mode='wpad-compile-only';phase='compiled';compiled=$true;apiCallAttempted=$false;logicalQueries=0;modelCalls=0;pacDownloaded=$false;executionPolicies=$policies}|ConvertTo-Json -Compress
}else{
  $phase='native_discovery'
  $result=[OwnedWpadDiscovery]::Observe()|ConvertTo-Json -Compress|ConvertFrom-Json
  $result|Add-Member -NotePropertyName apiCallAttempted -NotePropertyValue $true
  $result|Add-Member -NotePropertyName phase -NotePropertyValue 'native_discovery'
  $result|ConvertTo-Json -Compress
}
}catch{
  $compilerCode=[regex]::Match([string]$_.Exception.Message,'CS[0-9]{4}').Value
  @{mode=$(if($CompileOnly){'wpad-compile-only'}else{'wpad-discovery-only'});wrapperSucceeded=$false;phase=$phase;errorType=$_.Exception.GetType().Name;hresult=$_.Exception.HResult;compilerCode=$compilerCode;apiCallAttempted=($phase -eq 'native_discovery');discoverySucceeded=$null;discovered=$null;nativeCode=$null;pacDownloaded=$false;logicalQueries=0;modelCalls=0}|ConvertTo-Json -Compress
  exit 1
}
