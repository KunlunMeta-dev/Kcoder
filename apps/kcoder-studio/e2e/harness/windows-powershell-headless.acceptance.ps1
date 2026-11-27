param(
    [Parameter(Mandatory=$true)][string]$OwnedRoot,
    [Parameter(Mandatory=$true)][string]$Owner,
    [Parameter(Mandatory=$true)][string]$Node
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Assert-Acceptance([bool]$Value, [string]$Message) { if (!$Value) { throw $Message } }
function Save-Acceptance([string]$Path, $Value) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 14 -Compress))
    $file = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    if (Test-Path -LiteralPath $Path) { throw 'Owned receipt collision; do not overwrite or replay' }
    [IO.File]::Move($temporary, $Path)
}
function Get-AcceptanceHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-AcceptanceTextHash([string]$Text) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

$root = [IO.Path]::GetFullPath($OwnedRoot)
Assert-Acceptance ($Owner -match '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$') 'Invalid acceptance owner'
Assert-Acceptance ((Split-Path $root -Leaf) -ceq ('kcoder-package-' + $Owner)) 'Acceptance root binding changed'
$marker = Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw | ConvertFrom-Json
Assert-Acceptance ($marker.owner -ceq $Owner) 'Acceptance root owner changed'
Assert-Acceptance (!((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) 'Acceptance root is a reparse point'
$inputs = Get-Content -LiteralPath (Join-Path $root 'inputs.json') -Raw | ConvertFrom-Json
Assert-Acceptance ($inputs.owner -ceq $Owner) 'Acceptance input owner changed'
Assert-Acceptance ($PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1) 'Windows PowerShell 5.1 is required'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$process = $null; $captured = $null; $failure = $null
$result = [ordered]@{ owner=$Owner; scope='Windows PowerShell 5.1, owned filesystem staging and one synthetic process only';
    psVersion=$PSVersionTable.PSVersion.ToString(); powershellEdition=$PSVersionTable.PSEdition;
    currentSid=$sid; parser=@(); mechanism=$null; queryMechanism=$null; staging=$null; realCim=@();
    workerPid=$null; workerCloseConfirmed=$true; completed=$false; success=$false; stage='inputs';
    originalEntryPointsExecuted=$false; installationScans=0; scheduledTaskOperations=0; desktopOperations=0;
    conptyOperations=0; dpapiOperations=0; modelCalls=0 }
try {
    foreach ($sourceInput in $inputs.files) {
        Assert-Acceptance ($sourceInput.leaf -match '^[A-Za-z0-9_.-]+$') 'Invalid acceptance source leaf'
        Assert-Acceptance ((Get-AcceptanceHash (Join-Path $root $sourceInput.leaf)) -ceq $sourceInput.sha256) 'Acceptance source digest changed'
    }
    foreach ($leaf in @('close-installed-processes.ps1', 'windows-project-terminal-probe.ps1', 'acceptance.ps1')) {
        $tokens = $null; $errors = $null
        $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root $leaf), [ref]$tokens, [ref]$errors)
        Assert-Acceptance ($errors.Count -eq 0) ('PowerShell parser rejected owned source: ' + $leaf)
        $result.parser += [pscustomobject]@{leaf=$leaf; errors=@(); sourceSha256=(Get-AcceptanceHash (Join-Path $root $leaf))}
    }
    $result.stage='existing-mechanisms'
    $helper = Join-Path $root 'close-installed-processes.ps1'
    # Each script invocation has its own scope; its management commands are mocked.
    $mechanism = (& (Join-Path $root 'windows-shell-close-processes.test.ps1') -Helper $helper | Out-String).Trim()
    Assert-Acceptance ($mechanism -match '^KCODER_PREFLIGHT_MECHANISM_FENCES=(\d+)$') 'Existing mechanism verifier returned no receipt'
    $result.mechanism = @{fences=[int]$Matches[1]; receipt=$mechanism; realCim=$false}
    $result.queryMechanism = (& (Join-Path $root 'windows-shell-close-query.test.ps1') -Helper $helper | Out-String).Trim() | ConvertFrom-Json
    Assert-Acceptance ($result.queryMechanism.fixtureAssertions -eq 11) 'Existing query verifier did not finish all assertions'

    # The existing verifier uses one .NET 6 hash expression. Adapt that expression
    # for .NET Framework only; retain its actual source-AST filesystem allowlist.
    $result.stage='project-source-staging'
    $checker = [IO.File]::ReadAllText((Join-Path $root 'high-risk-b-powershell-staging.verify.ps1'))
    $modernHash = "[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes(`$SourcePath))).ToLowerInvariant()"
    $legacyHash = "(Get-FileHash -LiteralPath `$SourcePath -Algorithm SHA256).Hash.ToLowerInvariant()"
    Assert-Acceptance (($checker.Split(@($modernHash), [StringSplitOptions]::None).Count - 1) -eq 1) 'Unexpected staging verifier compatibility boundary'
    $compatibleChecker = $checker.Replace($modernHash, $legacyHash)
    $projectInput = @($inputs.files | Where-Object {$_.leaf -ceq 'windows-project-terminal-probe.ps1'})[0]
    $result.staging = (& ([ScriptBlock]::Create($compatibleChecker)) -SourcePath (Join-Path $root $projectInput.leaf) -ExpectedSha256 $projectInput.sha256 -OwnedRoot (Join-Path $root 'staging-fixtures') | Out-String).Trim() | ConvertFrom-Json
    $result.staging | Add-Member -NotePropertyName compatibilityAdapter -NotePropertyValue 'Only HashData/ToHexString replaced by Get-FileHash for .NET Framework'
    $result.staging | Add-Member -NotePropertyName adaptedVerifierSha256 -NotePropertyValue (Get-AcceptanceTextHash $compatibleChecker)
    Assert-Acceptance (@($result.staging.sourceStagingCases).Count -eq 7) 'Staging verifier did not finish seven source cases'
    Assert-Acceptance (@($result.staging.sourceStagingCases | Where-Object {!$_.passed}).Count -eq 0) 'Staging verifier rejected a fixture'
    Assert-Acceptance (!$result.staging.embeddedNodeProbeExecuted) 'Project terminal embedded probe was executed'

    foreach ($commandName in @('Get-CimInstance','Invoke-CimMethod','Stop-Process')) {
        Assert-Acceptance ((Get-Command $commandName).CommandType -eq [Management.Automation.CommandTypes]::Cmdlet) 'A mechanism fixture leaked a management mock into native acceptance'
    }

    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$errors)
    $allowedCommands = @('Invoke-CimMethod','Get-CimInstance','Select-Object','Get-KCoderCreationIdentity','Get-KCoderProcessOwner',
        'Test-KCoderSameProcess','Where-Object','Start-Sleep','Sort-Object','Stop-Process')
    $allowedMethods = @('ToUniversalTime','ToString','IsNullOrWhiteSpace','Equals','GetProcessById','CloseMainWindow','Dispose','AddSeconds')
    foreach ($name in @('Get-KCoderCreationIdentity','Get-KCoderProcessOwner','Test-KCoderSameProcess','Close-KCoderOwnedProcesses')) {
        $definition = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name}, $true)
        Assert-Acceptance ($null -ne $definition) 'Owned process mechanism missing'
        foreach ($command in @($definition.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]}, $true))) {
            Assert-Acceptance ($command.GetCommandName() -in $allowedCommands) 'Owned process function exceeded its command allowlist'
        }
        foreach ($call in @($definition.FindAll({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst]}, $true))) {
            Assert-Acceptance ($call.Member.Value -in $allowedMethods) 'Owned process function exceeded its method allowlist'
        }
        . ([ScriptBlock]::Create($definition.Extent.Text))
    }
    $result.stage='owned-worker-source'
    $workerPath = Join-Path $root 'owned-worker.mjs'
    $workerCode = @'
