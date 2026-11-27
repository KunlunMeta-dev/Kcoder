import assert from "node:assert/strict";
import { waitForStdioChildClose } from "./app-server-stdio.mjs";
import { runE2E } from "./run-context.mjs";

const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
assert.match(target ?? "", /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/);
const script = String.raw`
$ErrorActionPreference='Stop'
$node='C:\Program Files\nodejs\node.exe'
$studio='C:\Users\cyx\AppData\Local\Programs\kcoder-studio'
$helper=Join-Path $studio 'resources\bin\kcoder-process-supervisor.exe'
$files=@($node,$helper)|ForEach-Object{
  $path=$_
  if(!(Test-Path -LiteralPath $path -PathType Leaf)){[pscustomobject]@{path=$path;present=$false}}
  else{$item=Get-Item -LiteralPath $path;[pscustomobject]@{path=$path;present=$true;bytes=$item.Length;attributes=[string]$item.Attributes;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();fileVersion=$item.VersionInfo.FileVersion;lastWriteUtc=$item.LastWriteTimeUtc.ToString('o')}}
}
@{version=1;readOnly=$true;computer=$env:COMPUTERNAME;identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;temporaryRoot=$env:TEMP;files=@($files);cliStarted=$false;desktopAccessed=$false;globalEnvironmentChanged=$false}|ConvertTo-Json -Depth 5 -Compress
`;
await runE2E(import.meta.url, { testId: "windows-headless-protocol-read-only-preflight", tier: "host-preflight",
  modelPolicy: "Authorized read-only Node/supervisor identity inventory; no CLI, Windows account, desktop, scheduled task or configuration changes." }, async context => {
  const label = "windows-protocol-read-only";
  const child = context.spawnOwned(label, "ssh", ["-T", "-S", "none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=8", target,
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  { env: context.isolatedEnvironment() });
  let output = "", bytes = 0;
  child.stdout.on("data", data => { bytes += data.length; if (bytes <= 32768) output += data; });
  const closed = await waitForStdioChildClose(child, 20000, label);
  await context.stopOwned(label);
  assert.equal(closed.code, 0); assert.equal(closed.signal, null); assert.ok(bytes <= 32768);
  const result = JSON.parse(output.trim().replace(/^\uFEFF/, ""));
  assert.equal(result.readOnly, true);
  await context.writeArtifactJson("windows-protocol-preflight.json", result);
  return result;
});
