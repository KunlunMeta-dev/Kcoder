param([Parameter(Mandatory=$true)][string]$OwnedParent,[Parameter(Mandatory=$true)][string]$RunRoot,[Parameter(Mandatory=$true)][string]$AppSource,[Parameter(Mandatory=$true)][string]$ProbeSource,[Parameter(Mandatory=$true)][string]$Electron,[Parameter(Mandatory=$true)][string]$FixtureUrl)
$ErrorActionPreference='Stop'
$ownedPath=[IO.Path]::GetFullPath($OwnedParent).TrimEnd('\')
$runPath=[IO.Path]::GetFullPath($RunRoot)
if(-not $runPath.StartsWith($ownedPath+'\') -or [IO.Path]::GetFileName($runPath) -notmatch '^joint-runtime-[a-zA-Z0-9-]+$'){throw 'Run directory must be a fresh child of the explicit owner'}
if(Test-Path -LiteralPath $runPath){throw 'Refusing to reuse an existing native profile'}
foreach($source in @($AppSource,$ProbeSource,$Electron)) {if(-not(Test-Path -LiteralPath $source)){throw 'Explicit native source prerequisite missing'}}
foreach($item in @(Get-Item -LiteralPath $AppSource)+(Get-ChildItem -LiteralPath $AppSource -Recurse -Force)){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Native source snapshot cannot contain reparse points'}}
New-Item -ItemType Directory -Path $runPath | Out-Null
Copy-Item -LiteralPath $AppSource -Destination (Join-Path $runPath 'app') -Recurse
$probe=Join-Path $runPath 'app/e2e/fixtures/widget-isolation/electron-mcp-joint-probe.mjs'
Copy-Item -LiteralPath $ProbeSource -Destination $probe -Force
$account=Join-Path $runPath 'account';$temporary=Join-Path $runPath 'temp';$profile=Join-Path $runPath 'profile';$report=Join-Path $runPath 'native-joint-report.json'
New-Item -ItemType Directory -Path $account,$temporary | Out-Null
@{runRoot=$runPath;fixtureUrl=$FixtureUrl;probeSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $probe).Hash;startedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runPath 'owner.json') -Encoding UTF8
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=$Electron
$info.Arguments='"'+$probe+'" "--owned-profile='+$profile+'" "--owned-report='+$report+'" "--fixture-url='+$FixtureUrl+'"'
$info.WorkingDirectory=$runPath;$info.UseShellExecute=$false;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
foreach($name in @('OPENAI_API_KEY','ANTHROPIC_API_KEY','ELECTRON_RUN_AS_NODE','NODE_OPTIONS','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY')){$info.EnvironmentVariables.Remove($name)}
$info.EnvironmentVariables['USERPROFILE']=$account;$info.EnvironmentVariables['APPDATA']=Join-Path $account 'Roaming';$info.EnvironmentVariables['LOCALAPPDATA']=Join-Path $account 'Local';$info.EnvironmentVariables['TEMP']=$temporary;$info.EnvironmentVariables['TMP']=$temporary
$process=New-Object Diagnostics.Process;$process.StartInfo=$info
if(-not $process.Start()){throw 'Owned Electron failed to start'}
$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
$timedOut=-not $process.WaitForExit(150000)
if($timedOut){& taskkill.exe /PID $process.Id /T /F | Out-Null;$process.WaitForExit()}
[IO.File]::WriteAllText((Join-Path $runPath 'stdout.log'),$stdout.GetAwaiter().GetResult())
[IO.File]::WriteAllText((Join-Path $runPath 'stderr.log'),$stderr.GetAwaiter().GetResult())
if($timedOut){throw 'Owned native probe exceeded its external 150 second deadline'}
if(-not(Test-Path -LiteralPath $report)){throw 'Native probe returned no authoritative report'}
Get-Content -Raw -LiteralPath $report
exit $process.ExitCode
