import { runInteractiveWindowsProbe } from '../../harness/windows-interactive-probe.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runE2E, repoRoot } from '../../harness/run-context.mjs';

// Explicit opt-in: this diagnostic uses only synthetic configuration on a named
// Windows SSH host, never its real credentials, projects, or running Studio.
const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
const control = process.env.KCODER_E2E_WINDOWS_SSH_CONTROL_PATH;
const binary = process.env.KCODER_E2E_WINDOWS_BINARY;
const gatewayDirectory = process.env.KCODER_E2E_WINDOWS_GATEWAY_DIRECTORY;
const studioDirectory = process.env.KCODER_E2E_WINDOWS_STUDIO_DIRECTORY;
const modelScopeProbe = process.env.KCODER_E2E_WINDOWS_MODEL_SCOPE === '1';
const menusProbe = process.env.KCODER_E2E_WINDOWS_MENUS === '1';
const historyProbe = process.env.KCODER_E2E_WINDOWS_HISTORY === '1';
const workflowProbe = process.env.KCODER_E2E_WINDOWS_WORKFLOWS === '1';
const pluginsProbe = process.env.KCODER_E2E_WINDOWS_PLUGINS === '1';
const shortPaths = process.env.KCODER_E2E_WINDOWS_SHORT_PATHS === '1';
const phase1Probe = process.env.KCODER_E2E_WINDOWS_PHASE1 === '1';
if (!target || !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(target) || !control || !binary) {
  throw new Error('UNMET_PREREQUISITE: explicit Windows SSH target, control socket and test binary are required');
}
if ((historyProbe || workflowProbe || pluginsProbe || modelScopeProbe || menusProbe) && !studioDirectory) throw new Error('UNMET_PREREQUISITE: project history validation requires a Windows Studio installation');

