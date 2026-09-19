param([Parameter(Mandatory=$true)][string]$TestBinary)
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('kcoder-plugin-verification-' + [Guid]::NewGuid().ToString('N'))
$previousConfig = $env:KCODER_CONFIG_DIR
try {
    New-Item -ItemType Directory -Path $fixture | Out-Null
    # Only this newly-created fixture gets a private ACL; user configuration is untouched.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($identity)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $fixture -AclObject $acl
    $env:KCODER_CONFIG_DIR = $fixture
    & $TestBinary --exact materialize::tests::git_materialization_resolves_exact_revision_without_git_metadata --nocapture
    if ($LASTEXITCODE -ne 0) { throw "Windows Git materialization regression failed: $LASTEXITCODE" }
} finally {
    $env:KCODER_CONFIG_DIR = $previousConfig
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
