import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

// QA: isolated local marketplace; explicit add consent, confirm-before-revoke,
// never decision and deliberate restore, persisted target profile, no model calls.
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('KCODER_E2E_TAURI_BIN is required');
await runE2E(import.meta.url, {
  testId: 'tauri-plugin-trust-management', tier: 'manual-live',
  modelPolicy: 'model-independent real native UI and target trust storage; no model requests',
}, async context => {
  const source = context.pathInState('trust-market');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true });
  await writeFile(resolve(source, '.claude-plugin/marketplace.json'), JSON.stringify({
    name: 'trust-native', owner: { name: 'Fixture' }, plugins: [],
  }));
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  const selector = id => `[data-testid="${id}"]`;
  const click = id => client.command('click', { selector: selector(id) });
  const trustFile = resolve(dirname(client.settingsPath), 'trusted-folders.json');
  const trust = async () => JSON.parse(await readFile(trustFile, 'utf8'));
  try {
    await client.command('navigate', { value: '/plugins' });
    await client.command('waitFor', { selector: selector('plugins-add-marketplace-button'), timeoutMs: 15000 });
    await waitFor(async () => (await client.command('getText', { selector: selector('plugins-install-target') })).includes('/workspaces/tauri-verification'), 15000, 'target bootstrap');
    await click('plugins-add-marketplace-button');
    await click('plugins-add-custom-marketplace-button');
    await client.command('fill', { selector: selector('plugins-marketplace-path-input'), value: source });
    await click('plugins-marketplace-trust-directory');
    await click('plugins-marketplace-save-button');
    await waitFor(async () => Number(await client.command('getElementCount', { selector: selector('plugins-marketplace-config-dialog') })) === 0, 15000, 'marketplace registered');
    assert.ok((await trust()).trusted.includes(source));
    await click('plugins-trust-manage-button');
    await client.command('waitFor', { selector: selector('plugin-trust-revoke'), timeoutMs: 15000 });
    await click('plugin-trust-revoke');
    assert.ok((await trust()).trusted.includes(source), 'confirmation has not yet changed trust');
    await click('plugin-trust-apply');
    await waitFor(async () => (await trust()).revoked_defaults?.includes(source), 15000, 'persist revoke');
    await client.command('waitFor', { selector: selector('plugin-trust-trust'), timeoutMs: 15000 });
    await click('plugin-trust-never');
    await click('plugin-trust-apply');
    await waitFor(async () => (await trust()).never.includes(source), 15000, 'persist never');
    await waitFor(async () => Number(await client.command('getElementCount', { selector: selector('plugin-trust-confirm') })) === 0, 15000, 'never response applied to UI');
    assert.match(await client.command('getText', { selector: selector('plugin-trust-manager') }), /显式设置 · 禁止信任/);
    await client.capture('trust-never.png');
    await click('plugin-trust-trust');
    await click('plugin-trust-apply');
    await waitFor(async () => (await trust()).trusted.includes(source) && !(await trust()).never.includes(source), 15000, 'explicit restore');
    await client.command('waitFor', { selector: selector('plugin-trust-revoke'), timeoutMs: 15000 });
    await context.writeArtifactJson('trust-results.json', {
      targetScoped: true, confirmationBeforeMutation: true, revokePersisted: true,
      neverPersisted: true, deliberateRestore: true, realTauri: true,
    });
  } catch (error) {
    client.markFailed();
    await client.capture('trust-failure.png').catch(() => {});
    throw error;
  }
});
