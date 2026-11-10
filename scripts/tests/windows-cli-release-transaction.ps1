[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Join-Path $PSScriptRoot '../install/installers/cli-release.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Publish-LocalReleaseImage' }, $false)
# Dot-source only the pure function; no install, process cleanup or profile access.
. ([scriptblock]::Create($function.Extent.Text))
$root = Join-Path ([IO.Path]::GetTempPath()) ('kcoder-atomic-image-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $image = Join-Path $root 'image.exe'
    $staged = Join-Path $root 'staged.exe'
    [IO.File]::WriteAllText($staged, 'old')
    Publish-LocalReleaseImage $staged $image
    [IO.File]::WriteAllText($staged, 'new')
    Publish-LocalReleaseImage $staged $image
    if ([IO.File]::ReadAllText($image) -ne 'new') { throw 'Replacement failed' }
    [IO.File]::WriteAllText($staged, 'next')
    $lock = [IO.File]::Open($image, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $failed = $false
    try { Publish-LocalReleaseImage $staged $image } catch { $failed = $true } finally { $lock.Dispose() }
    if (-not $failed -or [IO.File]::ReadAllText($image) -ne 'new' -or -not [IO.File]::Exists($staged)) { throw 'Locked replacement changed the original image' }
    Write-Output 'KCODER_CLI_ATOMIC_REPLACEMENT_OK'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
