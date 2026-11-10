import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot } from './run-context.mjs';
import { windowsSshInvocation } from './windows-ssh-auth.mjs';
import { ownedCreationScript, ownedCleanupScript, psLiteral } from './windows-package-probe.mjs';
import { runInteractiveWindowsProbe } from './windows-interactive-probe.mjs';
import { runKeyringWindowsCommand } from './windows-keyring-logon.mjs';

export async function verifyWindowsDesktopActionUnknown(context, options) {
  assert.equal(options.consent, '1', 'UNMET_PREREQUISITE: explicit actual Windows desktop fixture consent required');
  assert.match(options.target ?? '', /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/);
  for (const field of ['archiveSha256', 'cliSha256', 'runtimeManifestSha256']) assert.match(options[field] ?? '', /^[a-f0-9]{64}$/);
  assert.match(options.parent ?? '', /^[A-Za-z]:\\[^\0\r\n"'<>|?*]*$/);
  assert.match(options.node ?? '', /^[A-Za-z]:\\[^\0\r\n"'<>|?*]+\.exe$/);
  assert.equal(createHash('sha256').update(await readFile(options.archive)).digest('hex'), options.archiveSha256);
  let sequence = 0;
  const execute = (command, args, timeout = 120000) => new Promise((accept, reject) => {
    const spec = windowsSshInvocation(context, command, args, options.target);
    const label = `desktop-host-${++sequence}`;
    const child = context.spawnOwned(label, spec.command, spec.args, spec.options);
    let output = '', diagnostic = '';
    const timer = setTimeout(() => { void context.stopOwned(label); reject(new Error('Owned Windows desktop command deadline')); }, timeout);
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 2 * 1024 * 1024) { void context.stopOwned(label); reject(new Error('Owned desktop output budget')); } });
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-4096); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? accept(output)
      : reject(new Error(`Owned desktop command failed (${code}): ${context.redactText(diagnostic || output)}`)); });
  });
  const args = script => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-S', 'none', options.target,
    'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')];
  const ps = script => execute('ssh', args(script));
  const cleanupPs = async script => {
    return runKeyringWindowsCommand(context, options.target, `desktop-cleanup-${++sequence}`, 'ssh', args(script),
      { cleanup: true, timeoutMs: 45000 });
  };
  const owner = randomUUID();
  const directory = JSON.parse((await ps(ownedCreationScript(options.parent, owner))).trim());
  assert.equal(directory, options.parent.replace(/\\$/, '') + '\\kcoder-package-' + owner);
  const cleanupPath = context.pathInArtifacts('windows-desktop-cleanup.json');
  context.addCleanup('remove exact owned Windows desktop package', async () => {
    const receipt = JSON.parse((await cleanupPs(ownedCleanupScript(directory, owner, 'studio-ui-probe.cjs'))).trim());
    await writeFile(cleanupPath, JSON.stringify(receipt)); assert.equal(receipt.cleaned, true);
  });
  const destination = directory.replaceAll('\\', '/');
  const upload = (source, leaf) => execute('scp', ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', source, `${options.target}:${destination}/${leaf}`], 240000);
  await context.writeArtifactJson('windows-desktop-inputs.json', { ...options, owner, directory,
    scope: options.ownedFixtureInput === true
      ? 'explicit owned-fixture-input only: actual MCP Click-to-focus, screenshot/short Type/Verify Click with point-owner and keyboard focus fences; no Snapshot/UIA, DESK02 full-scene, business or final-release claim'
      : 'actual native action and caller event receipt loss; not native broker transport loss, business success or latest-source release' });
  await upload(options.archive, 'desktop.zip');
  await ps(`$p=${psLiteral(directory)};if((Get-FileHash -LiteralPath (Join-Path $p 'desktop.zip') -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${options.archiveSha256}'){throw 'Desktop archive digest mismatch'};Expand-Archive -LiteralPath (Join-Path $p 'desktop.zip') -DestinationPath (Join-Path $p 'app');if((Get-FileHash -LiteralPath (Join-Path $p 'app\\resources\\bin\\kcoder.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${options.cliSha256}'){throw 'Desktop CLI mismatch'};if((Get-FileHash -LiteralPath (Join-Path $p 'app\\resources\\computer-use\\runtime-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${options.runtimeManifestSha256}'){throw 'Desktop runtime mismatch'}`);
  const sourceFiles = ['windows-desktop-action-unknown.mjs', 'desktop-action-receipt-loss.mjs', 'app-server-stdio.mjs', 'approval-model.mjs', 'owned-process.mjs'];
  if (options.ownedFixtureInput === true) sourceFiles.push('windows-owned-desktop-observation.mjs');
  const sourceIdentities = [];
  for (const leaf of [...sourceFiles, 'windows-desktop-action-entry.cjs']) sourceIdentities.push({ leaf,
    sha256: createHash('sha256').update(await readFile(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness', leaf))).digest('hex') });
  await context.writeArtifactJson('windows-desktop-actor-source.json', sourceIdentities);
  for (const leaf of sourceFiles) await upload(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness', leaf), leaf);
  await upload(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-desktop-action-entry.cjs'), 'studio-ui-probe.cjs');
  await upload(resolve(repoRoot, 'scripts/computer-use/live/fixture.ps1'), 'fixture.ps1');
  const config = await context.writeStateJson('desktop-input.json', { owner, cliSha256: options.cliSha256,
    runtimeManifestSha256: options.runtimeManifestSha256, ...(options.ownedFixtureInput === true ? { ownedFixtureInput: true } : {}) });
  await upload(config, 'desktop-input.json');
  let result;
  try {
    result = await runInteractiveWindowsProbe(context, { ps, cleanupPs, upload, directory,
      node: options.node, installation: directory + '\\app', flags: ['--native-input'] });
  } finally {
    const outputs = ['native-screenshot.png', 'native-failure.json'];
    if (options.ownedFixtureInput === true) outputs.push('owned-boundary-observations.json', 'owned-boundary-failure.json', 'owned-native-progress.json',
      'owned-click-schema-and-wire.json', 'owned-input-observed-receipt.json');
    for (const leaf of outputs) {
      if ((await ps(`Test-Path -LiteralPath ${psLiteral(directory + '\\' + leaf)}`)).trim() === 'True')
        await execute('scp', ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', `${options.target}:${destination}/${leaf}`, context.pathInArtifacts(leaf)]);
    }
    const original = await ps(`if(Test-Path -LiteralPath ${psLiteral(directory + '\\interactive-result.json')}){Get-Content -LiteralPath ${psLiteral(directory + '\\interactive-result.json')}}else{'null'}`);
    await context.writeArtifactJson('windows-desktop-original-output.json', { output: original });
  }
  assert.equal(result.passed, true);
  if (options.ownedFixtureInput === true) {
    assert.equal(result.ownedFixtureInput, true);
    assert.equal(result.snapshotUiaVerified, false);
    assert.equal(result.explicitRevoke.revoked, true);
    assert.equal(result.nativeLeaseCleanupConfirmed, true);
  } else assert.equal(result.lostAction.callerReceivedActionResult, false);
  assert.equal(result.originalHistoryReconciled, true);
  assert.deepEqual(result.afterReopen, result.originalReceipt);
  await context.writeArtifactJson('windows-desktop-action-proof.json', result);
  return result;
}
