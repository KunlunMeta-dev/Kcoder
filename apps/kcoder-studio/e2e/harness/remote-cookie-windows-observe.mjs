import assert from "node:assert/strict";
import { waitForStdioChildClose } from "./app-server-stdio.mjs";
import { runE2E } from "./run-context.mjs";

const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
assert.match(target ?? "", /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/);
const owner = "873658ed-7105-433d-ae67-1d867e13330e";
const root = "C:\\Users\\cyx\\AppData\\Local\\Temp\\kcoder-package-" + owner;
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const identityScript = "const s=require('node:fs').lstatSync(process.argv[1],{bigint:true});console.log(JSON.stringify({dev:String(s.dev),ino:String(s.ino)}));";
const script = `$ErrorActionPreference='Stop';$root=${quote(root)};$owner=${quote(owner)};
$marker=Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json;if($marker.owner -cne $owner){throw 'Original owner changed'}
$id=(& 'C:\\Program Files\\nodejs\\node.exe' -e ${quote(identityScript)} $root)|ConvertFrom-Json
if($id.dev -cne '3631862777' -or $id.ino -cne '5910974511267760'){throw 'Original root file identity changed'}
$status=@();$directory=Join-Path $root 'job-status';if(Test-Path -LiteralPath $directory){foreach($f in @(Get-ChildItem -LiteralPath $directory -File)){if($f.Length -gt 32768 -or $f.Name -notmatch '^[a-f0-9]+[.]jsonl$'){throw 'Unexpected status file'};$status+=@{name=$f.Name;bytes=$f.Length;text=[IO.File]::ReadAllText($f.FullName)}}}
$controller=@{pid=1720;originalBirth='639300670245781630';present=$false;currentBirthMatches=$null};$held=$null
try{$held=[Diagnostics.Process]::GetProcessById(1720);$handle=$held.Handle;$controller.present=$true;$controller.currentBirthMatches=($held.StartTime.ToUniversalTime().Ticks.ToString() -ceq $controller.originalBirth)}catch [ArgumentException]{}finally{if($held){$held.Dispose()}}
$live=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith(($root+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)}|ForEach-Object{@{pid=$_.ProcessId;creationTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString();name=$_.Name;sessionId=$_.SessionId}})
@{version=1;readOnly=$true;owner=$owner;root=$root;rootIdentity=$id;statusFiles=$status;controller=$controller;runtimeProcesses=$live;jobEmptyReceiptExists=(Test-Path -LiteralPath (Join-Path $root 'job-empty-receipt.json'));rootDeleted=$false}|ConvertTo-Json -Depth 8 -Compress`;

await runE2E(import.meta.url, { testId: "remote-cookie-windows-original-observation", tier: "host-preflight",
  modelPolicy: "Read-only original nonce root identity, birth and Job status. No launch, stop, retry, deletion, desktop or configuration action." }, async (context) => {
  const child = context.spawnOwned("cookie-original-observer", "ssh", ["-T", "-S", "none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ControlMaster=no", "-o", "ConnectTimeout=8", "-o", "ClearAllForwardings=yes", target,
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  let output = "";
  child.stdout.on("data", (bytes) => { output += bytes; assert.ok(output.length < 128 * 1024); });
  const closed = await waitForStdioChildClose(child, 25_000, "original Cookie observer");
  await context.stopOwned("cookie-original-observer");
  assert.equal(closed.code, 0);
  const record = JSON.parse(output.trim().replace(/^\uFEFF/, ""));
  await context.writeArtifactJson("original-owned-observation.json", record);
  return record;
});
