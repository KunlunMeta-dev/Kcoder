param(
 [Parameter(Mandatory=$true)][string]$RepairScript,
 [Parameter(Mandatory=$true)][string]$IconSource,
 [Parameter(Mandatory=$true)][string]$ShortcutTemplate
)
$ErrorActionPreference='Stop'
function Quote-RepairArgument([string]$Value) {
 $escaped=[regex]::Replace($Value,'(\\*)"','$1$1\"')
 $escaped=[regex]::Replace($escaped,'(\\+)$','$1$1')
 return '"'+$escaped+'"'
}
function Invoke-RepairFixture([string[]]$Arguments) {
 $start=[Diagnostics.ProcessStartInfo]::new()
 $start.FileName=$script:repairEngine
 $argv=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$RepairScript)+$Arguments
 $start.Arguments=(@($argv|ForEach-Object { Quote-RepairArgument $_ }) -join ' ')
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $child=[Diagnostics.Process]::new();$child.StartInfo=$start
 try {
  if(!$child.Start()){throw 'Owned repair process did not start'}
  $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
  if(!$child.WaitForExit(30000)){
   $child.Kill();[void]$child.WaitForExit(5000)
   throw 'Owned repair process timed out'
  }
  return [pscustomobject]@{ExitCode=$child.ExitCode;Output=$stdout.GetAwaiter().GetResult();Error=$stderr.GetAwaiter().GetResult()}
 } finally { $child.Dispose() }
}
function Release-FixtureCom($Value) {
 if($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)){
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value)
 }
}
$engineName=if($PSVersionTable.PSVersion.Major -lt 6){'powershell.exe'}elseif([Environment]::OSVersion.Platform -eq 'Win32NT'){'pwsh.exe'}else{'pwsh'}
$script:repairEngine=Join-Path $PSHOME $engineName
$root=Join-Path $env:TEMP ('kcoder-installer-icon-fixture-'+[Guid]::NewGuid().ToString('N'))
$install=Join-Path $root 'install space'
$resource=Join-Path $install 'resources\shell'
$pins=Join-Path $root 'pins'
$shell=$null;$primaryFailure=$null
try {
 New-Item -ItemType Directory -Path $resource,$pins -Force|Out-Null
 Set-Content (Join-Path $install 'kcoder-studio.exe') 'fixture not executable'
 Copy-Item -LiteralPath $IconSource -Destination (Join-Path $resource 'icon.ico')
 $iconHash=(Get-FileHash -LiteralPath $IconSource -Algorithm SHA256).Hash.ToLowerInvariant()
 $packagedIcon=Join-Path $resource "kcoder-$iconHash.ico"
 Copy-Item -LiteralPath $IconSource -Destination $packagedIcon
 function Get-ResourceSnapshot {
  return (@(Get-ChildItem -LiteralPath $resource -Recurse -File|Sort-Object FullName|ForEach-Object {
   $_.FullName.Substring($resource.Length)+'|'+$_.Length+'|'+(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }) -join "`n")
 }
 function Get-ShortcutFacts([string]$Path) {
  $shortcut=$shell.CreateShortcut($Path)
  try { return [pscustomobject]@{TargetPath=$shortcut.TargetPath;Arguments=$shortcut.Arguments;
   WorkingDirectory=$shortcut.WorkingDirectory;Description=$shortcut.Description;IconLocation=$shortcut.IconLocation} }
  finally { Release-FixtureCom $shortcut }
 }
 function Get-FixtureAppId([string]$Path) {
  $application=$null;$folder=$null;$item=$null
  try {
   $application=New-Object -ComObject Shell.Application
   $folder=$application.Namespace([IO.Path]::GetDirectoryName($Path))
   $item=$folder.ParseName([IO.Path]::GetFileName($Path))
   return [string]$item.ExtendedProperty('System.AppUserModel.ID')
  } finally { Release-FixtureCom $item;Release-FixtureCom $folder;Release-FixtureCom $application }
 }
 $resourceBefore=Get-ResourceSnapshot
 $linkPath=Join-Path $root 'KCoder Studio.lnk'
 Copy-Item -LiteralPath $ShortcutTemplate -Destination $linkPath
 $shell=New-Object -ComObject WScript.Shell
 $link=$shell.CreateShortcut($linkPath)
 try {
  $link.TargetPath=Join-Path $install 'kcoder-studio.exe';$link.Arguments='--fixture-argument';$link.WorkingDirectory=$install
  $link.Description='fixture-description';$link.IconLocation="$env:WINDIR\system32\shell32.dll,0";$link.Save()
 } finally { Release-FixtureCom $link }
 $appIdBefore=Get-FixtureAppId $linkPath
 if([string]::IsNullOrWhiteSpace($appIdBefore)){throw 'Fixture shortcut has no preserved AppUserModelID'}
 $startMenu=Join-Path $root 'Start menu.lnk';Copy-Item -LiteralPath $linkPath -Destination $startMenu
 $pin=Join-Path $pins 'KCoder.lnk';Copy-Item -LiteralPath $linkPath -Destination $pin
 $other=Join-Path $pins 'Other.lnk';$link=$shell.CreateShortcut($other)
 try { $link.TargetPath="$env:WINDIR\notepad.exe";$link.IconLocation="$env:WINDIR\system32\shell32.dll,0";$link.Save() }
 finally { Release-FixtureCom $link }
 $otherHash=(Get-FileHash -LiteralPath $other).Hash
 $arguments=@('-InstallDir',$install,'-DesktopLink',$linkPath,'-StartMenuLink',$startMenu,'-PinnedRoot',$pins)
 $first=Invoke-RepairFixture $arguments
 if($first.ExitCode -ne 0){throw 'Owned shortcut repair failed'}
 $facts=Get-ShortcutFacts $linkPath
 if(![String]::Equals($facts.IconLocation,"$packagedIcon,0",[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $packagedIcon -PathType Leaf)){throw 'icon path incorrect'}
 if(![String]::Equals($facts.TargetPath,(Join-Path $install 'kcoder-studio.exe'),[StringComparison]::OrdinalIgnoreCase)){throw 'shortcut target changed'}
 if($facts.Arguments -ne '--fixture-argument' -or $facts.Description -ne 'fixture-description' -or $facts.WorkingDirectory -ne $install){throw 'shortcut fields changed'}
 if($appIdBefore -cne (Get-FixtureAppId $linkPath)){throw 'AppUserModelID changed'}
 if((Get-ShortcutFacts $pin).IconLocation -ne $facts.IconLocation){throw 'matching pinned link not repaired'}
 if((Get-ShortcutFacts $startMenu).IconLocation -ne $facts.IconLocation){throw 'start-menu link not repaired'}
 if((Get-FileHash -LiteralPath $other).Hash -ne $otherHash){throw 'unrelated link modified'}
 if((Get-ResourceSnapshot) -cne $resourceBefore){throw 'first repair changed packaged resources'}
 $second=Invoke-RepairFixture $arguments
 if($second.ExitCode -ne 0){throw 'Repeated owned shortcut repair failed'}
 if((Get-ChildItem -LiteralPath $resource -Filter 'kcoder-*.ico').Count -ne 1){throw 'repeat repair duplicated icon'}
 if((Get-ResourceSnapshot) -cne $resourceBefore){throw 'repeat repair changed packaged resources'}
 Remove-Item -LiteralPath $packagedIcon
 $resourceMissing=Get-ResourceSnapshot
 $linksBefore=@($linkPath,$startMenu,$pin,$other)|ForEach-Object{(Get-FileHash -LiteralPath $_).Hash}
 $rejected=Invoke-RepairFixture $arguments
 if($rejected.ExitCode -eq 0 -or $rejected.Error -notmatch 'Packaged content-addressed Shell icon is missing or unsafe'){throw 'Expected content-addressed icon rejection was not observed'}
 if((Get-ResourceSnapshot) -cne $resourceMissing){throw 'missing-icon failure changed packaged resources'}
 $linksAfter=@($linkPath,$startMenu,$pin,$other)|ForEach-Object{(Get-FileHash -LiteralPath $_).Hash}
 if(($linksBefore -join ',') -cne ($linksAfter -join ',')){throw 'missing-icon failure changed shortcuts'}
 Write-Output 'PASS: real Windows shortcut repair, pinned/start-menu filtering, nonempty AppID/target/arguments preserved, repeated upgrade idempotent'
} catch { $primaryFailure=$_;throw }
finally {
 $cleanupFailure=$null
 try { Release-FixtureCom $shell } catch { $cleanupFailure=$_ }
 try { if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force} } catch { if(!$cleanupFailure){$cleanupFailure=$_} }
 if($cleanupFailure){if(!$primaryFailure){throw $cleanupFailure};Write-Warning ('Owned fixture cleanup unconfirmed: '+$root)}
}
