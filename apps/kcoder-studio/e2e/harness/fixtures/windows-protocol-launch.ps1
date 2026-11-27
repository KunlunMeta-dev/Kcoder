param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Owner)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$utf8=[Text.UTF8Encoding]::new($false)
$proof=Get-Content -LiteralPath (Join-Path $Root '.owner.json') -Raw|ConvertFrom-Json
if($proof.owner -cne $Owner){throw 'Protocol root ownership changed'}
$inputRecord=Get-Content -LiteralPath (Join-Path $Root 'protocol-input.json') -Raw|ConvertFrom-Json
if($inputRecord.owner -cne $Owner){throw 'Protocol input ownership changed'}
$reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),$utf8)
$lease=$reader.ReadLine()|ConvertFrom-Json
if($lease.owner -cne $Owner -or $lease.nonce -cne $inputRecord.nonce){throw 'Protocol lease changed'}
$nextLease=$reader.ReadLineAsync()
$helper=Join-Path $Root 'resources\bin\kcoder-process-supervisor.exe'
$node=Join-Path $Root 'node.exe'
$source=Join-Path $Root 'apps\kcoder-studio\e2e\harness\windows-protocol-native.mjs'
$statusFile=Join-Path $Root 'outer-status.jsonl'
$ownedProfile=Join-Path $Root 'outer-profile'
[IO.Directory]::CreateDirectory($ownedProfile)|Out-Null
$envs=[ordered]@{SystemRoot=$env:SystemRoot;WINDIR=$env:WINDIR;PATH=$env:PATH;TEMP=$ownedProfile;TMP=$ownedProfile;HOME=$ownedProfile;USERPROFILE=$ownedProfile;APPDATA=$ownedProfile;LOCALAPPDATA=$ownedProfile;KCODER_PROTOCOL_ROOT=$Root;KCODER_E2E_PROCESS_SUPERVISOR_BIN=$helper;KCODER_E2E_WINDOWS_PROTOCOL_CONSENT='1'}
$request=[ordered]@{version=1;nonce=$inputRecord.nonce;executable=$node;cwd=$Root;status_file=$statusFile;args=@($source);env=$envs}
$controllerTemp=Join-Path $Root 'controller-temp'
[IO.Directory]::CreateDirectory($controllerTemp)|Out-Null
$env:TEMP=$controllerTemp
$env:TMP=$controllerTemp
Add-Type -Path (Join-Path $Root 'apps\kcoder-studio\e2e\harness\fixtures\windows-protocol-kernel.cs')
$info=[Diagnostics.ProcessStartInfo]::new()
$info.FileName=$helper
$info.WorkingDirectory=$Root
$info.UseShellExecute=$false
$info.CreateNoWindow=$true
$info.RedirectStandardInput=$true
$info.RedirectStandardOutput=$true
$info.RedirectStandardError=$true
$process=[Diagnostics.Process]::new()
$process.StartInfo=$info
$target=$null
$started=$false
$receipt=$null
function Read-SharedStatus([string]$Path){
  $stream=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try{$statusReader=[IO.StreamReader]::new($stream);try{return $statusReader.ReadToEnd()}finally{$statusReader.Dispose()}}finally{$stream.Dispose()}
}
try {
  if(!$process.Start()){throw 'Original protocol supervisor did not start'}
  $started=$true
  # Hold the original process objects before reading any numeric receipt.
  $helperHandle=$process.Handle
  $helperTicks=$process.StartTime.ToUniversalTime().Ticks.ToString()
  [IO.File]::WriteAllText((Join-Path $Root 'outer-helper-birth.json'),(@{owner=$Owner;nonce=$inputRecord.nonce;helperPid=$process.Id;helperCreationTicks=$helperTicks;originalHelperHandleHeld=$true;nodeSha256=$inputRecord.nodeSha256;supervisorSha256=$inputRecord.supervisorSha256;sourcesDigest=$inputRecord.sourcesDigest}|ConvertTo-Json -Compress),$utf8)
  $stdout=$process.StandardOutput.ReadToEndAsync()
  $stderr=$process.StandardError.ReadToEndAsync()
  $process.StandardInput.WriteLine(($request|ConvertTo-Json -Depth 8 -Compress))
  $process.StandardInput.Flush()
  $ready=$null
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  while(!$ready -and [DateTime]::UtcNow -lt $deadline){
    if($process.HasExited){throw 'Original supervisor closed before READY'}
    if($nextLease.IsCompleted){throw 'Protocol owner disconnected before READY'}
    if(Test-Path -LiteralPath $statusFile){
      $text=Read-SharedStatus $statusFile
      $lines=$text -split "`n"
      for($i=0;$i -lt $lines.Length-1;$i++){
        $row=$lines[$i]|ConvertFrom-Json
        if($row.event -eq 'ERROR'){throw ('Protocol supervisor error: '+$row.code)}
        if($row.event -eq 'READY' -and $row.nonce -ceq $inputRecord.nonce -and $row.version -eq 1){$ready=$row}
      }
    }
    if(!$ready){Start-Sleep -Milliseconds 20}
  }
  if(!$ready){throw 'Original READY deadline exceeded'}
  $target=[Diagnostics.Process]::GetProcessById([int]$ready.pid)
  $targetHandle=$target.Handle
  $targetTicks=$target.StartTime.ToUniversalTime().Ticks.ToString()
  $targetInfo=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$ready.pid)
  [IO.File]::WriteAllText((Join-Path $Root 'outer-cim-diagnostic.json'),(@{owner=$Owner;nonce=$inputRecord.nonce;helperPid=$process.Id;targetPid=[int]$ready.pid;targetCreationTicks=$targetTicks;cimAvailable=($null -ne $targetInfo);cimParentPid=$targetInfo.ParentProcessId;cimImagePath=$targetInfo.ExecutablePath;cimCreationDate=$targetInfo.CreationDate}|ConvertTo-Json -Depth 4 -Compress),$utf8)
  $kernel=[KcoderProtocolKernel]::InspectHeld($targetHandle)
  $cimParentAvailable=($null -ne $targetInfo -and $null -ne $targetInfo.ParentProcessId -and $targetInfo.ParentProcessId -gt 0)
  $birth=[ordered]@{owner=$Owner;nonce=$inputRecord.nonce;helperPid=$process.Id;helperCreationTicks=$helperTicks;targetPid=[int]$ready.pid;targetCreationTicks=$targetTicks;kernel=$kernel;cimAvailable=($null -ne $targetInfo);cimParentAvailable=$cimParentAvailable;cimParentPid=$targetInfo.ParentProcessId;cimImagePath=$targetInfo.ExecutablePath;cimCreationDate=$targetInfo.CreationDate;cimParentMismatch=($cimParentAvailable -and $targetInfo.ParentProcessId -ne $process.Id);nodeSha256=$inputRecord.nodeSha256;supervisorSha256=$inputRecord.supervisorSha256;sourcesDigest=$inputRecord.sourcesDigest;originalHelperHandleHeld=$true;originalTargetHandleHeld=$true}
  [IO.File]::WriteAllText((Join-Path $Root 'outer-birth.json'),($birth|ConvertTo-Json -Depth 5 -Compress),$utf8)
  if($kernel.Pid -ne [int]$ready.pid -or $kernel.ParentPid -ne $process.Id -or $kernel.CreationTicks -cne $targetTicks -or ![String]::Equals([IO.Path]::GetFullPath($kernel.ImagePath),[IO.Path]::GetFullPath($node),[StringComparison]::OrdinalIgnoreCase)){throw 'Held kernel target identity or parent changed'}
  if($birth.cimParentMismatch){throw 'CIM parent differs from the original helper; kernel facts retained for diagnosis'}
  $process.StandardInput.WriteLine((@{command='START';version=1;nonce=$inputRecord.nonce}|ConvertTo-Json -Compress))
  $process.StandardInput.Flush()
  $startedAt=[DateTime]::UtcNow
  while(!$process.HasExited){
    if($nextLease.IsCompleted){throw 'Protocol owner disconnected; original scope receipt unknown'}
    if(([DateTime]::UtcNow-$startedAt).TotalSeconds -gt 180){throw 'Protocol run deadline exceeded; original scope receipt unknown'}
    Start-Sleep -Milliseconds 25
  }
  $process.WaitForExit()
  $events=@((Read-SharedStatus $statusFile) -split "`n"|Where-Object{$_}|ForEach-Object{$_|ConvertFrom-Json})
  $exits=@($events|Where-Object{$_.event -eq 'EXIT'})
  $readies=@($events|Where-Object{$_.event -eq 'READY' -and $_.nonce -ceq $inputRecord.nonce})
  if($exits.Count -ne 1 -or $readies.Count -ne 1 -or $exits[0].code -ne $process.ExitCode -or !$target.HasExited){throw 'Original Job EXIT/close confirmation missing'}
  $receipt=[ordered]@{owner=$Owner;nonce=$inputRecord.nonce;status='CONFIRMED';startSentExactlyOnce=$true;originalHelperClosed=$true;originalTargetClosed=$true;helperCreationTicks=$helperTicks;targetCreationTicks=$targetTicks;helperPid=$process.Id;targetPid=[int]$ready.pid;exitCode=$process.ExitCode;nativeJobEmptyAtExit=$true;scopeEvidence='V1 native supervisor EXIT is written only after original target handle exits and Job active count is one (the supervisor); original helper then closes';stdout=$stdout.Result;stderr=$stderr.Result;nodeSha256=$inputRecord.nodeSha256;supervisorSha256=$inputRecord.supervisorSha256;sourcesDigest=$inputRecord.sourcesDigest}
  [IO.File]::WriteAllText((Join-Path $Root 'outer-receipt.json'),($receipt|ConvertTo-Json -Depth 5 -Compress),$utf8)
  $receipt|ConvertTo-Json -Depth 5 -Compress
} finally {
  if($started -and !$process.HasExited){
    # Revoke only the retained original control pipe; never adopt or kill a PID by name.
    $process.StandardInput.Close()
    if(!$process.WaitForExit(10000)){throw 'Original supervisor close remains unconfirmed; retain root'}
  }
  if($target){$target.Dispose()}
  $process.Dispose()
}
