import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RunContext, repoRoot } from './run-context.mjs';
import { ownedCreationScript, psLiteral } from './windows-package-probe.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceInputs = [
  ['apps/kcoder-studio/desktop/windows-shell/close-installed-processes.ps1', 'close-installed-processes.ps1'],
  ['apps/kcoder-studio/e2e/harness/windows-project-terminal-probe.ps1', 'windows-project-terminal-probe.ps1'],
  ['apps/kcoder-studio/desktop/windows-shell-close-processes.test.ps1', 'windows-shell-close-processes.test.ps1'],
  ['apps/kcoder-studio/desktop/windows-shell-close-query.test.ps1', 'windows-shell-close-query.test.ps1'],
  ['apps/kcoder-studio/e2e/harness/high-risk-b-powershell-staging.verify.ps1', 'high-risk-b-powershell-staging.verify.ps1'],
  ['apps/kcoder-studio/e2e/harness/windows-powershell-headless.acceptance.ps1', 'acceptance.ps1'],
];

async function main() {
  assert.equal(process.env.KCODER_E2E_WINDOWS_PS_ACCEPTANCE, '1', 'Explicit Windows headless test consent required');
  const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
  const owner = process.env.KCODER_E2E_WINDOWS_PS_OWNER;
  const parent = process.env.KCODER_E2E_WINDOWS_PS_PARENT;
  const node = process.env.KCODER_E2E_WINDOWS_PS_NODE;
  assert.match(target ?? '', /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/);
  assert.match(owner ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  for (const path of [parent, node]) assert.match(path ?? '', /^[A-Za-z]:\\[^\0\r\n"<>|?*]+$/);
  const root = parent.replace(/\\$/, '') + '\\kcoder-package-' + owner;
  const context = await RunContext.create(import.meta.url, { testId: 'windows-ps51-owned-parser-staging-cim',
    tier: 'manual-live', retainSuccessLogs: true,
    modelPolicy: 'Windows PS5.1 parser, source AST staging and one no-fork synthetic process. No desktop, account, task, installer, model or personal process operations.' });
  const reportPath = resolve(repoRoot, 'target/high-risk-review-20261112-round2/windows_powershell_acceptance-results.json');
  const report = { schemaVersion: 1, lane: 'windows_powershell_acceptance-r2', owner, target, remoteRoot: root,
    runRoot: context.runRoot, startedAt: new Date().toISOString(), status: 'RUNNING', results: [], cleanup: null };
  const files = await Promise.all(sourceInputs.map(async ([path, leaf]) => ({ path, leaf, sha256: sha256(await readFile(resolve(repoRoot, path))) })));
  const cleanupEvidencePath = context.pathInArtifacts('windows-cleanup.json');
  report.sourceIdentities = files;
  report.controllerSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  let sequence = 0, creationDispatched = false, executionDispatched = false, failure;
  const sshBase = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-S', 'none'];
  const args = code => [...sshBase, target, 'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + code, 'utf16le').toString('base64')];
  const execute = (command, values, timeoutMs = 60000) => new Promise((accept, reject) => {
    const label = 'windows-ps51-' + ++sequence;
    const child = context.spawnOwned(label, command, values);
    let output = '', stderr = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : accept(value); };
    const timer = setTimeout(() => { void context.stopOwned(label).then(() => finish(new Error('Owned Windows PS transport deadline')), finish); }, timeoutMs);
    child.stdout.on('data', data => { output += data; if (output.length > 1024 * 1024) void context.stopOwned(label).then(() => finish(new Error('Owned Windows PS output limit')), finish); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
    child.once('error', error => finish(error));
    child.once('close', code => finish(code === 0 ? null : new Error('Owned Windows PS command failed: ' + context.redactText(stderr || output).slice(-2000)), output));
  });
  const ps = code => execute('ssh', args(code));
  const cleanupCode = () => `$root=${psLiteral(root)};$owner=${psLiteral(owner)};` + String.raw`
if(!(Test-Path -LiteralPath $root)){
 $live=@(Get-CimInstance Win32_Process -Filter ("CommandLine LIKE '%"+$owner+"%'") -ErrorAction Stop)
 if($live.Count){throw 'Owned nonce is still active although its root is absent'}
 @{owner=$owner;cleaned=$true;directoryAbsent=$true;ownedNonceProcessesAbsent=$true;alreadyAbsent=$true}|ConvertTo-Json -Compress
}else{
 $m=Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json
 if($m.owner -cne $owner -or (Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Owned cleanup identity changed'}
` + (executionDispatched ? String.raw`
 $receipt=Get-Content -LiteralPath (Join-Path $root 'result.json') -Raw|ConvertFrom-Json
 if($receipt.owner -cne $owner -or !$receipt.completed -or !$receipt.workerCloseConfirmed){throw 'Owned worker terminal receipt is unknown; retain root'}
` : '') + String.raw`
 $live=@(Get-CimInstance Win32_Process -Filter ("CommandLine LIKE '%"+$owner+"%'") -ErrorAction Stop)
 if($live.Count){throw 'Owned nonce still has a live process; retain root'}
 function Remove-OwnedReparseEntries([string]$Path){
  foreach($entry in @(Get-ChildItem -LiteralPath $Path -Force)){
   if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){
    if($entry.Attributes -band [IO.FileAttributes]::Directory){[IO.Directory]::Delete($entry.FullName)}else{[IO.File]::Delete($entry.FullName)}
   }elseif($entry.PSIsContainer){Remove-OwnedReparseEntries $entry.FullName}
  }
 }
 Remove-OwnedReparseEntries $root
 [IO.Directory]::Delete($root,$true)
 if(Test-Path -LiteralPath $root){throw 'Owned source root survived cleanup'}
 @{owner=$owner;cleaned=$true;directoryAbsent=$true;ownedNonceProcessesAbsent=$true;terminalReceiptRequired=` + (executionDispatched ? '$true' : '$false') + String.raw`}|ConvertTo-Json -Compress
}`;
  context.addCleanup('remove only owned Windows PowerShell sources after strict terminal reconciliation', async () => {
    if (!creationDispatched) return;
    // Cleanup uses a fresh read of the original nonce and receipt. No test action is replayed.
    const result = await promisify(execFile)('ssh', args(cleanupCode()), { timeout: 45000, maxBuffer: 128 * 1024 });
    report.cleanup = JSON.parse(result.stdout.trim());
    await writeFile(cleanupEvidencePath, JSON.stringify(report.cleanup, null, 2) + '\n');
    assert.equal(report.cleanup.cleaned, true);
    assert.equal(report.cleanup.directoryAbsent, true);
    assert.equal(report.cleanup.ownedNonceProcessesAbsent, true);
  });
  try {
    creationDispatched = true;
    const created = JSON.parse((await ps(ownedCreationScript(parent, owner))).trim());
    assert.equal(created, root);
    await context.writeArtifactJson('windows-owned-root.json', { owner, target, root, sourceInputs: files });
    for (const file of files) await execute('scp', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ControlPath=none', resolve(repoRoot, file.path), `${target}:${root.replaceAll('\\', '/')}/${file.leaf}`]);
    const manifestPath = context.pathInState('inputs.json');
    await writeFile(manifestPath, JSON.stringify({ owner, files }));
    await execute('scp', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ControlPath=none', manifestPath,
      `${target}:${root.replaceAll('\\', '/')}/inputs.json`]);
    const parser = JSON.parse((await ps(`$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseFile(${psLiteral(root + '\\acceptance.ps1')},[ref]$tokens,[ref]$errors);@{version=$PSVersionTable.PSVersion.ToString();errors=@($errors|ForEach-Object{@{id=$_.ErrorId;line=$_.Extent.StartLineNumber}})}|ConvertTo-Json -Depth 4 -Compress`)).trim());
    await context.writeArtifactJson('windows-acceptance-fixture-parser.json', parser);
    assert.deepEqual(parser.errors, []);
    await context.writeArtifactJson('windows-execution-intent.json', { owner, root, fixtureSha256: files.at(-1).sha256, dispatchedOnce: true });
    executionDispatched = true;
    let remote;
    try { remote = JSON.parse((await ps(`& ${psLiteral(root + '\\acceptance.ps1')} -OwnedRoot ${psLiteral(root)} -Owner ${psLiteral(owner)} -Node ${psLiteral(node)}`)).trim()); }
    catch (error) {
      const recovered = await ps(`$p=${psLiteral(root + '\\result.json')};if(!(Test-Path -LiteralPath $p)){throw 'Owned execution receipt is unavailable; do not replay'};Get-Content -LiteralPath $p -Raw`);
      remote = JSON.parse(recovered.trim());
      report.transportReceiptReconciled = true;
      report.transportFailure = context.redactText(error.message).slice(0, 1000);
    }
    assert.equal(remote.owner, owner);
    await context.writeArtifactJson('windows-ps51-result.json', remote);
    report.nativeEvidence = remote;
    assert.equal(remote.completed, true); assert.equal(remote.success, true); assert.equal(remote.workerCloseConfirmed, true);
    assert.equal(remote.originalEntryPointsExecuted, false);
    assert.equal(remote.realCim.length, 6);
    assert.ok(remote.realCim.every(row => row.passed && row.nativeCim));
    assert.ok(remote.parser.every(row => row.errors.length === 0));
    assert.equal(remote.staging.sourceStagingCases.length, 7);
    assert.equal(remote.staging.embeddedNodeProbeExecuted, false);
    for (const file of files) assert.equal(sha256(await readFile(resolve(repoRoot, file.path))), file.sha256, 'Original source changed while Windows verification ran');
    assert.equal(sha256(await readFile(fileURLToPath(import.meta.url))), report.controllerSha256, 'Windows verification controller changed while running');
    report.results = [
      { id: '5659255ce5068fb8', path: files[0].path, sourceSha256: files[0].sha256, decision: 'fixed',
        fixStatus: 'verified_windows_ps51_mechanisms_and_owned_real_cim', windowsPowerShell51: 'PASS',
        actualWindowsAcceptance: 'owned synthetic process identity/query/close only', fullInstallerAcceptance: false,
        rationale: 'The original source rejects actual CIM provider and owner-method errors, verifies SID/image/birth, closes one original owned process and observes successful empty CIM absence. Existing mechanism verifiers also pass in Windows PS5.1.' },
      { id: '62caef1e814e6bd9', path: files[1].path, sourceSha256: files[1].sha256, decision: 'partially_fixed',
        fixStatus: 'windows_ps51_parser_and_seven_owned_ast_staging_cases_passed_full_terminal_deferred', windowsPowerShell51: 'PASS',
        actualWindowsAcceptance: false, windowsFilesystemStagingAcceptance: true,
        rationale: 'Actual PS5.1 ParseFile and seven filesystem staging cases pass with current source. Embedded project Node, packaged Gateway/terminal, ConPTY and DPAPI remain unexecuted.' },
    ];
    report.status = 'PASS_SCOPED';
  } catch (error) {
    failure = error;
    report.status = 'FAIL_OR_UNCONFIRMED';
    report.failure = context.redactText(error.message).slice(0, 1800);
  } finally {
    try { await context.finish(failure ? 'failed' : 'passed', { scoped: true }, failure); }
    catch (error) {
      report.finalizationFailure = context.redactText(error.message).slice(0, 1800);
      if (!report.cleanup?.cleaned) report.cleanupFailure = report.finalizationFailure;
      failure ??= error;
    }
    report.endedAt = new Date().toISOString();
    report.limitations = ['No original installation/task enumeration or original script entrypoint executed.',
      'No personal process, configuration, account, SSH setup, firewall, desktop, ConPTY or DPAPI operation.',
      'The staging verifier only adapts its .NET hash expression; current project source is unchanged.',
      'Real CIM errors are induced through an absent namespace and missing owner method. Full installer and project terminal acceptance remain unexecuted.'];
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw new Error('Scoped Windows PowerShell acceptance failed; inspect retained owned receipts');
  console.log(JSON.stringify({ reportPath, status: report.status, runRoot: context.runRoot, cleanup: report.cleanup }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
