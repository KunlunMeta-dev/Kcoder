import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { startChromium } from '../../harness/chromium.mjs';
import { runE2E } from '../../harness/run-context.mjs';
import { createDeployedToolsExpert } from './deployed-expert-tools-owner.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'deployed-expert-tools-project-scope', tier: 'manual-live',
  modelPolicy: 'Explicit deployed expert settings inspection. Optional write gate owns one temporary expert for public UI persistence; no existing expert changes, tasks, models or platform sends.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_DEPLOYED_DESKTOP_READ, '1');
  const base = new URL(process.env.KCODER_E2E_DEPLOYED_DESKTOP_URL);
  assert.equal(base.protocol, 'https:');
  assert.ok(!base.search && !base.hash && !base.username && !base.password);
  const file = process.env.KCODER_E2E_DEPLOYED_ENV_FILE;
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  const raw = await readFile(file, 'utf8');
  const token = raw.trim().startsWith('{') ? JSON.parse(raw).KCODER_STUDIO_AUTH_TOKEN : raw.split(/\r?\n/).find(line => line.startsWith('KCODER_STUDIO_AUTH_TOKEN=')).split('=').slice(1).join('=').replace(/^['"]|['"]$/g, '');
  assert.ok(token); context.registerSecret(token);
  const deviceId = process.env.KCODER_E2E_EXPERT_TOOLS_TARGET;
  const workspacePath = process.env.KCODER_E2E_EXPERT_TOOLS_WORKSPACE;
  assert.ok(deviceId && workspacePath);
  const owned = process.env.KCODER_E2E_DEPLOYED_EXPERT_TOOLS_WRITE === '1'
    ? await createDeployedToolsExpert(context, { token, deviceId, workspacePath }) : null;
  const expertId = owned?.id ?? process.env.KCODER_E2E_EXPERT_TOOLS_ID;
  assert.ok(expertId);
  const prefix = base.pathname.replace(/\/$/, '');
  const browser = await startChromium(context, { startTimeoutMs: 60000 });
  const page = await browser.newPage({ viewport: { width: 1650, height: 968 }, ignoreHTTPSErrors: process.env.KCODER_E2E_DEPLOYED_SELF_SIGNED === '1' });
  context.addCleanup('close expert tools inspection', () => page.close());
  const errors = [], mutations = [], catalogs = [], failures = [], catalogResults = [];
  let previewExpert;
  const pending = new Set();
  page.on('request', request => pending.add(request));
  page.on('requestfinished', request => pending.delete(request));
  page.on('requestfailed', request => { pending.delete(request); failures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }); });
  page.on('response', response => { if(response.status() >= 400) failures.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  page.on('pageerror', error => errors.push(error.message.slice(0, 500)));
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    const catalogIds = new Set();
    socket.on('framesent', event => {
      try {
        let message = JSON.parse(String(event.payload));
        const requestId = message.id;
        for (let depth = 0; depth < 5 && message && typeof message === 'object'; depth++, message = message.params) {
          if (message.method === 'settings/tools/selection/read') {
            if (message.params?.previewExpert) previewExpert = message.params.previewExpert;
            catalogs.push({ serverId: url.searchParams.get('server'), workspacePath: url.searchParams.get('workspace') ?? url.searchParams.get('workspacePath') });
            if (url.searchParams.get('server') === deviceId &&
                (url.searchParams.get('workspace') ?? url.searchParams.get('workspacePath')) === workspacePath)
              catalogIds.add(requestId);
          }
          if (typeof message.method === 'string' && /(?:\/|\.)(?:save|saveDraft|saveVersion|create|start|prepareConnectionAction|revoke|bind|submit|acceptTask)$/.test(message.method)) mutations.push({ method: message.method, expertId: message.params?.payload?.definition?.id, revision: message.params?.expectedRevision });
        }
      } catch {}
    });
    socket.on('framereceived', event => {
      try {
        const message = JSON.parse(String(event.payload));
        if (catalogIds.has(message.id) && Array.isArray(message.result?.tools)) catalogResults.push(message.result);
      } catch {}
    });
  });
  const query = new URLSearchParams({ deviceId, workspacePath, expertId });
  const returnTo = `${prefix}/personalization/tools?${query}`;
  const login = new URL(`${base.origin}${prefix}/login`);
  login.searchParams.set('token', token); login.searchParams.set('returnTo', returnTo);
  await page.goto(login.href, { waitUntil: 'commit', timeout: 30000 });
  const panel = page.getByTestId('expert-tools-workspace');
  try {
    await panel.waitFor({ timeout: 120000 });
    await panel.getByRole('switch').first().waitFor({ timeout: 75000 });
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('expert-tools-unavailable.png'), timeout: 60000 });
    await context.writeArtifactJson('unavailable.json', { path: new URL(page.url()).pathname, body: (await page.locator('body').innerText()).slice(-6000), errors, catalogs, failures, pending: [...pending].map(request => new URL(request.url()).pathname), document: await page.evaluate(() => ({ready: document.readyState, rootBytes: document.getElementById('root')?.innerHTML.length, scripts: [...document.scripts].map(script => new URL(script.src || location.href).pathname)})) });
    throw error;
  }
  assert.equal(await page.getByTestId('expert-tools-project').textContent(), workspacePath);
  assert.ok((await page.getByTestId('personalization-current-expert').textContent()).trim());
  const switches = panel.getByRole('switch');
  const count = await switches.count(); assert.ok(count > 0);
  assert.ok(catalogs.some(row => row.serverId === deviceId && row.workspacePath === workspacePath), 'The actual RPC must use the selected project');
  assert.ok(catalogResults.length > 0, 'Inspect the actual target response, not a browser default');
  const catalog = catalogResults.at(-1);
  const lunaReported = Array.isArray(catalog.lunaAllowedTools);
  if (process.env.KCODER_E2E_REQUIRE_LUNA_BASELINE === '1') {
    assert.equal(lunaReported, true, 'Deployment acceptance requires the new target baseline, not the legacy warning path');
    assert.equal(catalog.truncated, false, 'Deployment acceptance requires the complete tool catalog');
  }
  const visibleTools = [];
  const pages = Math.ceil(catalog.tools.length / 10);
  for (let number = 0; number < pages; number++) {
    visibleTools.push(...await panel.locator('[data-expert-tool]').evaluateAll(rows => rows.map(row => ({
      name: row.getAttribute('data-expert-tool'),
      checked: row.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true',
      disabled: row.querySelector('[role="switch"]').disabled,
      resolution: row.querySelector('[data-testid="tool-selection-resolution"]')?.textContent,
    }))));
    if (number < pages - 1) {
      const before = await panel.locator('[data-expert-tool]').first().getAttribute('data-expert-tool');
      await panel.getByRole('button', { name: /^(下一页|Next)$/ }).click();
      await page.waitForFunction(previous => document.querySelector('[data-expert-tool]')?.getAttribute('data-expert-tool') !== previous, before);
    }
  }
  assert.equal(new Set(visibleTools.map(tool => tool.name)).size, catalog.tools.length, 'Verify every tool page without duplicates or omissions');
  for (const row of visibleTools) {
    const tool = catalog.tools.find(tool => tool.name === row.name);
    assert.ok(tool);
    const configured = previewExpert?.allowedTools ?? catalog.lunaAllowedTools ?? [];
    const expected = lunaReported && configured.includes(row.name);
    const grantable = lunaReported && tool.available && (catalog.expertToolsIndependent === true
      ? tool.supportedModes.length > 0
      : catalog.lunaAllowedTools.includes(row.name) && tool.supportedModes.includes('kcoder'));
    assert.equal(row.checked, expected, `Expert tool ${row.name} must show its configured selection`);
    assert.equal(row.disabled, !lunaReported || (!expected && !grantable) || catalog.truncated, 'Selected tools can be removed without granting unavailable tools');
    assert.ok(row.resolution, 'Configuration and the target preview must be displayed separately');
    const resolved = catalog.resolution?.find(mode => mode.mode === 'kcoder')?.tools.find(tool => tool.name === row.name);
    if (resolved) assert.match(row.resolution, resolved.effective ? /可用于新任务|Available in new tasks/ : /不能用于新任务|Unavailable in new tasks/);
  }
  for (let number = 1; number < pages; number++)
    await panel.getByRole('button', { name: /^(上一页|Previous)$/ }).click();
  assert.equal(await page.getByTestId('expert-tools-baseline-unknown').count(), lunaReported ? 0 : 1);
  await context.writeArtifactJson('expert-tool-scope.json', {
    baselineStatus: lunaReported ? 'reported' : 'target-upgrade-required',
    lunaAllowedTools: catalog.lunaAllowedTools ?? null,
    studioDefaultCount: catalog.modes.find(mode => mode.mode === 'kcoder')?.allowedTools.length,
    visibleTools,
  });
  await page.screenshot({ path: context.pathInArtifacts('expert-tools-current-project.png'), timeout: 60000 });
  const scrollLayouts = [];
  for (const viewport of [{ width: 1650, height: 968 }, { width: 1024, height: 640 }, { width: 390, height: 760 }]) {
    await page.setViewportSize(viewport);
    const layout = await panel.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const styles = getComputedStyle(element);
      return { height: element.clientHeight, contentHeight: element.scrollHeight, top: bounds.top, bottom: bounds.bottom, overflowY: styles.overflowY, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    scrollLayouts.push({ viewport, ...layout });
    await context.writeArtifactJson(`scroll-layout-${viewport.width}.json`, { viewport, ...layout });
    assert.ok(layout.height > 100 && layout.contentHeight > layout.height, 'The tools must have a height-bounded scroll region');
    assert.ok(['auto', 'scroll'].includes(layout.overflowY), 'Overflow must remain reachable through a scrollbar');
    assert.ok(layout.top >= 0 && layout.bottom <= viewport.height + 1, 'The scroll region must stay inside the viewport');
    assert.ok(layout.documentWidth <= layout.viewportWidth, 'The tool settings must not cause horizontal page overflow');
    await panel.focus();
    await page.keyboard.press('PageDown');
    await page.waitForFunction(() => document.querySelector('[data-testid="expert-tools-workspace"]')?.scrollTop > 0);
    await panel.evaluate(element => { element.scrollTop = 0; });
    const bounds = await panel.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => document.querySelector('[data-testid="expert-tools-workspace"]')?.scrollTop > 0);
    const scrolled = await panel.evaluate(element => element.scrollTop);
    assert.ok(scrolled > 0, 'Mouse-wheel input must scroll the actual tools region');
    await panel.getByRole('textbox').last().scrollIntoViewIfNeeded();
    const bottom = await panel.getByRole('button').last().boundingBox();
    assert.ok(bottom && bottom.y >= layout.top && bottom.y + bottom.height <= layout.bottom + 1, 'Save and publish actions must be reachable at the bottom');
    await page.screenshot({ path: context.pathInArtifacts(`expert-tools-scroll-${viewport.width}.png`), timeout: 60000 });
  }
  const tabs = page.locator('.octop-personalization-path-tabs');
  const toolTab = tabs.getByText(/^(工具|Tools)$/);
  assert.equal(await toolTab.locator('xpath=ancestor::label[1]').locator('input').isEnabled(), true);
  let persistence;
  if (owned) {
    const editable = catalog.tools.filter(tool => catalog.lunaAllowedTools.includes(tool.name) && tool.available && tool.supportedModes.includes('kcoder'));
    const tool = editable.find(tool => tool.name === 'AskUserQuestion') ?? editable[0];
    assert.ok(tool, 'A real Luna tool is required for persistence acceptance');
    const search = () => panel.getByRole('textbox', { name: /^(搜索工具|Search tools)$/ });
    const toggle = () => panel.locator('[data-expert-tool]').filter({ has: page.getByText(tool.name, { exact: true }) }).getByRole('switch');
    await search().fill(tool.name);
    assert.equal(await toggle().isEnabled(), true);
    await toggle().click();
    await panel.getByText(/^(工具配置已保存|Tool settings saved)/).waitFor();
    const disabled = (await owned.office('assistant/read', { id: expertId })).draft;
    assert.deepEqual(disabled.definition.allowedTools, catalog.lunaAllowedTools.filter(name => name !== tool.name));
    assert.ok(disabled.revision > owned.draft.revision);
    await page.reload();
    await panel.waitFor({ timeout: 120000 });
    await search().fill(tool.name);
    assert.equal(await toggle().getAttribute('aria-checked'), 'false', 'A new page must read the saved target configuration');
    await toggle().click();
    await panel.getByText(/^(工具配置已保存|Tool settings saved)/).waitFor();
    const enabled = (await owned.office('assistant/read', { id: expertId })).draft;
    assert.deepEqual(enabled.definition.allowedTools, [...disabled.definition.allowedTools, tool.name]);
    assert.ok(enabled.revision > disabled.revision);
    await panel.locator('.octop-select-selector, .ant-select-selector').filter({
      has: page.getByRole('combobox', { name: /^(工具范围|Tool access)$/ }),
    }).click();
    await page.locator('.octop-select-item-option-content').getByText(/^(继承 Luna 默认工具|Inherit Luna defaults)$/).click();
    await panel.getByText(/^(工具配置已保存|Tool settings saved)/).waitFor();
    const inherited = (await owned.office('assistant/read', { id: expertId })).draft;
    assert.equal(inherited.definition.allowedTools ?? null, null);
    assert.ok(inherited.revision > enabled.revision);
    await page.reload();
    await panel.waitFor({ timeout: 120000 });
    await search().fill(tool.name);
    assert.equal(await toggle().getAttribute('aria-checked'), 'true');
    await page.screenshot({ path: context.pathInArtifacts('expert-tools-persistence.png'), timeout: 60000 });
    persistence = { tool: tool.name, disabledRevision: disabled.revision, enabledRevision: enabled.revision, inheritedRevision: inherited.revision, reloadVerified: true };
    await context.writeArtifactJson('expert-tools-persistence.json', persistence);
    assert.equal(mutations.length, 3);
    assert.ok(mutations.every(item => item.method === 'integrations/assistant/saveDraft' && item.expertId === expertId));
  } else assert.deepEqual(mutations, []);
  assert.deepEqual(errors, []); assert.deepEqual(failures, []);
  return { publicRoute: true, expertId, workspacePath, toolCount: count, catalogProjectVerified: true, lunaBaselineReported: lunaReported, activationScopeVerified: lunaReported, legacyScopeUnavailableVerified: !lunaReported, scrollViewports: scrollLayouts.map(row => row.viewport), configurationWrites: mutations.length, persistence, modelCalls: 0, platformMessages: 0 };
});
