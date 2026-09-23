param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$request=Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$resultPath=[string]$request.resultPath
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
  if($request.action -eq 'install') {
    $actual=(Get-FileHash -LiteralPath $request.installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if($actual -ne $request.sha256){throw 'Installer transfer digest mismatch'}
    $child=Start-Process -FilePath $request.installer -ArgumentList @('/S','/currentuser',('/D='+$install)) -PassThru
    if(!$child.WaitForExit(180000)){ & taskkill /PID $child.Id /T /F | Out-Null; throw 'Installer timed out' }
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

  $result=@{ok=$true;action=$request.action;installedResources=$resources;installedCliVersion=$installedCliVersion;sid=$identity.User.Value;profile=$ownedUserProfile;isAdmin=$false;registration=$entries;retainedData=$retained}
} catch {
  $result=@{ok=$false;action=$request.action;error=$_.Exception.Message;registrationEvidence=$allStudioEntries}
}
[IO.File]::WriteAllText($resultPath,($result|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
if(!$result.ok){exit 1}
