param(
    [string]$SourceRoot = (Join-Path $env:USERPROFILE 'Downloads\kcoder-studio-cu-ui-source'),
    [string]$PackageRoot = (Join-Path $env:USERPROFILE 'Downloads\kcoder-studio-cu-ui'),
    [string]$NodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source,
    [string]$RendererRoot = '',
    [string]$UserId = $env:USERNAME,
    [switch]$ExpectLocked,
    [switch]$TailOnly,
    [switch]$InputDiagnostics
)
$ErrorActionPreference='Stop'
$base=$SourceRoot
$name='KCoderStudioUI-'+[guid]::NewGuid().ToString('N')
$entry=Join-Path $base 'apps\kcoder-studio\e2e\suites\browser\windows-computer-use.e2e.mjs'
$script=Join-Path $base ($name+'.ps1')
$content=@'
$env:KCODER_E2E_PACKAGED_DIR='__PACKAGE__'
$env:KCODER_E2E_PROCESS_SUPERVISOR_BIN='__SUPERVISOR__'
$env:KCODER_E2E_RENDERER_ROOT='__RENDERER__'
$env:KCODER_E2E_DESKTOP_EXPECT_LOCKED='__LOCKED__'
$env:KCODER_E2E_DESKTOP_INPUT_DIAGNOSTICS='__INPUTDIAG__'
$env:KCODER_E2E_DESKTOP_TAIL_ONLY='__TAIL__'
Set-Location '__SOURCE__'
& '__NODE__' '__ENTRY__' *> '__LOG__'
exit $LASTEXITCODE
'@
$values=@{ '__ENTRY__'=$entry; '__LOG__'=(Join-Path $base ($name+'.log'));
    '__SUPERVISOR__'=(Join-Path $PackageRoot 'resources\bin\kcoder-process-supervisor.exe');
    '__PACKAGE__'=$PackageRoot; '__SOURCE__'=$SourceRoot; '__NODE__'=$NodeExecutable; '__RENDERER__'=$RendererRoot; '__LOCKED__'=$(if($ExpectLocked){'1'}else{'0'}); '__INPUTDIAG__'=$(if($InputDiagnostics){'1'}else{'0'}); '__TAIL__'=$(if($TailOnly){'1'}else{'0'}) }
foreach($key in $values.Keys) { $content=$content.Replace($key,$values[$key].Replace("'","''")) }
[IO.File]::WriteAllText($script,$content,(New-Object Text.UTF8Encoding($true)))
$action=New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "'+$script+'"') -WorkingDirectory $base
$principal=New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 8) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
$run=@{taskName=$name;log=(Join-Path $base ($name+'.log'));source=$entry}|ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $base 'active-ui-run.json'),$run,(New-Object Text.UTF8Encoding($false)))
Start-ScheduledTask -TaskName $name
Write-Output $run
