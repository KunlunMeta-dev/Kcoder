param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
$request=Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$root=[IO.Path]::GetFullPath([string]$request.runRoot)
$downloads=[IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Downloads')).TrimEnd('\')+'\'
if(!$root.StartsWith($downloads,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($root) -notlike 'kcoder-cu-install-*'){throw 'Unexpected owned installation root'}
$install=[IO.Path]::GetFullPath([string]$request.installDirectory)
if(!$install.StartsWith(($root.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Installation directory escaped test root'}
$executableName='kcoder-studio-cu-verification.exe'
$utf8=[Text.UTF8Encoding]::new($false)
[IO.Directory]::CreateDirectory($root)|Out-Null
function PathDigest {
    $value=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$value))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
$result=@{ action=$request.action;status='failed';installDirectory=$install }
$normalFiles=@{}
$normalRegistryPath='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\dde41fb5-2370-5338-807d-3f5c37c73fa3'
function NormalRegistryState {
    $entry=Get-ItemProperty -LiteralPath $normalRegistryPath -ErrorAction SilentlyContinue
    return ($entry | Select-Object DisplayName,UninstallString | ConvertTo-Json -Compress)
}
try {
    if((Get-Process kcoder-studio-cu-verification -ErrorAction SilentlyContinue)){throw 'A verification Studio is running; refuse to stop an unrelated test window'}
    if($request.action -eq 'install') {
        $build=Get-Content -LiteralPath ($request.installer+'.build.json') -Raw | ConvertFrom-Json
        if($build.developmentOnly -ne $true -or $build.executableName -ne 'kcoder-studio-cu-verification' -or $build.packageName -ne 'kcoder-studio-cu-verification' -or $build.appId -ne 'dev.kcoder.studio.computer-use-verification.isolated' -or $build.installerSha256 -ne $request.sha256 -or $build.cliSha256 -notmatch '^[a-f0-9]{64}$'){throw 'Installer is not the independently named verification build'}
    }
    foreach($path in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\kcoder-studio\kcoder-studio.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\kcoder-studio\resources\bin\kcoder.exe'),
        (Join-Path $env:USERPROFILE '.config\kcoder\settings.json'),
        (Join-Path $env:USERPROFILE '.config\kcoder\credentials.json')
    )) {
        if(Test-Path -LiteralPath $path -PathType Leaf){$normalFiles[$path]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash}
    }
    $normalRegistryBefore=NormalRegistryState
    $marker=Join-Path $root 'owner.json'
    if(Test-Path -LiteralPath $marker) {
        $owner=Get-Content -LiteralPath $marker -Raw|ConvertFrom-Json
        if($owner.id -ne $request.owner){throw 'Wrong installation test owner'}
        if($owner.executableName -ne $executableName){throw 'Unexpected test executable ownership'}
    } else {
        if($request.action -ne 'install' -or (Test-Path -LiteralPath $install)){throw 'Unowned installation directory'}
        $owner=@{ id=$request.owner;pathDigest=(PathDigest);executableName=$executableName }
        [IO.File]::WriteAllText($marker,($owner|ConvertTo-Json),$utf8)
    }
    if($request.action -eq 'install') {
        $hash=(Get-FileHash -LiteralPath $request.installer -Algorithm SHA256).Hash.ToLowerInvariant()
        if($hash -ne $request.sha256){throw 'Installer digest mismatch'}
        $child=Start-Process -FilePath $request.installer -ArgumentList @('/S','/currentuser',('/D='+$install)) -PassThru
    } elseif($request.action -eq 'uninstall') {
        $entry=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object {Get-ItemProperty -LiteralPath $_.PSPath} | Where-Object {
            $_.DisplayName -like 'KCoder Studio Computer Use Verification *' -and $_.UninstallString -and
            $_.UninstallString.TrimStart('"').StartsWith(($install.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)
        })
        if($entry.Count -ne 1){throw 'Owned verification installer registration is missing'}
        $uninstaller=Get-ChildItem -LiteralPath $install -Filter '*Uninstall*.exe'|Select-Object -First 1
        if(!$uninstaller){throw 'Owned uninstaller missing'}
        $child=Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S','/currentuser') -PassThru
    } else {throw 'Unsupported installer test action'}
    $handle=$child.Handle
    if(!$child.WaitForExit(180000)){& taskkill /PID $child.Id /T /F | Out-Null;throw 'Installer process timed out'}
    $child.Refresh()
    if($child.ExitCode -ne 0){throw ('Installer exited '+$child.ExitCode)}
    $result.exitCode=$child.ExitCode
    if($request.action -eq 'install') {
        foreach($leaf in @($executableName,'resources\bin\kcoder.exe','resources\computer-use\launch.py','resources\computer-use\files.sha256.json')) {
            if(!(Test-Path -LiteralPath (Join-Path $install $leaf) -PathType Leaf)){throw ('Missing installed resource '+$leaf)}
        }
        $result.componentInventorySha256=(Get-FileHash -LiteralPath (Join-Path $install 'resources\computer-use\files.sha256.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        $result.cliSha256=(Get-FileHash -LiteralPath (Join-Path $install 'resources\bin\kcoder.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
        if($result.cliSha256 -ne $build.cliSha256){throw 'Installed CLI differs from the frozen build input'}
    } else {
        $deadline=[DateTime]::UtcNow.AddSeconds(30)
        while((Test-Path -LiteralPath (Join-Path $install $executableName)) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
        if(Test-Path -LiteralPath (Join-Path $install $executableName)){throw 'Application remained after uninstall'}
        # NSIS may finish cleanup in its copied uninstaller after the launcher
        # exits. Observe PATH restoration instead of racing its final section.
        $deadline=[DateTime]::UtcNow.AddSeconds(45)
        while((PathDigest) -ne $owner.pathDigest -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 200}
        $result.originalPathRestored=((PathDigest) -eq $owner.pathDigest)
        if(!$result.originalPathRestored){throw 'User PATH differs from pre-install state; no blind overwrite was performed'}
    }
    $result.normalStatePreserved=$true
    foreach($path in $normalFiles.Keys){
        if(!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $normalFiles[$path]){$result.normalStatePreserved=$false}
    }
    $result.normalRegistryPreserved=((NormalRegistryState) -eq $normalRegistryBefore)
    if(!$result.normalStatePreserved -or !$result.normalRegistryPreserved){throw 'Normal Studio files, configuration, or registration changed'}
    $result.status='passed'
} catch { $result.error=$_.Exception.Message }
[IO.File]::WriteAllText([string]$request.resultPath,($result|ConvertTo-Json -Depth 5),$utf8)
$result|ConvertTo-Json -Depth 5
if($result.status -ne 'passed'){exit 1}
