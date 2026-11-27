import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { waitForStdioChildClose } from "./app-server-stdio.mjs";
import { repoRoot, runE2E } from "./run-context.mjs";

const owner = process.env.KCODER_PROTOCOL_INSPECT_OWNER ?? "14495560-18db-408d-aa5b-416209595079";
assert.ok(["14495560-18db-408d-aa5b-416209595079", "82de006a-e3d3-46fc-aaa4-3c5bf3f301f3"].includes(owner));
const root = "C:\\Users\\cyx\\AppData\\Local\\Temp\\kcoder-package-" + owner;
assert.equal(process.env.KCODER_E2E_WINDOWS_SSH_TARGET, "win-cyx-ts");
const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root='C:\Users\cyx\AppData\Local\Temp\kcoder-package-14495560-18db-408d-aa5b-416209595079'
$owner='14495560-18db-408d-aa5b-416209595079'
function Read-Original([string]$path){
  $stream=[IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try{$reader=[IO.StreamReader]::new($stream);try{return $reader.ReadToEnd()}finally{$reader.Dispose()}}finally{$stream.Dispose()}
}
$proof=(Read-Original (Join-Path $root '.owner.json'))|ConvertFrom-Json
if($proof.owner -cne $owner){throw 'Original root owner changed'}
$files=@{}
foreach($leaf in @('outer-status.jsonl','outer-helper-birth.json','outer-birth.json','outer-receipt.json','native-result.json')){
  $path=Join-Path $root $leaf
  if(Test-Path -LiteralPath $path -PathType Leaf){$files[$leaf]=Read-Original $path}else{$files[$leaf]=$null}
}
$node=(Join-Path $root 'node.exe').Replace('\','\\')
$helper=(Join-Path $root 'resources\bin\kcoder-process-supervisor.exe').Replace('\','\\')
$candidates=@(Get-CimInstance Win32_Process -Filter ("ExecutablePath='"+$node+"' OR ExecutablePath='"+$helper+"'")|Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate)
@{owner=$owner;root=$root;readOnly=$true;files=$files;ownedPathCandidates=$candidates;candidateAbsenceIsNotJobEmptyReceipt=$true;signalsSent=$false;filesDeleted=$false}|ConvertTo-Json -Depth 8 -Compress
`.replaceAll("14495560-18db-408d-aa5b-416209595079", owner);
await runE2E(import.meta.url, { testId: "reconcile-original-windows-protocol-status-read-only", tier: "host-preflight",
  modelPolicy: "Read only original owned status after failed launcher. No replay, new Job, process signal, filesystem deletion or personal state access." }, async context => {
  const label = "inspect-original-windows-protocol";
  const child = context.spawnOwned(label, "ssh", ["-T", "-S", "none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=no",
    "-o", "ControlPath=none", "-o", "ClearAllForwardings=yes", "win-cyx-ts", "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: context.isolatedEnvironment() });
  let output = "", bytes = 0;
  child.stdout.on("data", data => { bytes += data.length; if (bytes <= 65536) output += data; });
  const closed = await waitForStdioChildClose(child, 20000, label);
  await context.stopOwned(label);
  assert.equal(closed.code, 0); assert.ok(bytes <= 65536);
  const result = JSON.parse(output.trim());
  await context.writeArtifactJson("original-windows-protocol-reconciliation.json", result);
  const path = resolve(repoRoot, "target/high-risk-review-20261112-round2/windows_protocol_acceptance-results.json");
  const previous = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...previous, reconciliation: result, reconciliationRunRoot: context.runRoot,
    status: "PARTIAL", outerStartSent: false, testsExecuted: false, remoteRootDisposition: "RETAINED_UNCONFIRMED_SCOPE", replayed: false }, null, 2) + "\n");
  return result;
});
