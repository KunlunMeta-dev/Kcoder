param([Parameter(Mandatory=$true)][string]$RunRoot,[Parameter(Mandatory=$true)][string]$Owner,[Parameter(Mandatory=$true)][string]$Username)
$ErrorActionPreference='Stop'
if($Username -notmatch '^kc_e2e_[a-f0-9]{8}$' -or $Owner -notmatch '^[a-f0-9-]{36}$'){throw 'Invalid cleanup identity'}
if(([IO.Path]::GetFileName($RunRoot)) -ne ('kcoder-installer-'+$Owner)){throw 'Invalid cleanup directory'}
if(Test-Path -LiteralPath $RunRoot){
 $marker=Get-Content -LiteralPath (Join-Path $RunRoot '.owner.json') -Raw|ConvertFrom-Json
 if($marker.owner -ne $owner -or $marker.username -ne $username){throw 'Run ownership marker mismatch'}
}
# Exact owned executable or owned probe/fixture script; never kill by application name.
Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith(($RunRoot.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)) -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -and ($_.CommandLine.Contains((Join-Path $RunRoot 'probe.cjs')) -or $_.CommandLine.Contains((Join-Path $RunRoot 'model.cjs'))))
} | ForEach-Object { & taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }
$user=Get-LocalUser -Name $Username -ErrorAction SilentlyContinue
if($user -and $user.Description -ne ('KCoderE2E '+$Owner)){throw 'Account ownership mismatch'}
if($user) {
 $sid=$user.SID.Value
 $ownedProfile=Get-CimInstance Win32_UserProfile -Filter ("SID='"+$sid+"'")
 Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -or ($_.ExecutablePath -and ($_.ExecutablePath.StartsWith($RunRoot,[StringComparison]::OrdinalIgnoreCase) -or ($ownedProfile -and $_.ExecutablePath.StartsWith($ownedProfile.LocalPath,[StringComparison]::OrdinalIgnoreCase)))) } | ForEach-Object {
   $process=$_
   try {$ownerSid=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop} catch {return}
   if($ownerSid.Sid -eq $sid){Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue}
 }
 $deadline=[DateTime]::UtcNow.AddSeconds(30)
 do {
   $ownedUserProfileState=Get-CimInstance Win32_UserProfile -Filter ("SID='"+$sid+"'")
   if(!$ownedUserProfileState){break}
   if(!$ownedUserProfileState.Loaded){$ownedUserProfileState | Remove-CimInstance;break}
   Start-Sleep -Milliseconds 250
 } while([DateTime]::UtcNow -lt $deadline)
 if(Get-CimInstance Win32_UserProfile -Filter ("SID='"+$sid+"'")){throw 'Owned profile remained loaded'}
 Remove-LocalUser -Name $Username
 if(Get-LocalUser -Name $Username -ErrorAction SilentlyContinue){throw 'Owned account cleanup failed'}
}
if(Test-Path -LiteralPath $RunRoot){[IO.Directory]::Delete($RunRoot,$true)}
if(Test-Path -LiteralPath $RunRoot){throw 'Owned installation directory cleanup failed'}
@{cleaned=$true;accountAbsent=$true;profileAbsent=$true;directoryAbsent=$true}|ConvertTo-Json -Compress
