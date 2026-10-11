param(
    [ValidateSet('install','uninstall')][string]$Action='install',
    [string]$RunRoot='',
    [string]$Installer=(Join-Path $env:USERPROFILE 'Downloads\KCoder-Computer-Use-Verification.exe'),
    [string]$Sha256=''
)
$ErrorActionPreference='Stop'
$downloads=Join-Path $env:USERPROFILE 'Downloads'
if(!$RunRoot){$RunRoot=Join-Path $downloads ('kcoder-cu-install-'+[guid]::NewGuid().ToString('N'))}
[IO.Directory]::CreateDirectory($RunRoot)|Out-Null
$owner=Join-Path $RunRoot 'owner.json'
$id=if(Test-Path -LiteralPath $owner){(Get-Content -LiteralPath $owner -Raw|ConvertFrom-Json).id}else{[guid]::NewGuid().ToString('N')}
$install=Join-Path $RunRoot ('Studio '+[char]0x9a8c+[char]0x8bc1+' Install')
$name='KCoderInstallerProbe-'+[guid]::NewGuid().ToString('N')
$requestPath=Join-Path $RunRoot ($name+'.json')
$resultPath=Join-Path $RunRoot ($name+'-result.json')
$request=@{ action=$Action;runRoot=$RunRoot;owner=$id;installDirectory=$install;installer=$Installer;sha256=$Sha256;resultPath=$resultPath }
[IO.File]::WriteAllText($requestPath,($request|ConvertTo-Json),[Text.UTF8Encoding]::new($true))
$entry=Join-Path $downloads 'install-windows-computer-use-fixture.ps1'
$taskAction=New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -ExecutionPolicy Bypass -File "'+$entry+'" -RequestPath "'+$requestPath+'"') -WorkingDirectory $RunRoot
$principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $taskAction -Principal $principal -Settings $settings|Out-Null
$run=@{taskName=$name;runRoot=$RunRoot;installDirectory=$install;resultPath=$resultPath}
[IO.File]::WriteAllText((Join-Path $downloads 'active-computer-use-install.json'),($run|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Start-ScheduledTask -TaskName $name
$run|ConvertTo-Json -Compress
