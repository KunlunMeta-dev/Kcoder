param([Parameter(Mandatory=$true)][object]$Request)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if($identity.User.Value -cne [string]$Request.sid -or [string]$Request.username -cnotmatch '^kc_e2e_[a-f0-9]{8}$'){throw 'OS profile qualification owner mismatch'}
if(([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'OS profile qualification requires an ordinary account'}
$profile=[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$roaming=[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
$local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$registered=[Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$identity.User.Value)).ProfileImagePath)
function Same-Path([string]$Left,[string]$Right){return [String]::Equals([IO.Path]::GetFullPath($Left).TrimEnd('\'),[IO.Path]::GetFullPath($Right).TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)}
if(![IO.Path]::IsPathRooted($profile) -or ([IO.Path]::GetFileName($profile)) -cne [string]$Request.username -or !(Same-Path $profile $registered)){throw 'Real OS profile does not belong to the owned SID'}
foreach($pair in @(@($roaming,(Join-Path $profile 'AppData\Roaming')),@($local,(Join-Path $profile 'AppData\Local')),@($env:USERPROFILE,$profile),@($env:APPDATA,$roaming),@($env:LOCALAPPDATA,$local))){if(!(Same-Path $pair[0] $pair[1])){throw 'Known Folder and normal-logon environment disagree; environment overrides are not isolation'}}
foreach($directory in @($profile,$roaming,$local)){
 $entry=Get-Item -LiteralPath $directory -Force
 if(!$entry.PSIsContainer){throw 'Owned OS profile folder is missing'}
 while($entry){if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Owned OS profile follows a reparse point'};$entry=$entry.Parent}
}
@{version=1;sid=$identity.User.Value;username=[string]$Request.username;isAdmin=$false;realOsProfile=$true;environmentMatchesKnownFolders=$true;environmentOverridden=$false;userProfile=$profile;roamingAppData=$roaming;localAppData=$local;registeredProfile=$registered;userInteractive=[Environment]::UserInteractive;sessionId=(Get-Process -Id $PID).SessionId;registryScope='owned-account-profile-registration';personalHkcuRead=$false;modelCalls=0;installersInvoked=0}
