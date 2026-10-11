param(
 [Parameter(Mandatory=$true)][string]$RepairScript,
 [Parameter(Mandatory=$true)][string]$IconSource,
 [Parameter(Mandatory=$true)][string]$ShortcutTemplate
)
$ErrorActionPreference='Stop'
$root=Join-Path $env:TEMP ('kcoder-installer-icon-fixture-'+[Guid]::NewGuid().ToString('N'))
$install=Join-Path $root 'install space'
$resource=Join-Path $install 'resources\shell'
$pins=Join-Path $root 'pins'
New-Item -ItemType Directory -Path $resource,$pins -Force|Out-Null
try {
 Set-Content (Join-Path $install 'kcoder-studio.exe') 'fixture not executable'
 Copy-Item -LiteralPath $IconSource -Destination (Join-Path $resource 'icon.ico')
 $linkPath=Join-Path $root 'KCoder Studio.lnk'
 Copy-Item -LiteralPath $ShortcutTemplate -Destination $linkPath
 $shell=New-Object -ComObject WScript.Shell
 $link=$shell.CreateShortcut($linkPath)
 $link.TargetPath=Join-Path $install 'kcoder-studio.exe';$link.Arguments='--fixture-argument';$link.WorkingDirectory=$install;$link.Description='fixture-description';$link.IconLocation="$env:WINDIR\system32\shell32.dll,0";$link.Save()
 $shellApp=New-Object -ComObject Shell.Application
 $appIdBefore=$shellApp.Namespace($root).ParseName('KCoder Studio.lnk').ExtendedProperty('System.AppUserModel.ID')
 $pin=Join-Path $pins 'KCoder.lnk';Copy-Item -LiteralPath $linkPath -Destination $pin
 $other=Join-Path $pins 'Other.lnk';$link=$shell.CreateShortcut($other);$link.TargetPath="$env:WINDIR\notepad.exe";$link.IconLocation="$env:WINDIR\system32\shell32.dll,0";$link.Save()
 $otherHash=(Get-FileHash $other).Hash
 & $RepairScript -InstallDir $install -DesktopLink $linkPath -StartMenuLink (Join-Path $root 'missing.lnk') -PinnedRoot $pins
 if($LASTEXITCODE){throw 'repair failed'}
 $link=$shell.CreateShortcut($linkPath)
 if($link.IconLocation -notmatch 'kcoder-[a-f0-9]{64}\.ico,0$'){throw 'icon path incorrect'}
 if($link.Arguments -ne '--fixture-argument' -or $link.Description -ne 'fixture-description' -or $link.WorkingDirectory -ne $install){throw 'shortcut fields changed'}
 $appIdAfter=$shellApp.Namespace($root).ParseName('KCoder Studio.lnk').ExtendedProperty('System.AppUserModel.ID')
 if($appIdBefore -ne $appIdAfter){throw 'AppUserModelID changed'}
 if($shell.CreateShortcut($pin).IconLocation -ne $link.IconLocation){throw 'matching pinned link not repaired'}
 if((Get-FileHash $other).Hash -ne $otherHash){throw 'unrelated link modified'}
 & $RepairScript -InstallDir $install -DesktopLink $linkPath -PinnedRoot $pins
 if((Get-ChildItem $resource -Filter 'kcoder-*.ico').Count -ne 1){throw 'repeat repair duplicated icon'}
 Write-Output "PASS: real Windows shortcut repair, pinned target filtering, AppID/arguments preserved, repeated upgrade idempotent"
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
