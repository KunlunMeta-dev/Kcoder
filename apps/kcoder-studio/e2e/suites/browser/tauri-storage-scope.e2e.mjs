import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit Tauri binary required');
await runE2E(import.meta.url, { testId: 'native-storage-scope-and-clean-confirmation', tier: 'manual-live', modelPolicy: 'model-independent real native report, target selector, confirmation and owned file cleanup' }, async context => {
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN, kcoderBin: resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist') });
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    const logs = resolve(dirname(client.settingsPath), 'logs/llm-request');
    await mkdir(logs, { recursive: true });
    await writeFile(resolve(logs, 'owned.json'), 'owned storage fixture');
    await cmd('waitFor', 'desktop-sidebar');
    await client.command('navigate', { value: '/settings/storage' });
    await cmd('waitFor', 'storage-scan-target');
    assert.match(await cmd('getText', 'storage-scan-completeness'), /扫描已完成/);
    assert.match(await cmd('getText', 'storage-scan-time'), /扫描时间/);
    assert.equal(await cmd('getValue', 'storage-target'), 'local');
    assert.ok((await cmd('getText', 'storage-total')).includes(dirname(client.settingsPath)));
    await cmd('click', 'storage-clean-debug-logs');
    await cmd('waitFor', 'storage-clean-dialog');
    await cmd('click', 'storage-clean-dialog-close');
    assert.equal(await readFile(resolve(logs, 'owned.json'), 'utf8'), 'owned storage fixture');
    await cmd('click', 'storage-clean-debug-logs');
    await cmd('waitFor', 'storage-clean-dialog-confirm'); await cmd('click', 'storage-clean-dialog-confirm');
    await waitFor(async () => !(await stat(resolve(logs, 'owned.json')).then(() => true, () => false)), 10000, 'native confirmed cleanup');
    await cmd('waitFor', 'storage-refresh', { enabled: true });
    await cmd('scrollIntoView', 'storage-target');
    await client.capture('native-storage-target.png');
    await client.command('navigate', { value: '/settings/appearance' });
    await cmd('waitFor', 'appearance-mode-dark'); await cmd('click', 'appearance-mode-dark');
    await client.command('navigate', { value: '/settings' });
    await cmd('waitFor', 'general-language-en-button'); await cmd('click', 'general-language-en-button');
    await client.command('navigate', { value: '/settings/storage' });
    await cmd('waitFor', 'storage-scan-completeness', { text: 'Completed scan' });
    const visible = await cmd('getText', 'storage-settings-page');
    assert.doesNotMatch(visible, /[\u3400-\u9fff]/);
    assert.match(await cmd('getText', 'storage-scan-target'), /This computer/);
    await client.capture('native-storage-en-dark.png');
    return { targetVisible: true, cancelPreservesFiles: true, confirmCleansOwnedFiles: true };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
