param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
$owner=[string]$request.owner;$username=[string]$request.username
if($owner -notmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or $username -notmatch '^kc_e2e_[a-f0-9]{8}$'){throw 'Invalid widget owner'}
if([IO.Path]::GetFileName($Root) -cne ('kcoder-widget-'+$owner)){throw 'Invalid widget root'}
$marker=Get-Content -LiteralPath (Join-Path $Root '.owner.json') -Raw|ConvertFrom-Json
if($marker.owner -cne $owner -or $marker.username -cne $username){throw 'Widget root marker mismatch'}
if(Get-LocalUser -Name $username -ErrorAction SilentlyContinue){throw 'Widget account already exists'}
$receipt=[ordered]@{version=1;owner=$owner;username=$username;sid=$null;birth=$null;exitCode=$null;jobEmpty=$false;accountAbsent=$false;profileAbsent=$false;failure=$null;phase="prelaunch"}
$receiptPath=Join-Path $Root 'session-receipt.json'
function Save-Receipt {
 $temporary=$receiptPath+'.tmp'
 [IO.File]::WriteAllText($temporary,($receipt|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
 if(Test-Path -LiteralPath $receiptPath){[IO.File]::Replace($temporary,$receiptPath,[Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($temporary,$receiptPath)}
}
$desktop=$null;$created=$false
try {
 $secure=ConvertTo-SecureString ([string]$request.password) -AsPlainText -Force
 $user=New-LocalUser -Name $username -Password $secure -Description ('KCoderE2E '+$owner) -AccountNeverExpires -PasswordNeverExpires
 $created=$true;$receipt.sid=$user.SID.Value;Save-Receipt
 $users=Get-LocalGroup -SID 'S-1-5-32-545'
 if(!(Get-LocalGroupMember -Group $users.Name|Where-Object{$_.SID.Value -eq $receipt.sid})){Add-LocalGroupMember -Group $users.Name -Member $username}
 & icacls $Root /grant ('*'+$receipt.sid+':(OI)(CI)F')|Out-Null
 if($LASTEXITCODE -ne 0){throw 'Widget owner ACL grant failed'}
 $harness=Join-Path $Root 'source\apps\kcoder-studio\e2e\harness'
 $receipt.phase='compile-original-owner';Save-Receipt
 $env:TEMP=Join-Path $Root 'compiler-temp';$env:TMP=$env:TEMP;[IO.Directory]::CreateDirectory($env:TEMP)|Out-Null
 Add-Type -Path @((Join-Path $harness 'windows-installer-desktop.cs'),(Join-Path $harness 'windows-keyring-logon-process.cs'))
 $desktop=[KcoderInstallerDesktop]::new($owner,$receipt.sid,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
 $actor=Join-Path $harness 'windows-widget-owned-actor.ps1'
 $configuration=Join-Path $Root 'actor.json'
 @{root=$Root;owner=$owner;sid=$receipt.sid;node=[string]$request.node}|ConvertTo-Json -Compress|Set-Content -LiteralPath $configuration -Encoding UTF8
 $body='& ([ScriptBlock]::Create([IO.File]::ReadAllText('''+$actor.Replace("'","''")+'''))) -Configuration '''+$configuration.Replace("'","''")+''''
 $arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
 $receipt['commandLineChars']=$arguments.Length+($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe').Length+3
 if($receipt.commandLineChars -ge 1024){throw 'Original logon command line exceeds API bound'}
 $publish=[Action[KcoderOwnedLogonBirth]]{param($birth)
  $receipt.birth=@{pid=$birth.Pid;creationTicks=$birth.CreationTicks;sid=$birth.Sid;logonLuid=$birth.AuthenticationId;logonType=$birth.LogonType;profileHiveLoaded=$birth.ProfileHiveLoaded;elevated=$birth.Elevated};Save-Receipt
 }
 $receipt.phase='original-logon';Save-Receipt
 $result=$desktop.RunObserved($username,$env:COMPUTERNAME,[string]$request.password,$receipt.sid,($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe'),$arguments,$Root,60000,$null,$publish)
 $receipt.exitCode=$result.ExitCode;$receipt.jobEmpty=$result.JobEmpty;Save-Receipt
 if($result.ExitCode -ne 0){throw 'Registered widget suite failed'}
} catch {$chain=@();$exception=$_.Exception;while($exception){$chain+=@{type=$exception.GetType().FullName;nativeErrorCode=if($exception -is [ComponentModel.Win32Exception]){$exception.NativeErrorCode}else{$null};message=$exception.Message};$exception=$exception.InnerException};$receipt.failure=@{chain=$chain;type=$_.Exception.GetType().Name;message=$_.Exception.Message;inner=if($_.Exception.InnerException){$_.Exception.InnerException.Message}else{$null}};Save-Receipt}
finally {
 if($desktop){$receipt.jobEmpty=$desktop.LastOwnedJobStopped;$desktop.Dispose()}
 if($created -and $receipt.jobEmpty){
  $current=Get-LocalUser -Name $username -ErrorAction SilentlyContinue
  if(!$current -or $current.SID.Value -cne $receipt.sid -or $current.Description -cne ('KCoderE2E '+$owner)){throw 'Widget cleanup owner changed'}
  $profile=Get-CimInstance Win32_UserProfile -Filter ("SID='"+$receipt.sid+"'")
  if($profile -and $profile.Loaded){throw 'Owned widget profile still loaded; account retained'}
  if($profile){$profile|Remove-CimInstance}
  $receipt.profileAbsent=!(Get-CimInstance Win32_UserProfile -Filter ("SID='"+$receipt.sid+"'"))
  if($receipt.profileAbsent){Remove-LocalUser -SID ([Security.Principal.SecurityIdentifier]::new($receipt.sid))}
  $receipt.accountAbsent=!(Get-LocalUser -Name $username -ErrorAction SilentlyContinue)
 }
 Save-Receipt
}
$receipt|ConvertTo-Json -Depth 12 -Compress
if($receipt.failure -or !$receipt.jobEmpty -or !$receipt.accountAbsent -or !$receipt.profileAbsent){exit 1}
