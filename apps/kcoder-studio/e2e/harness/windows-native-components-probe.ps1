param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
$request=Get-Content -LiteralPath $RequestPath -Raw|ConvertFrom-Json
$root=[IO.Path]::GetFullPath([string]$request.runRoot)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($sid -cne [string]$request.sid){throw 'Native fixture SID mismatch'}
foreach($pair in @(@('probe-cli.exe',[string]$request.probeCliSha256),@('probe-supervisor.exe',[string]$request.probeSupervisorSha256))){
 if((Get-FileHash -LiteralPath (Join-Path $root $pair[0]) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]){throw 'Native fixture binary transfer mismatch'}
}
Copy-Item -LiteralPath (Join-Path $root 'probe-supervisor.exe') -Destination (Join-Path $root 'kcoder-process-supervisor.exe')
function New-OwnedPrivateDirectory([string]$name){
 $path=Join-Path $root $name
 if(Test-Path -LiteralPath $path){throw 'Native fixture directory collision'}
 [IO.Directory]::CreateDirectory($path)|Out-Null
 $acl=Get-Acl -LiteralPath $path
 $acl.SetAccessRuleProtection($true,$false)
 foreach($identity in @($sid,'S-1-5-18','S-1-5-32-544')){
  $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($identity),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $path -AclObject $acl
 return $path
}
$profile=New-OwnedPrivateDirectory 'native-profile'
$workspace=New-OwnedPrivateDirectory 'native-workspace'
$source=New-OwnedPrivateDirectory 'source-repo'
Expand-Archive -LiteralPath (Join-Path $root 'channel-source.zip') -DestinationPath $source
if($request.nativeGateway){Expand-Archive -LiteralPath (Join-Path $root 'gateway-source.zip') -DestinationPath $source}
$settings=@{credential_store='file';active_provider='native-parent-probe';model='native-parent-probe';session_memory=@{enabled=$false};integrations=@{connectivity=@{enabled=$false}};providers=@{'native-parent-probe'=@{api_format='openai_chat_completions';authentication=@{mode='none'};endpoint='http://127.0.0.1:1';default_model='native-parent-probe';context_window_tokens=128000;max_output_tokens=1024;output_headroom_tokens=8192;no_proxy=$true;discover_models=$false}}}
[IO.File]::WriteAllText((Join-Path $profile 'settings.json'),($settings|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
$probe=[Diagnostics.ProcessStartInfo]::new()
$probe.FileName=[string]$request.node
$probe.Arguments='"'+(Join-Path $root 'native-components-probe.cjs')+'" "'+$root+'" "'+$profile+'" "'+$workspace+'" "'+(Join-Path $source 'apps\kcoder-channel-host')+'"'
if($request.nativeImageOnly){$probe.Arguments+=' imageOnly'}elseif($request.nativeGateway){$probe.Arguments+=' gateway'}
$probe.WorkingDirectory=$root;$probe.UseShellExecute=$false;$probe.CreateNoWindow=$true
$probe.RedirectStandardOutput=$true;$probe.RedirectStandardError=$true
$child=[Diagnostics.Process]::new();$child.StartInfo=$probe
try{
 if(!$child.Start()){throw 'Native component owner could not start'}
 $handle=$child.Handle;$stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
 if(!$child.WaitForExit(180000)){& taskkill /PID $child.Id /T /F 2>$null|Out-Null;throw 'Native component probe timed out'}
 if($child.ExitCode -ne 0){throw ('Native component probe failed: '+$stderr.GetAwaiter().GetResult())}
 return ($stdout.GetAwaiter().GetResult()|ConvertFrom-Json)
}finally{$child.Dispose()}
