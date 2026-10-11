import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('UNMET_PREREQUISITE: explicit owned Tauri binary required');
// QA: native private form from an owned local catalog, declared-key scope confirmation,
// fields cleared before RPC, availability refreshed after setup, actual installation.
// Runtime/MCP invocation is separately covered by plugin-private-lifecycle Gateway suite.
await runE2E(import.meta.url, { testId: 'tauri-plugin-private-catalog-installation', tier: 'full-integration',
  modelPolicy: 'model-independent native private UI/Gateway/store transport; no paid calls' }, async context => {
  const source = context.pathInState('private-native-market');
  const plugin = resolve(source, 'plugins/private-native');
  await mkdir(resolve(source, '.claude-plugin'), { recursive: true });
  await mkdir(resolve(plugin, '.claude-plugin'), { recursive: true });
  await writeFile(resolve(source, '.claude-plugin/marketplace.json'), JSON.stringify({
    name: 'private-native-market', owner: { name: 'Owned fixture' },
    plugins: [{ name: 'private-native', source: './plugins/private-native', description: 'Owned private setup fixture' }],
  }));
  await writeFile(resolve(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'private-native', version: '1.0.0',
    mcpServers: { native: { type: 'http', url: 'https://example.invalid/mcp',
      headers: { Authorization: 'Bearer ${P09_NATIVE_SYNTHETIC_TOKEN}' } } } }));
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist') });
  const selector = id => `[data-testid="${id}"]`;
  const command = (action, id, rest = {}) => client.command(action, { selector: selector(id), ...rest });
  const id = 'private-native@private-native-market';
  const installedState = async () => {
    try { return JSON.parse(await readFile(resolve(dirname(client.settingsPath), 'plugin_store/state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { installed: {} }; throw error; }
  };
  const token = 'p09-native-public-synthetic-fixture'; context.registerSecret(token);
  try {
    await client.command('navigate', { value: '/plugins' });
    await command('waitFor', 'plugins-add-marketplace-button', { timeoutMs: 20000 });
    await waitFor(async () => (await command('getText', 'plugins-install-target')).includes('/workspaces/tauri-verification'), 20000, 'stable owned target scope');
    await command('waitFor', 'plugins-marketplace-selector', { enabled: true, timeoutMs: 20000 });
    await command('click', 'plugins-add-marketplace-button');
    await command('click', 'plugins-add-custom-marketplace-button');
    await command('fill', 'plugins-marketplace-path-input', { value: source });
    await command('click', 'plugins-marketplace-trust-directory');
    await command('click', 'plugins-marketplace-save-button');
    await command('waitFor', `plugin-marketplace-row-${id}`, { timeoutMs: 20000 });
    await command('click', `plugin-marketplace-row-${id}`);
    await command('waitFor', 'plugin-activation-check', { enabled: true });
    await command('click', 'plugin-activation-check');
    await client.command('waitFor', { selector: 'input[name="P09_NATIVE_SYNTHETIC_TOKEN"]', enabled: true, timeoutMs: 15000 });
    await client.command('fill', { selector: 'input[name="P09_NATIVE_SYNTHETIC_TOKEN"]', value: token });
    await client.command('click', { selector: '[data-testid="plugin-private-credentials"] button[type="submit"]' });
    await waitFor(async () => Number(await command('getElementCount', 'plugin-private-credentials')) === 0, 15000,
      'private setup clears fields and refreshes catalog');
    await command('waitFor', `plugin-detail-toggle-${id}`, { enabled: true });
    await command('click', `plugin-detail-toggle-${id}`);
    await waitFor(async () => (await installedState()).installed[id]?.version === '1.0.0', 15000, 'owned immutable package published');
    assert.match((await installedState()).installed[id].operation_id, /^[a-f0-9]{32}$/);
    await command('waitFor', `plugin-detail-actions-${id}`);
    assert.ok(!(await command('getText', 'plugin-detail-page')).includes(token));
    await client.capture('private-plugin-installed.png');
    await command('click', `plugin-detail-actions-${id}`);
    await command('click', `plugin-detail-uninstall-${id}`);
    await waitFor(async () => !(await installedState()).installed[id], 15000, 'owned package removed');
    await context.writeArtifactJson('private-native-results.json', { realTauri: true, declaredFieldOnly: true,
      sourceIdentityConfirmed: true, privateControlsCleared: true, catalogRefreshed: true, packageInstalled: true });
  } catch (error) { client.markFailed(); await client.capture('private-plugin-failure.png').catch(() => {}); throw error; }
});
