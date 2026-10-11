import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('UNMET_PREREQUISITE: explicit Tauri binary required');
const templatesOnly = process.env.KCODER_E2E_CONFIG_TEMPLATES_ONLY === '1';
await runE2E(import.meta.url, {
  testId: templatesOnly ? 'tauri-settings-template-controls-and-recovery' : 'tauri-provider-configuration-file-sources', tier: 'manual-live',
  modelPolicy: 'model-independent real native UI, file-layer provenance and HTTP parameters',
  retainSuccessEvidence: templatesOnly, evidenceReason: templatesOnly ? 'Compact template list and native narrow/dark editor need visual evidence' : undefined,
}, async context => {
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist') });
  const command = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    await command('waitFor', 'desktop-sidebar', { visible: true });
    await writeFile(client.settingsPath, JSON.stringify({ active_provider: 'fixture', providers: { fixture: {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'source-model', no_proxy: true, context_window_tokens: 128000,
      max_output_tokens: 1024, output_headroom_tokens: 1024, extra_body: { temperature: 0.2 },
    } } }), { mode: 0o600 });
    if (templatesOnly) {
      const result = await verifyTemplates(client, command);
      assert.equal(model.requests.length, 0);
      return { ...result, modelRequests: 0 };
    }
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

async function verifyTemplates(client, command) {
  await client.command('navigate', { value: '/settings/personal/models' });
  await command('waitFor', 'provider-configuration-details');
  await client.command('click', { selector: '[data-testid="provider-configuration-details"] > summary' });
  await command('waitFor', 'config-templates-new', { enabled: true });
  await command('click', 'config-templates-new');
  await command('fill', 'config-templates-name', { value: 'Owned reusable settings' });
  await command('fill', 'config-templates-description', { value: 'A concise template for repeated work.' });
  await command('fill', 'config-templates-content', { value: '{' });
  await command('click', 'config-templates-save');
  await command('waitFor', 'config-templates-error', { visible: true });
  assert.equal(await command('getValue', 'config-templates-name'), 'Owned reusable settings');
  await command('fill', 'config-templates-content', { value: '{"permission_mode":"yolo"}' });
  await command('click', 'config-templates-save');
  const row = await waitFor(async () => {
    const count = await client.command('getElementCount', { selector: '[data-testid^="config-template-edit-"]' });
    return Number(count) === 1 ? client.command('getAttribute', { selector: '[data-testid^="config-template-edit-"]', value: 'data-testid' }) : null;
  }, 10000, 'native persisted template row');
  const id = row.slice('config-template-edit-'.length);
  const actions = `config-template-actions-${id}`;
  await command('click', actions);
  await command('click', `config-template-default-action-${id}`);
  await command('waitFor', 'config-templates-default', { text: 'Owned reusable settings' });
  await command('click', `config-template-edit-${id}`);
  await command('waitFor', 'config-templates-name');
  assert.equal(await command('getValue', 'config-templates-content'), '{"permission_mode":"yolo"}');
  await command('fill', 'config-templates-description', { value: 'Updated template description.' });
  await command('click', 'config-templates-save');
  await command('waitFor', `config-template-${id}`, { text: 'Updated template description.' });
  await command('click', actions);
  await command('click', `config-template-delete-${id}`);
  await command('waitFor', 'config-template-delete-dialog', { text: 'Owned reusable settings' });
  await command('press', 'config-template-delete-dialog', { key: 'Escape' });
  await client.command('waitFor', { selector: `[data-testid="${actions}"]:focus` });
  await command('waitFor', `config-template-${id}`);
  await command('scrollIntoView', 'config-templates-section');
  await client.capture('native-templates-light.png');
  await client.command('navigate', { value: '/settings/appearance' });
  await command('click', 'appearance-mode-dark');
  await client.command('navigate', { value: '/settings' });
  await command('click', 'general-language-en-button');
  await client.command('navigate', { value: '/settings/personal/models' });
  await command('waitFor', 'provider-configuration-details');
  await client.command('click', { selector: '[data-testid="provider-configuration-details"] > summary' });
  await command('waitFor', `config-template-${id}`, { text: 'Updated template description.' });
  await command('waitFor', 'config-templates-default', { text: 'Owned reusable settings' });
  await client.command('resizeWindow', { value: '400x600' });
  await command('click', actions);
  await command('waitFor', `${actions}-menu`, { visible: true });
  await client.capture('native-templates-menu-dark-narrow.png');
  await command('click', `config-template-clear-${id}`);
  await command('waitFor', 'config-templates-section', { text: 'No default template' });
  await command('click', `config-template-edit-${id}`);
  await command('waitFor', 'config-templates-editor', { visible: true });
  await command('scrollIntoView', 'config-templates-save');
  await client.capture('native-template-editor-dark-narrow.png');
  await command('click', 'config-templates-cancel');
  await command('click', actions);
  await command('click', `config-template-delete-${id}`);
  await command('click', 'config-template-delete-dialog-confirm');
  await command('waitFor', 'config-templates-empty', { text: 'No templates yet' });
  await client.command('navigate', { value: '/settings' });
  await client.command('navigate', { value: '/settings/personal/models' });
  await command('waitFor', 'config-templates-empty');
  await client.command('resizeWindow', { value: '1280x720' });
  await client.command('navigate', { value: '/settings/appearance' });
  await command('click', 'appearance-mode-light');
  return { savedAndEdited: true, invalidContentRecovery: true, defaultSetAndCleared: true, cancelledDeletePreserved: true, confirmedDeletePersisted: true, narrowDarkEnglish: true };
}
