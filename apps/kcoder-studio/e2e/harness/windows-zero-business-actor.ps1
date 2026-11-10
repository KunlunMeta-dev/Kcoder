param([Parameter(Mandatory=$true)]$Request)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($Request.nativeConsent -cne '1' -or $Request.externalConsent -cne '1'){throw 'Zero-business diagnostic gates missing'}
if($Request.zeroBusinessMode -cnotin @('exa-head','exa-handshake','searx-startup','wpad-detect','wpad-compile','winhttp-inprocess-compile','winhttp-inprocess-resolve')){throw 'Unsupported diagnostic mode'}
$root=[string]$Request.runRoot
if((Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json).owner -cne [string]$Request.owner){throw 'Diagnostic owner mismatch'}
if($Request.zeroBusinessMode -eq 'exa-head'){
  $clock=[Diagnostics.Stopwatch]::StartNew();$dns=@{completed=$false;addressCount=0;v4Count=0;v6Count=0}
  try {
    $task=[Net.Dns]::GetHostAddressesAsync('mcp.exa.ai')
    if(!$task.Wait(10000)){throw 'DNS observation deadline'}
    $addresses=@($task.GetAwaiter().GetResult());$dns.completed=$true;$dns.addressCount=$addresses.Count
    $dns.v4Count=@($addresses|Where-Object AddressFamily -eq InterNetwork).Count
    $dns.v6Count=@($addresses|Where-Object AddressFamily -eq InterNetworkV6).Count
  }catch{$dns.errorType=$_.Exception.GetType().Name}
  Add-Type -AssemblyName System.Net.Http
  $controls=@()
  foreach($endpoint in @(@{name='exa';uri='https://mcp.exa.ai/mcp'},@{name='bing-no-query';uri='https://www.bing.com/search'})){
    $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false;$handler.UseDefaultCredentials=$false
    $client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromSeconds(20)
    $message=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Head,[Uri]$endpoint.uri)
    $http=@{endpoint=$endpoint.name;method='HEAD';attempts=1;responseReceived=$false;httpStatus=$null;normalCertificateValidation=$true;defaultProxyHandler=$true;addressPinning=$false;bodyRead=$false;credentialsConfigured=$false;locationPresent=$false;locationHostClass='none'}
    try{
      $response=$client.SendAsync($message,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult();$http.responseReceived=$true;$http.httpStatus=[int]$response.StatusCode
      if($response.Headers.Location){$location=$response.Headers.Location;$http.locationPresent=$true;$http.locationHostClass=if(!$location.IsAbsoluteUri){'relative'}elseif($location.Host -in @('mcp.exa.ai','www.bing.com','bing.com')){'same-service'}elseif($location.Scheme -ne 'https'){'non-https'}else{'other-host'}}
      $response.Dispose()
    }catch{
      $chain=@();$errorObject=$_.Exception
      for($i=0;$i -lt 5 -and $errorObject;$i++){$chain+=@{type=$errorObject.GetType().Name;hresult=$errorObject.HResult};$errorObject=$errorObject.InnerException}
      $http.errorChain=$chain
    }finally{$message.Dispose();$client.Dispose();$handler.Dispose()}
    $controls+=,$http
  }
  return @{zeroBusinessObservation=$true;mode='endpoint-head-controls';logicalQueries=0;modelCalls=0;dns=$dns;controls=$controls;elapsedMs=$clock.ElapsedMilliseconds;registryWrites=0;proxySettingsChanged=$false;certificatePolicyChanged=$false;originalSearchCauseAttribution=$false}

}
foreach($entry in @(@{leaf='tests.exe';sha=[string]$Request.probeCliSha256},@{leaf='supervisor.exe';sha=[string]$Request.probeSupervisorSha256})){
  if((Get-FileHash -LiteralPath (Join-Path $root $entry.leaf) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha){throw 'Diagnostic executable bytes changed'}
}
$profileOwner=Join-Path $root 'diagnostic-profile-owner';$privateProfile=Join-Path $profileOwner 'state'
if(Test-Path -LiteralPath $profileOwner){throw 'Diagnostic profile collision'}
[IO.Directory]::CreateDirectory($privateProfile)|Out-Null
$secured=& (Join-Path $root 'private-state-directory.ps1') -StateDirectory $privateProfile -RunRoot $profileOwner|ConvertFrom-Json
$aclEvidence=@{ownerMatchesCurrentSid=($secured.ownerSid -ceq $secured.currentSid);protected=$secured.protected;aceCount=$secured.aceCount;inheritableFullControl=$secured.inheritableFullControl}
$startup=$Request.zeroBusinessMode -eq 'searx-startup'
$name='searxng_runtime::startup_probe::owned_startup_only_reports_ready_and_cleanup'
$descriptor=@{root=$root;owner=$Request.owner;testSha256=$Request.probeCliSha256;supervisorSha256=$Request.probeSupervisorSha256;sourceTreeSha256=$Request.sourceTreeSha256;probeKind=$(if($startup){'libtest'}elseif($Request.zeroBusinessMode -in @('wpad-detect','wpad-compile')){'web-wpad-discovery'}elseif($Request.zeroBusinessMode.StartsWith('winhttp-inprocess-')){'web-winhttp-inprocess'}else{'web-exa-handshake'});expectedTests=@($(if($startup){$name}elseif($Request.zeroBusinessMode -in @('wpad-detect','wpad-compile')){'wpad_discovery_only'}elseif($Request.zeroBusinessMode.StartsWith('winhttp-inprocess-')){'fixed_inprocess_metadata_only'}else{'fixed_exa_handshake_only'}))}
if($Request.zeroBusinessMode.StartsWith('winhttp-inprocess-')){$descriptor.helperSha256='e52d8e078bb50517671586b5e37f50fc1d02e333b92dafa014be581c7634ed3c'}
if($Request.zeroBusinessMode -eq 'winhttp-inprocess-compile'){$descriptor.inProcessCompileOnly=$true}
if($Request.zeroBusinessMode -eq 'wpad-compile'){$descriptor.wpadCompileOnly=$true}
if($startup){$descriptor.zeroBusinessStartup=$true;$descriptor.exactTest=$name;$descriptor.runIgnored=$true;$descriptor.runtimeArchiveSha256=$Request.runtimeArchiveSha256}
$inputFile=Join-Path $root 'zero-business-input.json'
[IO.File]::WriteAllText($inputFile,($descriptor|ConvertTo-Json -Depth 6 -Compress),[Text.UTF8Encoding]::new($false))
$start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=[string]$Request.node
$start.Arguments='"'+(Join-Path $root 'probe.mjs')+'" "'+$inputFile+'"';$start.WorkingDirectory=$root
$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
$start.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$start.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
$process=[Diagnostics.Process]::new();$process.StartInfo=$start
try{
  if(!$process.Start()){throw 'Diagnostic worker did not start'}
  $heldProcessHandle=$process.Handle
  $output=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  # Keep the original native supervisor authority open until its worker exits.
  $process.StandardInput.WriteLine((@{owner=$Request.owner}|ConvertTo-Json -Compress));$process.StandardInput.Flush()
  if(!$process.WaitForExit(150000)){
    $process.StandardInput.Close()
    if(!$process.WaitForExit(5000)){$process.Kill();if(!$process.WaitForExit(5000)){throw 'Original diagnostic process did not settle'}}
    throw 'Owned diagnostic deadline; original stdin authority revoked'
  }
  $raw=$output.GetAwaiter().GetResult();$discarded=$stderr.GetAwaiter().GetResult()
  if($raw.Length -gt 1048576){throw 'Diagnostic output budget'}
  try{$value=$raw|ConvertFrom-Json}catch{throw 'Diagnostic worker did not produce a bounded JSON observation'}
  if(!$value){throw 'Diagnostic worker observation absent'}
  $receipt=$value.receipt;$progress=$value.progress
  if($startup){
    $json=@();foreach($line in ([string]$value.executed.stdout).Split("`n")){if($line.Trim().StartsWith('{')){try{$record=$line|ConvertFrom-Json;if($record.mode -eq 'startup-only'){$json+=,$record}}catch{}}}
    if($json.Count -ne 1){throw 'Exact startup diagnostic JSON absent'}
    $receipt=$json[0];$progress=@()
  }
  if($startup){if($receipt.logicalQueries -ne 0 -or $receipt.modelCalls -ne 0){throw 'Startup diagnostic violated zero-business contract'}}elseif($Request.zeroBusinessMode -in @('wpad-detect','wpad-compile')){if($receipt.logicalQueries -ne 0 -or $receipt.pacDownloaded -ne $false){throw 'WPAD discovery violated its no-download contract'}}elseif($Request.zeroBusinessMode.StartsWith('winhttp-inprocess-')){if($receipt.logicalQueries -ne 0 -or $receipt.modelCalls -ne 0 -or $receipt.destinationHttpSent -ne $false){throw 'In-process metadata diagnostic violated zero-business contract'};if($Request.zeroBusinessMode -eq 'winhttp-inprocess-compile' -and $receipt.apiCallAttempted -ne $false){throw 'Compile-only diagnostic attempted a native API'}}elseif($receipt.fullEngineCall -ne $false){throw 'Handshake diagnostic did not confirm its zero-engine-call contract'}
  $deadline=[DateTime]::UtcNow.AddSeconds(5)
  do{$remaining=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith(($root.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)});if(!$remaining.Count){break};Start-Sleep -Milliseconds 100}while([DateTime]::UtcNow -lt $deadline)
  if($remaining.Count){throw 'Owned diagnostic processes remain after original worker exit'}
  return @{zeroBusinessObservation=$true;nativeScriptSha256=$(if($Request.zeroBusinessMode.StartsWith('winhttp-inprocess-')){'e52d8e078bb50517671586b5e37f50fc1d02e333b92dafa014be581c7634ed3c'}else{$null});nativeScriptSourceCommit=$(if($Request.zeroBusinessMode.StartsWith('winhttp-inprocess-')){'f10e54dbe322233f98eb7b9e998a4385c9b355ec'}else{$null});nativeBinaryExecuted=($Request.zeroBusinessMode -notin @('wpad-detect','wpad-compile','winhttp-inprocess-compile','winhttp-inprocess-resolve'));mode=$Request.zeroBusinessMode;privateProfileAcl=$aclEvidence;logicalQueries=0;modelCalls=0;receipt=$receipt;safeProgress=$progress;diagnosticProcessExitCode=$process.ExitCode;nativeExampleExitCode=$value.exampleExitCode;nativeTestSummary=$value.summary;selection=$value.selection;rawStderrPersisted=$false;stderrBytes=[Text.Encoding]::UTF8.GetByteCount($discarded);nativeStderrBytes=$value.stderrBytes;ownedProcessesAbsent=$true;registryWrites=0;proxySettingsChanged=$false;certificatePolicyChanged=$false;diagnosticSourceCommit=$Request.diagnosticSourceCommit}
}finally{$process.Dispose()}
