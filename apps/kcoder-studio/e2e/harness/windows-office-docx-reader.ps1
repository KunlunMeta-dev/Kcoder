param([Parameter(Mandatory=$true)][string]$OwnedRoot,[Parameter(Mandatory=$true)][string]$Document)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($OwnedRoot).TrimEnd('\')+'\'
$path=[IO.Path]::GetFullPath($Document)
if(!$path.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($path) -ne '.docx'){throw 'Owned DOCX required'}
$marker=Get-Content -LiteralPath (Join-Path $OwnedRoot '.owner.json') -Raw|ConvertFrom-Json
if($marker.owner -notmatch '^[a-f0-9-]{36}$'){throw 'Owned run marker required'}
if((Get-Item -LiteralPath $path).Length -gt 8MB){throw 'Bounded DOCX reader input exceeded'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($path)
try{
 $names=@($zip.Entries|ForEach-Object{$_.FullName})
 foreach($required in @('[Content_Types].xml','_rels/.rels','word/document.xml')){if($names -cnotcontains $required){throw 'Generated DOCX required ZIP part absent'}}
 if($names.Count -gt 1024 -or @($names|Where-Object{$_ -match '(^/|(^|/)\.\.(/|$)|vbaProject|activeX)'}).Count){throw 'Unexpected DOCX ZIP entry'}
 $entry=$zip.GetEntry('word/document.xml')
 if($entry.Length -gt 2MB){throw 'Document XML size exceeded'}
 $reader=[IO.StreamReader]::new($entry.Open())
 try{$xml=$reader.ReadToEnd()}finally{$reader.Dispose()}
 if(!$xml.Contains('1234.56') -or !$xml.Contains('responsible person pending confirmation')){throw 'Native document literal material missing'}
 @{structuralZipRead=$true;entryCount=$names.Count;documentXml=$true;literalMaterial=$true;applicationLayoutOrQualityClaim=$false}|ConvertTo-Json -Compress
}finally{$zip.Dispose()}
