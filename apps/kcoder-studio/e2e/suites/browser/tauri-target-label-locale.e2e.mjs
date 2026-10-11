import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit Tauri binary required');
await runE2E(import.meta.url, { testId: 'native-default-target-localization', tier: 'manual-live', modelPolicy: 'model-independent actual native settings, language and theme changes' }, async context => {
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const client = await startOwnedAiVerify(context, { tauriBin: process.env.KCODER_E2E_TAURI_BIN, kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), rendererRoot: resolve(appRoot, 'renderer/dist') });
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  const checkBuiltinSlashLocale = async language => {
    await client.command('navigate', { value: '/' });
    await cmd('waitFor', 'chat-message-input');
    await cmd('fill', 'chat-message-input', { value: '/' });
    await cmd('waitFor', 'slash-command-menu');
    const entries = {};
    for (const id of ['plan', 'goal', 'goal-pro', 'orchestrate', 'moa', 'moa-plan', 'compact', 'model']) {
      await cmd('waitFor', `slash-command-option-${id}`);
      const text = await cmd('getText', `slash-command-option-${id}`);
      assert.ok(text.startsWith(`/${id}`), 'command identifiers must stay stable');
      const description = text.slice(id.length + 1).trim();
      assert.ok(description.length > 0);
      if (language === 'zh-CN') assert.match(description, /[\u3400-\u9fff]/);
      else assert.doesNotMatch(description, /[\u3400-\u9fff]/);
      entries[id] = description;
    }
    await client.capture(`native-slash-${language}.png`);
    await cmd('fill', 'chat-message-input', { value: '' });
    return entries;
  };
  try {
    await cmd('waitFor', 'desktop-sidebar');
    await writeFile(client.settingsPath, JSON.stringify({ active_provider: 'fixture', providers: {
      fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
        default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true },
    } }));
    await client.command('navigate', { value: '/settings/personal/models' });
    await cmd('waitFor', 'provider-edit-fixture::fixture'); await cmd('click', 'provider-edit-fixture::fixture'); await cmd('click', 'provider-save');
    await client.command('waitFor', { selector: '[role="status"]', text: '已保存', timeoutMs: 15000 });
    const chineseSlash = await checkBuiltinSlashLocale('zh-CN');
    await client.command('navigate', { value: '/settings/kcoder-servers' });
    await cmd('waitFor', 'runtime-target-row-local', { text: '当前计算机' });
    await client.capture('native-default-target-zh-light.png');
    await client.command('navigate', { value: '/settings/appearance' });
    await cmd('waitFor', 'appearance-mode-dark'); await cmd('click', 'appearance-mode-dark');
    await client.command('navigate', { value: '/settings' });
    await cmd('waitFor', 'general-language-en-button'); await cmd('click', 'general-language-en-button');
    await checkBuiltinSlashLocale('en');
    await client.command('navigate', { value: '/settings/kcoder-servers' });
    await cmd('waitFor', 'runtime-target-row-local', { text: 'This computer' });
    await client.capture('native-default-target-en-dark.png');
    await client.command('navigate', { value: '/settings/personal/models' });
    await cmd('waitFor', 'provider-target');
    const option = await client.command('getText', { selector: '[data-testid="provider-target"] option[value="local"]' });
    assert.equal(option.trim(), 'This computer');
    await client.command('navigate', { value: '/' });
    await client.command('waitFor', { selector: '[data-testid^="project-title-"]', text: 'This computer' });
    await client.command('navigate', { value: '/settings/hooks' });
    await cmd('waitFor', 'hooks-json');
    assert.ok((await cmd('getText', 'hooks-settings-page')).includes('user-level Hooks'));
    assert.doesNotMatch(await cmd('getText', 'hooks-settings-page'), /[\u3400-\u9fff]/);
    await client.command('navigate', { value: '/settings/personal/quick-phrases' });
    await cmd('waitFor', 'quick-phrases-settings-page', { text: 'Summarize progress' });
    assert.doesNotMatch(await cmd('getText', 'quick-phrases-settings-page'), /[\u3400-\u9fff]/);
    await cmd('click', 'quick-phrase-edit-default-summary-progress');
    await cmd('waitFor', 'quick-phrase-title-input');
    await cmd('waitFor', 'quick-phrase-cancel-button', { text: 'Cancel' });
    await cmd('waitFor', 'quick-phrase-save-button', { text: 'Save' });
    assert.equal(await cmd('getValue', 'quick-phrase-title-input'), 'Summarize progress');
    await cmd('fill', 'quick-phrase-title-input', { value: 'Native resize draft' });
    await client.command('resizeWindow', { value: '400x300' });
    await cmd('waitFor', 'settings-compact-navigation');
    assert.equal(await cmd('getValue', 'quick-phrase-title-input'), 'Native resize draft');
    await cmd('scrollIntoView', 'quick-phrase-save-button');
    await client.capture('native-narrow-editor-draft.png');
    await client.command('resizeWindow', { value: '1280x720' });
    assert.equal(await cmd('getValue', 'quick-phrase-title-input'), 'Native resize draft');
    await client.capture('native-quick-phrase-en-dark.png');
    await cmd('press', 'quick-phrase-title-input', { key: 'Shift+Tab' });
    await client.command('waitFor', { selector: '[data-testid="quick-phrase-save-button"]:focus' });
    await cmd('press', 'quick-phrase-save-button', { key: 'Tab' });
    await client.command('waitFor', { selector: '[data-testid="quick-phrase-title-input"]:focus' });
    await cmd('press', 'quick-phrase-title-input', { key: 'Escape' });
    await client.command('waitFor', { selector: '[data-testid="quick-phrase-edit-default-summary-progress"]:focus' });
    await cmd('click', 'quick-phrase-actions-default-summary-progress');
    await cmd('waitFor', 'quick-phrase-delete-default-summary-progress');
    await cmd('click', 'quick-phrase-delete-default-summary-progress');
    await cmd('waitFor', 'quick-phrase-delete-dialog');
    await cmd('click', 'quick-phrase-delete-dialog-close');
    await cmd('waitFor', 'quick-phrase-edit-default-summary-progress');
    await client.command('navigate', { value: '/settings' });
    await cmd('waitFor', 'general-language-zh-CN-button'); await cmd('click', 'general-language-zh-CN-button');
    assert.deepEqual(await checkBuiltinSlashLocale('zh-CN'), chineseSlash);
    assert.equal(model.requests.length, 0, 'menu verification must not execute a model turn');
    return { builtInLocalized: true, liveLanguageChange: true, modelSelectorLocalized: true, builtinSlashCommandsLocalized: true, commandIdentifiersPreserved: true, chineseRestored: true };
  } catch (error) { client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error; }
  finally { await client.stop(); }
});
