param(
  [Parameter(Mandatory=$true)][string]$HelperPath,
  [Parameter(Mandatory=$true)][string]$Root
)
$ErrorActionPreference='Stop'
. $HelperPath
$checks=0
function Assert-True($Condition,[string]$Message){if(!$Condition){throw $Message};$script:checks++}
function Assert-Rejected([scriptblock]$Action,[string]$Message){
  $rejected=$false
  try{& $Action|Out-Null}catch{$rejected=$true}
  Assert-True $rejected $Message
}
function New-Package([string]$Directory,[string]$Commit){
  [IO.Directory]::CreateDirectory((Join-Path $Directory 'resources'))|Out-Null
  [IO.File]::WriteAllText((Join-Path $Directory 'kcoder-studio.exe'),'Inert synthetic host bytes; never executed.')
  $metadata=@{packagingSource=@{commit=$Commit;dirty=$false};kind='studio-desktop';platform='win32'}|ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $Directory 'resources\kcoder-release-manifest.json'),$metadata,[Text.UTF8Encoding]::new($false))
  return $Directory
}
function Pins([string]$Directory,[string]$Explicit,[string]$Commit){
  return [pscustomobject]@{installedDirectory=$Explicit;expectedCommit=$Commit
    manifestSha256=(Get-FileHash -LiteralPath (Join-Path $Directory 'resources\kcoder-release-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    hostSha256=(Get-FileHash -LiteralPath (Join-Path $Directory 'kcoder-studio.exe') -Algorithm SHA256).Hash.ToLowerInvariant()}
}
if(!(Test-Path -LiteralPath $Root -PathType Container)){throw 'Owned data fixture root is required'}
if(@(Get-ChildItem -LiteralPath $Root -Force).Count){throw 'Data fixture root must start empty'}
$commit='1234567890abcdef1234567890abcdef12345678'
$good=New-Package (Join-Path $Root 'registered-package') $commit
$explicit=New-Package (Join-Path $Root 'explicit-package') $commit
$missing=Join-Path $Root 'removed-installation'
$script:registered=$good
$script:registryReads=0
# Every call injects only fixture data. The real HKCU registry is never read or changed.
$read={ $script:registryReads++; return $script:registered }
$configuration=Pins $good $missing $commit
$resolved=Resolve-KCoderInstalledDirectory -Configuration $configuration -ReadCurrentUserInstallLocation $read
Assert-True ($resolved -eq $good) 'A missing old path must resolve only the pinned registered copy'
Assert-True ($script:registryReads -eq 1) 'Relocation must use exactly one registered candidate'
$script:registryReads=0
$direct=Pins $explicit $explicit $commit
Assert-True ((Resolve-KCoderInstalledDirectory -Configuration $direct -ReadCurrentUserInstallLocation {throw 'Registry must not be consulted'}) -eq $explicit) 'The explicit existing directory must win'
foreach($field in @('manifestSha256','hostSha256','expectedCommit')){
  $changed=Pins $good $missing $commit
  $changed.$field=if($field -eq 'expectedCommit'){'0'*40}else{'0'*64}
  Assert-Rejected {Resolve-KCoderInstalledDirectory -Configuration $changed -ReadCurrentUserInstallLocation $read} ('Wrong pinned '+$field+' was accepted')
}
$other=New-Package (Join-Path $Root 'different-package') ('a'*40)
$script:registered=$other
Assert-Rejected {Resolve-KCoderInstalledDirectory -Configuration $configuration -ReadCurrentUserInstallLocation $read} 'Another package must not replace the requested artifact'
foreach($candidate in @('', 'relative\package', 'C:relative', '\\unrequested-host\share')){
  $script:registered=$candidate
  Assert-Rejected {Resolve-KCoderInstalledDirectory -Configuration $configuration -ReadCurrentUserInstallLocation $read} 'Registered candidate must be an absolute local directory'
}
$script:registered=$good
$file=Join-Path $Root 'existing-file'
[IO.File]::WriteAllText($file,'Fixture file, not a directory.')
$invalid=Pins $good $file $commit
$script:registryReads=0
Assert-Rejected {Resolve-KCoderInstalledDirectory -Configuration $invalid -ReadCurrentUserInstallLocation $read} 'An existing invalid explicit path must fail without fallback'
Assert-True ($script:registryReads -eq 0) 'Invalid existing explicit input must not consult the registry'
$child=New-Package (Join-Path $good 'nested-package') $commit
$junction=Join-Path $Root 'registered-junction'
try{
  New-Item -ItemType Junction -Path $junction -Target $good -ErrorAction Stop|Out-Null
  $script:registered=$junction
  Assert-Rejected {Resolve-KCoderInstalledDirectory -Configuration $configuration -ReadCurrentUserInstallLocation $read} 'A registered junction must be rejected'
  $script:registered=Join-Path $junction 'nested-package'
  $nested=Pins $child $missing $commit
  Assert-Rejected {Resolve-KCoderInstalledDirectory -Configuration $nested -ReadCurrentUserInstallLocation $read} 'A registered directory below a junction must be rejected'
  $invalid=Pins $good $junction $commit
  $script:registryReads=0
  Assert-Rejected {Resolve-KCoderInstalledDirectory -Configuration $invalid -ReadCurrentUserInstallLocation $read} 'An explicit junction must not trigger fallback'
  Assert-True ($script:registryReads -eq 0) 'An existing explicit junction must fail before registry access'
  $invalid=Pins $good (Join-Path $junction 'missing-installation') $commit
  Assert-Rejected {Resolve-KCoderInstalledDirectory -Configuration $invalid -ReadCurrentUserInstallLocation $read} 'A missing leaf below an explicit junction must not trigger fallback'
  Assert-True ($script:registryReads -eq 0) 'An unsafe explicit ancestor must fail before registry access'
}finally{if(Test-Path -LiteralPath $junction){[IO.Directory]::Delete($junction)}}
Write-Output ('PASS: actual Windows installed-directory fixture; checks='+$checks+'; registry writes=0; executables started=0')
