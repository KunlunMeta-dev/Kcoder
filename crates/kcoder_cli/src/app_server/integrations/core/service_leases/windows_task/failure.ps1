# Only fixed stages, HRESULT and bounded exception digests leave this script.
$stage = 'fixed_task'
if ($kcoderTaskStage -and @('decode','current_sid','service_connect','folder_open','read_existing','construct','assert_before_register','register','assert_registered','run') -ccontains $kcoderTaskStage) { $stage = $kcoderTaskStage }
$digests = @()
$exception = $_.Exception
$hresult = $exception.HResult
while ($null -ne $exception -and $digests.Count -lt 6) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $digests += ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($exception.Message)))).Replace('-','').ToLowerInvariant() }
  finally { $hash.Dispose() }
  $exception = $exception.InnerException
}
@{stage=$stage;hresult=$hresult;reasonSha256=$digests} | ConvertTo-Json -Depth 3 -Compress
exit 1
