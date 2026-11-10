param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$request=Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$resultPath=[string]$request.resultPath
$installDiagnostics=@()
function Read-OwnedInstalledBuildIdentity {
    $install=Join-Path ([string]$request.runRoot) 'Installed Studio'
    $privateProfile=Join-Path ([string]$request.runRoot) $(if($request.action -eq 'officeUI'){'office-ui-profile\profile'}else{'installed-ui-profile\profile'})
    if(!(Test-Path -LiteralPath (Join-Path $privateProfile 'settings.json'))){throw 'Owned upgrade profile is required for the identity probe'}
    $env:KCODER_CONFIG_DIR=$privateProfile
    $buildIdentity=@{}
    # Doctor is read-only. Capture privately in memory; only the three whitelisted
    # fields below reach the result. Native stderr never enters PowerShell errors.
    $doctorStart=[Diagnostics.ProcessStartInfo]::new()
    $doctorStart.FileName=Join-Path $install 'resources\bin\kcoder.exe'
    $doctorStart.Arguments='doctor'
    $doctorStart.WorkingDirectory=[string]$request.runRoot
    $doctorStart.UseShellExecute=$false;$doctorStart.CreateNoWindow=$true
    $doctorStart.RedirectStandardOutput=$true;$doctorStart.RedirectStandardError=$true
    $doctor=[Diagnostics.Process]::new();$doctor.StartInfo=$doctorStart
    try {
      if(!$doctor.Start()){throw 'Installed CLI identity command could not start'}
      $doctorHandle=$doctor.Handle
      $doctorOutput=$doctor.StandardOutput.ReadToEndAsync()
      $doctorError=$doctor.StandardError.ReadToEndAsync()
      if(!$doctor.WaitForExit(60000)){& taskkill /PID $doctor.Id /T /F 2>$null|Out-Null;throw 'Installed CLI identity command timed out'}
      if($doctor.ExitCode -ne 0){throw 'Installed CLI identity command failed'}
      [void]$doctorError.GetAwaiter().GetResult()
      $doctorOutput.GetAwaiter().GetResult().Split("`n") | ForEach-Object {
        if($_ -match '^build commit:\s*([a-f0-9]{40})\s*$'){$buildIdentity.build_commit=$Matches[1].ToLowerInvariant()}
        elseif($_ -match '^build dirty:\s*(true|false)\s*$'){$buildIdentity.build_dirty=($Matches[1] -eq 'true')}
        elseif($_ -match '^executable sha256:\s*([a-f0-9]{64})\s*$'){$buildIdentity.executable_sha256=$Matches[1].ToLowerInvariant()}
      }
    } finally { $doctor.Dispose() }
    [IO.File]::WriteAllText((Join-Path ([string]$request.runRoot) 'windows-installed-build-identity.json'),($buildIdentity|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    if($buildIdentity.Count -ne 3){throw 'Installed CLI identity fields are missing'}
    if($buildIdentity.build_commit -cne [string]$request.expectedCommit){throw 'Installed CLI source commit mismatch'}
    if($buildIdentity.build_dirty -ne $false){throw 'Installed CLI was built from a dirty source tree'}
    if($buildIdentity.executable_sha256 -cne [string]$request.expectedCliSha256){throw 'Installed CLI self-reported file hash mismatch'}
    if((Get-FileHash -LiteralPath (Join-Path $install 'resources\bin\kcoder.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$request.expectedCliSha256){throw 'Installed CLI file bytes mismatch'}
    return $buildIdentity
}
function Read-OwnedNetworkFlags {
  if(!('OwnedWinHttpFlags' -as [type])){
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OwnedWinHttpFlags {
  [StructLayout(LayoutKind.Sequential)] private struct Config {
    [MarshalAs(UnmanagedType.Bool)] public bool AutoDetect;
    public IntPtr Pac, Proxy, Bypass;
  }
  [DllImport("winhttp.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool WinHttpGetIEProxyConfigForCurrentUser(out Config config);
  [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr memory);
  public static bool[] Observe() {
    Config config = new Config();
    bool success = WinHttpGetIEProxyConfigForCurrentUser(out config);
    try { return new bool[] { success, config.AutoDetect,
      config.Pac != IntPtr.Zero && !String.IsNullOrWhiteSpace(Marshal.PtrToStringUni(config.Pac)),
      config.Proxy != IntPtr.Zero && !String.IsNullOrWhiteSpace(Marshal.PtrToStringUni(config.Proxy)) }; }
    finally {
      if(config.Pac != IntPtr.Zero) GlobalFree(config.Pac);
      if(config.Proxy != IntPtr.Zero) GlobalFree(config.Proxy);
      if(config.Bypass != IntPtr.Zero) GlobalFree(config.Bypass);
    }
  }
}
"@
  }
  $flags=[OwnedWinHttpFlags]::Observe()
  return @{apiSucceeded=$flags[0];autoDetect=$flags[1];pacUrlConfigured=$flags[2];staticProxyConfigured=$flags[3];proxyEnvironmentPresent=[bool]($env:HTTPS_PROXY -or $env:HTTP_PROXY -or $env:ALL_PROXY);registryWrites=0}
}
function Get-FixtureDataDigest {
     $data=Join-Path ([string]$request.runRoot) 'installed-ui-profile'
     $hashes=@{}
     Get-ChildItem -LiteralPath $data -Recurse -File | Where-Object {$_.FullName -notmatch '\\(Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache)\\'} | ForEach-Object {$hashes[$_.FullName.Substring($data.Length)]=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
     return ($hashes.GetEnumerator()|Sort-Object Name|ForEach-Object {$_.Name+'='+$_.Value}) -join "`n"
   }

try {
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  if($identity.User.Value -ne $request.sid){throw 'Wrong installer account SID'}
  if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Installer test user must be unprivileged'}
  $ownedUserProfile=[Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$request.sid)).ProfileImagePath)
  if(([IO.Path]::GetFileName($ownedUserProfile)) -notlike ($request.username+'*')){throw 'Unexpected test user profile'}
  $env:USERPROFILE=$ownedUserProfile
  $env:APPDATA=Join-Path $ownedUserProfile 'AppData\Roaming'
  $env:LOCALAPPDATA=Join-Path $ownedUserProfile 'AppData\Local'
  $env:TEMP=Join-Path $env:LOCALAPPDATA 'Temp';$env:TMP=$env:TEMP
  [IO.Directory]::CreateDirectory($env:TEMP)|Out-Null
  $install=[IO.Path]::GetFullPath([string]$request.installDirectory)
  $root=[IO.Path]::GetFullPath([string]$request.runRoot).TrimEnd('\')+'\'
  if(!$install.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Installation escaped run directory'}
  if($request.action -eq 'profileDigest') {
    $label=[string]$request.uiLabel
    if($label -cnotin @('upgrade','uninstall') -or $request.verify -isnot [bool]){throw 'Invalid owned retention phase'}
    $marker=Get-Content -LiteralPath (Join-Path $request.runRoot '.owner.json') -Raw|ConvertFrom-Json
    if($marker.owner -cne [string]$request.owner -or $marker.username -cne [string]$request.username){throw 'Owned retention marker mismatch'}
    $private=Join-Path ([string]$request.runRoot) '.profile-retention-private'
    [IO.Directory]::CreateDirectory($private)|Out-Null
    if(([IO.File]::GetAttributes($private) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Owned retention directory changed'}
    $baseline=Join-Path $private ($label+'.txt')
    $digest=Get-FixtureDataDigest
    if($request.verify) {
      if(([IO.File]::GetAttributes($baseline) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Owned retention baseline changed'}
      if([IO.File]::ReadAllText($baseline) -cne $digest){throw 'Stopped fixture user data changed'}
    } else {
      $file=[IO.FileStream]::new($baseline,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try {$bytes=[Text.UTF8Encoding]::new($false).GetBytes($digest);$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
    }
    # Private auth-file values and hashes never enter public actor results.
    $value=@{ok=$true;action='profileDigest';sid=$identity.User.Value;isAdmin=$false;digestLabel=$label;recorded=(!$request.verify);unchanged=([bool]$request.verify)}
    [IO.File]::WriteAllText($resultPath,($value|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    exit 0
  }
  if($request.action -in @('officeUI','installedUI')) {
    if([string]$request.lifecycleModelUrl -notmatch '^http://127\.0\.0\.1:\d+/v1$'){throw 'Owned loopback model endpoint required'}
    $env:KCODER_E2E_LIFECYCLE_MODEL_URL=[string]$request.lifecycleModelUrl
    if($request.action -eq 'officeUI'){& (Join-Path $request.runRoot 'windows-office-process-probe.ps1') -OwnedRoot $request.runRoot}
    if($request.action -eq 'officeUI' -and (Get-FileHash -LiteralPath (Join-Path $install 'resources\bin\kcoder.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$request.expectedCliSha256){throw 'Office installed CLI does not match final frozen build'}
    $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=[string]$request.node
    $arguments='"'+(Join-Path $request.runRoot 'probe.cjs')+'" "'+(Join-Path $install 'resources\bin\kcoder.exe')+'" "'+$install+'" "'+$request.runRoot+'" "'+$request.runRoot+'" --direct-install'
    if($request.action -eq 'officeUI'){$arguments+=' --lifecycle-verify --lifecycle-current-features --office-native'}else{
     if([string]$request.uiLabel -notin @('seed','restored','restarted')){throw 'Invalid installed UI stage'}
     if($request.verify){$arguments+=' --lifecycle-verify'}
     if($request.currentFeatures){$arguments+=' --lifecycle-current-features'}
     if($request.smokeOnly){$arguments+=' --lifecycle-smoke'}
     if($request.directoryTrust){$arguments+=' --lifecycle-directory-trust'}
    }
    if($request.startupWindowExpected -and ($request.action -eq 'officeUI' -or $request.verify)){$arguments+=' --lifecycle-startup-window'}
    $start.Arguments=$arguments
    $start.WorkingDirectory=[string]$request.runRoot;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $probe=[Diagnostics.Process]::new();$probe.StartInfo=$start
    try{
     if(!$probe.Start()){throw 'Owned Office UI probe failed to start'}
     $held=$probe.Handle;$output=$probe.StandardOutput.ReadToEndAsync();$errorOutput=$probe.StandardError.ReadToEndAsync()
     if(!$probe.WaitForExit(330000)){& taskkill /PID $probe.Id /T /F 2>$null|Out-Null;throw 'Owned Office UI timeout'}
     $stdout=$output.GetAwaiter().GetResult();$stderr=$errorOutput.GetAwaiter().GetResult()
     $label=if($request.action -eq 'officeUI'){'office'}else{[string]$request.uiLabel}
     [IO.File]::WriteAllText((Join-Path $request.runRoot ($label+'-stdout.json')),$stdout,[Text.UTF8Encoding]::new($false))
     [IO.File]::WriteAllText((Join-Path $request.runRoot ($label+'-stderr.log')),$stderr,[Text.UTF8Encoding]::new($false))
     if($probe.ExitCode -ne 0){throw ('Owned UI failed '+$label+' code='+$probe.ExitCode)}
     $value=$stdout|ConvertFrom-Json
     if(!$value.result.passed -or !$value.cleaned){throw 'Owned Office UI incomplete'}
     $buildIdentity=if($request.expectedCommit -and ($request.action -eq 'installedUI' -or $request.action -eq 'officeUI')){Read-OwnedInstalledBuildIdentity}else{$null}
     @{ok=$true;action=$request.action;sid=$identity.User.Value;isAdmin=$false;probe=$value;buildIdentity=$buildIdentity}|ConvertTo-Json -Depth 18 -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
    }finally{$probe.Dispose()}
    exit 0
  }
  if($request.action -eq 'controlledPacPreflight' -or ($request.action -eq 'nativeBundledSearch' -and $request.nativeBundledControlled)){
    $preflight=$request.action -eq 'controlledPacPreflight'
    $probe=& (Join-Path $request.runRoot 'managed-pac-actor.ps1') -Request $request -PreflightOnly:$preflight
    @{ok=[bool]$probe.passed;action=$request.action;sid=$identity.User.Value;isAdmin=$false;probe=$probe;buildIdentity=$(if($preflight){$null}else{$probe.native.native.buildIdentity})}|ConvertTo-Json -Depth 30 -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit $(if($probe.passed){0}else{1})
  }
  if($request.action -in @('nativeWebSearch','nativeBundledSearch')) {
    if($request.nativeConsent -cne '1' -or $request.externalConsent -cne '1'){throw 'Native public web gates missing'}
    $ordinaryNetwork=Read-OwnedNetworkFlags
    if($request.action -eq 'nativeBundledSearch' -and (!$ordinaryNetwork.apiSucceeded -or !($ordinaryNetwork.autoDetect -or $ordinaryNetwork.pacUrlConfigured) -or $ordinaryNetwork.proxyEnvironmentPresent)) {
      @{ok=$false;action=$request.action;sid=$identity.User.Value;isAdmin=$false;scopePrerequisiteMissing=$true;ordinaryAccountNetwork=$ordinaryNetwork;error='System automatic proxy route prerequisite is absent; no bundled query dispatched'}|ConvertTo-Json -Depth 8 -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
      exit 1
    }
    $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=[string]$request.node
    $start.Arguments='"'+(Join-Path $request.runRoot 'windows-native-web-search.mjs')+'" "'+$RequestPath+'"'
    $start.WorkingDirectory=[string]$request.runRoot;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    $probe=[Diagnostics.Process]::new();$probe.StartInfo=$start
    try {
      if(!$probe.Start()){throw 'Native default web worker did not start'}
      $output=$probe.StandardOutput.ReadToEndAsync();$errorOutput=$probe.StandardError.ReadToEndAsync()
      if(!$probe.WaitForExit(210000)){& taskkill /PID $probe.Id /T /F 2>$null|Out-Null;throw 'Owned native web worker timed out'}
      $discardedError=$errorOutput.GetAwaiter().GetResult()
      $stdout=$output.GetAwaiter().GetResult()
      $value=if($stdout.Trim()){$stdout|ConvertFrom-Json}else{$null}
      if($probe.ExitCode -ne 0 -or !$value.passed){
        $safe=@{phase=$value.phase;errorType=$value.errorType;errorCode=$value.errorCode;errorMessage=$value.errorMessage;controlledProviderRequests=$value.controlledProviderRequests;controlledHttpRequests=$value.controlledHttpRequests;approvalCount=$value.approvalCount;nativeCalls=$value.nativeCalls;nativeEof=$value.nativeEof;publicDispatchKnown=$value.publicDispatchKnown;stderrBytes=[Text.Encoding]::UTF8.GetByteCount($discardedError);rawStderrPersisted=$false}
        @{ok=$false;action=$request.action;sid=$identity.User.Value;isAdmin=$false;diagnostic=$safe;ordinaryAccountNetwork=$ordinaryNetwork;error='Native worker returned a bounded diagnostic'}|ConvertTo-Json -Depth 8 -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
        exit 1
      }
      $value|Add-Member -NotePropertyName ordinaryAccountNetwork -NotePropertyValue $ordinaryNetwork
      if($request.action -eq 'nativeBundledSearch') {
        $deadline=[DateTime]::UtcNow.AddSeconds(5)
        do {
          $owned=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith(($install.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)})
          if(!$owned.Count){break}
          Start-Sleep -Milliseconds 100
        } while([DateTime]::UtcNow -lt $deadline)
        if($owned.Count){throw 'Bundled source left owned installed workers after native EOF'}
        $value|Add-Member -NotePropertyName nativeOwnedWorkersAbsent -NotePropertyValue $true
        $value|Add-Member -NotePropertyName parentRouteEvidence -NotePropertyValue @{requiredByObservedSystemFlags=$true;perUrlCounterObserved=$false}
      }
      if(!$value.passed){throw 'Native default web worker incomplete'}
      @{ok=$true;action=$request.action;sid=$identity.User.Value;isAdmin=$false;probe=$value;buildIdentity=$value.buildIdentity}|ConvertTo-Json -Depth 20 -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
    } finally {$probe.Dispose()}
    exit 0
  }
  if($request.action -eq 'nativeComponents') {
    if($request.zeroBusinessMode){
      $network=Read-OwnedNetworkFlags
      if(!$network.apiSucceeded -or !$network.autoDetect -or $network.pacUrlConfigured -or $network.staticProxyConfigured -or $network.proxyEnvironmentPresent){
        @{ok=$false;action='nativeComponents';sid=$identity.User.Value;isAdmin=$false;scopePrerequisiteMissing=$true;ordinaryAccountNetwork=$network;error='Ordinary diagnostic network flags differ; no diagnostic dispatched'}|ConvertTo-Json -Depth 8 -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
        exit 1
      }
      $probe=& (Join-Path $request.runRoot 'zero-business-actor.ps1') -Request $request
      $probe['ordinaryAccountNetwork']=$network
      @{ok=$true;action='nativeComponents';sid=$identity.User.Value;isAdmin=$false;probe=$probe}|ConvertTo-Json -Depth 24 -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
      exit 0
    }
    $probeScript=if($request.browserProfileNative){'browser-profile-probe.ps1'}else{'native-components-probe.ps1'}
    $probe=& (Join-Path $request.runRoot $probeScript) -RequestPath $RequestPath
    @{ok=$true;action='nativeComponents';sid=$identity.User.Value;probe=$probe}|ConvertTo-Json -Depth 16 -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 0
  }
  if($request.action -eq 'uninstallProbe') {
    $probe=& (Join-Path $request.runRoot 'uninstall-probe.ps1') -RequestPath $RequestPath
    @{ok=$true;action='uninstallProbe';sid=$identity.User.Value;probe=$probe}|ConvertTo-Json -Depth 14 -Compress|Set-Content -LiteralPath $resultPath -Encoding UTF8
    exit 0
  }
  if($request.action -eq 'install') {
    $actual=(Get-FileHash -LiteralPath $request.installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if($actual -ne $request.sha256){throw 'Installer transfer digest mismatch'}
    $child=Start-Process -FilePath $request.installer -ArgumentList @('/S','/currentuser',('/D='+$install)) -PassThru
    $installTimeoutSeconds=600
    $deadline=[DateTime]::UtcNow.AddSeconds($installTimeoutSeconds)
    $nextSample=[DateTime]::UtcNow
    while(!$child.WaitForExit(1000)) {
      if([DateTime]::UtcNow -ge $nextSample) {
        $owned=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | Select-Object Name,ProcessId,ParentProcessId,KernelModeTime,UserModeTime)
        $installDiagnostics+=@{elapsedSeconds=[int]($installTimeoutSeconds-($deadline-[DateTime]::UtcNow).TotalSeconds);processes=$owned;appExists=(Test-Path -LiteralPath (Join-Path $install 'kcoder-studio.exe'));shellHookPresent=(Test-Path -LiteralPath (Join-Path $install 'resources\shell\install-cli.ps1'))}
        $nextSample=[DateTime]::UtcNow.AddSeconds(10)
      }
      if([DateTime]::UtcNow -ge $deadline) {
        & taskkill /PID $child.Id /T /F | Out-Null
        throw 'Installer timed out'
      }
    }
    if($child.ExitCode -ne 0){throw ('Installer failed with code '+$child.ExitCode)}
    if(!(Test-Path -LiteralPath (Join-Path $install 'kcoder-studio.exe'))){throw 'Installer did not create the requested executable'}
  } elseif($request.action -eq 'uninstall') {
    $uninstaller=Get-ChildItem -LiteralPath $install -Filter '*Uninstall*.exe' | Select-Object -First 1
    if(!$uninstaller){throw 'Installed uninstaller not found'}
    $child=Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S','/currentuser') -PassThru
    if(!$child.WaitForExit(120000)){ & taskkill /PID $child.Id /T /F | Out-Null; throw 'Uninstaller timed out' }
    if($child.ExitCode -ne 0){throw ('Uninstaller failed with code '+$child.ExitCode)}
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    while((Test-Path -LiteralPath (Join-Path $install 'kcoder-studio.exe')) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
    if(Test-Path -LiteralPath (Join-Path $install 'kcoder-studio.exe')){throw 'Uninstaller left the application executable'}
  } elseif($request.action -ne 'inspect'){throw 'Unsupported installer action'}
  $marker=Join-Path $env:APPDATA 'kcoder-studio\installer-retention-fixture.txt'
  if($request.action -eq 'install') {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($marker))|Out-Null
    [IO.File]::WriteAllText($marker,[string]$request.owner)
  }
  $retained=(Test-Path -LiteralPath $marker) -and ((Get-Content -LiteralPath $marker -Raw) -eq $request.owner)
  $allStudioEntries=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {Get-ItemProperty -LiteralPath $_.PSPath} | Where-Object {$_.DisplayName -like '*KCoder*'} | Select-Object PSChildName,DisplayName,DisplayVersion,InstallLocation,UninstallString)
  $entries=@($allStudioEntries | Where-Object {
    ($_.InstallLocation -and ([IO.Path]::GetFullPath($_.InstallLocation.Trim('"')).TrimEnd('\') -eq $install.TrimEnd('\'))) -or
    ($_.UninstallString -and $_.UninstallString.TrimStart('"').StartsWith(($install.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase))
  })
  if($request.action -eq 'install' -and $entries.Count -ne 1){throw ('Expected one per-user uninstall registration: '+($allStudioEntries|ConvertTo-Json -Depth 4 -Compress))}
  if($request.action -eq 'uninstall') {
    $deadline=[DateTime]::UtcNow.AddSeconds(45)
    while($entries.Count -ne 0 -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 100
      $entries=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object {Get-ItemProperty -LiteralPath $_.PSPath} | Where-Object {$_.UninstallString -and $_.UninstallString.TrimStart('"').StartsWith(($install.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)})
    }
    if($entries.Count -ne 0){throw 'Uninstall registration survived'}
  }
  if($request.action -eq 'uninstall' -and !$retained){throw 'Uninstaller deleted retained application data'}
  $resources=@{}
  $installedCliVersion=$null
  if($request.action -eq 'install') {
    foreach($leaf in @('kcoder-studio.exe','resources\app.asar','resources\bin\kcoder.exe','resources\bin\kcoder-process-supervisor.exe','resources\gateway\dev-server.mjs','resources\renderer-dist\index.html')){
      $resource=Join-Path $install $leaf
      if(!(Test-Path -LiteralPath $resource)){throw 'Installed resource missing'}
      $resources[$leaf]=(Get-FileHash -LiteralPath $resource -Algorithm SHA256).Hash
    }
  }
  if($request.action -eq 'install') {
    $installedCliVersion=(& (Join-Path $install 'resources\bin\kcoder.exe') --version | Out-String).Trim()
    if($LASTEXITCODE -ne 0 -or $installedCliVersion -notmatch '^kcoder [0-9]'){throw 'Installed CLI version probe failed'}
  }

  $buildIdentity=$null
  if($request.action -eq 'install' -and $request.expectedCommit -and !$request.officeUpgradeOnly -and !$request.nativeWebSearch){$buildIdentity=Read-OwnedInstalledBuildIdentity}
  $result=@{ok=$true;buildIdentity=$buildIdentity;action=$request.action;installedResources=$resources;installedCliVersion=$installedCliVersion;sid=$identity.User.Value;profile=$ownedUserProfile;isAdmin=$false;registration=$entries;retainedData=$retained}
} catch {
  $result=@{ok=$false;action=$request.action;error=$_.Exception.Message;registrationEvidence=$allStudioEntries;diagnostics=$installDiagnostics}
}
[IO.File]::WriteAllText($resultPath,($result|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
if(!$result.ok){exit 1}
