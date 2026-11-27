param(
  [Parameter(Mandatory=$true)][string]$Request,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$RequestSha256
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'Start this runner from PowerShell on the logged-in Windows desktop, not SSH'}
if((Get-FileHash -LiteralPath $Request -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RequestSha256){throw 'Installed test request identity changed'}
$configuration=Get-Content -LiteralPath $Request -Raw -Encoding UTF8|ConvertFrom-Json
$allowed=@('version','installedDirectory','manifestSha256','hostSha256','expectedCommit','launcherPath','gitTemplateDirectory','suites','workMode')
if(@($configuration.PSObject.Properties.Name|Where-Object {$_ -notin $allowed}).Count -or $configuration.version -ne 1){throw 'Unsupported installed test request'}
foreach($name in @('manifestSha256','hostSha256')){if($configuration.$name -cnotmatch '^[a-f0-9]{64}$'){throw 'Explicit installed resource identities are required'}}
if($configuration.expectedCommit -cnotmatch '^[a-f0-9]{40}$'){throw 'Expected packaging commit is required'}
$suites=@($configuration.suites)
if($suites.Count -lt 1 -or $suites.Count -gt 2 -or @($suites|Where-Object {$_ -notin @('base','comparison')}).Count){throw 'Only the registered base and comparison suites are accepted'}
if($configuration.workMode -notin @('kcoder','kworker') -or ($configuration.workMode -eq 'kworker' -and 'comparison' -in $suites)){throw 'Invalid work mode for the selected suites'}
. (Join-Path $PSScriptRoot 'harness\installed-directory.ps1')
$install=Resolve-KCoderInstalledDirectory -Configuration $configuration
$template=Ordinary-Directory ([string]$configuration.gitTemplateDirectory)
if(@(Get-ChildItem -LiteralPath $template -Force).Count){throw 'The owned Git template directory must be empty'}
$node=(Get-Command node -CommandType Application -ErrorAction Stop).Source
$version=& $node --version
if($LASTEXITCODE -ne 0 -or $version -notmatch '^v\d+\.'){throw 'Node 22 or newer is required'}
if([int]([regex]::Match($version,'^v(\d+)\.').Groups[1].Value) -lt 22){throw 'Node 22 or newer is required'}
$env:KCODER_E2E_WORKSPACE_HOST='electron'
$env:KCODER_E2E_STUDIO_WORK_MODE=[string]$configuration.workMode
$env:KCODER_E2E_PACKAGED_DIR=$install
$env:KCODER_E2E_PACKAGED_MANIFEST_SHA256=[string]$configuration.manifestSha256
$env:KCODER_E2E_PACKAGED_HOST_SHA256=[string]$configuration.hostSha256
$env:KCODER_RELEASE_EXPECTED_COMMIT=[string]$configuration.expectedCommit
$env:KCODER_E2E_PROCESS_SUPERVISOR_BIN=Join-Path $install 'resources\bin\kcoder-process-supervisor.exe'
$env:KCODER_E2E_TASK_DELIVERY_LAUNCHER_BIN=[string]$configuration.launcherPath
$env:KCODER_E2E_GIT_BIN=(Get-Command git -CommandType Application -ErrorAction Stop).Source
$env:GIT_CONFIG_NOSYSTEM='1';$env:GIT_CONFIG_GLOBAL='NUL';$env:GIT_CONFIG_COUNT='0';$env:GIT_TEMPLATE_DIR=$template
foreach($name in @('KCODER_E2E_CHROMIUM_NO_SANDBOX','KCODER_E2E_KCODER_BIN','KCODER_E2E_ELECTRON_BIN','KCODER_E2E_RENDERER_ROOT')){Remove-Item -LiteralPath ('Env:\'+$name) -ErrorAction SilentlyContinue}
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
Push-Location $repo
try{
  foreach($suite in ($suites|Select-Object -Unique)){
    $file=if($suite -eq 'base'){'workspace-file-read-refresh.e2e.mjs'}else{'task-comparison-delivery.e2e.mjs'}
    Write-Output "Running isolated installed Studio suite: $suite"
    & $node (Join-Path 'apps\kcoder-studio\e2e\suites\browser' $file)
    if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
  }
}finally{Pop-Location}
