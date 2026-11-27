export function psLiteral(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw Error('Invalid PowerShell text');
  return "'" + value.replaceAll("'", "''") + "'";
}

export function ownedCreationScript(parent, owner) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner)) throw Error('Invalid native package owner');
  return `$parent=${psLiteral(parent)};if(!(Test-Path -LiteralPath $parent -PathType Container)){throw 'Explicit parent missing'};$p=Join-Path $parent 'kcoder-package-${owner}';if(Test-Path -LiteralPath $p){throw 'Owned path collision'};$created=$false;try{New-Item -ItemType Directory -Path $p -ErrorAction Stop|Out-Null;$created=$true;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;& icacls $p /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*'+$sid+':(OI)(CI)F')|Out-Null;if($LASTEXITCODE -ne 0){throw 'Could not isolate native package directory'};[IO.File]::WriteAllText((Join-Path $p '.owner.json'),'${JSON.stringify({ owner })}');ConvertTo-Json -InputObject $p -Compress}catch{if($created){[IO.Directory]::Delete($p,$true)};throw}`;
}
