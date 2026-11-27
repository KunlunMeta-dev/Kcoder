param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][string]$TestName,
    [switch]$IncludeIgnored
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($Executable)) { throw 'Absolute test executable required' }
$Executable = (Resolve-Path -LiteralPath $Executable).Path
function Quote-Ps([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
$name = 'KCoderNativeUnit-' + [guid]::NewGuid().ToString('N')
$output = Join-Path $PSScriptRoot $name
New-Item -ItemType Directory -Path $output | Out-Null
$wrapper = Join-Path $output 'run.ps1'
$log = Join-Path $output 'test.log'
$result = Join-Path $output 'result.json'
$ignored = if ($IncludeIgnored) { ' --ignored' } else { '' }
$script = "`$ErrorActionPreference = 'Continue'`n& " + (Quote-Ps $Executable) + ' ' + (Quote-Ps $TestName) + ' --exact' + $ignored + ' 2>&1 | Out-File -Encoding utf8 -LiteralPath ' + (Quote-Ps $log) + "`n`$code = `$LASTEXITCODE`n"
$script += '[IO.File]::WriteAllText(' + (Quote-Ps $result) + ', (@{ exitCode=$code } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))' + "`nexit `$code`n"
[IO.File]::WriteAllText($wrapper, $script, (New-Object Text.UTF8Encoding($true)))
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $wrapper + '"')
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $name
@{ taskName=$name; output=$output } | ConvertTo-Json -Compress
