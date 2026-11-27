$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$cli = Get-Command kcoder.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$localPrograms = Join-Path $env:LOCALAPPDATA 'Programs'
$studioCandidates = @(
    (Join-Path $localPrograms 'KCoder Studio'),
    (Join-Path $localPrograms 'kcoder-studio'),
    (Join-Path $env:ProgramFiles 'KCoder Studio')
)
$studios = @($studioCandidates | Select-Object -Unique | Where-Object {
    Test-Path -LiteralPath (Join-Path $_ 'kcoder-studio.exe') -PathType Leaf
})
$record = [ordered]@{
    version = 1
    readOnly = $true
    computer = $env:COMPUTERNAME
    identity = $identity.Name
    powerShellVersion = $PSVersionTable.PSVersion.ToString()
    osVersion = [Environment]::OSVersion.VersionString
    elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    administratorGroupPresent = @($identity.Groups | ForEach-Object { $_.Value }) -contains 'S-1-5-32-544'
    sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
    userProfile = $env:USERPROFILE
    temporaryRoot = $env:TEMP
    nodePath = $(if ($node) { $node.Source } else { $null })
    nodeVersion = $(if ($node) { (& $node.Source --version | Out-String).Trim() } else { $null })
    cliPath = $(if ($cli) { $cli.Source } else { $null })
    studioDirectories = $studios
}
$identity.Dispose()
$record | ConvertTo-Json -Depth 4 -Compress
