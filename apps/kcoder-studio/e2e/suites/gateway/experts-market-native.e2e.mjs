import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startNativeCodeManager } from '../../harness/native-code-service.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { login } from '../../harness/http.mjs';
import { openRpc, closeRpcAndWait, gatewayRpcUrl } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { runE2E, requireExecutable } from '../../harness/run-context.mjs';

process.umask(0o077);
async function selectExpertTab(page, name) {
  const tab = page.getByRole('tab', { name });
  const box = await tab.boundingBox(), wrap = await page.locator('.octop-tabs-nav-wrap').boundingBox();
  if (box && wrap && box.x >= wrap.x && box.x + box.width <= wrap.x + wrap.width) {
    await tab.click();
  } else {
    await page.getByRole('button', { name: 'ellipsis', exact: true }).hover();
    await page.getByRole('option', { name }).click();
  }
}
await runE2E(import.meta.url, { testId: 'experts-real-skillhub-native-storage-browser', tier: 'manual-live',
  modelPolicy: 'Explicit live SkillHub downloads, real isolated Native store and optional actual browser. No expert execution, no model requests, no native desktop claim.' }, async context => {
  assert.equal(process.env.KCODER_E2E_LIVE_EXPERT_MARKET, '1', 'Explicit live public marketplace consent required');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fresh normal Native CLI');
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'), process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'expert-storage' });
  const profile = context.pathInState('profile');
  const settingsFile = await context.writeStateJson('profile/settings.json', {
    active_provider: 'NoModel', tools: { profile: 'none' }, model: 'unused', credential_store: 'file',
    memory: { observer_mode: 'disabled', structured_enabled: false }, session_memory: { enabled: false },
    integrations: { office: { enabled: true }, connectivity: { enabled: true }, services: { enabled: true } }, providers: { NoModel: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: 'http://127.0.0.1:1/v1', default_model: 'unused', discover_models: false, context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024 } }
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned expert acceptance', transport: 'local', command: binary, workspace, settingsFile }]);
  if (process.env.KCODER_E2E_EXPERT_UI_FEISHU === '1' || process.env.KCODER_E2E_EXPERT_SKILLS === '1') {
    if (process.env.KCODER_E2E_EXPERT_UI_FEISHU === '1') assert.equal(process.env.KCODER_E2E_LIVE_FEISHU, '1', 'Explicit official Feishu network gate required');
    assert.ok(process.getuid() > 0, 'Owned Core runs under the current nonprivileged UID');
    await startNativeCodeManager(context, { binary, profile, workspace, uid: process.getuid(), gid: process.getgid(),
      imageSha256: process.env.KCODER_E2E_KCODER_BIN_SHA256, activeManagers: new Set(),
      env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: profile }) }, 'owned-expert-channel-core');
  }
  const gateway = await startGateway(context, { auth: true, workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: profile } });
  const settingsUrl = (id, tab = 'skills') => `${gateway.baseUrl}/personalization/${tab}?${new URLSearchParams({ deviceId: 'local', workspacePath: workspace, expertId: id })}`;
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const connect = async () => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', 'cookie-auth'), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup('close owned expert reader', () => closeRpcAndWait(rpc));
    await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'expert-acceptance', version: '1' }, capabilities: { experimental: { integrationScopeV1: true, officeWorkspaceV1: true } } });
    const scope = await rpc.request('integrations/scope/read');
    let sequence = 0;
    return { rpc, call: async (method, payload, mutation = {}) => {
      const value = await rpc.request(`integrations/${method}`, { contractVersion: 'parallel-v1', requestId: `expert-${++sequence}`, scope, timeoutMs: 60000, payload, ...mutation }, 65000);
      assert.equal(value.status, 'completed', JSON.stringify(value.error));
      return value.result;
    } };
  };
  const a = await connect();
  const market = await a.call('assistant/market/list', { language: 'en', query: 'tech-test-automation', limit: 10 });
  assert.equal(market.items.length, 1);
  const detail = await a.call('assistant/market/read', { language: 'en', slug: 'tech-test-automation' });
  assert.equal(detail.item.slug, 'tech-test-automation');
  assert.match(detail.content, /Test Automation Workflow/);
  assert.equal((await a.call('assistant/list', { language: 'en', personalOnly: true, limit: 10 })).total, 0);
  const id = 'personal.owned-acceptance';
  const installed = await a.call('assistant/market/install', { id, slug: 'tech-test-automation', language: 'en' }, { operationId: 'owned-install' });
  assert.equal(installed.executionEnabled, false);
  assert.equal(installed.package.skillSlugs.length, 6);
  for (const slug of installed.package.skillSlugs) assert.ok(installed.package.files.some(file => file.path === `skills/${slug}/SKILL.md`), slug);
  const soul = await a.call('assistant/package/read', { id, path: 'SOUL.md' });
  assert.equal(createHash('sha256').update(soul.content).digest('hex'), installed.package.files.find(file => file.path === 'SOUL.md').sha256);
  await closeRpcAndWait(a.rpc);
  const b = await connect();
  assert.deepEqual((await b.call('assistant/package/read', { id })).package, installed.package);
  const definition = { ...installed.draft.definition, title: 'Owned edited expert' };
  const saved = await b.call('assistant/saveDraft', { definition }, { operationId: 'owned-edit', expectedRevision: String(installed.draft.revision) });
  const copiedId = 'personal.owned-copy';
  const copied = await b.call('assistant/saveDraft', { definition: { ...definition, id: copiedId }, copyFrom: { id, revision: String(saved.draft.revision) } }, { operationId: 'owned-copy' });
  assert.deepEqual((await b.call('assistant/package/read', { id: copiedId })).package, installed.package);
  const published = await b.call('assistant/saveVersion', { id: copiedId, version: '1.0.0' }, { operationId: 'owned-publish', expectedRevision: String(copied.draft.revision) });
  assert.ok(published);
  await b.call('assistant/deleteDraft', { id }, { operationId: 'owned-delete', expectedRevision: String(saved.draft.revision) });
  const list = await b.call('assistant/list', { language: 'en', personalOnly: true, limit: 10 });
  assert.equal(list.items.some(item => item.definition.id === id), false);
  assert.equal(list.items.some(item => item.definition.id === copiedId), true);
  const builtin = await b.call('assistant/read', { id: 'builtin.octop.office-automation', language: 'zh-CN' });
  assert.deepEqual(builtin.definition.allowedTools, []);
  const builtinId = 'personal.owned-builtin';
  const builtinCopy = await b.call('assistant/saveDraft', { definition: { ...builtin.definition, id: builtinId }, copyFrom: { id: builtin.definition.id, revision: builtin.version } }, { operationId: 'owned-copy-octop-builtin' });
  const builtinPackage = (await b.call('assistant/package/read', { id: builtinId })).package;
  assert.equal(builtinPackage.source, 'octop-builtin');
  assert.equal(builtinPackage.files.length, 190);
  const license = await b.call('assistant/package/read', { id: builtinId, path: 'skills/docx/LICENSE.txt' });
  assert.equal(createHash('sha256').update(license.content).digest('hex'), builtinPackage.files.find(file => file.path === 'skills/docx/LICENSE.txt').sha256);
  await b.call('assistant/deleteDraft', { id: builtinId }, { operationId: 'owned-delete-builtin-copy', expectedRevision: String(builtinCopy.draft.revision) });
  assert.equal((await b.rpc.request('thread/list', { limit: 10 })).threads.length, 0);
  let skillTargetId;
  if (process.env.KCODER_E2E_EXPERT_SKILLS === '1') {
    skillTargetId = 'personal.owned-skill-target';
    const plain = { ...definition, id: skillTargetId, title: 'Owned skill target', instructions: 'Use reviewed enabled skill instructions.', skills: [] };
    const draft = (await b.call('assistant/saveDraft', { definition: plain }, { operationId: 'owned-skills-create' })).draft;
    const recommendation = await b.call('assistant/skills/catalog', { query: '', ranking: 'recommended', language: 'en', limit: 10 });
    assert.ok(recommendation.items.length > 0);
    const dependency = installed.package.files.filter(file => /^skills\/[^/]+\/SKILL\.md$/.test(file.path)
      && installed.package.skillSlugs.includes(file.path.split('/')[1]) && file.bytes < 16000).sort((a, b) => a.bytes - b.bytes)[0];
    assert.ok(dependency, 'One already verified small dependency is required for the real single-skill download');
    const slug = dependency.path.split('/')[1];
    const search = await b.call('assistant/skills/catalog', { query: slug, ranking: 'recommended', language: 'en', limit: 10 });
    assert.ok(search.items.some(item => item.slug === slug));
    const imported = (await b.call('assistant/skills/install', { id: skillTargetId, slug, language: 'en' }, { operationId: 'owned-single-skill-import', expectedRevision: String(draft.revision) })).draft;
    assert.equal(imported.definition.skills.length, 1);
    assert.equal(imported.definition.skills[0].enabled, false);
    const before = await b.call('assistant/saveVersion', { id: skillTargetId, version: 'disabled' }, { operationId: 'owned-skill-disabled-version', expectedRevision: String(imported.revision) });
    const enabled = (await b.call('assistant/saveDraft', { definition: { ...imported.definition, skills: imported.definition.skills.map(skill => ({ ...skill, enabled: true })) } }, { operationId: 'owned-skill-enable', expectedRevision: String(imported.revision) })).draft;
    await b.call('assistant/saveVersion', { id: skillTargetId, version: 'enabled' }, { operationId: 'owned-skill-enabled-version', expectedRevision: String(enabled.revision) });
    const pinned = await b.call('assistant/read', { id: skillTargetId, version: 'disabled', language: 'en' });
    assert.equal(pinned.saved.definition.skills[0].enabled, false);
    const assets = (await b.call('assistant/package/read', { id: skillTargetId })).package;
    assert.ok(assets.files.some(file => file.path === `source/skills/${slug}.json`));
    assert.equal((await b.call('assistant/read', { id: copiedId, language: 'en' })).draft.definition.skills?.length ?? 0, 0);
    await context.writeArtifactJson('expert-skills-native-proof.json', { liveCatalog: true, liveSearch: true, realSingleSkillDownload: true, slug, sourceFileCount: assets.files.length,
      importedDisabled: true, enabledNativeDraft: true, immutableDisabledVersion: true, otherExpertUnchanged: true, modelCalls: 0 });
  }
  if (process.env.KCODER_E2E_EXPERT_UI === '1') {
    const { startChromium } = await import('../../harness/chromium.mjs');
    const browser = await startChromium(context);
    const page = await browser.newPage({ viewport: { width: 1365, height: 960 } });
    await page.goto(gateway.baseUrl);
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.goto(`${gateway.baseUrl}/experts`);
    await page.getByTestId('expert-workspace').waitFor({ timeout: 30000 });
    await page.getByText('Owned edited expert', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^(编辑|Edit)$/ }).first().click();
    await page.getByRole('button', { name: /^(复制|Duplicate)$/ }).click();
    await page.getByLabel(/^(名称|Name)$/).fill('Owned browser duplicate');
    await page.getByLabel(/^(标题语|Welcome message)$/).fill('Owned saved welcome');
    await page.getByRole('button', { name: /^(保\s*存|Save|创建|Create)$/ }).click();
    await page.getByText(/^(已保存|Saved)$/).last().waitFor();
    await page.getByRole('dialog').getByRole('button', { name: /版本$|Versions$/ }).click();
    await page.getByText(/尚未保存版本|No saved versions/).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: /^(关闭|Close)$/ }).first().click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByText('Owned browser duplicate', { exact: true }).waitFor();
    const browserList = await b.call('assistant/list', { language: 'en', personalOnly: true, limit: 10 });
    const browserCopy = browserList.items.find(item => item.definition.title === 'Owned browser duplicate');
    assert.equal(browserCopy.definition.inputSchema['x-kcoder-expert'].welcome, 'Owned saved welcome');
    assert.deepEqual((await b.call('assistant/package/read', { id: browserCopy.definition.id })).package, installed.package);
    await page.screenshot({ path: context.pathInArtifacts('experts-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('expert-workspace').waitFor({ timeout: 30000 });
    await page.getByText('Owned edited expert', { exact: true }).waitFor();
    await page.screenshot({ path: context.pathInArtifacts('experts-narrow.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await selectExpertTab(page, /^(专家市场|Expert market)$/);
    await page.getByRole('searchbox').fill('tech-test-automation');
    const download = page.getByRole('button', { name: /^(从市场创建|Create from market)$/ });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="expert-workspace"] [class*=expertTemplateCard]').length === 1);
    await download.click({ trial: true });
    await page.screenshot({ path: context.pathInArtifacts('expert-download-narrow.png'), fullPage: true });
    await download.click();
    await page.getByRole('dialog').getByRole('button', { name: /^(保\s*存|Save|创建|Create)$/ }).click();
    await page.getByRole('dialog').getByText(/^(已保存|Saved)$/).waitFor({ timeout: 65000 });
    await page.getByRole('dialog').getByRole('button', { name: /^(关闭|Close)$/ }).first().click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await selectExpertTab(page, /^(我的专家|My experts)$/);
    await page.getByRole('heading', { name: '自动化测试专家', exact: true }).waitFor();
    if (skillTargetId) {
      await page.setViewportSize({ width: 1385, height: 960 });
      await page.goto(settingsUrl(skillTargetId));
      await page.getByTestId('expert-skills-workspace').waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: /^(创建技能|Create Skill)$/ }).first().click();
      await page.getByRole('dialog').getByLabel(/^(技能标识|Skill ID)$/).fill('owned-browser-skill');
      await page.getByRole('dialog').getByLabel(/^(名称|Name)$/).fill('Owned browser skill');
      await page.getByRole('dialog').getByLabel('SKILL.md', { exact: true }).fill('Preserve cited sources. Do not invent data.');
      await page.getByRole('dialog').getByRole('button', { name: /^(保\s*存|Save)$/ }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByText('Owned browser skill', { exact: true }).waitFor();
      await page.reload();
      await page.getByText('Owned browser skill', { exact: true }).waitFor({ timeout: 30000 });
      const observed = await b.call('assistant/read', { id: skillTargetId, language: 'en' });
      assert.equal(observed.draft.definition.skills.find(skill => skill.slug === 'owned-browser-skill').enabled, false);
      await page.getByTestId('personalization-page').screenshot({ path: context.pathInArtifacts('personalization-skills-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.getByTestId('personalization-page').screenshot({ path: context.pathInArtifacts('personalization-skills-narrow.png') });
      await b.call('assistant/saveDraft', { definition: { ...definition, id: 'personal.owned-empty-visual', title: 'Owned empty expert', skills: [] } }, { operationId: 'owned-empty-visual' });
      await page.setViewportSize({ width: 1385, height: 960 });
      await page.goto(settingsUrl('personal.owned-empty-visual'));
      await page.getByTestId('expert-skills-workspace').waitFor({ timeout: 30000 });
      await page.getByText('暂无技能', { exact: true }).waitFor();
      await page.getByTestId('expert-skills-workspace').screenshot({ path: context.pathInArtifacts('personalization-skills-empty.png'), animations: 'disabled' });
      await page.getByTestId('personalization-page').screenshot({ path: context.pathInArtifacts('personalization-skills-page.png'), animations: 'disabled' });
      await page.goto(settingsUrl(copiedId, 'channels'));
      await page.getByTestId('octop-channels-workspace').waitFor({ timeout: 30000 });
      await page.getByText(/共 1 个可用通道|1 supported channel/).waitFor();
      await page.getByTestId('octop-channels-workspace').screenshot({ path: context.pathInArtifacts('personalization-channels.png'), animations: 'disabled' });
      await page.getByTestId('personalization-page').screenshot({ path: context.pathInArtifacts('personalization-channels-page.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await page.goto(settingsUrl(copiedId, 'channels'));
    await page.getByTestId('expert-channel-settings').waitFor();
    await page.getByRole('combobox').first().click();
    await page.getByRole('option',{name:'1.0.0',exact:true}).waitFor({state:'attached'});
    await page.getByRole('combobox').first().press('ArrowDown');
    await page.getByRole('combobox').first().press('Enter');
    await page.locator('.octop-select-selection-item[title="1.0.0"]').waitFor();
    await page.getByRole('button', { name: /^(飞书|Feishu)$/, exact: true }).waitFor({ timeout: 30000 });
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-testid="octop-channels-workspace"]');
      const stats = root?.querySelector('[class*=channelsStats]')?.textContent ?? '';
      return /已配置|configured/.test(stats) || /无法读取已有通道|Existing channels could not be read/.test(root?.querySelector('[role=alert]')?.textContent ?? '');
    }, null, { timeout: 65000 });
    await page.screenshot({ path: context.pathInArtifacts('channels-narrow.png'), fullPage: true });
    if (process.env.KCODER_E2E_EXPERT_UI_FEISHU === '1') {
      await page.setViewportSize({ width: 1385, height: 960 });
      const createNew = page.getByRole('button', { name: /^(创建新飞书通道|Create new Feishu channel)$/ });
      if (await createNew.count()) await createNew.click();
      else await page.getByRole('button', { name: /^(飞书|Feishu)$/, exact: true }).click();
      const originalQr = page.getByTestId('feishu-registration-panel');
      try {
        await originalQr.getByRole('link').waitFor({ timeout: 65000 });
      } catch (error) {
        await context.writeArtifactJson('feishu-browser-observation.json', {
          panelCount: await originalQr.count(),
          status: await originalQr.getByRole('status').allTextContents(),
          codes: await originalQr.getByTestId('feishu-registration-diagnostic').allTextContents(),
          alerts: await page.locator('[role="alert"]').allTextContents(),
          buttons: await page.getByRole('dialog').getByRole('button').allTextContents(),
        });
        throw error;
      }
      const href = await originalQr.getByRole('link').getAttribute('href');
      context.registerSecret(href);
      assert.equal(new URL(href).hostname, 'open.feishu.cn');
      await originalQr.getByRole('button', { name: /^(取消创建|Cancel creation)$/ }).click();
      await originalQr.getByText(/已取消|Cancelled/).waitFor();
      await page.getByText(/^(手动填写|Enter manually)$/, { exact: true }).click();
      await page.locator('.octop-drawer-content-wrapper').screenshot({ path: context.pathInArtifacts('feishu-manual-drawer.png'), animations: 'disabled' });
      await page.getByRole('dialog').getByRole('button', { name: /^(关闭|Close)$/ }).first().click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: /^(飞书|Feishu)$/, exact: true }).click();
      await originalQr.getByText(/已取消|Cancelled/).waitFor({ timeout: 65000 });
      assert.equal(await originalQr.getByRole('link').count(), 0);
      await page.getByRole('dialog').getByRole('button', { name: /^(关闭|Close)$/ }).first().click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await context.writeArtifactJson('feishu-browser-proof.json', { originalBegin: true, officialHost: 'open.feishu.cn', cancelledOriginal: true, reopenedOriginalCancelled: true, privateValuesEntered: false });
    }
  }
  await context.writeArtifactJson('expert-native-proof.json', { realMarket: true, slug: installed.package.slug, dependencyCount: installed.package.skillSlugs.length,
    files: installed.package.files, builtinFiles: builtinPackage.files.length, builtinLicensePreserved: true, persistedAcrossReconnect: true, editCopyDelete: true, nativeVersionPublished: true, expertExecution: false, modelCalls: 0 });
  return { realMarket: true, dependencies: 6, editCopyDelete: true, modelCalls: 0 };
});
