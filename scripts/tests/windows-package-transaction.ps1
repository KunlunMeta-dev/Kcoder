[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Load only pure installation-transaction functions; fault injection touches no real installation directory, registry, or user PATH.
$installer = Join-Path $PSScriptRoot '../release/install-kcoder.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$functionAst = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Install-PackageDirectory'
}, $false)
if (-not $functionAst) { throw 'Install-PackageDirectory is missing' }
Invoke-Expression $functionAst.Extent.Text

$script:failureMode = ''
$script:installCopies = 0
$script:activeDestination = ''
function Copy-Item {
    param([string]$LiteralPath, [string]$Destination, [switch]$Force)
    if ($script:failureMode -eq 'rollback' -and $LiteralPath.Contains('backup')) { throw 'injected rollback failure' }
    if ($Destination.StartsWith($script:activeDestination + [IO.Path]::DirectorySeparatorChar) -and $LiteralPath.Contains('payload')) {
        $script:installCopies++
        if ($script:installCopies -eq 2 -and $script:failureMode) {
            [IO.File]::WriteAllText($Destination, 'partial new file')
            if ($script:failureMode -in @('copy', 'rollback')) { throw 'injected second copy failure' }
            return
        }
    }
    Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('kcoder-package-test-' + [guid]::NewGuid().ToString('N'))
try {
    foreach ($existing in @($false, $true)) {
        foreach ($mode in @('copy', 'hash', '', 'rollback')) {
            if ($mode -eq 'rollback' -and -not $existing) { continue }
            $case = Join-Path $root ("case-$existing-$mode")
            $payload = Join-Path $case 'payload'
            $destination = Join-Path $case 'installed'
            $backup = Join-Path $case 'backup'
            New-Item -ItemType Directory -Force -Path $payload, $destination | Out-Null
            foreach ($name in @('kcoder.exe', 'kcoder-process-supervisor.exe')) {
                [IO.File]::WriteAllText((Join-Path $payload $name), "new-$name")
                if ($existing) { [IO.File]::WriteAllText((Join-Path $destination $name), "old-$name") }
            }
            [IO.File]::WriteAllText((Join-Path $destination 'user-sentinel'), 'preserve')
            $script:failureMode = $mode
            $script:installCopies = 0
            $script:activeDestination = $destination
            $failed = $false
            $failure = $null
            try { Install-PackageDirectory $payload $destination $backup }
            catch { $failed = $true; $failure = $_.Exception }
            if ($failed -ne [bool]$mode) { throw "Unexpected result for case $existing/$mode" }
            foreach ($name in @('kcoder.exe', 'kcoder-process-supervisor.exe')) {
                $target = Join-Path $destination $name
                if ($mode -eq 'rollback') {
                    if (-not $failure.Data.Contains('KeepBackup')) { throw 'Rollback failure lost its recovery marker' }
                    if ([IO.File]::ReadAllText((Join-Path $backup $name)) -ne "old-$name") { throw 'Rollback failure lost the previous release' }
                } elseif ($mode -and -not $existing) {
                    if (Test-Path -LiteralPath $target) { throw "Failed fresh install left $target" }
                } else {
                    $expected = if ($mode) { "old-$name" } else { "new-$name" }
                    if ([IO.File]::ReadAllText($target) -ne $expected) { throw "Mixed release at $target" }
                }
            }
            if ([IO.File]::ReadAllText((Join-Path $destination 'user-sentinel')) -ne 'preserve') { throw 'Unrelated file changed' }
        }
    }
    Write-Output 'Windows package transaction: 7 cases passed'
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
