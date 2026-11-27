import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { waitForStdioChildClose } from "./app-server-stdio.mjs";
import { runE2E } from "./run-context.mjs";

const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
assert.match(target ?? "", /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/);
const owner = "3f8bc037-7145-4036-b27c-c7d8d52b1063";
const root = "C:\\Users\\cyx\\AppData\\Local\\Temp\\kcoder-package-" + owner;
const node = "C:\\Program Files\\nodejs\\node.exe";
const helperSha256 = "d25c92a52507fec5a078e8d4230093fbf40108c29eef9588d5ee0a6d4f81e763";
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
await runE2E(import.meta.url, { testId: "remote-cookie-original-job-reconciliation", tier: "platform",
  modelPolicy: "Original known Job-empty/birth/handle-close reconciliation only; no worker or Electron restart, user process action or desktop access." }, async (context) => {
  for (const value of [`owned-login-${owner}`, `host/${owner}`, `legacy/${owner}`, `http/${owner}`]) context.registerSecret(value);
  let sequence = 0;
  async function execute(command, args) {
    const label = `cookie-reconcile-${++sequence}`;
    const child = context.spawnOwned(label, command, args);
    let output = "";
    child.stdout.on("data", (value) => { output += value; assert.ok(output.length < 128 * 1024); });
    const closed = await waitForStdioChildClose(child, 30_000, label);
    await context.stopOwned(label);
    assert.equal(closed.code, 0, "original receipt reconciliation failed; root must remain");
    return output;
  }
  const ssh = async (script) => JSON.parse((await execute("ssh", ["-T", "-S", "none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ControlMaster=no", "-o", "ConnectTimeout=8", "-o", "ClearAllForwardings=yes", target,
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop';" + script, "utf16le").toString("base64")])).trim().replace(/^\uFEFF/, ""));
  const observation = await ssh(`$root=${quote(root)};$record=Get-Content -LiteralPath (Join-Path $root 'cookie-report.json') -Raw -Encoding UTF8|ConvertFrom-Json;$job=Get-Content -LiteralPath (Join-Path $root 'job-empty-receipt.json') -Raw|ConvertFrom-Json;if($record.owner -cne ${quote(owner)} -or $job.owner -cne ${quote(owner)}){throw 'Original observation owner mismatch'};$cases=@($record.cases|ForEach-Object{@{scenario=$_.kind;name=$_.name;secure=$_.secure;httpOnly=$_.httpOnly;sameSite=$_.sameSite;path=$_.path;hostOnly=$_.hostOnly;tlsIncludesSession=$_.httpsSendsExpected;plainHttpIncludesSession=$_.httpSendsExpected;plainHttpSessionCount=$_.httpSessionCookieCount}});@{owner=${quote(owner)};nativeObservation=@{electron=$record.electron;chromium=$record.chromium;platform=$record.platform;sessionId=$record.sessionId;browserWindowsCreated=$record.browserWindowsCreated;phase=$record.phase;failure=$record.failure;cases=$cases};originalJobReceipt=$job}|ConvertTo-Json -Depth 12 -Compress`);
  assert.equal(observation.originalJobReceipt.jobEmpty, true);
  assert.equal(observation.originalJobReceipt.originalHandleClosed, true);
  assert.equal(observation.nativeObservation.cases.length, 2);
  await context.writeArtifactJson("original-native-session-metadata.json", observation);
  const cleanup = fileURLToPath(new URL("../fixtures/remote-cookie/windows-cookie-cleanup.ps1", import.meta.url));
  const digest = createHash("sha256").update(await readFile(cleanup)).digest("hex");
  await execute("scp", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none",
    "-o", "ConnectTimeout=8", cleanup, `${target}:${root.replaceAll("\\", "/")}/cookie-cleanup.ps1`]);
  const result = await ssh(`$path=${quote(root + "\\cookie-cleanup.ps1")};if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${quote(digest)}){throw 'Cleanup source changed'};& $path -Root ${quote(root)} -Owner ${quote(owner)} -RootDev '3631862777' -RootIno '29273397578009610' -Node ${quote(node)} -SupervisorSha256 ${quote(helperSha256)}`);
  assert.equal(result.directoryAbsent, true);
  assert.equal(result.nativeJobReceiptRequired, true);
  await context.writeArtifactJson("original-job-cleanup-receipt.json", { ...result, cleanupSourceSha256: digest, observationArchivedBeforeRemoval: true });
  return { originalOwner: owner, directoryAbsent: true, acceptedHttpsCases: 2, completeHttpOriginCase: false, newWorkerLaunched: false };
});
