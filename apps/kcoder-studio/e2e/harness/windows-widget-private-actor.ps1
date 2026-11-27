param([Parameter(Mandatory=$true)][string]$Configuration)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$config=Get-Content -LiteralPath $Configuration -Raw -Encoding UTF8|ConvertFrom-Json
$owner=$null
try {
 Add-Type -Path $config.desktopSource -OutputAssembly $config.assembly -OutputType Library
 $null=[Reflection.Assembly]::LoadFrom($config.assembly)
 $owner=[KcoderSourceDesktopOwner]::new([string]$config.owner,[uint32]$config.sessionId)
 $body='& ([ScriptBlock]::Create([IO.File]::ReadAllText('''+([string]$config.actor).Replace("'","''")+'''))) -Configuration '''+([string]$config.actorConfiguration).Replace("'","''")+''''
 $arguments=@('-NoProfile','-NonInteractive','-EncodedCommand',[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body)))
 $owner.Start(($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe'),$arguments,[string]$config.root)
 $owner.Snapshot()|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $config.birth -Encoding UTF8
 $deadline=[DateTime]::UtcNow.AddMinutes(8)
 while($owner.IsRunning()){
  if([DateTime]::UtcNow -gt $deadline){throw 'Owned registered suite actor exceeded its original deadline'}
  Start-Sleep -Milliseconds 50
 }
} finally {
 if($owner){$owner.Dispose();$owner.Snapshot()|ConvertTo-Json -Depth 12|Set-Content -LiteralPath $config.released -Encoding UTF8}
}
