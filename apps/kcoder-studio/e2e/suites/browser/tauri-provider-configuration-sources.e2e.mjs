import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('UNMET_PREREQUISITE: explicit Tauri binary required');
await runE2E(import.meta.url, {
  testId: 'tauri-provider-configuration-file-sources', tier: 'manual-live',
  modelPolicy: 'model-independent real native UI, file-layer provenance and HTTP parameters',
}, async context => {
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist') });
  const command = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await command('waitFor', 'desktop-sidebar', { visible: true });
    await writeFile(client.settingsPath, JSON.stringify({ active_provider: 'fixture', providers: { fixture: {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'source-model', no_proxy: true, context_window_tokens: 128000,
      max_output_tokens: 1024, output_headroom_tokens: 1024, extra_body: { temperature: 0.2 },
    } } }), { mode: 0o600 });
    const project = join(client.runRoot, 'state/workspaces/tauri-verification/.kcoder');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'settings.json'), JSON.stringify({ provider_extra_body: { temperature: 0.9 } }));
    await client.command('navigate', { value: '/settings/personal/models' });
    await command('waitFor', 'provider-edit-fixture::source-model');
    await command('click', 'provider-edit-fixture::source-model');
    await command('waitFor', 'config-templates-import-button', { text: '选择文件' });
    await command('waitFor', 'provider-file-sources', { text: '项目配置' });
    await command('fill', 'provider-extra-body', { value: '{"temperature":0.7}' });
    await command('click', 'provider-save');
    await waitFor(async () => (await client.command('getText', { selector: '[role="status"]' })).includes('部分字段仍由更高优先级配置覆盖'), 30000, 'native override save');
    await command('waitFor', 'provider-save', { enabled: true });
    await command('scrollIntoView', 'provider-file-sources');
    await client.capture('native-file-sources.png');
    await client.command('navigate', { value: '/settings/appearance' });
    await command('waitFor', 'appearance-mode-dark');
    await command('click', 'appearance-mode-dark');
    await client.command('navigate', { value: '/settings' });
    await command('waitFor', 'general-language-en-button');
    await command('click', 'general-language-en-button');
    await client.command('navigate', { value: '/settings/personal/models' });
    await command('waitFor', 'provider-edit-fixture::source-model');
    await command('click', 'provider-edit-fixture::source-model');
    await command('waitFor', 'provider-file-sources', { text: 'Project settings' });
    await command('waitFor', 'config-templates-import-button', { text: 'Choose file' });
    const englishSources = await command('getText', 'provider-file-sources');
    assert.doesNotMatch(englishSources, /[\u3400-\u9fff]/);
    await command('scrollIntoView', 'provider-file-sources');
    await client.capture('native-file-sources-dark-en.png');

    const saved = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    assert.equal(saved.providers.fixture.models['source-model'].extra_body.temperature, 0.7);
    await client.command('navigate', { value: '/' });
    await command('waitFor', 'project-new-conversation-button');
    await command('click', 'project-new-conversation-button');
    await command('waitFor', 'chat-message-input', { visible: true });
    await command('fill', 'chat-message-input', { value: 'NATIVE_SOURCE_REQUEST' });
    await command('waitFor', 'send-message-button', { enabled: true });
    await command('click', 'send-message-button');
    await command('waitFor', 'message-assistant', { timeoutMs: 30000 });
    const request = await waitFor(() => model.requests.find(body => JSON.stringify(body.messages).includes('NATIVE_SOURCE_REQUEST')), 30000, 'native actual request');
    assert.equal(request.temperature, 0.9);
    return { native: true, sourceVisible: true, darkEnglishVerified: true, savedUserTemperature: 0.7, actualTemperature: 0.9 };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
