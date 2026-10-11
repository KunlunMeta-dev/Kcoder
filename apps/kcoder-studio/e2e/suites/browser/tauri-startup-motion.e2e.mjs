import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
// QA: hold only this run's backend startup so the real startup surface can be
// observed. Assert readable card labels, changing text colors and plane transform;
// then verify readiness replaces the scene. No model or user state involved.
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'native-startup-motion', tier: 'manual-live',
  modelPolicy: 'model-independent real native startup layout and CSS animation' }, async context => {
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN || resolve(appRoot, 'renderer/src-tauri/target/debug/app'),
    kcoderBin: resolve(appRoot, 'e2e/fixtures/runtime/delayed-startup-kcoder.sh'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  try {
    await client.command('waitFor', { selector: '[data-testid="kcoder-startup-scene"]', timeoutMs: 5000 });
    await client.command('resizeWindow', { value: '1280x900' });
    const style = (selector, value) => client.command('getStyle', { selector, value });
    assert.equal(await style('.kcoder-startup-card', 'font-weight'), '400');
    assert.equal(await style('.kcoder-startup-heading', 'background-image'), 'none');
    for (const [selector, property] of [['.kcoder-startup-description', 'background-position'], ['[data-testid="startup-plane"]', 'transform']]) {
      const before = await style(selector, property);
      await waitFor(async () => (await style(selector, property)) !== before, 2000, `${selector} animates`);
    }
    await waitFor(async () => (await style('.kcoder-startup-card-chat', 'opacity')) === '1', 3000, 'all startup cards fully visible');
    await client.capture('native-startup.png');
    await waitFor(async () => (await client.command('getElementCount', { selector: '[data-testid="kcoder-startup-scene"]' })) === '0', 30000, 'readiness ends startup immediately');
    await client.command('waitFor', { selector: '[data-testid="knowledge-button"]', timeoutMs: 10000 });
    await client.capture('native-workbench.png');
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
});
