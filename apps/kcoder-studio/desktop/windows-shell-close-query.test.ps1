param([string]$Helper = (Join-Path $PSScriptRoot 'windows-shell/close-installed-processes.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Helper, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Helper parse failed' }
foreach ($name in @('Get-KCoderCreationIdentity', 'Get-KCoderProcessOwner', 'Test-KCoderSameProcess',
                    'Get-KCoderExcludedProcesses', 'Get-KCoderOwnedProcessSnapshot', 'Close-KCoderOwnedProcesses')) {
    $function = $ast.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if (!$function) { throw ('Missing helper: ' + $name) }
    . ([scriptblock]::Create($function.Extent.Text))
}
$script:assertions = 0
function Assert-Fixture([bool]$Value, [string]$Message) { $script:assertions++; if (!$Value) { throw $Message } }
function Assert-Unknown([scriptblock]$Action) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert-Fixture $failed 'An unconfirmed process query was accepted as absence'
}
$script:mode = 'present'; $script:kills = 0
$sid = 'S-1-5-21-101-102-103-104'
$when = [DateTime]::SpecifyKind([DateTime]'2026-01-01', [DateTimeKind]::Utc)
$script:current = [pscustomobject]@{ ProcessId=424242; ParentProcessId=0;
    CreationDate=$when; ExecutablePath='C:\Owned\resources\bin\kcoder.exe' }
$captured = @{ pid=424242; parent=0; created=$when.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);
    path=$script:current.ExecutablePath; depth=0 }

# The fixture shadows every native management/termination command. It extracts
# only the real functions above; the helper's Windows entrypoint never executes.
function Get-CimInstance { [CmdletBinding()]param($ClassName, $Filter)
    if ($ClassName -cne 'Win32_Process') { throw 'Unexpected fixture class' }
    if ($script:mode -eq 'query-error') { Write-Error 'Owned query failure'; return }
    if ($script:mode -eq 'missing') { return }
    return $script:current
}
function Invoke-CimMethod { [CmdletBinding()]param($InputObject, $MethodName)
    if ($MethodName -cne 'GetOwnerSid') { throw 'Unexpected fixture method' }
    if ($script:mode -eq 'owner-error') { Write-Error 'Owned owner query failure'; return }
    return [pscustomobject]@{ ReturnValue=0; Sid=$sid }
}
function Stop-Process { [CmdletBinding()]param($Id, [switch]$Force)
    $script:kills++; throw 'Fixture must not terminate any process'
}
function Test-KCoderImageRoot { param($Image, $Roots) return $true }

Assert-Fixture (Test-KCoderSameProcess $captured $sid) 'Matching birth/image/SID rejected'
$script:current.CreationDate = $when.AddSeconds(1)
Assert-Fixture (!(Test-KCoderSameProcess $captured $sid)) 'Reused PID was treated as original'
$script:current.CreationDate = $when
$script:mode = 'missing'
Assert-Fixture (!(Test-KCoderSameProcess $captured $sid)) 'Successful absence query was rejected'
Close-KCoderOwnedProcesses @($captured) $sid 1

$script:mode = 'query-error'
Assert-Unknown { Test-KCoderSameProcess $captured $sid }
Assert-Unknown { Close-KCoderOwnedProcesses @($captured) $sid 1 }
Assert-Unknown { Get-KCoderExcludedProcesses 1 }
$excluded = [Collections.Generic.HashSet[int]]::new()
Assert-Unknown { Get-KCoderOwnedProcessSnapshot @('C:\Owned') $sid $excluded }

$script:mode = 'owner-error'
Assert-Unknown { Test-KCoderSameProcess $captured $sid }
Assert-Unknown { Close-KCoderOwnedProcesses @($captured) $sid 1 }
Assert-Unknown { Get-KCoderOwnedProcessSnapshot @('C:\Owned') $sid $excluded }
Assert-Fixture ($script:kills -eq 0) 'Unknown query attempted to terminate a process'
[pscustomobject]@{ version=$PSVersionTable.PSVersion.ToString(); fixtureAssertions=$script:assertions;
    nativeCimCalls=0; nativeProcessTerminations=0; windowsNativeAcceptance=$false } | ConvertTo-Json -Compress
