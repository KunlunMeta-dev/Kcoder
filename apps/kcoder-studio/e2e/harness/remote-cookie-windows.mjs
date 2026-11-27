import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { waitForStdioChildClose } from "./app-server-stdio.mjs";
import { runE2E, repoRoot } from "./run-context.mjs";
import { ownedCreationScript } from "./windows-package-probe.mjs";

const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
assert.match(target ?? "", /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/, "explicit authorized target required");
const installed = "C:\\Users\\cyx\\AppData\\Local\\Programs\\kcoder-studio";
const node = "C:\\Program Files\\nodejs\\node.exe";
const supervisorSha256 = "d25c92a52507fec5a078e8d4230093fbf40108c29eef9588d5ee0a6d4f81e763";
const psLiteral = (value) => "'" + value.replaceAll("'", "''") + "'";
const fusePreflight = "const fs=require('node:fs');const b=fs.readFileSync(process.argv[1]);const s=Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');const i=b.indexOf(s);if(i<0)throw Error('Fuse wire absent');const p=i+s.length;console.log(JSON.stringify({version:b[p],length:b[p+1],states:b.subarray(p+2,p+2+b[p+1]).toString('ascii')}));";
const statRoot = "const fs=require('node:fs');const s=fs.lstatSync(process.argv[1],{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe root');console.log(JSON.stringify({dev:String(s.dev),ino:String(s.ino)}));";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