await runE2E(import.meta.url, {
  testId: 'windows-long-path-workspace-initialize-prepare-thread',
  tier: 'manual-live',
  modelPolicy: 'model-independent native Windows; optional public marketplace/MCP access; local synthetic provider only',
}, async context => {
  let sequence = 0;
  const execute = (command, args, timeoutMs = 90000) => new Promise((resolveResult, reject) => {
    const label = `windows-probe-${++sequence}`;
    const child = context.spawnOwned(label, command, ['ssh', 'scp'].includes(command) ? ['-o', 'BatchMode=yes', ...args] : args);
    let stdout = '';
    const timer = setTimeout(() => { void context.stopOwned(label); reject(new Error('Windows probe command timed out')); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      code === 0 ? resolveResult(stdout) : reject(new Error(`Windows probe command exited ${code}`));
    });
  });
  const psArgs = script => ['-S', control, target, 'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from("$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new();" + script, 'utf16le').toString('base64')];
  const ps = (script, timeoutMs) => execute('ssh', psArgs(script), timeoutMs);
  const name = `kcoder-windows-e2e-${randomUUID()}`;
  const directory = JSON.parse((await ps(`$p=Join-Path ([IO.Path]::GetTempPath()) '${name}';[IO.Directory]::CreateDirectory($p)|Out-Null;ConvertTo-Json -InputObject $p`)).trim());
  assert.ok(typeof directory === 'string' && directory.endsWith(name) && !directory.includes("'"));
  context.addCleanup('remove owned Windows probe binaries', async () => {
    await promisify(execFile)('ssh', psArgs(`[IO.Directory]::Delete('${directory}', $true);if([IO.Directory]::Exists('${directory}')){throw 'Remote cleanup failed'}`), { timeout: 8000 });
  });
  const remoteDirectory = directory.replaceAll('\\', '/');
  await execute('scp', ['-o', `ControlPath=${control}`, resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-workspace-probe.ps1'), `${target}:${remoteDirectory}/probe.ps1`]);
  await execute('scp', ['-o', `ControlPath=${control}`, resolve(binary), `${target}:${remoteDirectory}/kcoder.exe`]);
  const binarySha256 = createHash('sha256').update(await readFile(resolve(binary))).digest('hex');
  const remoteSha256 = (await ps(`(Get-FileHash -Algorithm SHA256 -LiteralPath '${directory}\\kcoder.exe').Hash`)).trim().toLowerCase();
  assert.equal(remoteSha256, binarySha256);
  await context.writeArtifactJson('windows-binary.json', { binarySha256, uploadedBinaryMatches: true });
  if (process.env.KCODER_E2E_WINDOWS_OAUTH === '1') {
    for (const [source, destination] of [
      ['apps/kcoder-studio/e2e/harness/windows-oauth-probe.mjs', 'windows-oauth-probe.mjs'],
      ['apps/kcoder-studio/e2e/harness/oauth-mcp.mjs', 'oauth-mcp.mjs'],
      ['apps/kcoder-studio/src/mcp-oauth-callback.js', 'mcp-oauth-callback.mjs'],
    ]) {
      await execute('scp', ['-o', `ControlPath=${control}`, resolve(repoRoot, source), `${target}:${remoteDirectory}/${destination}`]);
    }
    const output = await ps(`& node '${directory}\\windows-oauth-probe.mjs' '${directory}\\kcoder.exe' '${directory}'`, 180000);
    const result = JSON.parse(output.trim());
    await context.writeArtifactJson('windows-oauth.json', result);
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.cleaned, true);
  }
  if (phase1Probe) {
    await execute('scp', ['-o', `ControlPath=${control}`, resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-phase1-probe.cjs'), `${target}:${remoteDirectory}/phase1-probe.cjs`]);
    const phase1 = JSON.parse((await ps(`& node '${directory}\\phase1-probe.cjs' '${directory}\\kcoder.exe' '${directory}'`, 180000)).trim());
    await context.writeArtifactJson('windows-phase1.json', { ...phase1, binarySha256 });
    assert.equal(phase1.cleaned, true);
    assert.equal(phase1.result?.passed, true, `Windows phase1 failed: ${phase1.result?.error}`);
  }
  if (process.env.KCODER_E2E_WINDOWS_MARKETPLACE === '1') {
    const marketplaceMcp = process.env.KCODER_E2E_WINDOWS_MARKETPLACE_MCP || 'exa';
    assert.ok(['exa', 'context7', 'playwright'].includes(marketplaceMcp));
    const mcpChrome = process.env.KCODER_E2E_WINDOWS_MCP_CHROME || '';
    assert.ok(!mcpChrome.includes("'"));
    if (marketplaceMcp === 'playwright') assert.ok(mcpChrome, 'Playwright test requires an explicit bundled Chrome executable');
    await execute('scp', ['-o', `ControlPath=${control}`, resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-marketplace-probe.mjs'), `${target}:${remoteDirectory}/marketplace-probe.mjs`]);
    const output = await ps(`& node '${directory}\\marketplace-probe.mjs' '${directory}\\kcoder.exe' '${directory}' '${marketplaceMcp}' '${mcpChrome}';if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`, 210000);
    await context.writeArtifactJson('windows-marketplace.json', { output, installedAndRemoved: ['frontend-design', marketplaceMcp, 'ai-plugins'] });
  }
  const result = JSON.parse((await ps(`& '${directory}\\probe.ps1' -Binary '${directory}\\kcoder.exe' ${shortPaths ? '-ShortPaths' : ''}`)).trim());
  await context.writeArtifactJson('windows-probe.json', result);
  assert.equal(result.cleaned, true);
  assert.equal(result.results.find(step => step.step === 'initialize')?.success, true);
  for (const name of ['prepare-create', 'prepare-select', 'workspace-list', 'thread-start', 'turn-start', 'archive-thread']) {
    const step = result.results.find(item => item.step === name);
    assert.ok(step?.response?.result, `${name} failed: ${JSON.stringify(step?.response?.error)}`);
  }
  assert.equal(result.results.find(step => step.step === 'turn-completed')?.status, 'completed');
  assert.equal(result.results.find(step => step.step === 'node-canonical-workspace-start')?.response?.status, 0);
  assert.equal(result.results.find(step => step.step === 'node-canonical-workspace-start')?.response?.initialized, true);
  assert.equal(result.results.find(step => step.step === 'node-canonical-workspace-start')?.response?.largeFrames, 20);
  assert.equal(result.results.find(step => step.step === 'node-canonical-workspace-start')?.response?.concurrentFrames, 20);
  assert.equal(result.results.find(step => step.step === 'process-exit')?.code, 0);
  const sshHost = process.env.KCODER_E2E_WINDOWS_REMOTE_HOST;
  if (sshHost) {
    const sshUser = process.env.KCODER_E2E_WINDOWS_REMOTE_USER;
    const sshWorkspace = process.env.KCODER_E2E_WINDOWS_REMOTE_WORKSPACE;
    assert.ok(studioDirectory && sshUser && sshWorkspace, 'Remote SSH probe requires the installed Studio and explicit remote user/workspace');
    for (const value of [studioDirectory, sshHost, sshUser, sshWorkspace]) assert.ok(!value.includes("'"));
    await execute('scp', ['-o', `ControlPath=${control}`, resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-ssh-launch-probe.mjs'), `${target}:${remoteDirectory}/ssh-launch-probe.mjs`]);
    const output = await ps(`& node '${directory}\\ssh-launch-probe.mjs' '${studioDirectory}\\resources\\gateway' '${sshHost}' '${sshUser}' '${sshWorkspace}';if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`, 20000);
    await context.writeArtifactJson('windows-installed-ssh.json', JSON.parse(output.trim()));
  }
  if (gatewayDirectory) {
    assert.ok(!gatewayDirectory.includes("'"));
    await execute('scp', ['-o', `ControlPath=${control}`, resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-project-terminal-probe.ps1'), `${target}:${remoteDirectory}/gateway-probe.ps1`]);
    await execute('scp', ['-o', `ControlPath=${control}`, resolve(repoRoot, 'apps/kcoder-studio/dev-server.mjs'), `${target}:${remoteDirectory}/dev-server.mjs`]);
    for (const name of ['ssh-terminal-store.js', 'ssh-credential-cipher.js', 'ssh-terminal.js']) {
      await execute('scp', ['-o', `ControlPath=${control}`, resolve(repoRoot, 'apps/kcoder-studio/src', name), `${target}:${remoteDirectory}/${name}`]);
    }
    const gatewayResult = JSON.parse((await ps(`& '${directory}\\gateway-probe.ps1' -Binary '${directory}\\kcoder.exe' -GatewayDirectory '${gatewayDirectory}' -GatewayEntry '${directory}\\dev-server.mjs'`)).trim());
    await context.writeArtifactJson('windows-project-terminal.json', gatewayResult);
    assert.equal(gatewayResult.cleaned, true);
    assert.equal(gatewayResult.result?.passed, true, `Windows project/terminal failed at ${gatewayResult.result?.stage}`);
  }
  if (studioDirectory) {
    assert.ok(!studioDirectory.includes("'"));
    const archive = context.pathInState('windows-ui-overlay.tar.gz');
    await execute('tar', ['-czf', archive, '-C', resolve(repoRoot, 'apps/kcoder-studio'), 'renderer/dist', 'dev-server.mjs', 'src', '-C', repoRoot, 'logo/logo.png']);
    await execute('scp', ['-o', `ControlPath=${control}`, archive, `${target}:${remoteDirectory}/ui-overlay.tar.gz`]);
    await execute('scp', ['-o', `ControlPath=${control}`, resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-studio-ui-probe.cjs'), `${target}:${remoteDirectory}/studio-ui-probe.cjs`]);
    if (process.env.KCODER_E2E_WINDOWS_NATIVE_INPUT === '1') await execute('scp', ['-o', `ControlPath=${control}`, resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-owned-input.ps1'), `${target}:${remoteDirectory}/windows-owned-input.ps1`]);
    await ps(`[IO.Directory]::CreateDirectory('${directory}\\overlay')|Out-Null; & tar -xf '${directory}\\ui-overlay.tar.gz' -C '${directory}\\overlay'; if($LASTEXITCODE -ne 0){throw 'Overlay extraction failed'}`);
    const ui = process.env.KCODER_E2E_WINDOWS_INTERACTIVE_INPUT === '1'
      ? await runInteractiveWindowsProbe(context, { ps, cleanupPs: async script => (await promisify(execFile)('ssh', ['-o','BatchMode=yes', ...psArgs(script)], {timeout:20000})).stdout, directory, installation: studioDirectory,
          node: process.env.KCODER_E2E_WINDOWS_NODE || 'node', flags: ['--model-scope','--native-input'],
          upload: (source, destination) => execute('scp', ['-o', `ControlPath=${control}`, source, `${target}:${remoteDirectory}/${destination}`]),
        })
      : JSON.parse((await ps(`$result=& '${process.env.KCODER_E2E_WINDOWS_NODE || 'node'}' '${directory}\\studio-ui-probe.cjs' '${directory}\\kcoder.exe' '${studioDirectory}' '${directory}\\overlay' '${directory}' ${modelScopeProbe ? '--model-scope' : menusProbe ? '--menu-layout' : pluginsProbe ? '--plugins' : workflowProbe ? '--workflows' : historyProbe ? '--project-history' : ''} ${process.env.KCODER_E2E_WINDOWS_INSTALLED_RESOURCES === '1' ? '--installed-resources' : ''} ${process.env.KCODER_E2E_WINDOWS_NATIVE_INPUT === '1' ? '--native-input' : ''}; Write-Output $result`, historyProbe || workflowProbe || process.env.KCODER_E2E_WINDOWS_INSTALLED_RESOURCES === '1' ? 240000 : 180000)).trim());
    await context.writeArtifactJson('windows-studio-ui.json', ui);
    for (const name of ['windows-model-scope-and-focus.png', 'windows-menu-layout.png', 'windows-skill-management.png', 'windows-mcp-management.png', 'windows-plugin-manager.png', 'windows-appearance.png', 'windows-avatar.png', 'windows-usage.png', 'windows-project-history.png', 'windows-workflow-colors.png', 'windows-workflows.png', 'windows-failure.png', 'windows-history-dom.json']) {
      const present = (await ps(`Test-Path -LiteralPath '${directory}\\${name}'`)).trim();
      if (present === 'True') await execute('scp', ['-o', `ControlPath=${control}`, `${target}:${remoteDirectory}/${name}`, context.pathInArtifacts(name)]);
    }
    assert.equal(ui.cleaned, true);
    assert.equal(ui.result?.passed, true, `Windows Studio failed at ${ui.result?.stage}: ${ui.result?.error}`);
    if (modelScopeProbe) {
      if (process.env.KCODER_E2E_WINDOWS_NATIVE_INPUT === '1') { assert.equal(ui.result?.nativeWindowsMouse, true); assert.equal(ui.result?.nativeWindowsIme, true); }
      assert.equal(ui.result?.modelScopedBodies, true);
      assert.equal(ui.result?.focusRestored, true);
      assert.equal(ui.result?.compositionEnterDoesNotSubmit, true);
    } else if (menusProbe) assert.equal(ui.result?.menuLayout, true);
    else if (pluginsProbe) assert.equal(ui.result?.pluginsValidated, true);
    else if (workflowProbe) assert.equal(ui.result?.workflowsValidated, true);
    else if (historyProbe) assert.equal(ui.result?.projectHistory, true);
  }
  return { initialized: true, longPathSkillsPublished: !shortPaths, projectRegistered: true, threadStarted: true, deterministicTurnCompleted: true, threadArchived: true, nodeCanonicalWorkspaceStarted: true, syntheticStateRemoved: true, projectHistoryValidated: historyProbe };
});
