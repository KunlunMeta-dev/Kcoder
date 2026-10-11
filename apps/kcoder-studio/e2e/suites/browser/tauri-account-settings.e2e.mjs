import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E } from '../../harness/run-context.mjs';

// QA: real Tauri account editor, persisted target, failed login and retry controls.
// Port 1 is deliberately unavailable; backend account isolation has a separate real SSH test.
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('KCODER_E2E_TAURI_BIN is required');
await runE2E(import.meta.url, {
  testId: 'tauri-account-target-and-login-failure', tier: 'manual-live', modelPolicy: 'model-independent account settings and failure recovery',
}, async context => {
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  const selector = id => `[data-testid="${id}"]`;
  const click = id => client.command('click', { selector: selector(id) });
  const fill = (id, value) => client.command('fill', { selector: selector(id), value });
  try {
    await client.command('snapshot');
    await client.command('navigate', { value: '/settings/kcoder-servers' });
    await client.command('waitFor', { selector: selector('runtime-target-add'), visible: true });
    await click('runtime-target-add');
    await fill('runtime-target-label', 'Account isolation fixture');
    await fill('runtime-target-id', 'account-fixture');
    await fill('runtime-target-transport', 'ssh');
    await fill('runtime-target-host', '127.0.0.1');
    await click('runtime-target-account-mode');
    await click('runtime-target-advanced-toggle');
    await fill('runtime-target-port', '1');
    assert.notEqual(await client.command('getAttribute', { selector: selector('runtime-target-command'), value: 'disabled' }), null);
    await click('runtime-target-save');
    const row = selector('runtime-target-row-account-fixture');
    await client.command('waitFor', { selector: row, visible: true });
    await client.command('fill', { selector: row + ' [data-testid="kcoder-account-username"]', value: 'alice' });
    await client.command('fill', { selector: row + ' [data-testid="kcoder-account-password"]', value: 'synthetic-account-password' });
    await client.command('click', { selector: row + ' [data-testid="kcoder-account-submit"]' });
    await client.command('waitFor', { selector: row + ' [role="alert"]', visible: true, timeoutMs: 20000 });
    await client.command('waitFor', { selector: row + ' [data-testid="kcoder-account-username"]', visible: true });
    assert.equal(Number(await client.command('getElementCount', { selector: row + ' [data-testid="kcoder-account-management"]' })), 0);
    await client.capture('account-login-retry.png');
    await context.writeArtifactJson('account-settings.json', { targetSaved: true, loginFailureVisible: true, retryEnabled: true, administratorControlsHidden: true });
  } catch (error) { client.markFailed(); throw error; }
  finally { await client.stop(); }
});