// This synthetic worker has no filesystem writes, subprocesses or external IO.
process.stdout.write(JSON.stringify({owner:process.argv[2],pid:process.pid,ready:true})+'\n');
process.stdin.resume();
'@
    [IO.File]::WriteAllText($workerPath, $workerCode, [Text.UTF8Encoding]::new($false))
    Save-Acceptance (Join-Path $root 'worker-intent.json') @{owner=$Owner; phase='may-start'; image=$Node; script=$workerPath; sourceSha256=(Get-AcceptanceHash $workerPath)}
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$Node; $start.Arguments='"'+$workerPath+'" '+$Owner; $start.WorkingDirectory=$root
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $start.EnvironmentVariables.Clear()
    $start.EnvironmentVariables['SystemRoot']=$env:SystemRoot
    $start.EnvironmentVariables['WINDIR']=$env:WINDIR
    $start.EnvironmentVariables['TEMP']=$root; $start.EnvironmentVariables['TMP']=$root
    $process = [Diagnostics.Process]::new(); $process.StartInfo=$start
    $result.stage='worker-start'
    Assert-Acceptance ($process.Start()) 'Owned synthetic worker did not start'
    $result.workerPid=$process.Id; $result.workerCloseConfirmed=$false
    $result.stage='worker-birth-receipt'
    Save-Acceptance (Join-Path $root 'worker-created.json') @{owner=$Owner; pid=$process.Id; processStartTicks=$process.StartTime.ToUniversalTime().Ticks.ToString(); image=$Node; script=$workerPath; phase='started'}
    $result.stage='worker-readiness'
    $readyTask=$process.StandardOutput.ReadLineAsync()
    Assert-Acceptance ($readyTask.Wait(5000)) 'Owned synthetic worker did not confirm readiness'
    $ready=$readyTask.Result|ConvertFrom-Json
    Assert-Acceptance ($ready.ready -and $ready.owner -ceq $Owner -and $ready.pid -eq $process.Id) 'Owned synthetic worker receipt changed'
    $result.stage='worker-cim-identity'
    $current = CimCmdlets\Get-CimInstance Win32_Process -Filter ('ProcessId='+$process.Id) -ErrorAction Stop
    Assert-Acceptance ($null -ne $current -and $current.CommandLine.Contains($workerPath) -and $current.CommandLine.Contains($Owner)) 'Synthetic worker command identity unavailable'
    Assert-Acceptance ((Get-KCoderProcessOwner $current) -ceq $sid) 'Synthetic worker owner SID changed'
    $captured=@{pid=[int]$current.ProcessId;parent=[int]$current.ParentProcessId;path=[string]$current.ExecutablePath;created=(Get-KCoderCreationIdentity $current);depth=0}
    Assert-Acceptance ([String]::Equals($captured.path,$Node,[StringComparison]::OrdinalIgnoreCase)) 'Synthetic worker executable changed'
    Save-Acceptance (Join-Path $root 'worker-owner.json') @{owner=$Owner;pid=$process.Id;created=$captured.created;path=$captured.path;sid=$sid;script=$workerPath;phase='identity-verified'}
    Assert-Acceptance (Test-KCoderSameProcess $captured $sid) 'Real CIM matching identity failed'
    $result.realCim += @{scenario='same-pid-birth-image-sid';passed=$true;nativeCim=$true}
    $changed=@{}+$captured; $changed.created=([long]$captured.created+1).ToString()
    Assert-Acceptance (!(Test-KCoderSameProcess $changed $sid)) 'Real CIM accepted a substituted birth'
    $result.realCim += @{scenario='birth-mismatch-rejected';passed=$true;nativeCim=$true}
    Assert-Acceptance (!(Test-KCoderSameProcess $captured 'S-1-5-21-101-102-103-104')) 'Real CIM accepted a foreign SID'
    $changed=@{}+$captured; $changed.path=$captured.path+'.peer'
    Assert-Acceptance (!(Test-KCoderSameProcess $changed $sid)) 'Real CIM accepted a foreign image'
    $result.realCim += @{scenario='sid-and-image-mismatch-rejected';passed=$true;nativeCim=$true}
    $result.stage='real-cim-failure-injection'
    $queryFailure = & {
        function Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter)
            CimCmdlets\Get-CimInstance -Namespace ('root\kcoder_absent_'+$Owner.Replace('-','')) -ClassName $ClassName -Filter $Filter -ErrorAction Stop
        }
        $readFailed=$false; $closeFailed=$false
        try { Test-KCoderSameProcess $captured $sid|Out-Null } catch {$readFailed=$true}
        try { Close-KCoderOwnedProcesses @($captured) $sid 1 } catch {$closeFailed=$true}
        return @{scenario='real-cim-invalid-namespace-fails-closed';passed=($readFailed -and $closeFailed);nativeCim=$true;injection='actual CimCmdlets provider error in an absent namespace'}
    }
    Assert-Acceptance ($queryFailure.passed -and !$process.HasExited) 'Real CIM query failure was accepted as absence or closed a process'
    $result.realCim += $queryFailure
    $ownerFailure = & {
        function Invoke-CimMethod { [CmdletBinding()]param($InputObject,$MethodName)
            CimCmdlets\Invoke-CimMethod -InputObject $InputObject -MethodName ('AbsentOwnerMethod_'+$Owner.Replace('-','')) -ErrorAction Stop
        }
        $rejected=$false
        try { Test-KCoderSameProcess $captured $sid|Out-Null } catch {$rejected=$true}
        return @{scenario='real-owner-method-error-fails-closed';passed=$rejected;nativeCim=$true;injection='actual CimCmdlets method-not-found error'}
    }
    Assert-Acceptance ($ownerFailure.passed -and !$process.HasExited) 'Unknown real CIM owner was accepted or closed a process'
    $result.realCim += $ownerFailure
    $result.stage='close-only-owned-worker'
    Close-KCoderOwnedProcesses @($captured) $sid 1
    Assert-Acceptance ($process.WaitForExit(5000)) 'Original handle did not confirm synthetic worker exit'
    Assert-Acceptance (!(Test-KCoderSameProcess $captured $sid)) 'Actual successful empty CIM query was not treated as absence'
    $result.realCim += @{scenario='only-owned-synthetic-worker-closed-and-absent';passed=$true;nativeCim=$true;originalHandleExitConfirmed=$true}
    $result.workerCloseConfirmed=$true
    foreach ($sourceInput in $inputs.files) { Assert-Acceptance ((Get-AcceptanceHash (Join-Path $root $sourceInput.leaf)) -ceq $sourceInput.sha256) 'Acceptance input changed while running' }
    $result.stage='complete'; $result.success=$true
} catch {
    $failure = $_
    $result.failure=@{category=$_.Exception.GetType().Name;message=$_.Exception.Message;line=$_.InvocationInfo.ScriptLineNumber;errorId=$_.FullyQualifiedErrorId}
} finally {
    if ($process) {
        if (!$process.HasExited -and $captured) {
            try { Close-KCoderOwnedProcesses @($captured) $sid 1; $result.workerCloseConfirmed=$process.WaitForExit(5000) }
            catch { $result.workerCloseConfirmed=$false }
        } elseif ($process.HasExited) { $result.workerCloseConfirmed=$true }
        if ($result.workerCloseConfirmed) {
            try { $workerError=$process.StandardError.ReadToEnd(); if($workerError){$result.workerStderr=$workerError.Substring(0,[Math]::Min(4000,$workerError.Length))} }
            catch {$result.workerDiagnosticFailure=$_.Exception.GetType().Name}
            $process.Dispose()
        }
    }
    $result.completed=$true
    Save-Acceptance (Join-Path $root 'result.json') $result
}
$result | ConvertTo-Json -Depth 14 -Compress
if ($failure -or !$result.workerCloseConfirmed) { exit 2 }
