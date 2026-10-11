import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { runE2E } from '../../harness/run-context.mjs';

for (const name of ['KCODER_E2E_TAURI_BIN', 'KCODER_E2E_KCODER_BIN', 'KCODER_E2E_RENDERER_ROOT']) {
  assert.ok(process.env[name], `${name} must explicitly identify this native verification build`);
}

// Each launch has its own controller/profile/display. The second begins only
// after the first run has proved cleanup, never by adopting a personal window.
for (let launch = 1; launch <= 2; launch += 1) {
  await runE2E(import.meta.url, {
    testId: 'native-shell-owned-start-stop-relaunch',
    tier: 'manual-live',
    modelPolicy: 'model-independent real Tauri window lifecycle and deny-all native boundary',
    retainSuccessEvidence: true,
    evidenceReason: 'Native module extraction and owned process cleanup',
  }, async context => {
    const client = await startOwnedAiVerify(context, {
      tauriBin: process.env.KCODER_E2E_TAURI_BIN,
      kcoderBin: process.env.KCODER_E2E_KCODER_BIN,
      rendererRoot: process.env.KCODER_E2E_RENDERER_ROOT,
    });
    const wait = id => client.command('waitFor', { selector: `[data-testid="${id}"]` });
    try {
      const boundary = JSON.parse(await readFile(resolve(client.runRoot, 'artifacts/native-boundary.json'), 'utf8'));
      assert.equal(boundary.nativeAppCommandDenied, true);
      assert.equal(boundary.nativePluginCommandDenied, true);
      await wait('desktop-sidebar');
      await client.command('navigate', { value: '/settings/kcoder-servers' });
      await wait('runtime-target-row-local');
      assert.equal(await client.command('resizeWindow', { value: '900x640' }), '900x640');
      await wait('runtime-target-row-local');
      assert.equal(await client.command('resizeWindow', { value: '1280x720' }), '1280x720');
      const denied = await client.command('closeMainWindowToTray', {
        expectedFailure: true,
        expectedError: 'Native automation commands are disabled in Gateway verification',
      });
      assert.equal(denied.expectedFailure, true);
      await client.command('navigate', { value: '/' });
      await wait('desktop-sidebar');
      await client.capture(`native-shell-launch-${launch}.png`);
      return { launch, ready: true, nativeBoundaryPreserved: true, resizeAndNavigationRecovered: true };
    } catch (error) {
      client.markFailed();
      await client.capture('native-shell-failure.png').catch(() => {});
      throw error;
    } finally {
      const cleanup = await client.stop();
      assert.equal(cleanup.cleaned, true);
    }
  });
}
