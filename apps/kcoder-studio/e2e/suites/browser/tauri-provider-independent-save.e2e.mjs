import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('UNMET_PREREQUISITE: explicit Tauri binary required');
await runE2E(import.meta.url, {
  testId: 'tauri-provider-independent-save-and-effective-values', tier: 'manual-live',
  modelPolicy: 'model-independent native UI, real Gateway/CLI and bounded loopback HTTP; no model quality claim',
}, async context => {
  const overloaded = await startApprovalModelFixture(context, {
    httpErrorPrompt: 'Reply only OK.', httpErrorStatus: 529, httpErrorCode: 'overloaded_error',
  });
  const healthy = await startApprovalModelFixture(context, { textOnly: true });
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  const selector = id => `[data-testid="${id}"]`;
  const command = (action, id, args = {}) => client.command(action, { selector: selector(id), ...args });
  const count = query => client.command('getElementCount', { selector: query }).then(Number);
  try {
    await command('waitFor', 'desktop-sidebar', { visible: true });
    await client.command('navigate', { value: '/settings/personal/models' });
    await command('waitFor', 'provider-save', { enabled: true });
    await command('fill', 'provider-template', { value: 'local-openai' });
    await command('fill', 'provider-endpoint', { value: overloaded.baseUrl });
    await command('fill', 'provider-model', { value: 'native-independent' });
    await client.command('click', { selector: '[data-testid="provider-advanced-settings"] > summary' });
    await command('fill', 'provider-contextWindowTokens', { value: '1000000' });
    await command('fill', 'provider-maxOutputTokens', { value: '65536' });
    await command('click', 'provider-save');
    await command('waitFor', 'provider-edit-local-openai::native-independent', { text: 'native-independent', enabled: true });
    const saved = await readFile(client.settingsPath, 'utf8');
    assert.equal(overloaded.requests.length, 0, 'native local save must not contact upstream');
    await command('click', 'provider-actions-local-openai::native-independent');
    await command('click', 'provider-test-local-openai::native-independent');
    await command('waitFor', 'provider-probe-result', { text: '529', timeoutMs: 30000 });
    assert.equal(overloaded.requests.length, 1);
    assert.equal(await readFile(client.settingsPath, 'utf8'), saved, 'failed independent test retains the exact committed configuration');
    assert.equal(await count(`${selector('provider-save-recovery')}`), 0);
    await command('waitFor', 'provider-save', { enabled: true });
    // Only this verifier's synthetic user root is edited to exercise owner clear.
    const withOverride = JSON.parse(saved);
    withOverride.max_tokens = 8192;
    await writeFile(client.settingsPath, JSON.stringify(withOverride), { mode: 0o600 });
    await command('click', 'provider-refresh');
    await command('waitFor', 'provider-save', { enabled: true });
    await command('click', 'provider-edit-local-openai::native-independent');
    await command('click', 'provider-tab-effectiveProfile');
    await command('waitFor', 'provider-effectiveProfile', { text: '65,536' });
    await command('click', 'provider-tab-effectiveNextTurn');
    await command('waitFor', 'provider-effectiveNextTurn', { text: '8,192' });
    assert.equal(await count(selector('provider-effectiveSnapshot')), 0, 'unscoped target must not present bootstrap configuration as a running conversation');
    await command('click', 'provider-clear-max_tokens');
    await waitFor(async () => await count(selector('provider-clear-max_tokens')) === 0, 15000, 'native user override removed', 100, context.abortSignal);
    await command('waitFor', 'provider-effectiveNextTurn', { text: '65,536' });
    assert.equal(await count(selector('provider-effectiveSnapshot')), 0);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(client.settingsPath, 'utf8')), 'max_tokens'), false);
    await command('fill', 'provider-endpoint', { value: healthy.baseUrl });
    await command('click', 'provider-save-test');
    await command('waitFor', 'provider-probe-result', { text: '通过', timeoutMs: 30000 });
    assert.equal(healthy.requests.length, 1);
    assert.equal(await command('getValue', 'provider-apiKey'), '');
    await client.capture('native-independent-save.png');
    await client.stop();
    return { native: true, localSaveNoNetwork: true, overloadKeepsExactConfig: true,
      profileOutput: 65536, rootOutput: 8192, clearActualUserOwner: true, unscopedSnapshotOmitted: true,
      correctedSaveAndTestSucceeded: true };
  } catch (error) {
    client.markFailed();
    await client.capture('failure.png').catch(() => {});
    throw error;
  } finally { await client.stop(); }
});
