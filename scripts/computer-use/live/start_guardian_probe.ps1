$ErrorActionPreference = 'Stop'
$base = Join-Path $env:USERPROFILE 'Downloads/kcoder-live-probe'
$name = 'KCoderGuardianRunner-' + [guid]::NewGuid().ToString('N')
$output = Join-Path $base ($name + '.json')
$python = Join-Path $env:USERPROFILE 'Downloads/kcoder-cu-prototype-7-tracked/runtime/cpython-3.14.6-windows-x86_64-none/python.exe'
$probe = Join-Path $base 'guardian_job_probe.py'
$supervisor = Join-Path $env:USERPROFILE 'Downloads/kcoder-studio-cu-ui/resources/bin/kcoder-process-supervisor.exe'
$arguments = '-I -B "' + $probe + '" "' + $supervisor + '" "' + $output + '"'
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $name
@{taskName=$name;output=$output} | ConvertTo-Json -Compress
