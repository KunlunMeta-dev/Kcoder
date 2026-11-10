# Signed URLs remain in the owning SSH stdin and never enter argv or receipts.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$request=$null;$part=$null;$response=$null;$stream=$null;$file=$null
try {
  $request=[Console]::In.ReadToEnd()|ConvertFrom-Json
  if([string]$request.owner -notmatch '^[a-f0-9-]{36}$' -or [string]$request.leaf -notmatch '^[A-Za-z0-9_.-]+$' -or [string]$request.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Invalid private transfer descriptor'}
  $root=[IO.Path]::GetFullPath([string]$request.root)
  if((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Owned transfer root changed'}
  $owner=Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json
  if($owner.owner -cne [string]$request.owner){throw 'Private transfer ownership mismatch'}
  $bytes=[long]$request.bytes
  if($bytes -le 0 -or $bytes -gt 512MB){throw 'Private transfer size bound'}
  $uri=[Uri]::new([string]$request.url)
  if(!$uri.IsAbsoluteUri -or $uri.Scheme -cne 'https' -or $uri.UserInfo -or $uri.Fragment -or $uri.Host -cnotin @('release-assets.githubusercontent.com','objects.githubusercontent.com')){throw 'Private transfer host is outside the explicit asset allowlist'}
  $destination=Join-Path $root ([string]$request.leaf)
  if(Test-Path -LiteralPath $destination){throw 'Owned destination already exists'}
  $part=$destination+'.'+[string]$request.owner+'.part'
  $web=[Net.HttpWebRequest]::Create($uri);$web.Method='GET';$web.AllowAutoRedirect=$false;$web.Timeout=30000;$web.ReadWriteTimeout=30000;$web.UseDefaultCredentials=$false;$web.Credentials=$null;$web.PreAuthenticate=$false
  if($web.Proxy){$web.Proxy.Credentials=$null}
  $response=$web.GetResponse()
  $status=[int]$response.StatusCode
  if($status -ne 200){throw 'Private asset response was not complete'}
  if($response.ContentLength -ge 0 -and $response.ContentLength -ne $bytes){throw 'Private asset length mismatch'}
  $stream=$response.GetResponseStream();$file=[IO.File]::Open($part,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $buffer=New-Object byte[] 65536;$total=[long]0;$deadline=[DateTime]::UtcNow.AddMinutes(3)
  while(($count=$stream.Read($buffer,0,$buffer.Length)) -gt 0){$total+=$count;if($total -gt $bytes -or [DateTime]::UtcNow -gt $deadline){throw 'Private asset stream bound'};$file.Write($buffer,0,$count)}
  $file.Flush($true);$file.Dispose();$file=$null
  if($total -ne $bytes){throw 'Private asset was incomplete'}
  $actual=(Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash.ToLowerInvariant()
  if($actual -cne [string]$request.sha256){throw 'Private asset checksum mismatch'}
  [IO.File]::Move($part,$destination);$part=$null
  @{passed=$true;httpStatus=$status;bytes=$total;sha256=$actual;tlsVerification=$true;redirectFollowed=$false;urlPersisted=$false;userCredentialsSent=$false}|ConvertTo-Json -Compress
} catch {
  # Native errors may embed signed URLs; retain only type and numeric HTTP status.
  $status=$null
  if($_.Exception -is [Net.WebException] -and $_.Exception.Response){$status=[int]$_.Exception.Response.StatusCode}
  @{passed=$false;errorType=$_.Exception.GetType().Name;httpStatus=$status;urlPersisted=$false;rawErrorPersisted=$false}|ConvertTo-Json -Compress
  exit 1
} finally {
  if($file){$file.Dispose()};if($stream){$stream.Dispose()};if($response){$response.Dispose()}
  if($part -and (Test-Path -LiteralPath $part)){[IO.File]::Delete($part)}
}
