param([Parameter(Mandatory=$true)][string]$Helper)
$ErrorActionPreference='Stop'
. $Helper
function Stop-KCoderInstallationTasks([string[]]$Roots,[string]$CurrentSid) {}
function Assert-Fixture([bool]$Condition,[string]$Name){if(!$Condition){throw ('Preflight fence failed: '+$Name)}}
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
function Get-CimInstance { param($ClassName,$Filter)
 if($Filter -match '^ProcessId=(\d+)$'){return $script:fixtures|Where-Object{$_.ProcessId -eq [int]$Matches[1]}}
 return $script:fixtures
}
function Get-KCoderProcessOwner($Process){return $Process.Owner}
$excluded=[Collections.Generic.HashSet[int]]::new()
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
 $script:closedPids+=@($Captured|ForEach-Object{$_.pid})
}
function Get-KCoderOwnedProcessSnapshot([string[]]$Roots,[string]$CurrentSid,$Excluded){
 $script:polls++
 if($script:restartForever -or $script:polls -eq 2){return @{pid=(200+$script:polls);created=[string]$script:polls}}
 return @()
}
function Start-Sleep { param([int]$Milliseconds) }
$first=@{pid=200;created='first'}
$closed=Close-KCoderInstallationProcesses -Captured @($first) -Roots @('C:\Apps\KCoder') -CurrentSid $fixtureSid -Excluded $excluded -GraceSeconds 1
Assert-Fixture ($closed -eq 2 -and (($script:closedPids -join ',') -eq '200,202')) 'restarted owned process is closed automatically'
$script:closedPids=@();$script:polls=0;$script:restartForever=$true;$failed=$false
try { Close-KCoderInstallationProcesses -Captured @($first) -Roots @('C:\Apps\KCoder') -CurrentSid $fixtureSid -Excluded $excluded -GraceSeconds 1 | Out-Null } catch { $failed=$true }
Assert-Fixture ($failed -and $script:closedPids.Count -eq 3) 'continuous restarts stop after bounded attempts'
Write-Output 'KCODER_PREFLIGHT_MECHANISM_FENCES=8'
