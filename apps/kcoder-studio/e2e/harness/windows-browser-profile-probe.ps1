param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
$request=Get-Content -LiteralPath $RequestPath -Raw|ConvertFrom-Json
$root=[IO.Path]::GetFullPath([string]$request.runRoot)
$marker=Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json
if($marker.owner -ne $request.owner -or !$request.browserProfileNative){throw 'Browser probe ownership mismatch'}
$electronUi=[string]$request.browserProfileNativeMode -eq 'electron-ui'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -ne $request.sid -or ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Browser probe requires its ordinary owner'}
$artifactInputs=@(@('probe-cli.exe',$request.probeCliSha256),@('probe-supervisor.exe',$request.probeSupervisorSha256),@('chromium.zip',$request.chromiumArchiveSha256))
if($electronUi){$artifactInputs+=,@('desktop.zip',$request.desktopArchiveSha256)}
foreach($artifact in $artifactInputs){
 if([string]$artifact[1] -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath (Join-Path $root $artifact[0]) -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$artifact[1]){throw 'Browser probe input digest mismatch'}
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Expand-OwnedProbeArchive([string]$archiveName,[string]$destinationName,[long]$byteLimit,[int]$entryLimit){
$zip=[IO.Compression.ZipFile]::OpenRead((Join-Path $root $archiveName))
$destination=Join-Path $root $destinationName
if(Test-Path -LiteralPath $destination){throw 'Browser extraction collision'}
try{
 $total=[long]0;$count=0;$names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($entry in $zip.Entries){
  $name=$entry.FullName;$count++;$total+=$entry.Length
  if($count -gt $entryLimit -or $total -gt $byteLimit -or $name -match '(^/|\\|:|(^|/)\.\.(/|$))' -or !$names.Add($name) -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000){throw 'Unsafe Chromium archive'}
 }
}finally{$zip.Dispose()}
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $root $archiveName),$destination)
}
Expand-OwnedProbeArchive 'chromium.zip' 'chromium' 1073741824 20000
$destination=Join-Path $root 'chromium'
if($electronUi){Expand-OwnedProbeArchive 'desktop.zip' 'desktop' 6442450944 60000}
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=Join-Path $root 'probe-cli.exe'
$stdioCrash=[string]$request.browserProfileNativeMode -eq 'stdio-crash'
if([string]$request.browserProfileNativeMode -notin @('native','stdio-crash','electron-ui')){throw 'Invalid ordinary browser mode'}
$exact='app_server::browser::profile_binding::tests::actual_chromium_profiles_keep_cookie_identity_exclusive_reconcile_start_and_release_owned_tree'
$start.Arguments='--ignored --exact '+$exact+' --test-threads=1 --nocapture'
if($stdioCrash){$start.FileName=[string]$request.node;$start.Arguments='"'+(Join-Path $root 'windows-browser-profile-crash.mjs')+'" "'+$root+'"'}
if($electronUi){
 $desktop=Join-Path $root 'desktop';$native=Join-Path $desktop 'resources\bin\kcoder.exe'
 if((Get-FileHash -LiteralPath $native -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$request.probeCliSha256){throw 'Packaged Electron Native bytes mismatch'}
 $start.FileName=[string]$request.node;$start.Arguments='"'+(Join-Path $root 'probe.cjs')+'" "'+$native+'" "'+$desktop+'" "'+$root+'" "'+$root+'" --direct-install --browser-profile-ui'
}
$start.WorkingDirectory=$root;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
$start.EnvironmentVariables.Clear()
foreach($name in @('SystemRoot','WINDIR','PATH','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP')){if([Environment]::GetEnvironmentVariable($name)){$start.EnvironmentVariables[$name]=[Environment]::GetEnvironmentVariable($name)}}
$start.EnvironmentVariables['HOME']=$env:USERPROFILE
if($electronUi){$start.EnvironmentVariables['KCODER_E2E_LIFECYCLE_MODEL_URL']=[string]$request.lifecycleModelUrl}
$start.EnvironmentVariables['KCODER_TEST_BROWSER_DEFAULT_PROFILE']='1'
$start.EnvironmentVariables['KCODER_CHROMIUM_BIN']=Join-Path $destination 'chrome-win64\chrome.exe'
$start.EnvironmentVariables['KCODER_PROCESS_SUPERVISOR_BIN']=Join-Path $root 'probe-supervisor.exe'
$probe=[Diagnostics.Process]::new();$probe.StartInfo=$start
try{
 if(!$probe.Start()){throw 'Browser native test could not start'}
 $held=$probe.Handle;$stdout=$probe.StandardOutput.ReadToEndAsync();$stderr=$probe.StandardError.ReadToEndAsync()
 if(!$probe.WaitForExit(90000)){$probe.Kill();$probe.WaitForExit();throw 'Browser native test deadline'}
 $output=$stdout.GetAwaiter().GetResult();$errorText=$stderr.GetAwaiter().GetResult()
 if($output.Length+$errorText.Length -gt 524288){throw 'Browser native test output limit'}
 $diagnostic=$errorText
 $diagnosticPath=Join-Path $root 'native-components-last-stderr.log'
 if($stdioCrash -and (Test-Path -LiteralPath $diagnosticPath)){$diagnostic=[IO.File]::ReadAllText($diagnosticPath)+"`nnode-owner:`n"+$errorText}
 $diagnostic=$diagnostic.Substring([Math]::Max(0,$diagnostic.Length-24576))
 [IO.File]::WriteAllText($diagnosticPath,$diagnostic,[Text.UTF8Encoding]::new($false))
 if($electronUi){
  if($probe.ExitCode -ne 0){throw ('Packaged Electron browser UI failed: '+$output.Substring([Math]::Max(0,$output.Length-4096))+' '+$errorText.Substring([Math]::Max(0,$errorText.Length-2048)))}
  $actual=$output|ConvertFrom-Json
  if($actual.result.passed -ne $true -or $actual.cleaned -ne $true){throw 'Packaged Electron browser UI incomplete'}
  return @{passed=$true;verificationScope='ordinary_windows_actual_electron_browser_profiles';sid=$identity.User.Value;isAdmin=$false;sourceTreeSha256=$request.sourceTreeSha256;binarySha256=$request.probeCliSha256;desktopArchiveSha256=$request.desktopArchiveSha256;nativeObservation=$actual.result}
 }
 if($stdioCrash){
  if($probe.ExitCode -ne 0){throw ('Browser stdio crash consumer failed: '+$errorText.Substring([Math]::Max(0,$errorText.Length-4096)))}
  $actual=$output|ConvertFrom-Json
  if($actual.passed -ne $true -or $actual.actualAppServerHardCrash -ne $true -or $actual.originalReceiptConfirmed -ne $true -or $actual.originalLaunchReplayRejected -ne $true -or $actual.modelCalls -ne 0){throw 'Browser stdio crash consumer incomplete'}
  return @{passed=$true;verificationScope='ordinary_windows_actual_browser_profile_stdio_crash';sid=$identity.User.Value;isAdmin=$false;sourceTreeSha256=$request.sourceTreeSha256;binarySha256=$request.probeCliSha256;supervisorSha256=$request.probeSupervisorSha256;chromiumArchiveSha256=$request.chromiumArchiveSha256;nativeObservation=$actual}
 }
 if($probe.ExitCode -ne 0 -or $output -notmatch 'test result: ok\. 1 passed; 0 failed; 0 ignored;'){
  throw ('Browser native test failed: '+$output.Substring([Math]::Max(0,$output.Length-4096)))
 }
 $metadataLine=@($output.Split("`n")|Where-Object{$_ -match '\{"actualNativeBrowserProfileFixture":'})
 if($metadataLine.Count -ne 1){throw 'Actual native profile observation missing'}
 $metadata=($metadataLine[0].Substring($metadataLine[0].IndexOf('{'))|ConvertFrom-Json).actualNativeBrowserProfileFixture
 if($metadata.defaultProductionProfile -ne $true -or $metadata.chromiumDefaultKeyPolicy -ne $true -or $metadata.passwordStoreOverride -ne $false -or $metadata.modelCalls -ne 0){throw 'Native profile did not observe the required production boundary'}
 @{passed=$true;verificationScope='ordinary_windows_actual_chromium_native_profile_consumer';sid=$identity.User.Value;isAdmin=$false;exactTest=$exact;summary=@{passed=1;failed=0;ignored=0};sourceTreeSha256=$request.sourceTreeSha256;binarySha256=$request.probeCliSha256;supervisorSha256=$request.probeSupervisorSha256;chromiumArchiveSha256=$request.chromiumArchiveSha256;modelCalls=0;studioUi=$false;appServerCrash=$false;nativeObservation=$metadata}
}finally{$probe.Dispose()}
