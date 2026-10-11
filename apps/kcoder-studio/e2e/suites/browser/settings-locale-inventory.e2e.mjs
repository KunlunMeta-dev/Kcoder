import assert from 'node:assert/strict';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh(process.env.KCODER_E2E_RENDERER_SOURCE_ROOT ? { sourceRoot: process.env.KCODER_E2E_RENDERER_SOURCE_ROOT } : {});
await runE2E(import.meta.url, { testId: 'settings-route-locale-inventory', tier: 'full-integration', modelPolicy: 'model-independent actual registered page navigation and locale/theme controls' }, async context => {
 const {path:workspace}=await materializeWorkspace(context,'minimal');
 await context.writeStateJson('kcoder-home/settings.json',{providers:{}});
 const gateway=await startGateway(context,{workspace});
 const browser=await startChromium(context);
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const findings=[];
 const mainRoutes=[];
 try {
  await page.goto(`${gateway.baseUrl}/settings`);
  await page.getByTestId('general-language-en-button').click();
  await page.getByTestId('settings-nav-appearance').click();
  await page.getByTestId('appearance-mode-dark').click();
  const ids=await page.locator('[data-testid^="settings-nav-"]').evaluateAll(nodes=>nodes.map(n=>n.dataset.testid));
  if (process.env.KCODER_E2E_LOCALE_COPY_ONLY === '1') {
    await page.getByTestId('settings-nav-general').click();
    await page.getByTestId('general-language-zh-CN-button').click();
    const expected = { context: ['终端', '注入终端信息'], 'keyboard-shortcuts': ['鼠标后退键', '鼠标前进键'], 'model-settings': ['本地 OpenAI 兼容服务'] };
    for (const theme of ['dark', 'light']) {
      await page.getByTestId('settings-nav-appearance').click();
      await page.getByTestId(`appearance-mode-${theme}`).click();
      for (const [id, labels] of Object.entries(expected)) {
        await page.getByTestId(`settings-nav-${id}`).click();
        const main = page.getByTestId('studio-settings-page').locator('main');
        await waitFor(async () => (await main.innerText()).includes(labels.at(-1)), 15000, `${id} final localized copy`);
        const text = await main.innerText();
        for (const label of labels) assert.ok(text.includes(label));
        assert.ok(!/Mouse Back|Mouse Forward|Local OpenAI-compatible|注入 Terminal|\{\{[^}]+\}\}/.test(text));
        findings.push({ id, theme, language: 'zh-CN', text });
      }
    }
    await context.writeArtifactJson('copy-inventory.json', findings);
    return { visited: findings.length, localizedCopyVerified: true };
  }
  for (const language of ['en','zh-CN']) {
    await page.getByTestId('settings-nav-general').click();
    await page.getByTestId(`general-language-${language}-button`).click();
    for (const theme of ['dark','light']) {
      await page.getByTestId('settings-nav-appearance').click();
      await page.getByTestId(`appearance-mode-${theme}`).click();
      for(const id of ids){
        await page.getByTestId(id).click();
        assert.equal(await page.getByTestId(id).getAttribute('aria-current'),'page');
        const main=page.getByTestId('studio-settings-page').locator('main');
        await main.waitFor();
        await waitFor(async () => await main.locator('.animate-spin').count() === 0, 15000, `${language}/${theme}/${id} loading settled`);
        const text=await main.innerText();
        assert.ok(text.trim().length > 0);
        findings.push({id,language,theme,path:new URL(page.url()).pathname,text,han:text.split('\n').filter(line=>/[\u3400-\u9fff]/.test(line)),keys:text.match(/\b(?:settings_|[a-zA-Z]+\.[a-zA-Z]+\.[a-zA-Z_]+)[a-zA-Z_.]*/g)||[]});
      }
    }
  }
  await context.writeArtifactJson('inventory.json',findings);
  for (const language of ['en','zh-CN']) {
    await page.getByTestId('settings-nav-general').click();
    await page.getByTestId(`general-language-${language}-button`).click();
    for (const theme of ['dark','light']) {
      await page.getByTestId('settings-nav-appearance').click();
      await page.getByTestId(`appearance-mode-${theme}`).click();
      for (const route of ['/', '/automations', '/plugins', '/plugins/manage']) {
        await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, route);
        const routeReady = { '/': 'chat-message-input', '/automations': 'scheduled-tasks-panel', '/plugins': 'plugins-workspace', '/plugins/manage': 'kcoder-plugin-management' };
        await page.getByTestId(routeReady[route]).waitFor({ state: 'visible' });
        if (route === '/plugins') await waitFor(() => page.getByTestId('plugins-refresh-button').isEnabled(), 15000, 'marketplace request complete');
        await waitFor(async () => !/Loading extensions…|正在加载扩展|正在加载插件|Loading plugin/.test(await page.locator('body').innerText()), 15000, `${route} inventory loaded`);
        await waitFor(async () => await page.locator('.animate-spin:visible').count() === 0, 15000, `${route} settled`);
        const text = await page.locator('body').innerText();
        mainRoutes.push({ route, language, theme, text, han: text.split('\n').filter(line => /[\u3400-\u9fff]/.test(line)) });
        await page.screenshot({ path: context.pathInArtifacts(`route-${route.replaceAll('/', '_')}-${language}-${theme}.png`) });
      }
      await page.evaluate(() => { history.pushState({}, '', '/settings/appearance'); dispatchEvent(new PopStateEvent('popstate')); });
      await page.getByTestId('appearance-mode-dark').waitFor();
    }
  }
  await context.writeArtifactJson('main-routes.json', mainRoutes);
  for (const item of [...findings, ...mainRoutes]) {
    if (item.language === 'en') assert.deepEqual(item.han, [], `${item.id || item.route}/${item.theme} English application copy`);
    assert.ok(!/\{\{[^}]+\}\}|\b(?:settings|common|chat|plugins|workbench)\.[a-z_]+\.[a-z_]+/i.test(item.text), `${item.id || item.route} no translation placeholder`);
  }
  for (const id of ['context', 'hooks', 'quick-phrases', 'model-settings', 'kcoder-servers']) {
    assert.deepEqual(findings.find(item => item.id === `settings-nav-${id}` && item.language === 'en').han, [], `${id} application copy`);
  }
  await page.getByTestId('settings-nav-general').click();
  await page.getByTestId('general-language-en-button').click();
  await page.getByTestId('settings-nav-quick-phrases').click();
  await page.getByTestId('quick-phrase-edit-default-summary-progress').click();
  await page.getByTestId('quick-phrase-title-input').fill('User-owned phrase');
  await page.getByTestId('quick-phrase-content-input').fill('Preserve this draft after a failed save');
  await page.evaluate(() => {
    const bridge = window.__TAURI_INTERNALS__, invoke = bridge.invoke;
    let failOnce = true;
    bridge.invoke = async (command,args) => {
      if (failOnce && command === 'update_app_preferences' && args?.patch?.quickPhrases) {
        failOnce = false;
        throw new Error('Owned fixture: settings write failed');
      }
      return invoke(command,args);
    };
  });
  await page.getByTestId('quick-phrase-save-button').click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('quick-phrase-title-input').inputValue(), 'User-owned phrase');
  await page.getByTestId('quick-phrase-save-button').click();
  await page.getByTestId('quick-phrase-editor').waitFor({state:'hidden'});
  await page.reload();
  await page.getByText('User-owned phrase',{exact:true}).waitFor();
  await page.getByTestId('settings-nav-general').click();
  await page.getByTestId('general-language-zh-CN-button').click();
  await page.getByTestId('settings-nav-quick-phrases').click();
  await page.getByText('User-owned phrase',{exact:true}).waitFor();
  await page.screenshot({path:context.pathInArtifacts('custom-phrase-survives-language.png')});
  assert.equal(findings.length, ids.length * 4);
  assert.equal(ids.length, 17);
  return {visited:findings.length,localizedAudit:'recorded for classification'};
 } finally {await page.close();}
});
