param([Parameter(Mandatory=$true)][string]$Helper)
$ErrorActionPreference='Stop'
. $Helper
$script:mechanismEvents=@()
$script:fenceCount=0
function Stop-KCoderInstallationTasks([string[]]$Roots,[string]$CurrentSid) {
 if(($Roots -join '|') -cne 'C:\Apps\KCoder' -or $CurrentSid -cne $fixtureSid){throw 'Scheduled-task ownership scope changed'}
 $script:mechanismEvents+='tasks'
}
function Assert-Fixture([bool]$Condition,[string]$Name){if(!$Condition){throw ('Preflight fence failed: '+$Name)};$script:fenceCount++}
$fixtureSid='S-1-5-21-101-102-103-104'
$otherSid='S-1-5-21-201-202-203-204'
$when=[DateTime]::UtcNow.AddMinutes(-1)
$script:fixtures=@(
 [pscustomobject]@{ProcessId=100;ParentProcessId=1;ExecutablePath='C:\Apps\KCoder\resources\bin\kcoder.exe';CreationDate=$when;Owner=$fixtureSid},
 [pscustomobject]@{ProcessId=101;ParentProcessId=100;ExecutablePath='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';CreationDate=$when.AddSeconds(1);Owner=$fixtureSid},
 [pscustomobject]@{ProcessId=102;ParentProcessId=1;ExecutablePath='C:\Apps\KCoder Peer\resources\bin\kcoder.exe';CreationDate=$when;Owner=$fixtureSid},
 [pscustomobject]@{ProcessId=103;ParentProcessId=1;ExecutablePath='C:\Apps\KCoder\resources\bin\kcoder.exe';CreationDate=$when;Owner=$otherSid},
 [pscustomobject]@{ProcessId=104;ParentProcessId=100;ExecutablePath='C:\Windows\System32\cmd.exe';CreationDate=$when.AddSeconds(-1);Owner=$fixtureSid}
)
# Only mechanism facts are mocked here. The separate native E2E starts real
# private-account processes and executes the original frozen uninstaller.
function Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter)
 if($ClassName -cne 'Win32_Process'){throw 'Unexpected CIM fixture class'}
 if($Filter -match '^ProcessId=(\d+)$'){return $script:fixtures|Where-Object{$_.ProcessId -eq [int]$Matches[1]}}
 if($PSBoundParameters.ContainsKey('Filter')){throw 'Unexpected CIM fixture filter'}
 return $script:fixtures
}
function Get-KCoderProcessOwner($Process){return $Process.Owner}
$excluded=[Collections.Generic.HashSet[int]]::new()
$script:expectedExcluded=$excluded
$captured=@(Get-KCoderOwnedProcessSnapshot @('C:\Apps\KCoder') $fixtureSid $excluded)
Assert-Fixture ((($captured.pid|Sort-Object)-join ',') -eq '100,101') 'root plus exact current-SID descendant only'
Assert-Fixture (!(Test-KCoderImageRoot 'C:\Apps\KCoder Peer\resources\bin\kcoder.exe' @('C:\Apps\KCoder'))) 'same-prefix peer preserved'
Assert-Fixture (Test-KCoderImageRoot 'c:\apps\kcoder\RESOURCES\bin\kcoder.exe' @('C:\Apps\KCoder')) 'ordinal normalized root'
$original=$captured|Where-Object{$_.pid -eq 100}
Assert-Fixture (Test-KCoderSameProcess $original $fixtureSid) 'original PID creation identity'
$script:fixtures[0].CreationDate=$when.AddSeconds(5)
Assert-Fixture (!(Test-KCoderSameProcess $original $fixtureSid)) 'reused PID never terminated'
$script:fixtures[0].CreationDate=$when
[void]$excluded.Add(100)
$withoutAncestor=@(Get-KCoderOwnedProcessSnapshot @('C:\Apps\KCoder') $fixtureSid $excluded)
Assert-Fixture ($withoutAncestor.Count -eq 0) 'excluded ancestor cannot seed descendant closure'

# An owned process can restart after the first captured tree has exited.
$script:closedPids=@()
$script:polls=0
$script:restartForever=$false
function Close-KCoderOwnedProcesses($Captured,[string]$CurrentSid,[int]$GraceSeconds){
 if($CurrentSid -cne $fixtureSid -or $GraceSeconds -ne 1 -or !$script:mechanismEvents.Count -or $script:mechanismEvents[0] -cne 'tasks'){throw 'Process close preceded owned task stop'}
 foreach($entry in $Captured){if(!$entry.ContainsKey('parent') -or !$entry.ContainsKey('path') -or !$entry.ContainsKey('depth')){throw 'Captured process identity shape changed'}}
 $script:mechanismEvents+='close'
 $script:closedPids+=@($Captured|ForEach-Object{$_.pid})
}
function Get-KCoderOwnedProcessSnapshot([string[]]$Roots,[string]$CurrentSid,$Excluded){
 if(($Roots -join '|') -cne 'C:\Apps\KCoder' -or $CurrentSid -cne $fixtureSid -or ![object]::ReferenceEquals($Excluded,$script:expectedExcluded)){throw 'Restart snapshot ownership scope changed'}
 $script:polls++
 if($script:restartForever -or $script:polls -eq 2){return @{pid=(200+$script:polls);created=[string]$script:polls;parent=0;path='C:\Apps\KCoder\resources\bin\kcoder.exe';depth=0}}
 return @()
}
function Start-Sleep { [CmdletBinding()]param([int]$Milliseconds) }
$first=@{pid=200;created='first';parent=0;path='C:\Apps\KCoder\resources\bin\kcoder.exe';depth=0}
$closed=Close-KCoderInstallationProcesses -Captured @($first) -Roots @('C:\Apps\KCoder') -CurrentSid $fixtureSid -Excluded $excluded -GraceSeconds 1
Assert-Fixture ($closed -eq 2 -and (($script:closedPids -join ',') -eq '200,202')) 'restarted owned process is closed automatically'
Assert-Fixture (($script:mechanismEvents -join ',') -eq 'tasks,close,close') 'owned tasks stop before the first process close'
$script:closedPids=@();$script:polls=0;$script:restartForever=$true;$failed=$false;$script:mechanismEvents=@()
try { Close-KCoderInstallationProcesses -Captured @($first) -Roots @('C:\Apps\KCoder') -CurrentSid $fixtureSid -Excluded $excluded -GraceSeconds 1 | Out-Null } catch { $failed=$true }
Assert-Fixture ($failed -and $script:closedPids.Count -eq 3) 'continuous restarts stop after bounded attempts'
Write-Output ('KCODER_PREFLIGHT_MECHANISM_FENCES='+$script:fenceCount)
