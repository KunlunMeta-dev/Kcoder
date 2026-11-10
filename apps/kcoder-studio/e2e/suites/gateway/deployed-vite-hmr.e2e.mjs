import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { startChromium } from '../../harness/chromium.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'deployed-vite-mounted-hmr', tier: 'manual-live',
  modelPolicy: 'Authorized deployed renderer inspection and reversible source edit; no model input or platform message.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_DEPLOYED_DESKTOP_READ, '1');
  assert.equal(process.env.KCODER_E2E_DEPLOYED_HMR_SOURCE_EDIT, '1');
  const base = new URL(process.env.KCODER_E2E_DEPLOYED_DESKTOP_URL);
  const loopbackDiagnostic = process.env.KCODER_E2E_VITE_LOOPBACK_DIAGNOSTIC === '1';
  if (loopbackDiagnostic) { assert.equal(base.protocol, 'http:'); assert.equal(base.hostname, '127.0.0.1'); }
  else assert.equal(base.protocol, 'https:');
  assert.ok(!base.username && !base.password && !base.search && !base.hash);
  const prefix = base.pathname.replace(/\/$/, '');
  const path = process.env.KCODER_E2E_DEPLOYED_ENV_FILE;
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  const raw = await readFile(path, 'utf8');
  const token = raw.trim().startsWith('{') ? JSON.parse(raw).KCODER_STUDIO_AUTH_TOKEN :
    raw.split(/\r?\n/).find(line => line.startsWith('KCODER_STUDIO_AUTH_TOKEN=')).split('=').slice(1).join('=').replace(/^['"]|['"]$/g, '');
  assert.ok(token); context.registerSecret(token);
  const browser = await startChromium(context, { startTimeoutMs: 60_000 });
  const page = await browser.newPage({ viewport: { width: 1650, height: 968 },
    ignoreHTTPSErrors: process.env.KCODER_E2E_DEPLOYED_SELF_SIGNED === '1' });
  context.addCleanup('close deployed HMR page', () => page.close());
  const errors = [], failures = [], sockets = [], updates = [], mutations = [];
  const pending = new Set();
  const captureTask = async name => {
    try { await page.screenshot({ path: context.pathInArtifacts(name), timeout: 60_000 }); }
    catch (error) {
      await writeFile(context.pathInArtifacts('task-screenshot-failure.json'), context.redactText(JSON.stringify({ errors, failures,
        pending: [...pending].map(request => new URL(request.url()).pathname),
        fonts: await page.evaluate(() => [...document.fonts].map(font => ({ family: font.family, status: font.status }))),
      }, null, 2)));
      throw error;
    }
  };
  page.on('request', request => pending.add(request));
  page.on('requestfinished', request => pending.delete(request));
  page.on('requestfailed', request => pending.delete(request));
  page.on('requestfailed', request => failures.push({ path: new URL(request.url()).pathname, failure: request.failure()?.errorText }));
  page.on('pageerror', error => errors.push(error.message.slice(0, 500)));
  page.on('console', message => {
    if (message.type() === 'error' && /content security policy|refused to apply|refused to execute/i.test(message.text()))
      errors.push(message.text().slice(0, 500));
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === base.origin && response.status() >= 400) failures.push({ path: url.pathname, status: response.status() });
  });
  page.on('websocket', ws => {
    ws.on('framesent', event => {
      try {
        const message = JSON.parse(String(event.payload));
        for (const method of [message.method, message.params?.method, message.params?.params?.method])
          if (typeof method === 'string' && /(?:\/|\.)(?:start|save|create|delete|revoke|renew|bind|unbind|switch|submit|acceptTask|prepareConnectionAction)$/.test(method)) mutations.push(method);
        for (const rpc of [message, message.params, message.params?.params])
          if (rpc?.method === 'thread/expert' && rpc.params?.change) mutations.push(rpc.method);
      } catch {}
    });
    const pathname = new URL(ws.url()).pathname;
    if (!pathname.endsWith('/__vite_hmr')) return;
    sockets.push(pathname);
    ws.on('framereceived', event => {
      try { const data = JSON.parse(String(event.payload)); if (data.type === 'update') updates.push(data.updates.map(update => update.path)); } catch {}
    });
  });
  const anonymous = await page.request.get(`${base}src/main.tsx`);
  assert.equal(anonymous.status(), 401, 'Source must require Gateway authentication');
  const login = new URL(`${base.origin}${prefix}/login`);
  login.searchParams.set('token', token); login.searchParams.set('returnTo', `${prefix}/`);
  await page.goto(login.href, { waitUntil: 'commit', timeout: 30_000 });
  const sidebarSearch = page.getByTestId('runtime-search-button');
  const brand = sidebarSearch.locator('..').locator('span').first();
  try {
    await sidebarSearch.waitFor({ timeout: 120_000 });
    await brand.waitFor({ timeout: 30_000 });
  } catch (error) {
    await writeFile(context.pathInArtifacts('startup-failure.json'), context.redactText(JSON.stringify({ errors, failures,
      pending: [...pending].map(request => new URL(request.url()).pathname),
      document: await page.evaluate(() => ({ path: location.pathname, ready: document.readyState, rootBytes: document.getElementById('root')?.innerHTML.length, styles: document.styleSheets.length })),
    }, null, 2)));
    await page.screenshot({ path: context.pathInArtifacts('startup-failure.png') });
    throw error;
  }
  const styleObservation = await brand.evaluate(element => ({
    fontWeight: getComputedStyle(element).fontWeight, classes: element.className,
    stylesheetCount: document.styleSheets.length,
    inlineStyleCount: document.querySelectorAll('style').length,
  }));
  await writeFile(context.pathInArtifacts('style-observation.json'), context.redactText(JSON.stringify({ styleObservation, errors, failures }, null, 2)));
  await page.screenshot({ path: context.pathInArtifacts('desktop-vite-before-update.png') });
  assert.ok(Number(styleObservation.fontWeight) >= 600, 'Tailwind typography must be applied');
  const expert = page.getByTestId('task-expert-control');
  await expert.waitFor({ state: 'visible', timeout: 30_000 });
  const expertPlacement = await expert.evaluate(element => {
    const composer = element.closest('[data-testid="project-chat-composer"]');
    const context = composer?.querySelector('[data-testid="composer-project-context"]');
    const form = composer?.querySelector('[data-testid="project-chat-composer-form"]');
    const toolbar = composer?.querySelector('[data-testid="composer-toolbar-actions"]');
    const button = element.querySelector('button');
    return { aboveForm: !!context && !!form && context.getBoundingClientRect().bottom <= form.getBoundingClientRect().top + 1,
      inProjectContext: !!context?.contains(element), inBottomToolbar: !!toolbar?.contains(element),
      label: button?.getAttribute('aria-label'), disabled: button?.disabled };
  });
  await writeFile(context.pathInArtifacts('expert-placement.json'), context.redactText(JSON.stringify(expertPlacement, null, 2)));
  assert.equal(expertPlacement.inProjectContext, false);
  assert.equal(expertPlacement.aboveForm, false);
  assert.equal(expertPlacement.inBottomToolbar, true, 'Expert selection belongs to the composer bottom toolbar');
  assert.equal(await page.getByRole('button', { name: /^(?:专家使用记录|Expert history)$/ }).count(), 0);
  assert.match(expertPlacement.label, /专家选择|Select expert/i, 'A fresh draft must offer expert selection');
  assert.equal(new URL(page.url()).search, '', 'Login token must leave the address bar');
  await page.waitForFunction(() => !document.querySelector('vite-error-overlay'), { timeout: 1000 });
  const source = await page.request.get(`${base.origin}${prefix}/src/main.tsx`);
  assert.equal(source.status(), 200);
  assert.equal(source.headers()['x-kcoder-renderer'], 'vite');
  const client = await (await page.request.get(`${base.origin}${prefix}/@vite/client`)).text();
  const wsToken = client.match(/const wsToken = "([^"]+)"/)[1]; context.registerSecret(wsToken);
  const clientBase = JSON.parse(client.match(/const base = ("[^"]+")/)[1]);
  const wsUrl = `${base.origin.replace(/^http/, 'ws')}${clientBase}__vite_hmr?token=${wsToken}`;
  const cookie = (await page.context().cookies(base.href)).map(item => `${item.name}=${item.value}`).join('; ');
  context.registerSecret(cookie);
  for (const options of [{ origin: base.origin }, { origin: 'https://untrusted.example', headers: { cookie } }]) {
    const rejected = await new Promise(resolveResult => {
      const ws = new WebSocket(wsUrl, 'vite-hmr', { rejectUnauthorized: false, handshakeTimeout: 5000, ...options });
      ws.once('open', () => { ws.terminate(); resolveResult(false); });
      ws.once('error', () => resolveResult(true));
    });
    assert.equal(rejected, true, 'HMR must reject missing login or a foreign Origin');
  }
  const marker = `KCODER_HMR_${randomBytes(5).toString('hex')}`;
  const sidebar = resolve(repoRoot, 'apps/kcoder-studio/renderer/src/components/layout/DesktopSidebar.tsx');
  const original = await readFile(sidebar, 'utf8');
  const anchor = "{t('workbench.brand', 'KCoder Studio')}";
  assert.equal(original.split(anchor).length, 2);
  const modified = original.replace(anchor, `${anchor}{' · ${marker}'}`);
  let changed = false;
  const restore = async () => {
    if (!changed) return;
    const current = await readFile(sidebar, 'utf8');
    assert.equal(current, modified, 'Do not overwrite a concurrent source edit');
    await writeFile(sidebar, original); changed = false;
  };
  context.addCleanup('restore exact temporary HMR source edit', restore);
  await page.evaluate(value => { window.__kcoderHmrDocumentIdentity = value; }, marker);
  await writeFile(sidebar, modified); changed = true;
  await brand.filter({ hasText: marker }).waitFor({ timeout: 30_000 });
  assert.equal(await page.evaluate(() => window.__kcoderHmrDocumentIdentity), marker, 'HMR must preserve the original document');
  await restore();
  await page.waitForFunction(() => {
    const search = document.querySelector('[data-testid="runtime-search-button"]');
    return search?.parentElement?.querySelector('span')?.textContent?.trim() === 'KCoder Studio';
  }, { timeout: 30_000 });
  assert.ok(sockets.length > 0); assert.ok(updates.some(paths => paths.some(path => path.includes('DesktopSidebar.tsx'))));
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  await page.screenshot({ path: context.pathInArtifacts('desktop-vite-restored.png') });
  let taskHeaderBinding = null;
  let taskExpertControl = null;
  let taskChannelIcon = null;
  const taskTitle = process.env.KCODER_E2E_DEPLOYED_TASK_TITLE;
  if (taskTitle) {
    const project = process.env.KCODER_E2E_DEPLOYED_PROJECT_LABEL;
    const connection = process.env.KCODER_E2E_DEPLOYED_EXPECT_CONNECTION_ID;
    assert.ok(project && connection, 'Task inspection must select the explicit original project and connection');
    const sidebar = page.getByTestId('desktop-sidebar');
    const projectToggle = sidebar.getByTestId('project-item-button').filter({ hasText: project }).first();
    await projectToggle.waitFor({ timeout: 45_000 });
    if (await projectToggle.getAttribute('aria-expanded') !== 'true') await projectToggle.click();
    const row = sidebar.locator('[data-testid^="runtime-local-task-row-"]')
      .filter({ has: page.getByText(taskTitle, { exact: true }) });
    await row.waitFor({ timeout: 75_000 });
    const taskId = (await row.getAttribute('data-testid')).slice('runtime-local-task-row-'.length);
    if (process.env.KCODER_E2E_DEPLOYED_CHANNEL_ICON_READ === '1') {
      const icon = row.getByTestId(`runtime-local-task-channel-${taskId}`);
      await icon.waitFor({ timeout: 75_000 });
      assert.equal(await icon.getAttribute('data-connection-id'), connection);
      assert.equal(await icon.getAttribute('data-platform'), 'feishu');
      assert.equal(await icon.locator('img').evaluate(element => element.complete && element.naturalWidth > 0), true);
      assert.equal(await icon.evaluate(element => element.parentElement?.firstElementChild === element), true);
      await captureTask('original-task-sidebar-channel-icon.png');
      taskChannelIcon = { taskId, connectionId: connection, platform: 'feishu',
        imageLoaded: true, beforeTitle: true, bindingChanged: false };
    }
    await row.click();
    await page.waitForURL(url => url.pathname === `${prefix}/runtime-tasks` && url.searchParams.get('taskId') === taskId);
    await page.getByTestId('chat-loading-state').waitFor({ state: 'hidden', timeout: 75_000 });
    if (process.env.KCODER_E2E_DEPLOYED_EXPERT_CONTROL_READ === '1') {
      const control = page.getByTestId('task-expert-control');
      await control.waitFor({ timeout: 45_000 });
      await page.waitForFunction(() => {
        const button = document.querySelector('[data-testid="task-expert-control"] button');
        return button && !button.disabled;
      }, undefined, { timeout: 75_000 });
      await control.locator('button').first().click();
      const picker = page.getByTestId('expert-task-dialog');
      await picker.waitFor({ timeout: 75_000 });
      await picker.getByRole('option', { name: /^(不使用专家|No expert)$/ }).waitFor({ state: 'attached' });
      await captureTask('original-task-expert-picker.png');
      await page.keyboard.press('Escape');
      await picker.waitFor({ state: 'hidden' });
      await control.getByRole('button', { name: /^(专家使用记录|Expert history)$/ }).click();
      const history = page.getByTestId('task-expert-history');
      await history.waitFor({ timeout: 45_000 });
      await captureTask('original-task-expert-history.png');
      await page.keyboard.press('Escape');
      await history.waitFor({ state: 'hidden' });
      taskExpertControl = { taskId, enabled: true, originalTask: true, pickerOpened: true,
        explicitNoExpertAvailable: true, historyOpened: true, configurationChanged: false };
    }
    await captureTask('original-task-before-binding.png');
    const bind = page.getByRole('button', { name: /^(绑定通道|Bind channel)$/ });
    await bind.click();
    assert.equal(await bind.evaluate(element => !!element.closest('[data-testid="workspace-panel-floating-actions"], [data-testid="titlebar-main-actions"]')), true);
    const dialog = page.getByTestId('task-channel-binding-dialog');
    await dialog.waitFor();
    await page.waitForFunction(id => [...(document.querySelector('[data-testid="task-channel-binding-dialog"] select')?.options ?? [])].some(option => option.value === id), connection, { timeout: 75_000 });
    await dialog.getByRole('combobox').selectOption(connection);
    const unbind = dialog.getByRole('button', { name: /^(解绑|Unbind)$/ });
    await unbind.waitFor({ timeout: 75_000 });
    assert.equal(await unbind.isEnabled(), true, 'The original task binding must be manageable through the same dialog');
    await captureTask('original-task-header-channel-binding.png');
    await page.goBack();
    await page.waitForURL(url => url.pathname === `${prefix}/`);
    await dialog.waitFor({ state: 'hidden' });
    taskHeaderBinding = { taskId, connectionId: connection, dialogOpened: true, unbindAvailable: true, closesOnNavigation: true, bindingChanged: false };
  }
  assert.deepEqual(mutations, [], 'Deployed inspection must not create tasks, invoke a model or mutate bindings');
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  const result = { renderer: 'vite', publicRoute: !loopbackDiagnostic, mounted: true, anonymousSourceRejected: true,
    unauthorizedHmrRejected: true, foreignOriginRejected: true, hmrObserved: true,
    sameDocument: true, sourceRestored: true, tailwindApplied: true, expertAboveInput: true, defaultNoExpert: true,
    sourceSha256: createHash('sha256').update(original).digest('hex'), modelInputs: 0, platformMessages: 0, taskHeaderBinding, taskExpertControl, taskChannelIcon };
  await writeFile(context.pathInArtifacts('verification.json'), JSON.stringify(result, null, 2));
  return result;
});
