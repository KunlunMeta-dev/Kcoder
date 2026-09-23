param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$configuration=Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json
$root=[IO.Path]::GetFullPath($configuration.root)
if(-not [IO.Path]::GetFullPath($Config).StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Interactive probe config is outside its owned directory'}
[IO.File]::WriteAllText((Join-Path $root 'interactive-owner.pid'),[string]$PID)
try {
  $arguments=@($configuration.probe,$configuration.binary,$configuration.installation,$configuration.overlay,$root)+@($configuration.flags)
  $output=& $configuration.node @arguments
  $exitCode=$LASTEXITCODE
  [IO.File]::WriteAllText((Join-Path $root 'interactive-result.json'),($output -join "`n"),[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $root 'interactive-exit-code'),[string]$exitCode)
  exit $exitCode
} catch {
  [IO.File]::WriteAllText((Join-Path $root 'interactive-failure.txt'),$_.Exception.Message,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $root 'interactive-exit-code'),'1')
  exit 1
}
