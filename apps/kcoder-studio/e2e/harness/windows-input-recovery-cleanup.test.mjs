import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { assertWindowsInputCleanupReady, observeWindowsInputCleanup, windowsProbeCleanupScript } from './windows-input-recovery-cleanup.mjs';
import { isolatedEnvironment, runE2E } from './run-context.mjs';

const powershell = process.env.KCODER_E2E_PWSH_BIN || (process.env.PATH || '').split(delimiter)
  .map(directory => join(directory, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh')).find(path => existsSync(path));

test('an unconfirmed or missing Native input receipt cannot authorize directory removal', () => {
  for (const state of ['pending', 'unknown', undefined, 'completed']) assert.throws(() => assertWindowsInputCleanupReady(state), /RECOVERY_UNCONFIRMED/);
  assert.doesNotThrow(() => assertWindowsInputCleanupReady('not_started'));
  assert.doesNotThrow(() => assertWindowsInputCleanupReady('confirmed'));
  for (const receipt of [null, {}, { cleaned: false }, { cleaned: true, fixtureStateRetained: true },
    { cleaned: true, result: { nativeInputRecovery: { outcome: 'unknown' } } }]) {
    assert.equal(observeWindowsInputCleanup(receipt), 'unknown');
  }
  assert.equal(observeWindowsInputCleanup({ cleaned: true, result: { passed: false } }), 'confirmed');
  assert.throws(() => windowsProbeCleanupScript('relative/kcoder-windows-e2e-' + randomUUID()), /DIRECTORY_INVALID/);
  assert.throws(() => windowsProbeCleanupScript("C:\\owned\\kcoder-windows-e2e-'bad'"), /DIRECTORY_INVALID/);
});

test('the actual Windows suite fences cleanup before dispatch and rechecks owned recovery markers', async () => {
  const source = await readFile(new URL('../../integration/gateway/windows-workspace-probe.integration.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('assertWindowsInputCleanupReady(nativeInputCleanupState)') < source.indexOf('psArgs(windowsProbeCleanupScript(directory))'));
  assert.ok(source.indexOf("nativeInputCleanupState = 'pending'") < source.indexOf('    const ui ='));
  assert.ok(source.indexOf('observeWindowsInputCleanup(ui)') < source.indexOf("writeArtifactJson('windows-studio-ui.json'"));
});

test('PowerShell outer cleanup retains the entire original directory for inner or outer recovery evidence',
  { timeout: 45000, skip: !powershell ? 'PowerShell unavailable; outer native cleanup not validated' : false }, async () => {
    await runE2E(import.meta.url, { tier: 'harness-unit', modelPolicy: 'owned files and real PowerShell filesystem guard only; no SSH, CIM, desktop or model' }, async context => {
      const observations = [];
      for (const mode of ['inner-marker', 'outer-marker', 'clean']) {
        const root = context.pathInState('kcoder-windows-e2e-' + randomUUID()); await mkdir(root);
        const inner = join(root, 'studio-ui-original'); await mkdir(inner);
        const marker = mode === 'outer-marker' ? join(root, 'native-input-recovery-required.json') : join(inner, 'native-input-foreground.json');
        if (mode !== 'clean') await writeFile(marker, '{"state":"unknown"}');
        const code = windowsProbeCleanupScript(root);
        const child = context.spawnOwned('outer-cleanup-' + mode, powershell,
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')],
          { env: isolatedEnvironment({}, [], { HOME: context.pathInState('home'), USERPROFILE: context.pathInState('home'),
            POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' }) });
        const [exitCode] = await once(child, 'exit');
        if (mode === 'clean') { assert.equal(exitCode, 0); assert.equal(existsSync(root), false); }
        else { assert.notEqual(exitCode, 0); assert.equal(existsSync(root), true); assert.equal(existsSync(marker), true); }
        observations.push({ mode, exitCode, rootRetained: existsSync(root), markerRetained: existsSync(marker) });
      }
      await context.writeArtifactJson('outer-recovery-cleanup.json', { observations, windowsNativeAcceptance: false, sshCalls: 0, cimCalls: 0 });
      return { cases: observations.length, windowsNativeAcceptance: false, sshCalls: 0, cimCalls: 0 };
    });
  });
