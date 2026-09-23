import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { pluginCancellationFixture } from '../../harness/plugin-cancellation-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit Tauri binary required');
await runE2E(import.meta.url, { testId: 'native-studio-plugin-install-cancellation', tier: 'manual-live', modelPolicy: 'model-independent real native Studio and npm download cancellation/retry' }, async context => {
  const fixture = await pluginCancellationFixture(context);
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN, kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist') });
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await cmd('waitFor', 'plugins-button'); await cmd('click', 'plugins-button');
    await cmd('waitFor', 'plugins-install-target', { text: '/workspaces/tauri-verification' });
    await cmd('waitFor', 'plugins-marketplace-selector');
    await cmd('waitFor', 'plugins-add-marketplace-button'); await cmd('click', 'plugins-add-marketplace-button');
    await cmd('waitFor', 'plugins-add-custom-marketplace-button'); await cmd('click', 'plugins-add-custom-marketplace-button');
    await cmd('waitFor', 'plugins-marketplace-path-input'); await cmd('fill', 'plugins-marketplace-path-input', { value: fixture.source });
    await cmd('click', 'plugins-marketplace-trust-directory'); await cmd('click', 'plugins-marketplace-save-button');
    const install = `plugin-marketplace-install-${fixture.id}`;
    await cmd('waitFor', install, { timeoutMs: 30000 }); await cmd('click', install);
    await waitFor(() => fixture.requests > 0, 15000, 'native npm download');
    await cmd('waitFor', install, { text: '取消安装' }); await cmd('click', install);
    await waitFor(async () => (await client.command('getText')).includes('操作已取消'), 15000, 'native cancellation');
    await client.capture('native-install-cancelled.png');
    fixture.unblock(); await cmd('waitFor', install, { enabled: true }); await cmd('click', install);
    await cmd('waitFor', install, { text: '在对话中试用', timeoutMs: 30000 });
    assert.ok(fixture.requests > 1);
    return { native: true, cancellationVisible: true, retryInstalled: true };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
