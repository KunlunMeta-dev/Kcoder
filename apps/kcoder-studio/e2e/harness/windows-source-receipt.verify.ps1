param(
  [Parameter(Mandatory=$true)][string]$SourcePath,
  [Parameter(Mandatory=$true)][string]$Root
)
$ErrorActionPreference='Stop'
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($SourcePath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Private desktop source has syntax errors'}
# Load only the trusted versioned publication functions, without starting a desktop.
foreach($name in @('Assert-OwnedPath','Publish-Receipt')){
  $functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$false))
  if($functions.Count -ne 1){throw 'Private desktop publication function is missing'}
  . ([ScriptBlock]::Create($functions[0].Extent.Text))
}
$root=[IO.Path]::GetFullPath($Root).TrimEnd('\')
$receipt=Join-Path $root 'receipt.json'
foreach($phase in @('desktop-created','process-started','ready')){
  Publish-Receipt @{version=1;owner='receipt-fixture'} $phase
}
$current=Get-Content -LiteralPath $receipt -Raw|ConvertFrom-Json
if($current.phase -ne 'ready' -or $current.owner -ne 'receipt-fixture'){throw 'Receipt publication did not retain the latest phase'}
$previous=@(Get-ChildItem -LiteralPath $root -Filter '*.previous' -File|ForEach-Object {(Get-Content -LiteralPath $_.FullName -Raw|ConvertFrom-Json).phase}|Sort-Object)
if(($previous -join ',') -ne 'desktop-created,process-started'){throw 'Prior receipt phases were not retained atomically'}
if(@(Get-ChildItem -LiteralPath $root -Filter '*.tmp' -File).Count){throw 'Receipt publication left a temporary file'}
Write-Output 'PASS: actual PowerShell receipt creation, atomic replacement and previous phases'
