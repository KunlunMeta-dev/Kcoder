param([switch]$CompileOnly)

# The caller must own this process in its native Job with a 25s + 4s deadline.
# This synchronous diagnostic is never a production cancellation mechanism.
$phase = 'bootstrap'
$apiCallAttempted = $false
try {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    if ($args.Count -ne 0) { throw [ArgumentException]::new('Unsupported diagnostic arguments') }
    $phase = 'compile'
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class OwnedWinHttpInprocess {
    [StructLayout(LayoutKind.Sequential)]
    private struct AutoProxyOptions {
        public uint flags, detectFlags;
        public IntPtr configUrl, reserved;
        public uint reservedValue;
        public int autoLogonIfChallenged;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProxyInfo {
        public uint accessType;
        public IntPtr proxy, bypass;
    }
    public sealed class Observation {
        public string phase = "session_open";
        public bool nativeResolutionAttempted, resolutionSucceeded;
        public uint nativeCode;
        public string routeClass = "None";
        public long resolutionElapsedMs;
        public bool sessionClosed, allocationCleanupObserved;
    }
    [DllImport("winhttp.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    private static extern IntPtr WinHttpOpen(string agent, uint accessType, IntPtr proxy, IntPtr bypass, uint flags);
    [DllImport("winhttp.dll", ExactSpelling=true, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinHttpSetTimeouts(IntPtr session, int resolve, int connect, int send, int receive);
    [DllImport("winhttp.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinHttpGetProxyForUrl(IntPtr session, string url, ref AutoProxyOptions options, ref ProxyInfo info);
    [DllImport("winhttp.dll", ExactSpelling=true, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinHttpCloseHandle(IntPtr session);
    [DllImport("kernel32.dll", ExactSpelling=true)]
    private static extern IntPtr GlobalFree(IntPtr pointer);

    public static Observation Observe() {
        const uint NO_PROXY = 1, NAMED_PROXY = 3;
        const uint AUTO_DETECT = 1, RUN_INPROCESS = 0x00010000;
        const uint NO_CACHE_CLIENT = 0x00080000, NO_CACHE_SVC = 0x00100000;
        const uint DHCP = 1, DNS_A = 2;
        Observation result = new Observation();
        ProxyInfo info = new ProxyInfo();
        IntPtr session = IntPtr.Zero;
        bool allocationsReleased = true;
        try {
            // A synchronous session is required for this in-process contrast.
            session = WinHttpOpen("KCoder owned in-process diagnostic", NO_PROXY, IntPtr.Zero, IntPtr.Zero, 0);
            if (session == IntPtr.Zero) {
                result.nativeCode = unchecked((uint)Marshal.GetLastWin32Error());
                return result;
            }
            result.phase = "session_timeouts";
            if (!WinHttpSetTimeouts(session, 10000, 10000, 10000, 10000)) {
                result.nativeCode = unchecked((uint)Marshal.GetLastWin32Error());
                return result;
            }
            AutoProxyOptions options = new AutoProxyOptions();
            options.flags = AUTO_DETECT | RUN_INPROCESS | NO_CACHE_CLIENT | NO_CACHE_SVC;
            options.detectFlags = DHCP | DNS_A;
            options.autoLogonIfChallenged = 0;
            result.phase = "native_resolution";
            result.nativeResolutionAttempted = true;
            Stopwatch clock = Stopwatch.StartNew();
            bool success = WinHttpGetProxyForUrl(session, "https://mcp.exa.ai/mcp", ref options, ref info);
            uint code = success ? 0 : unchecked((uint)Marshal.GetLastWin32Error());
            clock.Stop();
            result.resolutionSucceeded = success;
            result.nativeCode = code;
            result.resolutionElapsedMs = clock.ElapsedMilliseconds;
            if (success) {
                result.routeClass = info.accessType == NO_PROXY ? "Direct"
                    : info.accessType == NAMED_PROXY && info.proxy != IntPtr.Zero ? "Proxy" : "Other";
            }
            return result;
        } finally {
            // Never read or serialize the native PAC/proxy/bypass strings.
            try {
                if (info.proxy != IntPtr.Zero) allocationsReleased &= GlobalFree(info.proxy) == IntPtr.Zero;
            } finally {
                try {
                    if (info.bypass != IntPtr.Zero) allocationsReleased &= GlobalFree(info.bypass) == IntPtr.Zero;
                } finally {
                    result.allocationCleanupObserved = allocationsReleased;
                    result.sessionClosed = session == IntPtr.Zero || WinHttpCloseHandle(session);
                }
            }
        }
    }
}
'@
    if ($CompileOnly) {
        @{mode='winhttp-inprocess-compile';wrapperSucceeded=$true;compiled=$true;
          apiCallAttempted=$false;nativeResolutionAttempted=$false;
          resolutionSucceeded=$null;nativeCode=$null;routeClass='None';
          requestedRunInProcess=$true;mayDownloadAndEvaluatePac=$false;
          destinationHttpSent=$false;logicalQueries=0;modelCalls=0;registryWrites=0} | ConvertTo-Json -Compress
    } else {
        $phase = 'consent'
        if ($env:KCODER_E2E_WINDOWS_NATIVE_LIBTEST -ne '1' -or $env:KCODER_E2E_WEB_EXTERNAL_NETWORK -ne '1') {
            throw [InvalidOperationException]::new('Explicit native and external diagnostic gates are required')
        }
        $phase = 'native_resolution'
        $apiCallAttempted = $true
        $result = [OwnedWinHttpInprocess]::Observe()
        @{mode='winhttp-inprocess-resolve';wrapperSucceeded=$true;compiled=$true;
          phase=$result.phase;apiCallAttempted=$true;nativeResolutionAttempted=$result.nativeResolutionAttempted;
          resolutionSucceeded=$result.resolutionSucceeded;nativeCode=$result.nativeCode;routeClass=$result.routeClass;
          resolutionElapsedMs=$result.resolutionElapsedMs;sessionClosed=$result.sessionClosed;
          allocationCleanupObserved=$result.allocationCleanupObserved;
          requestedRunInProcess=$true;mayDownloadAndEvaluatePac=$true;
          destinationHttpSent=$false;logicalQueries=0;modelCalls=0;registryWrites=0} | ConvertTo-Json -Compress
    }
} catch {
    $errorType = $_.Exception.GetType().Name
    if ($errorType -notmatch '^[A-Za-z][A-Za-z0-9_]*$') { $errorType = 'Exception' }
    @{mode=$(if($CompileOnly){'winhttp-inprocess-compile'}else{'winhttp-inprocess-resolve'});
      wrapperSucceeded=$false;phase=$phase;errorType=$errorType;apiCallAttempted=$apiCallAttempted;
      nativeResolutionAttempted=$null;resolutionSucceeded=$null;nativeCode=$null;routeClass='None';
      requestedRunInProcess=$true;mayDownloadAndEvaluatePac=$apiCallAttempted;
      destinationHttpSent=$false;logicalQueries=0;modelCalls=0;registryWrites=0} | ConvertTo-Json -Compress
    exit 1
}
