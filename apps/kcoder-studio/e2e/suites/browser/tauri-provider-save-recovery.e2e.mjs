import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('UNMET_PREREQUISITE: explicit Tauri binary required');
await runE2E(import.meta.url, {
  testId: 'tauri-provider-save-recovery', tier: 'manual-live',
  modelPolicy: 'model-independent native save transport loss; real Gateway/CLI and loopback HTTP',
}, async context => {
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'), dropSaveReply: true,
  });
  const command = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await command('waitFor', 'desktop-sidebar', { visible: true });
    await client.command('navigate', { value: '/settings/personal/models' });
    await command('waitFor', 'provider-save', { enabled: true });
    await command('waitFor', 'provider-identity', { text: '共享运行账号' });
    await command('fill', 'provider-template', { value: 'local-openai' });
    await command('fill', 'provider-endpoint', { value: model.baseUrl });
    await command('fill', 'provider-model', { value: 'native-recovery' });
    await command('click', 'provider-save');
    await command('waitFor', 'provider-save-recovery', { text: '尚不能确认', timeoutMs: 30000 });
    assert.equal(await command('getValue', 'provider-model'), 'native-recovery');
    assert.equal(Number(await client.command('getElementCount', { selector: '[data-testid="provider-save"]:disabled' })), 1);
    const saved = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    assert.ok(saved.providers['local-openai']);
    await command('click', 'provider-refresh');
    await command('waitFor', 'provider-save-recovery', { text: '已读取', timeoutMs: 30000 });
    assert.equal(Number(await client.command('getElementCount', { selector: '[data-testid="provider-save"]:disabled' })), 1);
    await command('click', 'provider-edit-local-openai::native-recovery');
    await command('waitFor', 'provider-save', { enabled: true });
    await command('click', 'provider-save');
    await waitFor(async () => (await client.command('getText', { selector: '[role="status"]' })).includes('下一轮'), 30000, 'native reviewed save');
    assert.equal(model.requests.length, 2);
    await client.capture('native-save-recovered.png');
    assert.deepEqual(JSON.parse(await readFile(resolve(client.runRoot, 'artifacts/save-reply-fault.json'), 'utf8')),
      { committedReplyDropped: true });
    await client.stop();
    return { native: true, committedReplyDropped: true, readAndReviewRecovered: true, requests: model.requests.length };
  } catch (error) {
    client.markFailed();
    await client.capture('failure.png').catch(() => {});
    throw error;
  } finally { await client.stop(); }
});
