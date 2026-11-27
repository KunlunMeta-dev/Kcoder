param([Parameter(Mandatory=$true)][string]$OwnedRoot)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Path $OwnedRoot -Force|Out-Null
function Assert-Owned($Condition,[string]$Message){if(-not $Condition){throw $Message}}
$sourcePath=Join-Path $PSScriptRoot 'windows-owned-input.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$errors)
Assert-Owned ($errors.Count -eq 0) 'Recovery source has PowerShell parser errors'
$nativeSource=[regex]::Match((Get-Content -Raw -LiteralPath $sourcePath),"(?s)Add-Type -TypeDefinition @'\r?\n(.*?)\r?\n'@")
Assert-Owned $nativeSource.Success 'Native input declarations are missing'
Add-Type -TypeDefinition $nativeSource.Groups[1].Value
foreach($name in @('Set-OwnedInputField','Write-OwnedInputCheckpoint','Invoke-OwnedInputRecovery')){
  $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
  Assert-Owned ($null -ne $function) ('Recovery function missing: '+$name)
  Invoke-Expression $function.Extent.Text
}

# Execute only the old restore branch with managed ports, never user32.dll.
Add-Type @'
using System;
public static class OwnedInputLegacyProbe {
  public static int LayoutCalls,ForegroundCalls,PointerCalls;
  public static string Run(uint pid,string action,int x,int y,string text){throw new Exception("CONTROLLED_ESCAPE_FAILURE");}
  public static void RestoreLayout(IntPtr target,uint owner,IntPtr layout){LayoutCalls++;}
  public static bool Restore(IntPtr window,uint owner){ForegroundCalls++;return true;}
  public static bool SetCursorPos(int x,int y){PointerCalls++;return true;}
}
'@
$legacy=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'fixtures/windows-owned-input-v1.ps1.txt')
$legacyBlock=$legacy.Substring($legacy.IndexOf("if(`$Action -eq 'restore'){"))
$legacyBlock=$legacyBlock.Substring(0,$legacyBlock.IndexOf("if(-not(Test-Path -LiteralPath `$focusFile))"))
$focusFile=Join-Path $OwnedRoot 'legacy.json'
[IO.File]::WriteAllText($focusFile,'{"imeToggled":true,"layout":123,"target":1,"targetOwner":42,"handle":2,"owner":43,"pointerX":4,"pointerY":5}')
$Action='restore';$ProcessId=42;$legacyFailed=$false
try {Invoke-Expression ($legacyBlock.Replace('[OwnedWindowsInput]','[OwnedInputLegacyProbe]'))} catch {$legacyFailed=$true}
Assert-Owned $legacyFailed 'Legacy branch did not reproduce the first-step failure'
Assert-Owned ([OwnedInputLegacyProbe]::LayoutCalls -eq 0 -and [OwnedInputLegacyProbe]::ForegroundCalls -eq 0 -and [OwnedInputLegacyProbe]::PointerCalls -eq 0) 'Legacy branch unexpectedly restored later steps'

$observations=[Collections.Generic.List[object]]::new()
foreach($scenario in @('escape-failed','toggle-failed','ime-ack-only','forward-ime-unknown','restore-input-inflight','target-exited','layout-refused','foreground-refused','pointer-refused','no-ime','legacy')){
  $path=Join-Path $OwnedRoot ($scenario+'.json')
  $state=[pscustomobject]@{version=2;ownedProcessId=42;ownedProcessStartTicks='original-start';imeToggleState='completed';imeToggled=$true;layout=123;target=1;targetOwner=42;handle=2;owner=43;pointerX=4;pointerY=5}
  if($scenario -in @('layout-refused','foreground-refused','pointer-refused','no-ime')){$state.imeToggleState='none';$state.imeToggled=$false}
  if($scenario -eq 'forward-ime-unknown'){$state.imeToggleState='started'}
  if($scenario -eq 'restore-input-inflight'){Set-OwnedInputField $state 'restoreSteps' ([pscustomobject]@{ime='started'})}
  if($scenario -eq 'legacy'){$state.PSObject.Properties.Remove('version')}
  Write-OwnedInputCheckpoint $path $state
  $calls=[Collections.Generic.List[string]]::new()
  $backend=@{
    escape={$calls.Add('escape');if($scenario -eq 'escape-failed'){throw 'controlled escape failure'}}
    toggle={$calls.Add('toggle');if($scenario -eq 'toggle-failed'){throw 'controlled toggle failure'}}
    layout={param($value) $calls.Add('layout');return $scenario -ne 'layout-refused'}
    foreground={param($value) $calls.Add('foreground');return $scenario -ne 'foreground-refused'}
    pointer={param($value) $calls.Add('pointer');return $scenario -ne 'pointer-refused'}
  }
  $receipt=Invoke-OwnedInputRecovery $path ($scenario -ne 'target-exited') 42 'original-start' $backend
  Assert-Owned ($calls.Contains('layout') -and $calls.Contains('foreground') -and $calls.Contains('pointer')) ('Independent restoration skipped: '+$scenario+' '+($receipt|ConvertTo-Json -Depth 5 -Compress))
  if($scenario -eq 'no-ime'){
    Assert-Owned ($receipt.restored -and -not(Test-Path -LiteralPath $path)) 'Confirmed non-IME restoration retained its marker'
  } else {
    Assert-Owned (-not $receipt.restored -and $receipt.markerRetained) ('Unknown restoration lost its marker: '+$scenario)
    $before=$calls.Count
    [void](Invoke-OwnedInputRecovery $path ($scenario -ne 'target-exited') 42 'original-start' $backend)
    Assert-Owned ($calls.Count -eq $before) ('A prior attempted step was replayed: '+$scenario)
  }
  if($scenario -in @('forward-ime-unknown','restore-input-inflight','target-exited','legacy')){Assert-Owned (-not $calls.Contains('escape') -and -not $calls.Contains('toggle')) 'Unknown original IME input was replayed'}
  $observations.Add([pscustomobject]@{scenario=$scenario;restored=$receipt.restored;outcome=$receipt.outcome;steps=$receipt.steps;markerRetained=$receipt.markerRetained;calls=$calls.ToArray()})
}
[pscustomobject]@{legacyFirstStepFailureReproduced=$true;nativeDeclarationsCompiled=$true;cases=$observations;nativeWindowsInput=$false;user32Calls=0}|ConvertTo-Json -Depth 8 -Compress
