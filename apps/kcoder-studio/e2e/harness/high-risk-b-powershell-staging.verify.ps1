param(
    [Parameter(Mandatory=$true)][string]$SourcePath,
    [Parameter(Mandatory=$true)][string]$ExpectedSha256,
    [Parameter(Mandatory=$true)][string]$OwnedRoot
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Assert-Verification($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Get-SourceHash { return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($SourcePath))).ToLowerInvariant() }
Assert-Verification ((Get-SourceHash) -eq $ExpectedSha256) 'Source identity changed before parsing'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$errors)
Assert-Verification ($errors.Count -eq 0) 'Project terminal source has parser errors'
$statements = @($ast.EndBlock.Statements)
$tryBlocks = @($statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
Assert-Verification ($tryBlocks.Count -eq 1) 'Unexpected project terminal script structure'
$sourceAssignment = @($statements | Where-Object { $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -eq '$channelSource' })
Assert-Verification ($sourceAssignment.Count -eq 1) 'Channel host preflight assignment is missing'
$assignmentIndex = [Array]::IndexOf($statements, $sourceAssignment[0])
$tryIndex = [Array]::IndexOf($statements, $tryBlocks[0])
$preflight = @($statements[$assignmentIndex..($tryIndex - 1)])
$body = @($tryBlocks[0].Body.Statements)
$codeAssignment = @($body | Where-Object { $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -eq '$code' })
Assert-Verification ($codeAssignment.Count -eq 1) 'Embedded native probe boundary is missing'
$codeIndex = [Array]::IndexOf($body, $codeAssignment[0])
Assert-Verification ($codeIndex -eq 6) 'Unexpected project terminal staging boundary'
$selected = @($preflight) + @($body[0..($codeIndex - 1)])
# Execute only the source's filesystem preflight/staging AST, never the embedded
# Node probe, native process start, terminal, SSH, taskkill or account operations.
$allowedCommands = @('Join-Path', 'Split-Path', 'Test-Path', 'Get-Item', 'Get-ChildItem', 'Where-Object', 'Select-Object', 'Copy-Item', 'Out-Null')
$allowedMethods = @('GetFullPath', 'CreateDirectory')
foreach ($statement in $selected) {
    foreach ($command in @($statement.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true))) {
        Assert-Verification ($command.GetCommandName() -in $allowedCommands) 'Staging contains a command outside the filesystem allowlist'
    }
    foreach ($invoke in @($statement.FindAll({ param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] }, $true))) {
        Assert-Verification ($invoke.Member.Value -in $allowedMethods) 'Staging contains a method outside the filesystem allowlist'
    }
}
$staging = [ScriptBlock]::Create(($selected | ForEach-Object { $_.Extent.Text }) -join "`n")
$root = [IO.Path]::GetFullPath($OwnedRoot)
Assert-Verification (!(Test-Path -LiteralPath $root)) 'Verification root already exists'
[IO.Directory]::CreateDirectory($root) | Out-Null
$observations = [Collections.Generic.List[object]]::new()
foreach ($scenario in @('default-sibling', 'explicit-sibling', 'entry-override', 'missing-sibling', 'channel-link', 'gateway-link', 'gateway-root-link')) {
    $caseRoot = Join-Path $root $scenario
    $packageRoot = Join-Path $caseRoot 'package'
    $GatewayDirectory = Join-Path $packageRoot 'gateway'
    $ChannelHostDirectory = $null
    $GatewayEntry = $null
    $Binary = 'not-executed'
    $probeRoot = Join-Path $caseRoot 'staged'
    $channel = if ($scenario -eq 'explicit-sibling') { Join-Path $caseRoot 'separate-channel-host' } else { Join-Path $packageRoot 'kcoder-channel-host' }
    foreach ($directory in @((Join-Path $GatewayDirectory 'src'), (Join-Path $channel 'src/channels'), (Join-Path $channel 'node_modules/fixture-dependency'))) {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $GatewayDirectory 'dev-server.mjs'), 'gateway-marker')
    [IO.File]::WriteAllText((Join-Path $GatewayDirectory 'src/fixture.mjs'), 'gateway-src-marker')
    [IO.File]::WriteAllText((Join-Path $channel 'package.json'), '{"name":"channel-host-fixture"}')
    [IO.File]::WriteAllText((Join-Path $channel 'src/channels/fixture.mjs'), 'channel-source-marker')
    [IO.File]::WriteAllText((Join-Path $channel 'node_modules/fixture-dependency/index.mjs'), 'dependency-marker')
    [IO.File]::WriteAllText((Join-Path $channel '.fixture-hidden'), 'hidden-marker')
    if ($scenario -eq 'explicit-sibling') { $ChannelHostDirectory = $channel }
    if ($scenario -eq 'entry-override') {
        $flat = Join-Path $caseRoot 'flat-entry'
        [IO.Directory]::CreateDirectory($flat) | Out-Null
        $GatewayEntry = Join-Path $flat 'candidate.mjs'
        [IO.File]::WriteAllText($GatewayEntry, 'candidate-entry-marker')
        foreach ($name in @('ssh-terminal-store.js', 'ssh-credential-cipher.js', 'ssh-terminal.js')) {
            [IO.File]::WriteAllText((Join-Path $flat $name), ('candidate-' + $name))
        }
    }
    if ($scenario -eq 'missing-sibling') { Remove-Item -LiteralPath $channel -Recurse -Force }
    if ($scenario -in @('channel-link', 'gateway-link')) {
        $linkRoot = if ($scenario -eq 'channel-link') { $channel } else { $GatewayDirectory }
        New-Item -ItemType SymbolicLink -Path (Join-Path $linkRoot 'untrusted-link') -Target (Join-Path $GatewayDirectory 'src/fixture.mjs') | Out-Null
    }
    if ($scenario -eq 'gateway-root-link') {
        $realGateway = $GatewayDirectory
        $GatewayDirectory = Join-Path $packageRoot 'gateway-link'
        New-Item -ItemType SymbolicLink -Path $GatewayDirectory -Target $realGateway | Out-Null
    }
    $failure = $null
    try { . $staging } catch { $failure = $_.Exception.Message }
    $shouldReject = $scenario -in @('missing-sibling', 'channel-link', 'gateway-link', 'gateway-root-link')
    if ($shouldReject) {
        Assert-Verification ($null -ne $failure) ('Unsafe/missing staging input was accepted: ' + $scenario)
        Assert-Verification (!(Test-Path -LiteralPath $probeRoot)) ('Rejected preflight created staging: ' + $scenario)
        if ($scenario -eq 'missing-sibling') { Assert-Verification ($failure.StartsWith('UNMET_PREREQUISITE:')) 'Missing sibling did not report a prerequisite' }
        else { Assert-Verification ($failure -match 'reparse|ordinary directories') 'Link input failed for an unrelated reason' }
    } else {
        Assert-Verification ($null -eq $failure) ('Ordinary staging failed: ' + $scenario + ': ' + $failure)
        $copiedChannel = Join-Path $probeRoot 'kcoder-channel-host'
        foreach ($entry in @(@('package.json','{"name":"channel-host-fixture"}'), @('src/channels/fixture.mjs','channel-source-marker'), @('node_modules/fixture-dependency/index.mjs','dependency-marker'), @('.fixture-hidden','hidden-marker'))) {
            Assert-Verification (([IO.File]::ReadAllText((Join-Path $copiedChannel $entry[0]))) -ceq $entry[1]) ('Complete sibling closure was not copied: ' + $scenario + ':' + $entry[0])
        }
        Assert-Verification (([IO.File]::ReadAllText((Join-Path $probeRoot 'gateway/src/fixture.mjs'))) -ceq 'gateway-src-marker') 'Gateway source was not copied'
        if ($scenario -eq 'entry-override') {
            Assert-Verification (([IO.File]::ReadAllText((Join-Path $probeRoot 'gateway/dev-server.mjs'))) -ceq 'candidate-entry-marker') 'Flat candidate entry was not copied'
            foreach ($name in @('ssh-terminal-store.js', 'ssh-credential-cipher.js', 'ssh-terminal.js')) {
                Assert-Verification (([IO.File]::ReadAllText((Join-Path $probeRoot ('gateway/src/' + $name)))) -ceq ('candidate-' + $name)) 'Flat SSH source override was not copied'
            }
        }
    }
    $observations.Add([pscustomobject]@{scenario=$scenario;rejected=$shouldReject;passed=$true;embeddedProbeExecuted=$false})
}
Assert-Verification ((Get-SourceHash) -eq $ExpectedSha256) 'Source identity changed during verification'
[pscustomobject]@{
    sourceSha256=$ExpectedSha256
    parserErrors=@()
    psVersion=$PSVersionTable.PSVersion.ToString()
    platform=$PSVersionTable.Platform
    sourceStagingCases=$observations
    embeddedNodeProbeExecuted=$false
    nativeWindowsOperations=0
    sshCalls=0
    user32Calls=0
    accountOperations=0
    actualWindowsAcceptance=$false
} | ConvertTo-Json -Depth 8 -Compress
