param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Node,[Parameter(Mandatory=$true)][string]$Harness)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if($PSVersionTable.PSVersion.Major -ne 5){throw 'Actual Windows PowerShell 5 required'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Ordinary token required'}
Add-Type -Path (Join-Path $Harness 'windows-native-stream.cs')
[IO.Directory]::CreateDirectory($Root)|Out-Null
$fixture=Join-Path $Harness 'windows-native-stream-fixture.mjs'
$normal=[KcoderOwnedNativeStreams]::Run($Node,@($fixture,'emit',$Root),$Root,(Join-Path $Root 'normal.stdout.bin'),(Join-Path $Root 'normal.stderr.bin'),10000,65536)
$expectedOut="plain stdout`nUnicode 你好 😀`n"+[char]27+"[32mANSI stdout"+[char]27+"[0m`n"
$expectedErr="plain stderr`nUnicode 错误 🌏`n"+[char]27+"[31mANSI stderr"+[char]27+"[0m`n#< CLIXML`r`n<Objs><S S=""Error"">fixture only</S></Objs>`r`nnon-XML tail`n"
function Exact-Bytes([string]$file,[string]$expected){return [Convert]::ToBase64String([IO.File]::ReadAllBytes($file)) -ceq [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes($expected))}
if($normal.ExitCode -ne 23 -or !$normal.InheritedJob -or !$normal.DrainsCompleted -or $normal.OutputLimitExceeded -or $normal.TimedOut){throw 'Original native nonzero exit was not preserved'}
if(!(Exact-Bytes (Join-Path $Root 'normal.stdout.bin') $expectedOut) -or !(Exact-Bytes (Join-Path $Root 'normal.stderr.bin') $expectedErr)){throw 'Raw Unicode/ANSI/CLIXML bytes changed'}
$child=Get-Content (Join-Path $Root 'fixture-child.json') -Raw|ConvertFrom-Json
if(!$child.pid -or $child.parentPid -ne $normal.ProcessId){throw 'Fixture child identity missing'}
$held=Get-Process -Id $child.pid -ErrorAction SilentlyContinue
$childIdentity=@{pid=[int]$child.pid;alreadyExited=(!$held)}
if($held){
 if(![KcoderOwnedNativeStreams]::InheritedJob($held.Handle)){throw 'Fixture descendant escaped inherited Job'}
 $childIdentity.creationTicks=$held.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
 $held.Dispose()
}
$overflow=[KcoderOwnedNativeStreams]::Run($Node,@($fixture,'overflow',$Root),$Root,(Join-Path $Root 'overflow.stdout.bin'),(Join-Path $Root 'overflow.stderr.bin'),10000,1024)
if(!$overflow.OutputLimitExceeded -or !$overflow.InheritedJob -or !$overflow.DrainsCompleted){throw 'Output bound was not enforced'}
if((Get-Item (Join-Path $Root 'overflow.stdout.bin')).Length -gt 1024 -or (Get-Item (Join-Path $Root 'overflow.stderr.bin')).Length -gt 1024){throw 'Output log exceeded bound'}
$timeout=[KcoderOwnedNativeStreams]::Run($Node,@($fixture,'timeout',$Root),$Root,(Join-Path $Root 'timeout.stdout.bin'),(Join-Path $Root 'timeout.stderr.bin'),500,1024)
if(!$timeout.TimedOut -or !$timeout.InheritedJob -or !$timeout.DrainsCompleted){throw 'Owned timeout did not settle'}
$result=@{passed=$true;powerShellMajor=5;sid=$identity.User.Value;isAdmin=$false;normal=$normal;exactStdout=$true;exactStderr=$true;overflow=$overflow;timeout=$timeout;fixtureChild=$childIdentity}
[IO.File]::WriteAllText((Join-Path $Root 'verification.json'),($result|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
$result|ConvertTo-Json -Depth 6 -Compress
