param([Parameter(Mandatory=$true)][string]$Helper)
$ErrorActionPreference='Stop'
. $Helper
$script:stopped=@()
$sid='S-1-5-21-101-102-103-104'
function New-FixtureTask([string]$Key,[string]$Owner,[string]$Image) {
    $actions=[pscustomobject]@{Count=1;Value=[pscustomobject]@{Type=0;Path=$Image}}
    $actions|Add-Member ScriptMethod Item {param($index) return $this.Value}
    $task=[pscustomobject]@{Name=('KCoder-Channel-'+$Key.PadRight(64,'a'));State=4;Xml=$Key;Definition=[pscustomobject]@{
        RegistrationInfo=[pscustomobject]@{Description=('kcoder-native-user-service-v1:'+('a'*64))}
        Principal=[pscustomobject]@{UserId=$Owner;LogonType=3;RunLevel=0};Actions=$actions}}
    $task|Add-Member ScriptMethod Stop {param($flags) $script:stopped+=@($this.Name)}
    return $task
}
$owned=New-FixtureTask 'a' $sid 'C:\Apps\KCoder\resources\bin\kcoder.exe'
$peer=New-FixtureTask 'b' $sid 'C:\Apps\KCoder Peer\resources\bin\kcoder.exe'
$other=New-FixtureTask 'c' 'S-1-5-21-201-202-203-204' 'C:\Apps\KCoder\resources\bin\kcoder.exe'
$script:tasks=@($owned,$peer,$other)
$folder=[pscustomobject]@{Changed=$false}
$folder|Add-Member ScriptMethod GetTasks {param($flags) return $script:tasks}
$folder|Add-Member ScriptMethod GetTask {param($name)
    $task=$script:tasks|Where-Object{$_.Name -eq $name}
    if($this.Changed){$task.Xml='changed'}
    return $task
}
Stop-KCoderInstallationTasks @('C:\Apps\KCoder') $sid $folder
if($script:stopped.Count -ne 1 -or $script:stopped[0] -ne $owned.Name){throw 'Task ownership fence failed'}
if($owned.Definition.Principal.UserId -ne $sid -or $script:tasks.Count -ne 3){throw 'Task registration was changed'}
$script:stopped=@();$folder.Changed=$true;$failed=$false
try {Stop-KCoderInstallationTasks @('C:\Apps\KCoder') $sid $folder} catch {$failed=$true}
if(-not $failed -or $script:stopped.Count){throw 'Changed task definition was stopped'}
Write-Output 'KCODER_SCHEDULED_TASK_OWNERSHIP_FENCES_OK'
