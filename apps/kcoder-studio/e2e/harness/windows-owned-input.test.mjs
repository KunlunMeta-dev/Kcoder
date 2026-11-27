import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import test from 'node:test';
import { isolatedEnvironment, runE2E } from './run-context.mjs';

const powershell = process.env.KCODER_E2E_PWSH_BIN || (process.env.PATH || '').split(delimiter)
  .map(directory => join(directory, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh')).find(path => existsSync(path));

test('PowerShell recovery attempts independent steps and retains unknown IME receipts',
  { timeout: 45000, skip: !powershell ? 'PowerShell runtime unavailable; recovery/native Windows not validated' : false }, async () => {
    await runE2E(import.meta.url, { tier: 'harness-unit', modelPolicy: 'managed PowerShell ports and owned checkpoint files only; no user32, desktop input or model' }, async context => {
      const script = fileURLToPath(new URL('./windows-owned-input.test.ps1', import.meta.url));
      const child = context.spawnOwned('powershell-input-recovery', powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-OwnedRoot', context.pathInState('checkpoints')],
        { env: isolatedEnvironment({}, [], { HOME: context.pathInState('home'), USERPROFILE: context.pathInState('home'),
          POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' }) });
      let output = ''; child.stdout.on('data', bytes => { output += bytes; });
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, 'PowerShell managed recovery test failed; inspect the owned process log');
      const result = JSON.parse(output.trim());
      assert.equal(result.legacyFirstStepFailureReproduced, true);
      assert.equal(result.nativeDeclarationsCompiled, true);
      assert.equal(result.cases.length, 11);
      assert.equal(result.user32Calls, 0);
      assert.equal(result.nativeWindowsInput, false);
      await context.writeArtifactJson('recovery-mechanisms.json', result);
      return { cases: result.cases.length, nativeWindowsInput: false, user32Calls: 0 };
    });
  });
