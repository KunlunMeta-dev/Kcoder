import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

// QA: owned profile, explicit public catalog access, select/search/install/remove,
// real ZIP and on-disk receipt; no conversation, plugin hook or model execution.
const requested = process.env.KCODER_E2E_HOSTED_MARKET || 'qoder';
const cases = {
  'trae-research-data-analysis-workspace': { preset: 'trae-cn', label: 'TRAE', plugin: 'research-data-analysis-workspace@trae-remote-official', search: 'research-data-analysis-workspace', icons: true, hosted: true },
  'trae-web-app-development': { preset: 'trae-cn', label: 'TRAE', plugin: 'web-app-development@trae-remote-official', search: 'web-app-development', icons: true, hosted: true },
  'trae-gitee': { preInstallBlocked: true, setupMessage: 'GITEE_ACCESS_TOKEN', preset: 'trae-cn', label: 'TRAE', plugin: 'gitee@trae-remote-official', search: 'gitee', icons: true, hosted: true },
  'trae-qq-mail': { preset: 'trae-cn', label: 'TRAE', plugin: 'qq-mail@trae-remote-official', search: 'qq-mail', icons: true, hosted: true },
  'trae-cn': { preset: 'trae-cn', label: 'TRAE', plugin: 'teaching-management-assistant@trae-remote-official', search: '教学管理助理', icons: true, hosted: true },
  'qoder-product-management': { preset: 'qoder', label: 'Qoder', plugin: 'product-management@qoder', search: 'product-management', icons: true, hosted: true },
  'qoder-architecture-visualization': { preset: 'qoder', label: 'Qoder', plugin: 'architecture-visualization@qoder', search: 'architecture-visualization', icons: true, hosted: true },
  'qoder-design-review': { preset: 'qoder', label: 'Qoder', plugin: 'design-review@qoder', search: 'design-review', icons: true, hosted: true },
  'qoder-context7': { preset: 'qoder', label: 'Qoder', plugin: 'context7@qoder', search: 'context7', icons: true, hosted: true },
  qoder: { preset: 'qoder', label: 'Qoder', plugin: 'superpowers@qoder', search: 'superpowers', icons: true, hosted: true },
  'workbuddy-agent': { preset: 'workbuddy', label: 'WorkBuddy', plugin: 'agent-sdk-dev@workbuddy', search: 'agent-sdk-dev', icons: false, hosted: false },
  workbuddy: { preset: 'workbuddy', label: 'WorkBuddy', plugin: 'find-skills@workbuddy', search: 'find-skills', icons: false, hosted: false },
  'workbuddy-teams': { preset: 'workbuddy-teams', label: 'WorkBuddy', plugin: 'internal-comms@workbuddy-teams', search: 'internal-comms', icons: false, hosted: false },
};
const marketplace = cases[requested];
if (!marketplace) throw new Error('Unsupported hosted market test case');
await assertRendererBuildFresh();
if (process.env.KCODER_E2E_PUBLIC_MARKETPLACE !== '1') throw new Error('KCODER_E2E_PUBLIC_MARKETPLACE=1 is required');
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('KCODER_E2E_TAURI_BIN is required');
await runE2E(import.meta.url, {
  testId: 'tauri-hosted-marketplace', tier: 'manual-live',
  modelPolicy: 'real public hosted catalog/package, isolated native UI, no model calls or plugin execution',
}, async context => {
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  if (process.env.KCODER_E2E_PLUGIN_PROXY) {
    const settings = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    settings.plugins ??= {}; settings.plugins.installation ??= {};
    settings.plugins.installation.proxy_url = process.env.KCODER_E2E_PLUGIN_PROXY;
    await writeFile(client.settingsPath, JSON.stringify(settings));
  }
  const selector = id => `[data-testid="${id}"]`;
  const click = id => client.command('click', { selector: selector(id) });
  const receipt = async () => {
    try { return JSON.parse(await readFile(resolve(dirname(client.settingsPath), 'plugin_store/state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { installed: {} }; throw error; }
  };
  try {
    await client.command('navigate', { value: '/plugins' });
    await client.command('waitFor', { selector: `${selector('plugins-marketplace-selector')}:not(:disabled)`, timeoutMs: 15000 });
    await waitFor(async () => (await client.command('getText', { selector: selector('plugins-install-target') })).includes('/workspaces/tauri-verification'), 15000, 'target bootstrap');
    await client.command('waitFor', { selector: `${selector('plugins-marketplace-selector')}:not(:disabled)`, timeoutMs: 15000 });
    assert.ok((await client.command('getText', { selector: selector('plugins-marketplace-selector') })).includes(marketplace.label));
    await client.command('press', { selector: selector('plugins-marketplace-selector'), key: 'ArrowDown' });
    await client.command('waitFor', { selector: `[role="option"][data-value="preset:${marketplace.preset}"]` });
    await client.command('click', { selector: `[role="option"][data-value="preset:${marketplace.preset}"]` });
    await client.command('fill', { selector: selector('plugins-search-input'), value: marketplace.search });
    await client.command('waitFor', { selector: selector(`plugin-marketplace-install-${marketplace.plugin}`), timeoutMs: 60000 });
    if (marketplace.icons) await client.command('waitFor', { selector: `${selector(`plugin-marketplace-row-${marketplace.plugin}`)} img:is([src^="data:image/"], [src^="https://p11-market.byteimg.com/"])`, timeoutMs: 15000 });
    if (marketplace.preInstallBlocked) {
      await client.command('waitFor', { selector: `${selector(`plugin-marketplace-install-${marketplace.plugin}`)}:not(:disabled)`, text: '让 KCoder 帮我安装' });
      await client.command('waitFor', { selector: selector(`plugin-unavailable-reason-${marketplace.plugin}`), text: '缺少访问凭据' });
      await click(`plugin-marketplace-row-${marketplace.plugin}`);
      await client.command('waitFor', { selector: selector('plugin-compatibility-warning'), text: marketplace.setupMessage });
      assert.ok(!(await receipt()).installed?.[marketplace.plugin], 'blocked plugin was never installed');
      await client.capture('plugin-credentials-before-install.png');
      await click(`plugin-detail-toggle-${marketplace.plugin}`);
      await client.command('waitFor', { selector: selector('chat-message-input'), text: 'GITEE_ACCESS_TOKEN' });
      const prompt = await client.command('getText', { selector: selector('chat-message-input') });
      assert.ok(prompt.includes(marketplace.plugin));
      assert.ok(prompt.includes('trae-remote-official'));
      assert.ok(prompt.includes('0f8003a1-ebe2-40d9-a618-2bcbe5414db2'));
      assert.ok(!(await receipt()).installed?.[marketplace.plugin], 'assistance does not bypass credential policy');
      await client.capture('plugin-installation-conversation.png');
      await context.writeArtifactJson('hosted-results.json', { market: marketplace.preset, credentialsRequired: true, reasonVisible: true, conversationContext: true, noInstallation: true, realTauri: true });
      return;
    }
    await click(`plugin-marketplace-install-${marketplace.plugin}`);
    await waitFor(async () => (await receipt()).installed?.[marketplace.plugin], 60000, 'verified package installed');
    await client.command('waitFor', { selector: selector(`plugins-installed-strip-item-${marketplace.plugin}`), timeoutMs: 15000 });
    if (marketplace.icons) await client.command('waitFor', { selector: `${selector(`plugins-installed-strip-item-${marketplace.plugin}`)} img`, timeoutMs: 15000 });
    const record = (await receipt()).installed[marketplace.plugin];
    assert.equal(record.source.type, marketplace.hosted ? 'hosted' : 'marketplace');
    if (marketplace.hosted) assert.match(record.source.sha256, /^[0-9a-f]{64}$/);
    await client.capture(`${marketplace.preset}-installed.png`);
    if (marketplace.setupMessage) {
      await click(`plugins-installed-strip-item-${marketplace.plugin}`);
      await client.command('waitFor', {selector: selector('plugin-compatibility-warning'), text: marketplace.setupMessage});
      await client.capture('plugin-setup-requirement.png');
      await click('plugin-detail-back-button');
    }

    await click(`plugin-marketplace-actions-${marketplace.plugin}`);
    await click(`plugin-marketplace-uninstall-${marketplace.plugin}`);
    await waitFor(async () => !(await receipt()).installed?.[marketplace.plugin], 15000, 'package uninstalled');
    await context.writeArtifactJson('hosted-results.json', { market: marketplace.preset, catalogSelected: true, search: true, originalIcons: marketplace.icons, installed: true, publisherSha256Verified: marketplace.hosted, uninstalled: true, realTauri: true });
  } catch (error) {
    client.markFailed(); await client.capture('failure.png').catch(() => {}); throw error;
  }
});
