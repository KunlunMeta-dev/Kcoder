param(
 [Parameter(Mandatory=$true)][string]$ProcessFixture,
 [Parameter(Mandatory=$true)][string]$RepairScript,
 [string]$InstallerFixture = '',
 [switch]$ReproduceStaleExitCode
)
$ErrorActionPreference='Stop'
function Test-SimpleParameter { param($Value) return @{value=$Value;remaining=@($args)} }
$simple=Test-SimpleParameter -Value 'owned' -ErrorAction Stop
if($simple.value -cne 'owned' -or ($simple.remaining -join ',') -cne '-ErrorAction,Stop'){throw 'Simple function argument semantics changed'}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($ProcessFixture,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Process fixture syntax invalid'}
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-CimInstance'},$true)
if(!$definition){throw 'CIM fixture function missing'}
Set-Item Function:Get-CimInstance $definition.Body.GetScriptBlock()
$script:fixtures=@([pscustomobject]@{ProcessId=42})
$result=Get-CimInstance Win32_Process -Filter 'ProcessId=42' -ErrorAction SilentlyContinue
if($result.ProcessId -ne 42){throw 'Actual CIM fixture did not execute'}
$strictQueries=0
foreach($query in @(@('Other_Class','ProcessId=42'),@('Win32_Process',"Name='peer'"))){
 try { Get-CimInstance $query[0] -Filter $query[1]|Out-Null }
 catch { if($_.Exception.Message -notlike 'Unexpected CIM fixture*'){throw};$strictQueries++ }
}
if($strictQueries -ne 2){throw 'Unexpected CIM queries were silently accepted'}
$helper=Join-Path ([IO.Path]::GetDirectoryName($RepairScript)) 'close-installed-processes.ps1'
$helperAst=[Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Process helper syntax invalid'}
$close=$helperAst.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Close-KCoderInstallationProcesses'},$true)
. ([scriptblock]::Create($close.Extent.Text))
foreach($name in @('Stop-KCoderInstallationTasks','Assert-Fixture')){
 $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
 . ([scriptblock]::Create($function.Extent.Text))
}
$fixtureSid='S-1-5-21-101-102-103-104'
$excluded=[Collections.Generic.HashSet[int]]::new();$script:expectedExcluded=$excluded
$script:fenceCount=0;$script:mechanismEvents=@()
$processSource=Get-Content -LiteralPath $ProcessFixture -Raw
$restart=$processSource.IndexOf('# An owned process can restart')
if($restart -lt 0){throw 'Restart fixture section missing'}
# Only the original mock-backed restart section is executed; Windows path/CIM/kill are not emulated.
. ([scriptblock]::Create($processSource.Substring($restart)))
if($script:fenceCount -ne 3){throw 'Restart mechanism fences did not all execute'}
$restartFences=$script:fenceCount
$source=Get-Content -LiteralPath $RepairScript -Raw
$match=[regex]::Match($source,"(?s)Add-Type @'\r?\n(.*?)\r?\n'@")
if(!$match.Success){throw 'Actual repair type definition missing'}
Add-Type -TypeDefinition $match.Groups[1].Value
$repeat='accepted'
try { Add-Type -TypeDefinition $match.Groups[1].Value } catch { $repeat='rejected' }
if($InstallerFixture){
 $installer=[Management.Automation.Language.Parser]::ParseFile($InstallerFixture,[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'Installer fixture syntax invalid'}
 foreach($name in @('Quote-RepairArgument','Invoke-RepairFixture')){
  $function=$installer.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  if(!$function){throw 'Isolated repair invocation helper missing'}
  . ([scriptblock]::Create($function.Extent.Text))
 }
 $probe=Join-Path ([IO.Path]::GetTempPath()) ('kcoder-powershell-arguments-'+[Guid]::NewGuid().ToString('N'))
 $actualRepairScript=$RepairScript
 try {
  New-Item -ItemType Directory -Path $probe|Out-Null
  $RepairScript=Join-Path $probe 'repair stub.ps1'
  Set-Content -LiteralPath $RepairScript -Encoding utf8 -Value @'
param([string]$Value)
Add-Type 'public class KCoderInstallerIsolatedProbe {}'
Write-Output ($PID.ToString()+'|'+$Value)
'@
  $global:LASTEXITCODE=9
  & $RepairScript -Value 'owned'|Out-Null
  $staleExit=$LASTEXITCODE
  if($staleExit -ne 9){throw 'Managed script unexpectedly reset native exit code'}
  if($ReproduceStaleExitCode -and $LASTEXITCODE){throw 'Legacy repair failed check misclassified a successful script'}
  $engineName=if([Environment]::OSVersion.Platform -eq 'Win32NT'){'pwsh.exe'}else{'pwsh'}
  if($PSVersionTable.PSVersion.Major -lt 6){$engineName='powershell.exe'}
  $script:repairEngine=Join-Path $PSHOME $engineName
  $childPids=@();$value='space "quote" backslash\'
  for($i=0;$i -lt 3;$i++){
   $child=Invoke-RepairFixture -Arguments @('-Value',$value)
   if($child.ExitCode -ne 0){throw ('Owned stub failed: '+$child.Error)}
   $fields=$child.Output.Trim() -split '\|',2
   if($fields.Count -ne 2 -or $fields[1] -cne $value){throw 'Child argument quoting changed data'}
   $childPids+=@($fields[0])
  }
  if(@($childPids|Select-Object -Unique).Count -ne 3){throw 'Repair invocations reused a process'}
 } finally { $RepairScript=$actualRepairScript;Remove-Item -LiteralPath $probe -Recurse -Force }
}
[pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;
 simpleUnknownArgumentsAccepted=$true;actualCimMockExecuted=$true;repeatActualTypeDefinition=$repeat;
 rejectedUnexpectedCimQueries=$strictQueries;
 restartMechanismFences=$restartFences;
 staleNativeExitCode=$staleExit;isolatedRepairProcesses=@($childPids).Count;
 windowsNativeAcceptance=$false}|ConvertTo-Json -Compress
