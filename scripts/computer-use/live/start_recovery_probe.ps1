$ErrorActionPreference='Stop'
$base=Join-Path $env:USERPROFILE 'Downloads/kcoder-live-probe'
$name='KCoderRecoveryStartup-'+[guid]::NewGuid().ToString('N')
$output=Join-Path $base ($name+'.json')
$action=New-ScheduledTaskAction -Execute (Join-Path $base 'recovery_startup_probe.exe') -Argument ('"'+$output+'"')
$principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $name
@{taskName=$name;output=$output}|ConvertTo-Json -Compress