await runE2E(import.meta.url, {
  testId: "remote-cookie-windows-session-zero", tier: "platform",
  modelPolicy: "Synthetic loopback Cookie fixture; no accounts, real Gateway, models, interactive desktop or installation changes.",
  retainSuccessLogs: true,
}, async (context) => {
  let sequence = 0;
  async function powershell(source, { timeoutMs = 25_000, heartbeatOwner, allowNonzero = false } = {}) {
    const label = `cookie-windows-${++sequence}`;
    const encoded = Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + source, "utf16le").toString("base64");
    assert.ok(encoded.length < 7_600, "use a versioned -File entry before exceeding the Windows command budget");
    const child = (context.finishing ? context.spawnCleanupOwned.bind(context) : context.spawnOwned.bind(context))(label, "ssh", ["-T", "-S", "none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "ControlMaster=no", "-o", "ConnectTimeout=8", "-o", "ClearAllForwardings=yes", "-o", "ServerAliveInterval=5",
      "-o", "ServerAliveCountMax=2", target, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { stdin: heartbeatOwner ? "pipe" : "ignore" });
    let output = "", size = 0;
    child.stdout.on("data", (chunk) => { size += chunk.length; if (size <= 256 * 1024) output += chunk.toString("utf8"); });
    let heartbeat, closed;
    if (heartbeatOwner) {
      const send = () => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ owner: heartbeatOwner, command: "HEARTBEAT" }) + "\n"); };
      child.stdin.on("error", () => {});
      send(); heartbeat = setInterval(send, 2_000);
    }
    try { closed = await waitForStdioChildClose(child, timeoutMs, label); }
    finally { clearInterval(heartbeat); await context.stopOwned(label); }
    assert.equal(size <= 256 * 1024, true, "remote output budget");
    if (!allowNonzero) assert.equal(closed.code, 0, "remote command failed; inspect owned log");
    const value = JSON.parse(output.trim().replace(/^\uFEFF/, ""));
    return allowNonzero ? { code: closed.code, value } : value;
  }
  const preflight = await powershell(`
$root=${psLiteral(installed)};$node=${psLiteral(node)}
$files=@(Get-ChildItem -LiteralPath $root -File|ForEach-Object{@{name=$_.Name;size=$_.Length;attributes=$_.Attributes.ToString()}})
$helper=Join-Path $root 'resources\\bin\\kcoder-process-supervisor.exe'
$fuses=(& $node -e ${psLiteral(fusePreflight)} (Join-Path $root 'kcoder-studio.exe'))|ConvertFrom-Json;if($LASTEXITCODE -ne 0){throw 'Fuse preflight failed'}
$record=@{version=1;readOnly=$true;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;root=$root;node=$node;nodeExists=(Test-Path -LiteralPath $node -PathType Leaf);supervisor=$helper;supervisorExists=(Test-Path -LiteralPath $helper -PathType Leaf);englishLocaleExists=(Test-Path -LiteralPath (Join-Path $root 'locales\\en-US.pak') -PathType Leaf);files=$files;temporaryRoot=$env:TEMP;fuses=$fuses}
$record|ConvertTo-Json -Depth 6 -Compress
`);
  await context.writeArtifactJson("runtime-preflight.json", { ...preflight, sharedSupervisorSha256: supervisorSha256,
    sharedSupervisorEvidence: "target/e2e/2026/11/12/harness/windows-protocol-preflight.mjs/20261112-073926.440Z/artifacts/windows-protocol-preflight.json" });
  assert.equal(preflight.sessionId, 0, "this fixture is restricted to noninteractive Session 0");
  assert.equal(preflight.nodeExists, true);
  assert.equal(preflight.supervisorExists, true);
  assert.equal(preflight.englishLocaleExists, true);
  assert.ok(preflight.files.some((file) => file.name === "kcoder-studio.exe"));
  assert.equal(preflight.fuses.version, 1);
  assert.equal(preflight.fuses.states[5], "0", "immutable runtime requires app.asar; do not bypass its fuse");
  assert.equal(preflight.fuses.states[4], "0", "do not bypass an embedded app integrity requirement");
  if (process.env.KCODER_E2E_REMOTE_COOKIE_WINDOWS !== "1") {
    return { readOnly: true, sessionId: preflight.sessionId, runtimeFiles: preflight.files.length, stagingStarted: false };
  }

  const owner = process.env.KCODER_E2E_COOKIE_WINDOWS_OWNER || randomUUID();
  assert.match(owner, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const expectedRoot = preflight.temporaryRoot.replace(/\\$/, "") + "\\kcoder-package-" + owner;
  for (const value of [`owned-login-${owner}`, `host/${owner}`, `legacy/${owner}`, `http/${owner}`]) context.registerSecret(value);
  await context.writeArtifactJson("remote-creation-intent.json", { owner, expectedRoot, target, jobMayHaveStarted: false });
  const created = await powershell(`$directory=(& {${ownedCreationScript(preflight.temporaryRoot, owner)}})|ConvertFrom-Json;$identity=(& ${psLiteral(node)} -e ${psLiteral(statRoot)} $directory)|ConvertFrom-Json;if($LASTEXITCODE -ne 0){throw 'Root identity failed'};@{directory=$directory;rootIdentity=$identity;owner=${psLiteral(owner)}}|ConvertTo-Json -Compress`);
  assert.equal(created.directory, expectedRoot);
  await context.writeArtifactJson("remote-root-identity.json", created);
  let jobMayHaveStarted = false, cleanupScriptReady = false;
  const cleanupSource = fileURLToPath(new URL("../fixtures/remote-cookie/windows-cookie-cleanup.ps1", import.meta.url));
  const cleanupSourceSha256 = sha256(await readFile(cleanupSource));
  const cleanupPath = context.pathInArtifacts("remote-cleanup-receipt.json");
  context.addCleanup("verify original Windows Cookie Job receipt then remove its root", async () => {
    assert.ok(cleanupScriptReady || !jobMayHaveStarted, "cleanup source missing after possible launch");
    const command = cleanupScriptReady
      ? `$path=${psLiteral(expectedRoot + "\\cookie-cleanup.ps1")};if((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${psLiteral(cleanupSourceSha256)}){throw 'Cleanup source changed'};& $path -Root ${psLiteral(expectedRoot)} -Owner ${psLiteral(owner)} -RootDev ${psLiteral(created.rootIdentity.dev)} -RootIno ${psLiteral(created.rootIdentity.ino)} -Node ${psLiteral(node)} -SupervisorSha256 ${psLiteral(supervisorSha256)} ${jobMayHaveStarted ? "" : "-NeverLaunched"}`
      : `$root=${psLiteral(expectedRoot)};$m=Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json;$id=(& ${psLiteral(node)} -e ${psLiteral(statRoot)} $root)|ConvertFrom-Json;if($m.owner -cne ${psLiteral(owner)} -or $id.dev -cne ${psLiteral(created.rootIdentity.dev)} -or $id.ino -cne ${psLiteral(created.rootIdentity.ino)} -or (Test-Path -LiteralPath (Join-Path $root 'controller-birth.json')) -or (Test-Path -LiteralPath (Join-Path $root 'supervisor-birth.json'))){throw 'Exclusive never-launched root changed'};[IO.Directory]::Delete($root,$true);@{directoryAbsent=!(Test-Path -LiteralPath $root);nativeJobReceiptRequired=$false;neverLaunched=$true}|ConvertTo-Json -Compress`;
    const cleanup = await powershell(command, { timeoutMs: 30_000 });
    await writeFile(cleanupPath, JSON.stringify(context.redactValue(cleanup), null, 2) + "\n", { mode: 0o600 });
  }, { timeoutMs: 40_000 });

  const stagedRuntime = await powershell(`
$root=${psLiteral(expectedRoot)};$source=${psLiteral(installed)};$runtime=Join-Path $root 'runtime';[IO.Directory]::CreateDirectory($runtime)|Out-Null
$files=@(Get-ChildItem -LiteralPath $source -File|Where-Object{$_.Name -ceq 'kcoder-studio.exe' -or $_.Extension -in @('.dll','.pak','.bin','.dat','.json')})
$records=@();foreach($f in $files){if(($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Runtime source reparse point'};$leaf=if($f.Name -ceq 'kcoder-studio.exe'){'electron-cookie.exe'}else{$f.Name};$dest=Join-Path $runtime $leaf;$digest=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant();[IO.File]::Copy($f.FullName,$dest,$false);if((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $digest){throw 'Runtime copy bytes changed'};$records+=@{source=$f.FullName;leaf=$leaf;sha256=$digest;size=$f.Length}}
[IO.Directory]::CreateDirectory((Join-Path $runtime 'locales'))|Out-Null;[IO.File]::Copy((Join-Path $source 'locales\\en-US.pak'),(Join-Path $runtime 'locales\\en-US.pak'),$false)
[IO.Directory]::CreateDirectory((Join-Path $runtime 'resources\\app'))|Out-Null
[IO.File]::Copy((Join-Path $source 'resources\\bin\\kcoder-process-supervisor.exe'),(Join-Path $root 'supervisor.exe'),$false)
if((Get-FileHash -LiteralPath (Join-Path $root 'supervisor.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne ${psLiteral(supervisorSha256)}){throw 'Shared supervisor identity changed'}
@{owner=${psLiteral(owner)};runtimeFiles=$records;supervisorSha256=${psLiteral(supervisorSha256)};sourceInstallationWritten=$false}|ConvertTo-Json -Depth 5 -Compress
`, { timeoutMs: 60_000 });
  await context.writeArtifactJson("staged-runtime-identity.json", stagedRuntime);

  const sourcePath = resolve(repoRoot, "apps/kcoder-studio/desktop/remote-main.mjs");
  const source = await readFile(sourcePath, "utf8");
  const ts = createRequire(resolve(repoRoot, "apps/kcoder-studio/renderer/package.json"))("typescript");
  const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = parsed.statements.filter((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "remoteSessionCookieDetails");
  assert.equal(functions.length, 1);
  const component = source.slice(functions[0].getStart(parsed), functions[0].end) + "\n";
  const contract = context.pathInState("remote-cookie-contract.mjs");
  await writeFile(contract, component);
  await context.writeArtifactJson("actual-source-identity.json", { source: sourcePath, sourceSha256: sha256(source), exportedFunction: "remoteSessionCookieDetails", exactFunctionSha256: sha256(component), extraction: "TypeScript parser node start/end; exact source slice, no emit or implementation rewrite" });
  const localPackage = await context.writeStateJson("fixture-package.json", { name: "kcoder-owned-cookie-fixture", version: "1.0.0", type: "module", main: "electron-headless-cookie-probe.mjs" });
  const configuration = await context.writeStateJson("worker-config.json", { root: expectedRoot, owner, supervisorSha256 });
  const certificate = context.pathInState("certificate.pem"), key = context.pathInState("certificate-key.pem");
  const localTemporary = context.pathInState("temporary");
  await mkdir(localTemporary, { recursive: true });
  const cert = context.spawnOwned("cookie-windows-certificate", "/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes",
    "-subj", "/CN=owned-cookie.invalid", "-addext", "subjectAltName=DNS:owned-cookie.invalid", "-out", certificate, "-keyout", key],
  { env: context.isolatedEnvironment({ TMPDIR: localTemporary, TMP: localTemporary, TEMP: localTemporary }) });
  const certExit = await waitForStdioChildClose(cert, 10_000, "owned Cookie certificate");
  assert.equal(certExit.code, 0);
  context.registerSecret(await readFile(key, "utf8"));
  const app = "runtime/resources/app/";
  const payload = [
    [cleanupSource, "cookie-cleanup.ps1"],
    [fileURLToPath(new URL("../fixtures/remote-cookie/electron-headless-cookie-probe.mjs", import.meta.url)), app + "electron-headless-cookie-probe.mjs"],
    [fileURLToPath(new URL("../fixtures/remote-cookie/windows-cookie-worker.mjs", import.meta.url)), "windows-cookie-worker.mjs"],
    [fileURLToPath(new URL("../fixtures/remote-cookie/windows-cookie-environment.mjs", import.meta.url)), "windows-cookie-environment.mjs"],
    [fileURLToPath(new URL("./owned-process.mjs", import.meta.url)), "owned-process.mjs"],
    [resolve(repoRoot, "apps/kcoder-studio/desktop/remote-config.mjs"), app + "remote-config.mjs"],
    [contract, app + "remote-cookie-contract.mjs"], [localPackage, app + "package.json"],
    [configuration, "worker-config.json"], [certificate, "certificate.pem"], [key, "certificate-key.pem"],
  ];
  const payloadHashes = [];
  for (const [file, leaf] of payload) {
    const label = `cookie-upload-${++sequence}`;
    const child = context.spawnOwned(label, "scp", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none",
      "-o", "ConnectTimeout=8", file, `${target}:${expectedRoot.replaceAll("\\", "/")}/${leaf}`]);
    const closed = await waitForStdioChildClose(child, 25_000, label);
    await context.stopOwned(label);
    assert.equal(closed.code, 0, "owned payload upload failed");
    if (leaf === "cookie-cleanup.ps1") cleanupScriptReady = true;
    payloadHashes.push({ leaf: leaf.replaceAll("/", "\\"), sha256: sha256(await readFile(file)) });
  }
  const verifiedPayload = await powershell(`$root=${psLiteral(expectedRoot)};$files=${psLiteral(JSON.stringify(payloadHashes))}|ConvertFrom-Json;foreach($f in $files){if((Get-FileHash -LiteralPath (Join-Path $root $f.leaf) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256){throw 'Transferred fixture bytes changed'}};@{verified=$true;files=$files}|ConvertTo-Json -Depth 5 -Compress`);
  await context.writeArtifactJson("payload-source-identities.json", verifiedPayload);
  jobMayHaveStarted = true;
  await context.writeArtifactJson("worker-launch-intent.json", { owner, expectedRoot, jobMayHaveStarted: true });
  let execution;
  try {
    execution = await powershell(`$root=${psLiteral(expectedRoot)};foreach($leaf in @('controller-home','temporary','appdata','localappdata','compile-cache')){[IO.Directory]::CreateDirectory((Join-Path $root $leaf))|Out-Null};$env:HOME=Join-Path $root 'controller-home';$env:USERPROFILE=$env:HOME;$env:TEMP=Join-Path $root 'temporary';$env:TMP=$env:TEMP;$env:APPDATA=Join-Path $root 'appdata';$env:LOCALAPPDATA=Join-Path $root 'localappdata';$env:NODE_COMPILE_CACHE=Join-Path $root 'compile-cache';[Environment]::SetEnvironmentVariable('NODE_OPTIONS',$null,'Process');[Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$null,'Process');& ${psLiteral(node)} ${psLiteral(expectedRoot + "\\windows-cookie-worker.mjs")} ${psLiteral(expectedRoot + "\\worker-config.json")};exit $LASTEXITCODE`,
      { timeoutMs: 60_000, heartbeatOwner: owner, allowNonzero: true });
  } finally {
    const observation = await powershell(`$root=${psLiteral(expectedRoot)};$out=@{};foreach($leaf in @('controller-birth.json','supervisor-birth.json','job-empty-receipt.json','controller-result.json','cookie-report.json')){$p=Join-Path $root $leaf;if(Test-Path -LiteralPath $p -PathType Leaf){$out[$leaf]=Get-Content -LiteralPath $p -Raw -Encoding UTF8|ConvertFrom-Json}};@{owner=${psLiteral(owner)};root=$root;receipts=$out}|ConvertTo-Json -Depth 15 -Compress`);
    await context.writeArtifactJson("remote-native-observation.json", observation);
  }
  await context.writeArtifactJson("remote-worker-outcome.json", execution);
  assert.equal(execution.code, 0, "actual Windows Cookie acceptance failed; inspect original receipts");
  assert.equal(execution.value.passed, true);
  assert.equal(execution.value.jobEmpty, true);
  return { target, owner, root: expectedRoot, actualWindowsCookieAcceptance: true, cases: 3, browserWindowsCreated: 0 };
});
