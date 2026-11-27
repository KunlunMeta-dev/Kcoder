import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ownedCreationScript, psLiteral } from "./windows-package-probe.mjs";
import { waitForStdioChildClose } from "./app-server-stdio.mjs";
import { repoRoot, runE2E } from "./run-context.mjs";

assert.equal(process.env.KCODER_E2E_WINDOWS_PROTOCOL_CONSENT, "1", "Explicit isolated Windows protocol consent required");
const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
assert.equal(target, "win-cyx-ts");
const owner = "e3db9ebc-9e97-4c4b-b5bc-01d95877521f";
const nonce = "protocol-" + owner;
const parent = "C:\\Users\\cyx\\AppData\\Local\\Temp";
const root = parent + "\\kcoder-package-" + owner;
const nodeSource = "C:\\Program Files\\nodejs\\node.exe";
const supervisorSource = "C:\\Users\\cyx\\AppData\\Local\\Programs\\kcoder-studio\\resources\\bin\\kcoder-process-supervisor.exe";
const nodeSha256 = "58e74bf02fc5bbacc41dcb8bef089961cd5bddd37830b87784e4fc624d145d1f";
const supervisorSha256 = "d25c92a52507fec5a078e8d4230093fbf40108c29eef9588d5ee0a6d4f81e763";
const hash = value => createHash("sha256").update(value).digest("hex");
const harness = "apps/kcoder-studio/e2e/harness/";
const sources = new Map();
async function addSource(path) {
  path = resolve(repoRoot, path);
  const rel = relative(repoRoot, path).replaceAll("\\", "/");
  assert.ok(rel.startsWith(harness) && !rel.split("/").includes(".."));
  if (sources.has(rel)) return;
  const content = await readFile(path);
  sources.set(rel, { path: rel, sha256: hash(content), bytes: content.length });
  if (!/\.(mjs|cjs)$/.test(path)) return;
  const matches = content.toString("utf8").matchAll(/(?:\bfrom\s*|\bimport\s*)(["'])(\.[^"']+)\1/g);
  for (const match of matches) await addSource(resolve(dirname(path), match[2]));
}
for (const leaf of ["windows-protocol-native.mjs", "windows-ui-probe-wrapper.mjs", "windows-state-directory.ps1",
  "fixtures/windows-protocol-worker.cjs", "fixtures/windows-protocol-launch.ps1", "fixtures/windows-protocol-kernel.cs"]) await addSource(harness + leaf);
const sourceList = [...sources.values()].sort((a, b) => a.path.localeCompare(b.path));
const sourcesDigest = hash(JSON.stringify(sourceList));
function spawnForCurrentPhase(context, ...args) {
  return context.finishing ? context.spawnCleanupOwned(...args) : context.spawnOwned(...args);
}
async function writeBoundArtifact(context, path, value) {
  await writeFile(path, JSON.stringify(context.redactValue(value), null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
function remoteStageDisposition(jobStarted, scopeConfirmed, evidenceCopied) {
  if (!jobStarted) return "REMOVE_STAGE_WITHOUT_JOB";
  if (!scopeConfirmed) return "RETAINED_UNCONFIRMED";
  if (!evidenceCopied) return "RETAINED_FOR_EVIDENCE";
  return "REMOVE_CONFIRMED_STAGE";
}
function projectNativeEvidence(evidence, exitCode) {
  const expected = ["actual-job-desktop-error-and-peer", "migration-security-epipe", "migration-security-callback", "remote-studio-os-epipe",
    "actual-ui-wrapper-owner-connected", "actual-ui-wrapper-owner-eof"].sort();
  const cases = evidence.result?.cases ?? evidence.progress?.at(-1)?.cases ?? [];
  const coverage = evidence.result && JSON.stringify(cases.map(row => row.id).sort()) === JSON.stringify(expected) ? "COMPLETE" : "PARTIAL";
  return { cases, coverage, status: coverage !== "COMPLETE" ? "PARTIAL" : evidence.result.allPassed && exitCode === 0 && cases.every(row => row.status === "PASS") ? "PASS" : "FAIL" };
}
if (process.argv.includes("--self-test-local-cleanup")) {
  await runE2E(import.meta.url, { testId: "protocol-controller-bound-cleanup-phase", tier: "harness-unit", modelPolicy: "Local Node cleanup-phase test only; no SSH or Windows access." }, async context => {
    const receiptPath = context.pathInArtifacts("cleanup-phase-receipt.json");
    const environment = context.isolatedEnvironment();
    assert.equal(remoteStageDisposition(true, false, false), "RETAINED_UNCONFIRMED");
    assert.equal(remoteStageDisposition(true, true, false), "RETAINED_FOR_EVIDENCE");
    assert.equal(remoteStageDisposition(true, true, true), "REMOVE_CONFIRMED_STAGE");
    assert.equal(remoteStageDisposition(false, false, false), "REMOVE_STAGE_WITHOUT_JOB");
    const ids = ["actual-job-desktop-error-and-peer", "migration-security-epipe", "migration-security-callback", "remote-studio-os-epipe", "actual-ui-wrapper-owner-connected", "actual-ui-wrapper-owner-eof"];
    const rows = ids.map(id => ({ id, status: "PASS" }));
    assert.equal(projectNativeEvidence({ result: { cases: rows, allPassed: true } }, 0).status, "PASS");
    const prefix = projectNativeEvidence({ result: null, progress: [{ cases: rows.slice(0, 1) }, { cases: rows.slice(0, 2) }] }, 1);
    assert.equal(prefix.status, "PARTIAL"); assert.equal(prefix.cases.length, 2);
    assert.equal(projectNativeEvidence({ result: { cases: [...rows.slice(0, 5), rows[0]], allPassed: true } }, 0).status, "PARTIAL");
    assert.equal(projectNativeEvidence({ result: { cases: rows.map((row, index) => index === 1 ? { ...row, status: "FAIL" } : row), allPassed: true } }, 0).status, "FAIL");
    assert.equal(projectNativeEvidence({ result: null, progress: [] }, 1).status, "PARTIAL");
    context.addCleanup("verify protocol cleanup phase", async () => {
      assert.equal(context.finishing, true);
      const child = spawnForCurrentPhase(context, "protocol-cleanup-probe", process.execPath, ["-e", "process.stdout.write('owned-cleanup')"], { env: environment });
      const closed = await waitForStdioChildClose(child, 5000, "protocol cleanup probe");
      await context.stopOwned("protocol-cleanup-probe");
      assert.equal(closed.code, 0);
      await writeBoundArtifact(context, receiptPath, { phase: "cleanup", originalChildClosed: true });
    });
    return { localOnly: true };
  });
  process.exit(0);
}
if (process.argv.includes("--prepare-only")) {
  console.log(JSON.stringify({ target, owner, root, sourcesDigest, sources: sourceList }, null, 2));
  process.exit(0);
}
const sshOptions = ["-T", "-S", "none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=no",
  "-o", "ControlPath=none", "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=8"];
const scpOptions = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none"];
const reportPath = resolve(repoRoot, "target/high-risk-review-20261112-round2/windows_protocol_acceptance-results.json");
let finalReport = { schemaVersion: 1, lane: "windows_protocol_acceptance", owner, root, target, status: "NOT_RUN", results: [], sourcesDigest, sourceIdentities: sourceList };
try {
  const bytes = await readFile(reportPath);
  const previous = JSON.parse(bytes);
  finalReport.previousAttempts = [...(previous.previousAttempts ?? [])];
  if (previous.owner && previous.owner !== owner) {
    const preservedPath = reportPath.replace(/\.json$/, `-${previous.owner}.json`);
    try { await writeFile(preservedPath, bytes, { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    finalReport.previousAttempts = [{ owner: previous.owner, root: previous.root, status: previous.status,
      remoteRootDisposition: previous.remoteRootDisposition, testsExecuted: previous.testsExecuted ?? false,
      preservedReport: preservedPath, replayed: false }];
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }

try {
  await runE2E(import.meta.url, { testId: "authorized-isolated-windows-protocol-native-acceptance", tier: "native-platform",
    modelPolicy: "Explicit authorized Windows Session0 synthetic Node/Job only. No user desktop, CLI, vault, personal settings, installation writes or external model." }, async context => {
    let sequence = 0, stageCreated = false, jobStarted = false, scopeConfirmed = false, evidenceCopied = false;
    const cleanupArtifactPath = context.pathInArtifacts("windows-protocol-cleanup.json");
    const processEnvironment = context.isolatedEnvironment();
    async function execute(command, args, { input, timeoutMs = 30000, keepInput = false, maxBytes = 2 * 1024 * 1024 } = {}) {
      const label = `windows-protocol-${++sequence}`;
      const child = spawnForCurrentPhase(context, label, command, args, { stdin: input === undefined ? "ignore" : "pipe", env: processEnvironment });
      let output = "", bytes = 0, streamError;
      child.stdout.on("data", data => { bytes += data.length; if (bytes <= maxBytes) output += data; });
      child.stdin?.on("error", error => { streamError ??= error; });
      if (input !== undefined) {
        try { if (keepInput) child.stdin.write(input, error => { streamError ??= error; }); else child.stdin.end(input); }
        catch (error) { streamError ??= error; }
      }
      const closed = await waitForStdioChildClose(child, timeoutMs, label);
      await context.stopOwned(label);
      if (streamError) throw streamError;
      assert.equal(closed.code, 0, "Owned Windows transport failed; inspect the retained log");
      assert.equal(closed.signal, null); assert.ok(bytes <= maxBytes);
      return output;
    }
    const ps = (script, options) => execute("ssh", [...sshOptions, target, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, "utf16le").toString("base64")], options);
    const authority = `$root=${psLiteral(root)};if((Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json).owner -cne '${owner}'){throw 'Owned protocol root changed'};`;
    context.addCleanup("remove only confirmed Windows protocol stage", async () => {
      if (!stageCreated) return;
      const disposition = remoteStageDisposition(jobStarted, scopeConfirmed, evidenceCopied);
      if (disposition.startsWith("RETAINED_")) {
        await writeBoundArtifact(context, cleanupArtifactPath, { owner, root, status: disposition, scopeConfirmed,
          reason: scopeConfirmed ? "Native case evidence has not been copied" : "Original outer Job receipt missing; no PID or marker fallback" });
        throw new Error("Windows protocol scope or evidence incomplete; original stage retained");
      }
      const receiptGuard = jobStarted ? `$receipt=Get-Content -LiteralPath (Join-Path $root 'outer-receipt.json') -Raw|ConvertFrom-Json;if($receipt.owner -cne '${owner}' -or $receipt.nonce -cne '${nonce}' -or $receipt.status -cne 'CONFIRMED' -or !$receipt.nativeJobEmptyAtExit -or !$receipt.originalHelperClosed -or !$receipt.originalTargetClosed){throw 'Original outer Job receipt changed'};` : "";
      const output = await ps(authority + receiptGuard + `$todo=[Collections.Generic.Stack[string]]::new();$todo.Push($root);while($todo.Count){$p=$todo.Pop();$item=Get-Item -LiteralPath $p -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Owned cleanup cannot follow a reparse point'};if($item.PSIsContainer){foreach($entry in [IO.Directory]::EnumerateFileSystemEntries($p)){$todo.Push($entry)}}};Remove-Item -LiteralPath $root -Recurse -Force;@{owner='${owner}';removed=(!(Test-Path -LiteralPath $root));scopeConfirmed=${jobStarted ? "$true" : "$false"};personalStateChanged=$false}|ConvertTo-Json -Compress`);
      const cleaned = JSON.parse(output.trim()); assert.equal(cleaned.removed, true);
      finalReport.cleanup = cleaned;
      await writeBoundArtifact(context, cleanupArtifactPath, cleaned);
    });
    await context.writeArtifactJson("windows-protocol-owner-intent.json", { owner, root, nonce, nodeSha256, supervisorSha256, sourcesDigest, userAuthorizedIsolatedProtocolOnly: true });
    const created = await ps(`$p=${psLiteral(parent)};$cursor=Get-Item -LiteralPath $p;while($cursor){if($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Protocol parent cannot follow a reparse point'};$cursor=$cursor.Parent};` + ownedCreationScript(parent, owner));
    assert.equal(JSON.parse(created.trim()), root); stageCreated = true;
    const copied = JSON.parse((await ps(authority + `[IO.Directory]::CreateDirectory((Join-Path $root 'resources\\bin'))|Out-Null;$n=Join-Path $root 'node.exe';$h=Join-Path $root 'resources\\bin\\kcoder-process-supervisor.exe';[IO.File]::Copy(${psLiteral(nodeSource)},$n,$false);[IO.File]::Copy(${psLiteral(supervisorSource)},$h,$false);$ns=(Get-FileHash -LiteralPath $n -Algorithm SHA256).Hash.ToLowerInvariant();$hs=(Get-FileHash -LiteralPath $h -Algorithm SHA256).Hash.ToLowerInvariant();if($ns -cne '${nodeSha256}' -or $hs -cne '${supervisorSha256}'){throw 'Read-only runtime copy identity mismatch'};(Get-Item -LiteralPath $n).IsReadOnly=$true;(Get-Item -LiteralPath $h).IsReadOnly=$true;@{nodeSha256=$ns;supervisorSha256=$hs;copiesReadOnly=$true;installedFilesModified=$false}|ConvertTo-Json -Compress`)).trim());
    await context.writeArtifactJson("windows-protocol-runtime-copies.json", copied);
    const fileList = context.pathInState("source-list.json"), archive = context.pathInState("harness.zip");
    await writeFile(fileList, JSON.stringify(sourceList.map(row => row.path)));
    await execute("python3", [fileURLToPath(new URL("./fixtures/windows-protocol-pack.py", import.meta.url)), repoRoot, fileList, archive]);
    const archiveSha256 = hash(await readFile(archive));
    await copyFile(archive, context.pathInArtifacts("windows-protocol-source.zip"));
    await context.writeArtifactJson("windows-protocol-source-inputs.json", { sources: sourceList, sourcesDigest, archiveSha256 });
    const descriptor = context.pathInState("protocol-input.json");
    await writeFile(descriptor, JSON.stringify({ owner, nonce, root, nodeSha256, supervisorSha256, sourcesDigest, sources: sourceList }));
    const remoteBase = `${target}:${root.replaceAll("\\", "/")}`;
    await execute("scp", [...scpOptions, archive, `${remoteBase}/harness.zip`]);
    await execute("scp", [...scpOptions, descriptor, `${remoteBase}/protocol-input.json`]);
    await ps(authority + `if((Get-FileHash -LiteralPath (Join-Path $root 'harness.zip') -Algorithm SHA256).Hash.ToLowerInvariant() -cne '${archiveSha256}'){throw 'Protocol archive identity mismatch'};Add-Type -AssemblyName System.IO.Compression.FileSystem;$zip=[IO.Compression.ZipFile]::OpenRead((Join-Path $root 'harness.zip'));try{$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);foreach($entry in $zip.Entries){if($entry.FullName -notlike 'apps/kcoder-studio/e2e/harness/*' -or $entry.FullName.StartsWith('/') -or $entry.FullName.Contains(':') -or $entry.FullName.Contains([char]92) -or ($entry.FullName.Split('/') -contains '..') -or !$seen.Add($entry.FullName)){throw 'Unsafe protocol archive entry'}}}finally{$zip.Dispose()};[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $root 'harness.zip'),$root);@{extracted=$true}|ConvertTo-Json -Compress`);
    const parsed = JSON.parse((await ps(authority + `$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'apps\\kcoder-studio\\e2e\\harness\\fixtures\\windows-protocol-launch.ps1'),[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw ($errors|ForEach-Object{$_.Message}|Out-String)};@{parsed=$true;executed=$false}|ConvertTo-Json -Compress`)).trim());
    assert.equal(parsed.parsed, true); assert.equal(parsed.executed, false);
    jobStarted = true;
    const launch = `${authority}& ${psLiteral(root + "\\apps\\kcoder-studio\\e2e\\harness\\fixtures\\windows-protocol-launch.ps1")} -Root ${psLiteral(root)} -Owner '${owner}'`;
    const receipt = JSON.parse((await ps(launch, { input: JSON.stringify({ owner, nonce }) + "\n", keepInput: true, timeoutMs: 210000 })).trim());
    assert.equal(receipt.owner, owner); assert.equal(receipt.nonce, nonce); assert.equal(receipt.status, "CONFIRMED");
    assert.equal(receipt.originalHelperClosed, true); assert.equal(receipt.originalTargetClosed, true); assert.equal(receipt.nativeJobEmptyAtExit, true);
    scopeConfirmed = true;
    finalReport.outerReceipt = receipt;
    finalReport.runRoot = context.runRoot;
    await context.writeArtifactJson("windows-protocol-outer-receipt.json", receipt);
    const evidence = JSON.parse((await ps(authority + `$final=$null;$finalPath=Join-Path $root 'native-result.json';if(Test-Path -LiteralPath $finalPath){$final=Get-Content -LiteralPath $finalPath -Raw|ConvertFrom-Json};$progress=@(Get-ChildItem -LiteralPath (Join-Path $root 'target\\e2e') -File -Recurse -Filter 'windows-protocol-case-progress-*.json'|Sort-Object Name|ForEach-Object{Get-Content -LiteralPath $_.FullName -Raw|ConvertFrom-Json});@{birth=(Get-Content -LiteralPath (Join-Path $root 'outer-birth.json') -Raw|ConvertFrom-Json);result=$final;progress=$progress;status=@([IO.File]::ReadAllLines((Join-Path $root 'outer-status.jsonl'))|Where-Object{$_}|ForEach-Object{$_|ConvertFrom-Json})}|ConvertTo-Json -Depth 12 -Compress`)).trim());
    await context.writeArtifactJson("windows-protocol-native-evidence.json", evidence);
    const zipReceipt = JSON.parse((await ps(authority + `Add-Type -AssemblyName System.IO.Compression.FileSystem;$destination=Join-Path $root 'run-evidence.zip';$stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew);$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$false);try{foreach($file in Get-ChildItem -LiteralPath (Join-Path $root 'target\\e2e') -File -Recurse){$relative=$file.FullName.Substring($root.Length+1).Replace('\\','/');if($relative -match '(^|/)state(/|$)'){continue};[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file.FullName,$relative)|Out-Null}}finally{$zip.Dispose();$stream.Dispose()};@{sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $destination).Length}|ConvertTo-Json -Compress`)).trim());
    const evidenceZip = context.pathInState("windows-run-evidence.zip");
    await execute("scp", [...scpOptions, `${remoteBase}/run-evidence.zip`, evidenceZip]);
    assert.equal(hash(await readFile(evidenceZip)), zipReceipt.sha256);
    await copyFile(evidenceZip, context.pathInArtifacts("windows-run-evidence.zip"));
    evidenceCopied = true;
    const projected = projectNativeEvidence(evidence, receipt.exitCode);
    finalReport = { ...finalReport, generatedAt: new Date().toISOString(), status: projected.status,
      nodeSha256, supervisorSha256, outerReceipt: receipt, evidence, runRoot: context.runRoot,
      nativeEvidenceZip: context.pathInArtifacts("windows-run-evidence.zip"),
      results: projected.cases, nativeCoverage: projected.coverage, boundaries: { nativeSession0Only: true, desktopAccessed: false, cliOrVaultUsed: false, realRemoteTransportProducerUsed: false,
        physicalWidgetSsh: "POSIX entry remains outside Windows acceptance", wholeScopeReceipt: "outer exact native V1 EXIT plus original helper and target closes" } };
    await context.writeArtifactJson("windows-protocol-acceptance.json", finalReport);
    assert.equal(finalReport.status, "PASS", "Actual Windows protocol acceptance reported failures");
    return finalReport;
  });
} catch (error) {
  finalReport = { ...finalReport, generatedAt: new Date().toISOString(), status: finalReport.status === "FAIL" ? "FAIL" : "PARTIAL", error: error.stack ?? String(error),
    replayed: false, rootRetainedUnlessExplicitConfirmedCleanup: true };
  await writeFile(reportPath, JSON.stringify(finalReport, null, 2) + "\n");
  throw error;
}
await writeFile(reportPath, JSON.stringify(finalReport, null, 2) + "\n");
