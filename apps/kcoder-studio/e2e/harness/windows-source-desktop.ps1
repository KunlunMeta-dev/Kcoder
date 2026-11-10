param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$configuration=Get-Content -LiteralPath $Request -Raw -Encoding UTF8|ConvertFrom-Json
if($configuration.version -ne 1 -or $configuration.owner -notmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'){throw 'Invalid private desktop request'}
$root=[IO.Path]::GetFullPath([string]$configuration.root).TrimEnd('\')
function Assert-OwnedPath([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path)
  if(!$full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Private desktop file is outside its owner directory'}
  $cursor=$full
  while($cursor.Length -ge $root.Length){
    if((Test-Path -LiteralPath $cursor) -and ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Private desktop path contains a reparse point'}
    $cursor=[IO.Path]::GetDirectoryName($cursor)
  }
  return $full
}
$null=Assert-OwnedPath $Request
$receipt=Assert-OwnedPath ([string]$configuration.receiptPath)
$stop=Assert-OwnedPath ([string]$configuration.stopPath)
$assembly=Assert-OwnedPath ([string]$configuration.assemblyPath)
if((Test-Path -LiteralPath $assembly) -or (Test-Path -LiteralPath $receipt) -or (Test-Path -LiteralPath $stop)){throw 'Private desktop owner collision'}
if((Get-FileHash -LiteralPath $configuration.sourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $configuration.sourceSha256){throw 'Private desktop source hash changed'}
function Publish-Receipt($Value,[string]$Phase) {
  $Value['phase']=$Phase
  $temporary=Assert-OwnedPath ($receipt+'.'+[Guid]::NewGuid().ToString('N')+'.tmp')
  try {
    [IO.File]::WriteAllText($temporary,($Value|ConvertTo-Json -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
    if(Test-Path -LiteralPath $receipt){
      # Windows PowerShell may bind a null backup name as an invalid empty path.
      $previous=Assert-OwnedPath ($receipt+'.'+[Guid]::NewGuid().ToString('N')+'.previous')
      [IO.File]::Replace($temporary,$receipt,$previous)
    }else{[IO.File]::Move($temporary,$receipt)}
  } finally {if(Test-Path -LiteralPath $temporary){[IO.File]::Delete($temporary)}}
}
$desktopOwner=$null
$failure=$null
try {
  # Compilation output and compiler scratch stay under this run's protected TEMP/root.
  Add-Type -Path ([string]$configuration.sourcePath) -OutputAssembly $assembly -OutputType Library
  $null=[Reflection.Assembly]::LoadFrom($assembly)
  $desktopOwner=[KcoderSourceDesktopOwner]::new([string]$configuration.owner,[uint32]$configuration.sessionId)
  Publish-Receipt ($desktopOwner.Snapshot()) 'desktop-created'
  $desktopOwner.Start([string]$configuration.executable,[string[]]$configuration.args,[string]$configuration.cwd)
  Publish-Receipt ($desktopOwner.Snapshot()) 'process-started'
  $deadline=[DateTime]::UtcNow.AddMinutes(8)
  $ready=$false
  while($true) {
    if(Test-Path -LiteralPath $stop){
      $authority=Get-Content -LiteralPath $stop -Raw -Encoding UTF8|ConvertFrom-Json
      if($authority.version -ne 1 -or $authority.owner -cne $configuration.owner){throw 'Private desktop stop owner mismatch'}
      break
    }
    if(!$desktopOwner.IsRunning()){throw 'Owned source Electron exited before its explicit release'}
    if(!$ready -and $desktopOwner.ObserveWindow()){
      Publish-Receipt ($desktopOwner.Snapshot()) 'ready'
      $ready=$true
    }
    if([DateTime]::UtcNow -gt $deadline){throw 'Private source desktop exceeded its owner lifetime'}
    Start-Sleep -Milliseconds 50
  }
} catch {$failure=$_.Exception.Message}
finally {
  if($desktopOwner){
    try {$desktopOwner.Dispose()}catch{$failure='Private desktop handle release failed: '+$_.Exception.Message}
    $final=$desktopOwner.Snapshot()
  } else {$final=@{version=1;owner=[string]$configuration.owner}}
  if($failure){$final['error']=$failure;Publish-Receipt $final 'failed'}else{Publish-Receipt $final 'released'}
}
if($failure){throw $failure}
