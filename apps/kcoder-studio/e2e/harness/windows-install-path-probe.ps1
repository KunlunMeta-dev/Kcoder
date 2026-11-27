param([Parameter(Mandatory=$true)][string]$Script)
$ErrorActionPreference='Stop'
. $Script
$root='C:\KCoder Probe'
foreach($image in @('C:\KCoder Probe\kcoder-studio.exe','\\?\C:\KCoder Probe\kcoder-studio.exe','\\?\C:\KCoder Probe\resources\bin\kcoder.exe')){
  if(-not (Test-KCoderImageRoot $image @($root))){throw 'Same owned image was not recognized'}
}
foreach($image in @('C:\KCoder Probe-other\kcoder-studio.exe','\\?\C:\KCoder Probe-other\resources\bin\kcoder.exe')){
  if(Test-KCoderImageRoot $image @($root)){throw 'A sibling installation was selected'}
}
if((Get-KCoderNormalizedPath '\\?\UNC\server\share\KCoder') -cne '\\server\share\KCoder'){throw 'UNC identity changed'}
'Owned installation path checks passed'
