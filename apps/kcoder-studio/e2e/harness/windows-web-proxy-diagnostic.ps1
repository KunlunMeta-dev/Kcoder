param([ValidateSet('example','python-asyncio')][string]$Case='example',[switch]$Direct,[switch]$HostnameConnect)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Test-PublicAddress([Net.IPAddress]$Address) {
  if ($Address.IsIPv4MappedToIPv6) { $Address = $Address.MapToIPv4() }
  $bytes = $Address.GetAddressBytes()
  if ($bytes.Length -eq 4) {
    $a=$bytes[0];$b=$bytes[1];$c=$bytes[2]
    return -not ($a -eq 0 -or $a -eq 10 -or $a -eq 127 -or $a -ge 224 -or ($a -eq 100 -and $b -ge 64 -and $b -le 127) -or ($a -eq 169 -and $b -eq 254) -or ($a -eq 172 -and $b -ge 16 -and $b -le 31) -or ($a -eq 192 -and ($b -eq 168 -or ($b -eq 0 -and ($c -eq 0 -or $c -eq 2)) -or ($b -eq 88 -and $c -eq 99))) -or ($a -eq 198 -and ($b -eq 18 -or $b -eq 19 -or ($b -eq 51 -and $c -eq 100))) -or ($a -eq 203 -and $b -eq 0 -and $c -eq 113))
  }
  return (($bytes[0] -band 224) -eq 32) -and -not (($bytes[0] -eq 32 -and $bytes[1] -eq 1 -and (($bytes[2] -lt 2) -or ($bytes[2] -eq 13 -and $bytes[3] -eq 184))) -or ($bytes[0] -eq 32 -and $bytes[1] -eq 2))
}
function Read-Header($Stream) {
  $data=[Collections.Generic.List[byte]]::new()
  while ($data.Count -lt 8192) {
    $value=$Stream.ReadByte();if($value -lt 0){throw 'Incomplete peer response'};$data.Add([byte]$value)
    if($data.Count -ge 4 -and [Text.Encoding]::ASCII.GetString($data.ToArray()).EndsWith("`r`n`r`n")){break}
  }
  return [Text.Encoding]::ASCII.GetString($data.ToArray()).Split("`n")[0].Trim()
}
if($HostnameConnect -and ($Direct -or $Case -ne 'python-asyncio')){throw 'Hostname control requires the one fixed Python URL through the system proxy'}
$probeOriginHost=if($Case -eq 'python-asyncio'){'docs.python.org'}else{'example.com'}
$probeOriginPath=if($Case -eq 'python-asyncio'){'/3/library/asyncio.html'}else{'/'}
$probeResult=@{readOnly=$true;registryWrites=0;fixedPublicUrl=('https://'+$probeOriginHost+$probeOriginPath);dnsPinned=$true;tlsBypass=$false;controls=@()}
try {
  $probeAddresses=@([Net.Dns]::GetHostAddresses($probeOriginHost))
  if(!$probeAddresses.Count -or $probeAddresses.Count -gt 64 -or @($probeAddresses|Where-Object{!(Test-PublicAddress $_)}).Count){throw 'Destination policy denied'}
  $probeV4=@($probeAddresses|Where-Object{$_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork}|Select-Object -First 2)
  $probeAddress=$probeV4|Select-Object -First 1
  $probeResult['resolvedAddressCount']=$probeAddresses.Count
  $probeResult['testedAddressCount']=$probeV4.Count
  if(!$probeAddress){throw 'No supported pinned IPv4 address'}
  if($Direct){
    $probeResult['testedAddressCount']=1
    $probeResult['explicitProxyBypassedForDiagnostic']=$true
    $probeDirect=@{client='dotnet-direct';stage='tcp';verifiedTls=$false;httpStatus=0}
    $probeTcp=[Net.Sockets.TcpClient]::new()
    try {
      if(!$probeTcp.ConnectAsync($probeAddress,443).Wait(10000)){throw 'Pinned direct TCP timeout'}
      $probeStream=$probeTcp.GetStream();$probeStream.ReadTimeout=10000;$probeStream.WriteTimeout=10000
      $probeDirect['stage']='tls';$probeSsl=[Net.Security.SslStream]::new($probeStream,$false)
      try {
        $probeSsl.ReadTimeout=10000;$probeSsl.WriteTimeout=10000;$probeSsl.AuthenticateAsClient($probeOriginHost);$probeDirect['verifiedTls']=$true
        $probeDirect['stage']='origin_http';$probeBytes=[Text.Encoding]::ASCII.GetBytes("GET $probeOriginPath HTTP/1.1`r`nHost: $probeOriginHost`r`nConnection: close`r`n`r`n");$probeSsl.Write($probeBytes,0,$probeBytes.Length)
        $probeHeader=Read-Header $probeSsl;if($probeHeader -match '^HTTP/1\.[01] (\d{3})'){$probeDirect['httpStatus']=[int]$Matches[1]}
      } finally {$probeSsl.Dispose()}
    } catch {$probeTypes=@();$probeCodes=@();$probeFailure=$_.Exception;while($probeFailure){$probeTypes+=$probeFailure.GetType().Name;if($probeFailure.PSObject.Properties['NativeErrorCode']){$probeCodes+=$probeFailure.NativeErrorCode};$probeFailure=$probeFailure.InnerException};$probeDirect['errorTypes']=$probeTypes;$probeDirect['nativeCodes']=$probeCodes}
    finally {$probeTcp.Dispose()}
    $probeResult.controls+= $probeDirect;$probeResult|ConvertTo-Json -Depth 6 -Compress;return
  }
  $probeKey=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Internet Settings',$false)
  if(!$probeKey){throw 'Static system policy is unavailable'}
  try {
    if([int]$probeKey.GetValue('ProxyEnable',0) -eq 0){throw 'No enabled static system proxy'}
    $probeRaw=[string]$probeKey.GetValue('ProxyServer','')
    $probeBypass=[string]$probeKey.GetValue('ProxyOverride','')
    $probeSelected=$probeRaw
    if($probeRaw.Contains('=')) {
      $probeMappings=@{};foreach($probePart in $probeRaw.Split(';')){if($probePart.Contains('=')){$probePair=$probePart.Split('=',2);$probeMappings[$probePair[0].Trim()]=$probePair[1].Trim()}}
      $probeSelected=$probeMappings['https']
      if(!$probeSelected){throw 'No static HTTPS proxy mapping'}
    }
    if(!$probeSelected.Contains('://')){$probeSelected='http://'+$probeSelected}
    $probeProxy=[Uri]$probeSelected
    if($probeProxy.Scheme -ne 'http'){throw 'Diagnostic supports HTTP CONNECT only'}
    $probeResult['bypassAppliesToFixedHost']=@($probeBypass.Split(';')|Where-Object{$_ -and $probeOriginHost -like $_}).Count -gt 0
  } finally {$probeKey.Dispose()}
  if($HostnameConnect){
    if($probeProxy.UserInfo){throw 'Credential-bearing proxy is outside this diagnostic'}
    if($probeResult.bypassAppliesToFixedHost){throw 'The fixed URL bypasses the system proxy'}
    $probeResult['dnsPinned']=$false
    $probeResult['route']='static-system-proxy/hostname-CONNECT'
    $probeResult['credentialsSent']=$false
    $probeResult['curlReadAttempts']=1
    $probeResult['testedAddressCount']=0
    $probeStart=[Diagnostics.ProcessStartInfo]::new()
    $probeStart.FileName=Join-Path $env:SystemRoot 'System32\curl.exe'
    $probeStart.UseShellExecute=$false
    $probeStart.RedirectStandardOutput=$true
    $probeStart.RedirectStandardError=$true
    $probeFormat='{"httpStatus":%{http_code},"connectStatus":%{http_connect},"sslVerifyResult":%{ssl_verify_result},"timeTls":%{time_appconnect}}'
    # The single control leaves CONNECT authority and TLS defaults to system curl.
    $probeStart.Arguments='-q --silent --retry 0 --connect-timeout 10 --max-time 20 --max-redirs 0 --output NUL --write-out '+([char]34)+$probeFormat.Replace('"','\"')+([char]34)+' https://docs.python.org/3/library/asyncio.html'
    $probeStart.EnvironmentVariables['HTTPS_PROXY']=$probeProxy.AbsoluteUri
    $probeStart.EnvironmentVariables['NO_PROXY']=''
    $probeStart.EnvironmentVariables['no_proxy']=''
    $probeProcess=[Diagnostics.Process]::Start($probeStart)
    try {
      $probeOutput=$probeProcess.StandardOutput.ReadToEnd()
      $null=$probeProcess.StandardError.ReadToEnd()
      $probeProcess.WaitForExit()
      $probeCurl=$probeOutput|ConvertFrom-Json
      $category=switch($probeProcess.ExitCode){0{'none'}35{'tls_handshake'}60{'certificate_validation'}56{'receive'}28{'timeout'}5{'proxy_resolution'}6{'origin_resolution'}7{'connect'}default{'other'}}
      $probeResult.controls+=@{client='system-curl-hostname';exitCode=$probeProcess.ExitCode;httpStatus=$probeCurl.httpStatus;connectStatus=$probeCurl.connectStatus;verifiedTls=($probeProcess.ExitCode -eq 0 -and $probeCurl.timeTls -gt 0 -and $probeCurl.sslVerifyResult -eq 0);errorCategory=$category}
    } finally {$probeProcess.Dispose()}
    $probeResult|ConvertTo-Json -Depth 6 -Compress
    return
  }
  $probeOrdinal=0
  foreach($probeAddress in $probeV4){
  $probeControl=@{client='dotnet';addressOrdinal=$probeOrdinal;stage='proxy_tcp';connectStatus=0;httpStatus=0;verifiedTls=$false};$probeOrdinal++
  $probeStage='proxy_tcp'
  $probeTcp=[Net.Sockets.TcpClient]::new()
  try {
    if(!$probeTcp.ConnectAsync($probeProxy.DnsSafeHost,$probeProxy.Port).Wait(10000)){throw 'Proxy TCP timeout'}
    $probeStream=$probeTcp.GetStream();$probeStream.ReadTimeout=10000;$probeStream.WriteTimeout=10000
    $probeStage='proxy_connect'
    $probeAuthority=$probeAddress.ToString()+':443'
    $probeRequest="CONNECT $probeAuthority HTTP/1.1`r`nHost: $probeAuthority`r`n"
    if($probeProxy.UserInfo){$probeAuth=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Uri]::UnescapeDataString($probeProxy.UserInfo)));$probeRequest+="Proxy-Authorization: Basic $probeAuth`r`n"}
    $probeBytes=[Text.Encoding]::ASCII.GetBytes($probeRequest+"`r`n");$probeStream.Write($probeBytes,0,$probeBytes.Length)
    $probeHeader=Read-Header $probeStream
    $probeStatus=if($probeHeader -match '^HTTP/1\.[01] (\d{3})'){[int]$Matches[1]}else{0}
    $probeControl['connectStatus']=$probeStatus
    if($probeStatus -eq 200){
      $probeStage='tls';$probeSsl=[Net.Security.SslStream]::new($probeStream,$false)
      try {
        $probeSsl.ReadTimeout=10000;$probeSsl.WriteTimeout=10000;$probeSsl.AuthenticateAsClient($probeOriginHost);$probeControl['verifiedTls']=$true
        $probeStage='origin_http';$probeBytes=[Text.Encoding]::ASCII.GetBytes("GET $probeOriginPath HTTP/1.1`r`nHost: $probeOriginHost`r`nConnection: close`r`n`r`n");$probeSsl.Write($probeBytes,0,$probeBytes.Length)
        $probeHeader=Read-Header $probeSsl
        if($probeHeader -match '^HTTP/1\.[01] (\d{3})'){$probeControl['httpStatus']=[int]$Matches[1]}
      } finally {$probeSsl.Dispose()}
    }
    $probeControl['stage']=$probeStage;$probeResult.controls+=$probeControl
  } catch { $probeControl['stage']=$probeStage;$probeTypes=@();$probeCodes=@();$probeFailure=$_.Exception;while($probeFailure){$probeTypes+=$probeFailure.GetType().Name;if($probeFailure.PSObject.Properties['NativeErrorCode']){$probeCodes+=$probeFailure.NativeErrorCode};$probeFailure=$probeFailure.InnerException};$probeControl['errorTypes']=$probeTypes;$probeControl['nativeCodes']=$probeCodes;$probeResult.controls+=$probeControl }
  finally {$probeTcp.Dispose()}
  }
  $probeAddress=$probeV4|Select-Object -First 1
  $probeStart=[Diagnostics.ProcessStartInfo]::new();$probeStart.FileName=Join-Path $env:SystemRoot 'System32\curl.exe';$probeStart.UseShellExecute=$false;$probeStart.RedirectStandardOutput=$true;$probeStart.RedirectStandardError=$true
  $probeFormat='{"httpStatus":%{http_code},"connectStatus":%{http_connect},"sslVerifyResult":%{ssl_verify_result},"timeConnect":%{time_connect},"timeTls":%{time_appconnect},"timeTotal":%{time_total}}'
  $probeStart.Arguments='-q --silent --retry 0 --connect-timeout 10 --max-time 20 --max-redirs 0 --output NUL --connect-to '+$probeOriginHost+':443:'+$probeAddress.ToString()+':443 --write-out '+([char]34)+$probeFormat.Replace('"','\"')+([char]34)+' https://'+$probeOriginHost+$probeOriginPath
  $probeStart.EnvironmentVariables['HTTPS_PROXY']=$probeProxy.AbsoluteUri;$probeStart.EnvironmentVariables['NO_PROXY']='';$probeStart.EnvironmentVariables['no_proxy']=''
  $probeProcess=[Diagnostics.Process]::Start($probeStart);$probeOutput=$probeProcess.StandardOutput.ReadToEnd();$null=$probeProcess.StandardError.ReadToEnd();$probeProcess.WaitForExit()
  try {$probeCurl=$probeOutput|ConvertFrom-Json;$probeResult.controls+=@{client='system-curl';exitCode=$probeProcess.ExitCode;httpStatus=$probeCurl.httpStatus;connectStatus=$probeCurl.connectStatus;sslVerifyResult=$probeCurl.sslVerifyResult;timeConnect=$probeCurl.timeConnect;timeTls=$probeCurl.timeTls;timeTotal=$probeCurl.timeTotal}}catch{$probeResult.controls+=@{client='system-curl';exitCode=$probeProcess.ExitCode;stage='redacted_output_unavailable'}}finally{$probeProcess.Dispose()}
} catch {$probeResult['setupErrorType']=$_.Exception.GetType().Name}
$probeResult|ConvertTo-Json -Depth 6 -Compress
