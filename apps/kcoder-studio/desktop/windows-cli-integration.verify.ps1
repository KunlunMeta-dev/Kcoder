param([Parameter(Mandatory=$true)][string]$Script)
$ErrorActionPreference = 'Stop'
. $Script
$id = [Guid]::NewGuid().ToString('N')
$registryPath = "Software\KunlunMeta\KCoder\InstallTests\$id"
$fixture = Join-Path ([IO.Path]::GetTempPath()) "kcoder-cli-fixture-$id"
$environmentKey = $null
$ownershipKey = $null
function Assert-True([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
try {
    $bin = Join-Path $fixture 'Studio With Spaces\resources\bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $bin 'kcoder.exe'), [byte[]]@(0))
    $install = Join-Path $fixture 'Studio With Spaces'
    $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("$registryPath\Environment")
    $ownershipKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("$registryPath\Owners")
    $original = '%SystemRoot%\System32;C:\Other CLI;;C:\Tail'
    $environmentKey.SetValue('Path', $original, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    $apply = { param($action) Update-KCoderCliPath -Directory $install -Action $action -EnvironmentKey $environmentKey -OwnershipKey $ownershipKey }
    Assert-True ((& $apply Install).Changed) 'initial install must register CLI'
    $installed = $environmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    Assert-True ($installed -ceq "$bin;$original") 'PATH contents and expandable tokens must be preserved'
    Assert-True ($environmentKey.GetValueKind('Path') -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) 'registry kind must be preserved'
    Assert-True (!(& $apply Install).Changed) 'repeat install must be idempotent'
    $environmentKey.SetValue('Path', "$installed;C:\Added Later", [Microsoft.Win32.RegistryValueKind]::ExpandString)
    Assert-True ((& $apply Uninstall).Changed) 'owned PATH must be removed on uninstall'
    Assert-True ($environmentKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -ceq "$original;C:\Added Later") 'later unrelated PATH edits must survive'
    Assert-True (!(& $apply Uninstall).Changed) 'repeat uninstall must be idempotent'
    $manual = '"' + $bin.ToLowerInvariant() + '\";' + $original
    $environmentKey.SetValue('Path', $manual, [Microsoft.Win32.RegistryValueKind]::String)
    Assert-True (!(& $apply Install).Changed) 'case-insensitive quoted pre-existing PATH must not duplicate'
    Assert-True (!(& $apply Uninstall).Changed) 'uninstall must not remove manually registered PATH'
    Assert-True ($environmentKey.GetValue('Path') -ceq $manual) 'manual PATH must remain byte-for-byte unchanged'
    $environmentKey.DeleteValue('Path')
    Assert-True ((& $apply Install).Changed) 'missing PATH can be initialized'
    Assert-True ((& $apply Uninstall).Changed) 'initialized entry must be removable'
    $environmentKey.SetValue('Path', [byte[]]@(1,2), [Microsoft.Win32.RegistryValueKind]::Binary)
    $rejected = $false
    try { & $apply Install | Out-Null } catch { $rejected = $true }
    Assert-True $rejected 'non-string PATH must be rejected without overwriting'
    Assert-True ($environmentKey.GetValueKind('Path') -eq [Microsoft.Win32.RegistryValueKind]::Binary) 'invalid registry value must be retained'
    Write-Output 'PASS: isolated CLI install, upgrade idempotence, uninstall ownership, PATH preservation'
} finally {
    if ($environmentKey) { $environmentKey.Dispose() }
    if ($ownershipKey) { $ownershipKey.Dispose() }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($registryPath, $false)
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
