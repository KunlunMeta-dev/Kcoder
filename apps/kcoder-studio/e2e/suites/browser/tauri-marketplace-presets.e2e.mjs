import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

// QA: docs/plugin-marketplace-presets-qa.md. Model independent, local fixtures only.
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('KCODER_E2E_TAURI_BIN is required');
await runE2E(import.meta.url, {
  testId: 'tauri-marketplace-presets', tier: 'manual-live',
  modelPolicy: 'real native selector and target registration, no model or public network',
}, async context => {
  const source = context.pathInState('preset-fixture');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true });
  await writeFile(resolve(source, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'preset-fixture', plugins: [] }));
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  const selector = id => `[data-testid="${id}"]`;
  const click = id => client.command('click', { selector: selector(id) });
  try {
    await client.command('navigate', { value: '/plugins' });
    await client.command('waitFor', { selector: `${selector('plugins-marketplace-selector')}:not(:disabled)`, timeoutMs: 15000 });
    await client.command('press', { selector: selector('plugins-marketplace-selector'), key: 'ArrowDown' });
    await client.command('waitFor', { selector: '[role="listbox"]', text: 'xAI / Grok 官方' });
    const labels = await client.command('getText', { selector: '[role="listbox"]' });
    for (const label of ['腾讯 CodeBuddy 官方', 'xAI / Grok 官方', 'OpenAI 官方', 'Claude 官方']) assert.ok(labels.includes(label), label);
    await client.capture('marketplace-presets.png');
    // Capture can resize the WebView, which deliberately dismisses anchored menus.
    await client.command('press', { selector: selector('plugins-marketplace-selector'), key: 'ArrowDown' });
    await client.command('waitFor', { selector: '[role="option"][data-value="custom:new"]' });
    await client.command('click', { selector: '[role="option"][data-value="custom:new"]' });
    await client.command('fill', { selector: selector('plugins-marketplace-path-input'), value: resolve(source, 'missing') });
    await click('plugins-marketplace-save-button');
    await client.command('waitFor', { selector: selector('plugins-marketplace-config-error') });
    await client.command('fill', { selector: selector('plugins-marketplace-path-input'), value: source });
    await click('plugins-marketplace-trust-directory');
    await click('plugins-marketplace-save-button');
    await waitFor(async () => Number(await client.command('getElementCount', { selector: selector('plugins-marketplace-config-dialog') })) === 0, 15000, 'successful recovery');
    await client.command('press', { selector: selector('plugins-marketplace-selector'), key: 'ArrowDown' });
    await client.command('waitFor', { selector: '[role="option"][data-value="local:preset-fixture"][aria-selected="true"]' });
    await client.capture('marketplace-added.png');
    // A second market makes this a real selection-memory test, not default fallback.
    const secondSource = context.pathInState('second-fixture');
    await mkdir(resolve(secondSource, '.claude-plugin'), { recursive: true });
    await writeFile(resolve(secondSource, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'second-fixture', plugins: [] }));
    await client.command('press', { selector: selector('plugins-marketplace-selector'), key: 'ArrowDown' });
    await client.command('click', { selector: '[role="option"][data-value="custom:new"]' });
    await client.command('fill', { selector: selector('plugins-marketplace-path-input'), value: secondSource });
    await click('plugins-marketplace-trust-directory');
    await click('plugins-marketplace-save-button');
    await waitFor(async () => Number(await client.command('getElementCount', { selector: selector('plugins-marketplace-config-dialog') })) === 0, 15000, 'second market registered');
    await client.command('press', { selector: selector('plugins-marketplace-selector'), key: 'ArrowDown' });
    await client.command('click', { selector: '[role="option"][data-value="local:preset-fixture"]' });
    await client.command('navigate', { value: '/' });
    await client.command('navigate', { value: '/plugins' });
    await client.command('waitFor', { selector: `${selector('plugins-marketplace-selector')}:not(:disabled)`, timeoutMs: 15000 });
    await client.command('press', { selector: selector('plugins-marketplace-selector'), key: 'ArrowDown' });
    await client.command('waitFor', { selector: '[role="option"][data-value="local:preset-fixture"][aria-selected="true"]' });
    await client.capture('marketplace-selection-restored.png');
    await context.writeArtifactJson('presets-results.json', { emptyStatePresets: true, officialCatalogs: true, customRegistration: true, failureRecovery: true, selectionSurvivesNavigation: true, realTauri: true });
  } catch (error) {
    client.markFailed();
    await client.capture('failure.png').catch(() => {});
    throw error;
  }
});
