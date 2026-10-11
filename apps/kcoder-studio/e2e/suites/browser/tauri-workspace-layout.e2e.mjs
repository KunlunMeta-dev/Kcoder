import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startWikiModelFixture } from '../../harness/wiki-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

// QA: own real native Studio, Gateway and app-server. Hold a loopback Provider
// response solely to inspect layout and pause a real job, never assess model quality.
// Check collapsed details, source close, independent modes, basic/advanced model
// forms, light/dark and narrow layout. RunContext cleans every process and profile.
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'native-workspace-progressive-details-layout', tier: 'full-integration', modelPolicy: 'model-independent native layout and actual Wiki job control', retainSuccessLogs: true }, async context => {
  let held = true;
  const release = () => { held = false; };
  const model = await startWikiModelFixture(context, { responseReady: () => !held });
  context.addCleanup('release held layout response', release);
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN || resolve(appRoot, 'renderer/src-tauri/target/debug/app'), kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist') });
  const command = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    const initial = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    await writeFile(client.settingsPath, JSON.stringify({ ...initial, active_provider: 'layout', providers: { layout: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'layout-model', context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192, no_proxy: true } } }));
    await command('waitFor', 'knowledge-button'); await command('click', 'knowledge-button');
    await command('waitFor', 'knowledge-enable', { enabled: true }); await command('click', 'knowledge-enable');
    await command('waitFor', 'knowledge-create', { enabled: true }); await command('click', 'knowledge-create');
    await command('fill', 'wiki-create-input', { value: '研究与笔记' }); await command('click', 'wiki-create-confirm');
    await command('waitFor', 'knowledge-library-picker', { text: '研究与笔记' });
    await command('waitFor', 'wiki-file-import', { enabled: true });
    await command('fill', 'wiki-import-files', { value: JSON.stringify([{ name: '协议说明.md', text: '# 协议说明\n\n产品支持协议 A。' }]) });
    await command('waitFor', 'wiki-job-status', { text: '分析原文', timeoutMs: 20000 });
    await command('waitFor', 'wiki-job-details', { timeoutMs: 20000 });
    assert.equal(Number(await command('getElementCount', 'wiki-job-details-dialog')), 0);
    assert.equal(Number(await client.command('getElementCount', { selector: '[data-testid="knowledge-workspace"] details[open]' })), 0, 'upload details and limits start collapsed');
    await client.capture('wiki-compact-progress.png');
    await command('click', 'wiki-job-details'); await command('waitFor', 'wiki-job-details-dialog', { visible: true });
    await client.capture('wiki-task-details.png'); await command('click', 'wiki-job-details-dialog-close');
    await command('waitFor', 'wiki-job-control', { enabled: true }); await command('click', 'wiki-job-control');
    await command('waitFor', 'wiki-job-status', { text: '已暂停', timeoutMs: 15000 });
    await command('click', 'knowledge-tab-sources');
    await client.command('waitFor', { selector: '[data-testid^="wiki-source-row-"]', text: '协议说明.md' });
    await client.command('click', { selector: '[data-testid^="wiki-source-row-"]' });
    await command('waitFor', 'wiki-original-reader', { visible: true }); await command('click', 'wiki-original-reader-close');
    await waitFor(async () => Number(await command('getElementCount', 'wiki-original-reader')) === 0, 5000, 'source closes without resetting job');
    await client.command('navigate', { value: '/settings/personal/models' });
    await command('waitFor', 'provider-edit-layout::layout-model'); await command('click', 'provider-edit-layout::layout-model');
    await command('waitFor', 'provider-form', { visible: true });
    assert.equal(Number(await client.command('getElementCount', { selector: '[data-testid="provider-advanced-settings"][open]' })), 0);
    assert.equal(await command('getValue', 'provider-model'), 'layout-model');
    await client.capture('model-basic-settings.png');
    await client.command('click', { selector: '[data-testid="provider-advanced-settings"] > summary' });
    await command('scrollIntoView', 'provider-maxOutputTokens');
    await command('waitFor', 'provider-maxOutputTokens', { visible: true });
    await client.command('navigate', { value: '/settings/appearance' });
    await command('waitFor', 'appearance-mode-dark'); await command('click', 'appearance-mode-dark');
    await client.command('navigate', { value: '/knowledge' });
    await command('waitFor', 'knowledge-workspace', { visible: true }); await client.capture('wiki-dark.png');
    await client.command('resizeWindow', { value: '440x800' });
    await command('waitFor', 'knowledge-workspace', { visible: true });
    await waitFor(async () => { const [bounds] = JSON.parse(await command('getElementMetrics', 'knowledge-workspace')); return bounds.width >= 380; }, 5000, 'narrow Wiki receives the available width after sidebar collapse');
    await client.capture('wiki-narrow.png');
    await context.writeArtifactJson('workspace-layout-summary.json', { native: true, pausedJob: true, sourceClosed: true, detailsCollapsed: true, modelBasicAndAdvanced: true, darkAndNarrow: true });
    return { native: true, detailsCollapsed: true, originalClosed: true, pausedJob: true, modelAdvancedAccessible: true };
  } catch (error) { client.markFailed(); await client.capture('workspace-layout-failure.png').catch(() => {}); throw error; }
  finally { release(); await client.stop(); }
});
