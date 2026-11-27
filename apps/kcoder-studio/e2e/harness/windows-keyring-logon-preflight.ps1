param([Parameter(Mandatory=$true)][string]$Parent)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($Parent -notmatch '^[D-Zd-z]:\\$'){throw 'An explicit non-C local drive root is required'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$commands=@('New-LocalUser','Get-LocalUser','Remove-LocalUser','Get-LocalGroup','Add-LocalGroupMember')
$localAccounts=$true
foreach($name in $commands){if(!(Get-Command -Name $name -ErrorAction SilentlyContinue)){$localAccounts=$false}}
$service=Get-Service -Name seclogon -ErrorAction SilentlyContinue
$drive=[IO.DriveInfo]::new($Parent)
$fixedNtfs=$drive.IsReady -and $drive.DriveType -eq [IO.DriveType]::Fixed -and $drive.DriveFormat -eq 'NTFS'
$domainRole=[int](Get-CimInstance Win32_ComputerSystem -Property DomainRole).DomainRole
$ready=$admin -and !$identity.IsSystem -and $localAccounts -and $null -ne $service -and ([string]$service.StartType -in @('Manual','Automatic')) -and $fixedNtfs -and $domainRole -lt 4
@{
 readOnly=$true;prerequisitesReady=$ready;effectiveAdministrator=$admin;isLocalSystem=[bool]$identity.IsSystem
 callerSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;callerUserInteractive=[Environment]::UserInteractive
 localAccountsCommandsAvailable=$localAccounts;secondaryLogonPresent=($null -ne $service)
 secondaryLogonStatus=$(if($service){[string]$service.Status}else{$null})
 secondaryLogonStartType=$(if($service){[string]$service.StartType}else{$null})
 fixedNtfsParent=$fixedNtfs;domainController=($domainRole -ge 4)
 accountsCreated=0;vaultCalls=0;scheduledTasksCreated=0;normalLogonAttempted=$false;borrowedConsoleIdentity=$false
}|ConvertTo-Json -Compress
