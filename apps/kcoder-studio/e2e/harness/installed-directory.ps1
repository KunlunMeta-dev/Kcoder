# Resolve only the current user's registered copy of an externally pinned package.
function Ordinary-Directory([string]$Path, [switch]$AllowMissing) {
  if(!$Path -or ![IO.Path]::IsPathRooted($Path)){throw 'An absolute test directory is required'}
  $full=[IO.Path]::GetFullPath($Path)
  $leaf=$null
  $cursor=$full
  while($cursor){
    $item=$null
    try{$item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop}
    catch [System.Management.Automation.ItemNotFoundException]{if(!$AllowMissing){throw}}
    if($item){
      if(!$item.PSIsContainer){throw 'Test directory is not a directory'}
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Test directories cannot follow reparse points'}
      if($cursor -eq $full){$leaf=$item.FullName}
    }
    $parent=[IO.Path]::GetDirectoryName($cursor.TrimEnd('\'))
    if(!$parent -or $parent -eq $cursor){break}
    $cursor=$parent
  }
  return $leaf
}

function Get-KCoderInstalledIdentityFile([string]$Path) {
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){
    throw 'Installed identity input must be an ordinary file'
  }
  return $item.FullName
}

function Resolve-KCoderInstalledDirectory {
  param(
    [Parameter(Mandatory=$true)]$Configuration,
    [scriptblock]$ReadCurrentUserInstallLocation={
      $registration=Get-ItemProperty -LiteralPath 'HKCU:\Software\dde41fb5-2370-5338-807d-3f5c37c73fa3' -Name InstallLocation -ErrorAction Stop
      return [string]$registration.InstallLocation
    }
  )
  # An existing explicit path remains authoritative. Its complete resource and
  # single-link verification still belongs to verifyInstalledDesktop downstream.
  $explicit=Ordinary-Directory ([string]$Configuration.installedDirectory) -AllowMissing
  if($explicit){return $explicit}

  foreach($name in @('manifestSha256','hostSha256')){
    if($Configuration.$name -cnotmatch '^[a-f0-9]{64}$'){throw 'Explicit installed resource identities are required'}
  }
  if($Configuration.expectedCommit -cnotmatch '^[a-f0-9]{40}$'){throw 'Expected packaging commit is required'}
  $candidate=[string](& $ReadCurrentUserInstallLocation)
  if($candidate -cnotmatch '^[A-Za-z]:\\' -or $candidate -match '[\x00-\x1f]'){
    throw 'Registered installation must be an absolute local directory'
  }
  $registered=Ordinary-Directory $candidate
  $resources=Ordinary-Directory (Join-Path $registered 'resources')
  $manifest=Get-KCoderInstalledIdentityFile (Join-Path $resources 'kcoder-release-manifest.json')
  $hostFile=Get-KCoderInstalledIdentityFile (Join-Path $registered 'kcoder-studio.exe')
  if((Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Configuration.manifestSha256){
    throw 'Registered resource manifest differs from the pinned package'
  }
  if((Get-FileHash -LiteralPath $hostFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Configuration.hostSha256){
    throw 'Registered executable differs from the pinned package'
  }
  $metadata=Get-Content -LiteralPath $manifest -Raw -Encoding UTF8|ConvertFrom-Json
  if($metadata.packagingSource.commit -cne $Configuration.expectedCommit){
    throw 'Registered package is from a different source commit'
  }
  return $registered
}
