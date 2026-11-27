param([Parameter(Mandatory=$true)][string]$OwnedRoot)
$ErrorActionPreference='Stop'
$marker=Get-Content -LiteralPath (Join-Path $OwnedRoot '.owner.json') -Raw|ConvertFrom-Json
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.Name.Split('\')[-1] -ne $marker.username -or $marker.owner -notmatch '^[a-f0-9-]{36}$'){throw 'Original ordinary fixture caller required'}
$install=Join-Path $OwnedRoot 'Installed Studio'
$entry=(Get-Item -LiteralPath (Join-Path $install 'resources\office\components\src\cli.mjs')).FullName
$program=Join-Path $install 'kcoder-studio.exe'
$start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$program
$start.Arguments='--max-old-space-size=256 --disable-proto=throw --no-addons "'+$entry+'"'
$start.WorkingDirectory=Join-Path $install 'resources\office\components'
$start.UseShellExecute=$false;$start.CreateNoWindow=$true
$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
$start.EnvironmentVariables.Clear();$start.EnvironmentVariables['LANG']='C.UTF-8'
$start.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1';$start.EnvironmentVariables['SystemRoot']=$env:SystemRoot
$process=[Diagnostics.Process]::new();$process.StartInfo=$start
try {
 if(!$process.Start()){throw 'Owned Office protocol probe could not start'}
 $held=$process.Handle;$output=$process.StandardOutput.ReadToEndAsync();$errorOutput=$process.StandardError.ReadToEndAsync()
 $stdinWritten=$true
 try{$process.StandardInput.Write('{"method":"probe"}');$process.StandardInput.Close()}catch{$stdinWritten=$false}
 if(!$process.WaitForExit(15000)){$process.Kill();throw 'Owned Office protocol probe timed out'}
 $stdout=[string]$output.GetAwaiter().GetResult();$stderr=[string]$errorOutput.GetAwaiter().GetResult();$decoded=$null
 try{$decoded=$stdout|ConvertFrom-Json}catch{}
 $finiteCode=if($stderr -match '(ERR_[A-Z0-9_]+)'){$Matches[1]}elseif($stderr -match 'bad option:\s*(--[a-z-]+)'){'BAD_OPTION:'+ $Matches[1]}elseif($stderr -match 'SyntaxError'){'SYNTAX_ERROR'}elseif($stderr -match 'Error'){'PROCESS_ERROR'}else{'none'}
 $result=@{exitCode=$process.ExitCode;stdoutBytes=[Text.Encoding]::UTF8.GetByteCount($stdout);stderrBytes=[Text.Encoding]::UTF8.GetByteCount($stderr);stdoutJson=($null -ne $decoded);ok=($decoded.ok -eq $true);workerErrorCode=[string]$decoded.error.code;stderrCode=$finiteCode;fullGeneratorFlags=$true;clearedEnvironment=$true;stdinEof=$stdinWritten;ordinarySid=$identity.User.Value;runtimeStatus=[string]$decoded.result.runtime.status;dependencyStatus=[string]$decoded.result.status;actorOrModelClaim=$false}
 [IO.File]::WriteAllText((Join-Path $OwnedRoot 'windows-office-process-probe.json'),($result|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}finally{$process.Dispose()}
