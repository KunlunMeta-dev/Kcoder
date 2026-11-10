import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { startChromium } from '../../harness/chromium.mjs';
import { runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'deployed-desktop-mounted-readonly', tier: 'manual-live',
  modelPolicy: 'Explicit read-only inspection of an actual deployed desktop route; owned browser, no task input, platform send or model claim.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_DEPLOYED_DESKTOP_READ, '1', 'Explicit deployed-route read required');
  const base = new URL(process.env.KCODER_E2E_DEPLOYED_DESKTOP_URL);
  assert.equal(base.protocol, 'https:');
  assert.ok(!base.username && !base.password && !base.search && !base.hash);
  assert.match(base.pathname, /^\/g\/[a-f0-9]{32}\/?$/);
  const loginFile = process.env.KCODER_E2E_DEPLOYED_LOGIN_FILE;
  const environment = loginFile || process.env.KCODER_E2E_DEPLOYED_ENV_FILE;
  const pinPath = process.env.KCODER_E2E_DEPLOYED_RENDERER_PIN;
  const vite = process.env.KCODER_E2E_DEPLOYED_RENDERER_MODE === 'vite';
  const taskExpertRead = process.env.KCODER_E2E_DEPLOYED_TASK_EXPERT_READ === '1';
  const relayRead = process.env.KCODER_E2E_DEPLOYED_RELAY_READ === '1';
  assert.ok(environment && (vite || taskExpertRead || pinPath), 'Private login source and reviewed renderer pin required');
  const info = await lstat(environment);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  const privateSource = await readFile(environment, 'utf8');
  const line = privateSource.split(/\r?\n/).find(value => value.startsWith('KCODER_STUDIO_AUTH_TOKEN='));
  const privateLogin = loginFile ? new URL(privateSource.trim()) : null;
  if (privateLogin) { assert.equal(privateLogin.origin, base.origin); assert.equal(privateLogin.pathname, base.pathname.replace(/\/$/, '') + '/login'); }
  else assert.ok(line);
  const token = privateLogin ? privateLogin.searchParams.get('token') : line.slice(line.indexOf('=') + 1).replace(/^['"]|['"]$/g, '');
  assert.ok(token);
  context.registerSecret(token);
  const pin = taskExpertRead || vite ? {} : JSON.parse(await readFile(pinPath, 'utf8'));
  if (!taskExpertRead && !vite) {
    assert.match(pin.entrySha256, /^[a-f0-9]{64}$/);
    assert.match(pin.entry, /^assets\/index-[a-zA-Z0-9_-]+\.js$/);
  }
  const prefix = base.pathname.replace(/\/$/, ''), failures = [], pageErrors = [], mutations = [], httpFailures = [];
  const selfSigned = process.env.KCODER_E2E_DEPLOYED_SELF_SIGNED === '1';
  const browser = await startChromium(context, { startTimeoutMs: 60_000 });
  const page = await browser.newPage({ viewport: { width: 1650, height: 968 }, ignoreHTTPSErrors: selfSigned });
  context.addCleanup('close actual deployment read page', () => page.close());
  context.addCleanup('logout owned deployment read session', async () => {
    const response = await page.request.post(`${base.origin}${prefix}/logout`, {
      headers: { Origin: base.origin }, maxRedirects: 0, timeout: 8000,
    });
    assert.equal(response.status(), 303);
  });
  const entryPath = `${prefix}/${pin.entry}`;
  let entrySha256 = null, channelsChunkSha256 = null;
  const reads = [];
  const observedScopes = new Map(), observedServers = new Set();
  const chatReads = [];
  const backgroundReads = [];
  const expertReads = [], expertPending = new Map();
  const rpcPending = new Map(), rpcErrors = [];
  const catalogDiagnostics = [], diagnosticReads = [];
  let socketSequence = 0;
  let hmrConnected = false, rpcInitialized = false;
  const channelsChunkPath = pin.channelsChunk ? `${prefix}/${pin.channelsChunk}` : null;
  page.on('pageerror', error => pageErrors.push(String(error.name)));
  page.on('console', message => {
    if (!['warning', 'error'].includes(message.type()) || !message.text().startsWith('[KCoder]')) return;
    diagnosticReads.push(Promise.all(message.args().map(argument => argument.jsonValue().catch(() => null)))
      .then(args => catalogDiagnostics.push(args)));
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== base.origin) return;
    if (response.status() >= 400) httpFailures.push({ path: url.pathname, status: response.status() });
    if (/(?:\/assets\/|\/runtime-config\.js$)/.test(url.pathname) && response.status() >= 400)
      failures.push({ path: url.pathname, status: response.status() });
    if (channelsChunkPath && url.pathname === channelsChunkPath && response.status() === 200)
      reads.push(response.body().then(bytes => { channelsChunkSha256 = createHash('sha256').update(bytes).digest('hex'); }));
    if (url.pathname === entryPath && response.status() === 200)
      reads.push(response.body().then(bytes => { entrySha256 = createHash('sha256').update(bytes).digest('hex'); }));
  });
  page.on('websocket', socket => {
    const socketId = ++socketSequence;
    const server = new URL(socket.url()).searchParams.get('server');
    if (server) observedServers.add(server);
    socket.on('framesent', frame => {
    try {
      const message = JSON.parse(typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8'));
      if (typeof message.method === 'string' && rpcPending.size < 256)
        rpcPending.set(`${socketId}:${message.id}`, { method: message.method, threadId: message.params?.threadId });
      if (message.method === 'thread/expert') {
        if (message.params?.change) mutations.push(message.method);
        const read = { threadId: message.params?.threadId, response: null };
        expertReads.push(read); expertPending.set(`${socketId}:${message.id}`, read);
      }
      let current = message;
      for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
        if (current.method === 'integrations/services/channel/current' && backgroundReads.length < 100)
          backgroundReads.push(current.params?.payload?.connectionRef);
        if (current.method === 'integrations/connectivity/readResourceGrant'
          && typeof current.params?.payload?.connectionId === 'string' && chatReads.length < 100)
          chatReads.push({ connectionId: current.params.payload.connectionId,
            revision: current.params.expectedRevision ?? null });
        const scope = current.scope;
        if (scope && typeof scope.accountId === 'string' && typeof scope.targetId === 'string') {
          const projection = Object.fromEntries(['accountId', 'targetId', 'workspaceId', 'identityGeneration', 'targetRevision']
            .map(key => [key, scope[key] ?? null]));
          if (observedScopes.size < 32) observedScopes.set(JSON.stringify(projection), projection);
        }
        current = current.params;
      }
      for (const method of [message.method, message.params?.method, message.params?.params?.method]) {
      if (typeof method === 'string' && /(?:\/|\.)(?:start|save|create|delete|revoke|renew|bind|unbind|switch|submit|acceptTask|prepareConnectionAction)$/.test(method))
        mutations.push(method);
      }
    } catch { /* Binary transport frames are not parsed as JSON RPC. */ }
    });
    socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (new URL(socket.url()).pathname.endsWith('/__vite_hmr') && message.type === 'connected') hmrConnected = true;
        if (message.result?.protocolVersion) rpcInitialized = true;
        const request = rpcPending.get(`${socketId}:${message.id}`);
        if (request && message.error && rpcErrors.length < 30)
          rpcErrors.push({ ...request, error: String(message.error.message).slice(0, 500), code: message.error.code });
        const read = expertPending.get(`${socketId}:${message.id}`);
        if (read) read.response = message.error ? { error: message.error.message, code: message.error.code } :
          { threadId: message.result?.threadId, revision: message.result?.revision, expert: message.result?.expert?.title ?? null };
      } catch {}
    });
  });
  await page.goto(`${base.origin}${prefix}/login`);
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([
    page.waitForURL(url => !url.pathname.endsWith('/login'), { waitUntil: 'commit', timeout: 60000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  if (relayRead) {
    await page.goto(`${base.origin}${prefix}/settings/access-links`);
    await page.getByTestId('gateway-relay-configured').waitFor({ timeout: 120000 });
    const state = await page.evaluate(async prefix => {
      const response = await fetch(`${prefix}/api/relay`, { cache: 'no-store' });
      return { status: response.status, body: await response.json() };
    }, prefix);
    assert.equal(state.status, 200);
    assert.equal(state.body.configured, true);
    assert.equal(state.body.publicBaseUrl, base.origin + prefix);
    assert.equal(await page.locator('#relay-activation-link').count(), 0);
    assert.equal(state.body.switchSupported, true);
    await page.getByRole('button', { name: '切换中继', exact: true }).click();
    await page.locator('#relay-address').waitFor();
    assert.equal(await page.locator('#relay-address').inputValue(), state.body.relayUrl);
    assert.equal(await page.locator('#relay-activation-link').count(), 1);
    assert.equal(await page.evaluate(() => Boolean(window.kcoderDesktopHost)), false);
    await page.screenshot({ path: context.pathInArtifacts('gateway-relay-web.png'), fullPage: true,
      mask: [page.getByTestId('mobile-pairing-qr'), page.getByTestId('mobile-web-pairing-qr')] });
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(mutations, []);
    await context.writeArtifactJson('gateway-relay-web.json', { state, pageErrors, httpFailures, mutations });
    return { sharedGatewayRelayUi: true, switchConfigurationVisible: true, browserHost: true, existingRegistration: true, credentialReplacement: false };
  }
  if (vite) {
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 120000 });
    await page.getByTestId('runtime-chat-section').waitFor({ timeout: 60000 });
    try {
      await page.getByTestId('channels-button').click();
      await page.getByTestId('channels-page').waitFor({ timeout: 45000 });
      await page.getByTestId('octop-channels-workspace').first().waitFor({ timeout: 45000 });
    } finally {
      await context.writeArtifactJson('desktop-vite-channel-load.json', { httpFailures, pageErrors, mutations });
      await page.screenshot({ path: context.pathInArtifacts('desktop-vite-channels.png') });
    }
    const deadline = Date.now() + 60000;
    while ((!hmrConnected || !rpcInitialized) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 100));
    const taskThread = process.env.KCODER_E2E_DEPLOYED_TASK_THREAD;
    try {
      if (taskThread) {
        const serverId = process.env.KCODER_E2E_DEPLOYED_SERVER_ID;
        assert.ok(serverId && /^[A-Za-z0-9_-]+$/.test(taskThread));
        const project = page.getByTestId('project-item')
          .filter({ has: page.getByText(serverId, { exact: true }) });
        await project.waitFor({ timeout: 60000 });
        const toggle = project.getByTestId('project-item-button');
        if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
        const row = project.getByTestId(`runtime-local-task-row-kcoder:${serverId}:${taskThread}`);
        for (let index = 0; index < 100 && !await row.count(); index++) {
          const more = project.locator('[data-testid^="project-runtime-tasks-expand-"]');
          await Promise.race([row.waitFor({ state: 'attached', timeout: 30000 }),
            more.waitFor({ state: 'visible', timeout: 30000 })]);
          if (!await row.count()) await more.click();
        }
        await row.waitFor({ state: 'visible', timeout: 30000 });
      }
    } finally {
      await Promise.all(diagnosticReads);
      await context.writeArtifactJson('task-catalog-read.json', {
        taskThread: taskThread ?? null, catalogDiagnostics, rpcErrors, httpFailures,
        rpcMethods: [...rpcPending.values()].map(value => value.method),
      });
      await page.screenshot({ path: context.pathInArtifacts('task-catalog-read.png') });
    }
    await page.screenshot({ path: context.pathInArtifacts('desktop-vite.png') });
    await context.writeArtifactJson('desktop-vite-read.json', { hmrConnected, rpcInitialized, httpFailures, pageErrors, mutations });
    assert.ok(hmrConnected, 'The authenticated public Vite HMR socket must connect');
    assert.ok(rpcInitialized, 'The actual target app-server must initialize over public RPC');
    assert.deepEqual(httpFailures, []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(mutations, []);
    return { renderer: 'vite', sidebar: true, hmrConnected, rpcInitialized, modelCalls: 0, platformMessages: 0 };
  }
  if (taskExpertRead) {
    const serverId = process.env.KCODER_E2E_DEPLOYED_SERVER_ID;
    const threads = (process.env.KCODER_E2E_DEPLOYED_EXPERT_THREADS ?? '').split(',').filter(Boolean);
    assert.ok(serverId && threads.length > 0 && threads.length <= 3);
    assert.ok(threads.every(id => /^[A-Za-z0-9_-]+$/.test(id)));
    const observations = [];
    for (const threadId of threads) {
      const query = new URLSearchParams({ deviceId: serverId, taskId: `kcoder:${serverId}:${threadId}` });
      await page.goto(`${base.origin}${prefix}/runtime-tasks?${query}`, { waitUntil: 'commit', timeout: 60000 });
      const control = page.getByTestId('task-expert-control');
      await control.waitFor({ timeout: 75000 });
      await page.waitForFunction(() => {
        const button = document.querySelector('[data-testid="task-expert-control"] button');
        return button && !button.disabled;
      }, null, { timeout: 75000 });
      await control.getByRole('button').first().click();
      await page.waitForFunction(() => {
        if (document.querySelector('[data-testid="expert-task-dialog"], [data-testid="expert-task-read-error"]')) return true;
        const target = document.querySelector('[data-testid="expert-task-target-status"]');
        return !!target?.querySelector('[role="alert"]') ||
          [...(target?.querySelectorAll('button') ?? [])].some(button => !button.disabled && !button.getAttribute('aria-label'));
      }, null, { timeout: 75000 });
      const picker = page.getByTestId('expert-task-dialog');
      observations.push({ threadId, pickerOpened: await picker.count() === 1,
        visibleErrors: await page.getByRole('alert').allTextContents(),
        // Local failures before an RPC have no wire receipt; inspect only this
        // owned page's retained error strings, never task or credential state.
        localReadErrors: await control.evaluate(element => {
          const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'));
          let fiber = key ? element[key] : null;
          for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return) {
            if (fiber.type?.name !== 'TaskExpertControl') continue;
            const errors = [];
            for (let hook = fiber.memoizedState, count = 0; hook && count < 100; hook = hook.next, count++) {
              const value = hook.memoizedState;
              if (value && typeof value === 'object' && typeof value.key === 'string' && typeof value.message === 'string')
                errors.push(value.message.slice(0, 500));
            }
            return errors;
          }
          return [];
        }),
        reads: expertReads.filter(read => read.threadId === threadId) });
      await page.screenshot({ path: context.pathInArtifacts(`task-expert-${threadId}.png`) });
    }
    await context.writeArtifactJson('task-expert-read.json', { observations, expertReads, rpcErrors, mutations, pageErrors });
    assert.deepEqual(mutations, []);
    assert.deepEqual(pageErrors, []);
    assert.ok(observations.every(row => row.pickerOpened), 'Every selected original task must open its expert picker');
    assert.ok(observations.every(row => row.reads.some(read => read.response?.threadId === row.threadId && Number.isSafeInteger(read.response.revision))),
      'The expert selection must come from a successful original task read');
    return { originalTaskExpertRead: true, tasks: threads, pickerOpened: true, writes: 0, modelCalls: 0, platformMessages: 0 };
  }
  let expertPickerRead = null;
  if (process.env.KCODER_E2E_DEPLOYED_EXPERT_PICKER_READ === '1') {
    await page.goto(`${base.origin}${prefix}/`);
    await page.getByTestId('desktop-sidebar').getByRole('button', {
      name: /^(新建任务|New task|New Task|New chat|New Chat)$/,
    }).first().click({ timeout: 45000 });
    const control = page.locator('[data-testid="task-expert-control"]:visible').first();
    await control.waitFor({ timeout: 45000 });
    const choose = control.getByRole('button').first();
    await choose.waitFor();
    const project = process.env.KCODER_E2E_DEPLOYED_PROJECT_LABEL;
    if (project) {
      await page.locator('[data-testid="project-work-button"]:visible').first().click();
      const menu = page.getByTestId('project-work-menu');
      try { await menu.getByRole('button').filter({ hasText: project }).first().click({ timeout: 75000 }); }
      catch (error) {
        await page.screenshot({ path: context.pathInArtifacts('deployed-project-selection-unavailable.png') });
        throw error;
      }
    }
    await page.screenshot({ path: context.pathInArtifacts('deployed-new-task-expert-entry.png') });
    await choose.click({ timeout: 45000 });
    const dialog = page.getByTestId('expert-task-dialog');
    try { await dialog.waitFor({ timeout: 75000 }); }
    catch (error) {
      await page.screenshot({ path: context.pathInArtifacts('deployed-expert-picker-unavailable.png') });
      throw error;
    }
    await page.screenshot({ path: context.pathInArtifacts('deployed-expert-dialog-open.png') });
    const experts = dialog.getByRole('combobox').first();
    try { await page.waitForFunction(() => [...(document.querySelectorAll(
      '[data-testid="expert-task-dialog"] select'
    )[0]?.options ?? [])].some(option => option.value), null, { timeout: 75000 }); }
    catch (error) {
      await page.screenshot({ path: context.pathInArtifacts('deployed-expert-catalog-unavailable.png') });
      await context.writeArtifactJson('expert-picker-read-unavailable.json', {
        dialogText: await dialog.textContent(), scopes: [...observedScopes.values()], servers: [...observedServers],
      });
      throw error;
    }
    const choices = await experts.locator('option').evaluateAll(options => options
      .filter(option => option.value).map(option => ({ value: option.value, label: option.textContent })));
    assert.ok(choices.length > 0, 'The real target must return an expert catalog');
    // Applying only selects a saved version for the unsent browser draft.
    const expectedExpert = process.env.KCODER_E2E_DEPLOYED_EXPERT_LABEL;
    const selected = expectedExpert ? choices.find(choice => choice.label === expectedExpert) : choices[0];
    assert.ok(selected, 'The explicitly selected existing expert must be in the real catalog');
    await experts.selectOption(selected.value);
    const versions = dialog.getByRole('combobox').nth(1);
    await page.waitForFunction(() => [...(document.querySelectorAll(
      '[data-testid="expert-task-dialog"] select'
    )[1]?.options ?? [])].some(option => option.value), null, { timeout: 75000 });
    const savedVersions = await versions.locator('option').evaluateAll(options => options.filter(option => option.value).length);
    const firstVersion = await versions.locator('option').evaluateAll(options => options.find(option => option.value)?.value);
    assert.ok(firstVersion);
    await versions.selectOption(firstVersion);
    await page.screenshot({ path: context.pathInArtifacts('deployed-expert-version-picker.png') });
    const labels = await Promise.all(['en', 'zh-CN'].map(async locale =>
      JSON.parse(await readFile(new URL(`../../../renderer/src/i18n/locales/${locale}/experts.json`, import.meta.url), 'utf8')).task.apply));
    const apply = dialog.getByRole('button').filter({ hasText: new RegExp(labels.join('|')) });
    await apply.click();
    await dialog.waitFor({ state: 'hidden' });
    assert.ok((await control.textContent()).includes(selected.label), 'The selected expert must return to this original draft');
    await page.screenshot({ path: context.pathInArtifacts('deployed-expert-selected-draft.png') });
    expertPickerRead = { visibleEntry: true, dialogOpened: true, actualExpertChoices: choices.length,
      savedVersions, taskCreated: false, modelCalled: false, appliedToLocalDraftOnly: true };
  }
  let taskEntryRead = null;
  const taskTitle = process.env.KCODER_E2E_DEPLOYED_TASK_TITLE;
  if (taskTitle) {
    const sidebar = page.getByTestId('desktop-sidebar');
    const project = process.env.KCODER_E2E_DEPLOYED_PROJECT_LABEL;
    if (project) {
      const projectToggle = sidebar.getByTestId('project-item-button')
        .filter({ hasText: project }).first();
      await projectToggle.waitFor({ timeout: 45000 });
      if (await projectToggle.getAttribute('aria-expanded') !== 'true') await projectToggle.click();
    }
    const row = sidebar.locator('[data-testid^="runtime-local-task-row-"]')
      .filter({ has: page.getByText(taskTitle, { exact: true }) }).first();
    await row.waitFor({ timeout: 75000 });
    const taskId = (await row.getAttribute('data-testid')).slice('runtime-local-task-row-'.length);
    await row.click();
    await page.waitForURL(url => url.pathname === `${prefix}/runtime-tasks`
      && url.searchParams.get('taskId') === taskId, { timeout: 45000 });
    await page.getByTestId('chat-loading-state').waitFor({ state: 'hidden', timeout: 75000 });
    assert.equal(await page.getByTestId('expert-conversations').count(), 0,
      'Opening an original task must not force the expert conversation layout');
    await page.screenshot({ path: context.pathInArtifacts('deployed-original-task-entry.png') });
    await sidebar.getByTestId('experts-button').click();
    const expertsPage = page.getByTestId('experts-page');
    await expertsPage.waitFor({ timeout: 45000 });
    await expertsPage.getByRole('button', { name: /^(对话|Chat)$/ }).first().click({ timeout: 75000 });
    await page.waitForURL(url => url.pathname === `${prefix}/expert-conversations`, { timeout: 45000 });
    await page.getByTestId('expert-conversations').waitFor();
    const session = page.getByTestId('expert-conversation-session').filter({ hasText: taskTitle });
    await session.waitFor({ timeout: 75000 });
    assert.equal(await session.getAttribute('data-task-id'), taskId,
      'The explicit expert entry must reference the same original task');
    await page.getByTestId('chat-loading-state').waitFor({ state: 'hidden', timeout: 75000 });
    await page.screenshot({ path: context.pathInArtifacts('deployed-explicit-expert-entry.png') });
    taskEntryRead = { originalTaskPage: true, automaticExpertRedirect: false,
      explicitExpertEntry: true, sameOriginalTask: true, taskCreated: false, modelCalled: false };
  }
  await page.goto(`${base.origin}${prefix}/channels`);
  await page.getByTestId('channels-page').waitFor({ timeout: 45000 });
  await page.getByTestId('octop-channels-workspace').first().waitFor({ timeout: 45000 });
  await page.waitForTimeout(1000);
  let unusedDraftRemovalRead = null;
  if (process.env.KCODER_E2E_DEPLOYED_DRAFT_REMOVAL_READ === '1') {
    const buttons = page.locator('[data-testid^="channel-remove-"]');
    await buttons.first().waitFor({ timeout: 75000 });
    unusedDraftRemovalRead = { visibleRemoveActions: await buttons.count(), mutations: 0 };
    await page.screenshot({ path: context.pathInArtifacts('deployed-unused-draft-remove-entry.png'), fullPage: true });
  }
  let connectionInstances = null;
  let chatDirectoryRead = null;
  let nativeBackgroundRead = null;
  if (process.env.KCODER_E2E_DEPLOYED_MULTI_CONNECTIONS_UI === '1') {
    await page.getByTestId('channel-add-connection-feishu').first().waitFor({ timeout: 30000 });
    const cards = page.getByTestId('channel-connection-instance');
    // Each rendered instance has its own durable ID. This checks real deployment
    // presentation only; fixture regressions cover second-connection mutations.
    const observations = await cards.evaluateAll(elements => elements.map(element => ({
      id: element.getAttribute('data-connection-id'),
      owner: element.closest('[data-namespace-id]')?.getAttribute('data-namespace-id')
        ?? element.closest('[data-owner-scope]')?.getAttribute('data-owner-scope') ?? null,
    })));
    const ids = observations.map(row => row.id);
    assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
    assert.equal(new Set(observations.map(row => JSON.stringify([row.owner, row.id]))).size, ids.length, 'Connection instances must retain their original namespace and ID');
    connectionInstances = ids.length;
    if (process.env.KCODER_E2E_DEPLOYED_EXPECT_CONNECTION_ID) {
      try {
        // Inventory permits one metadata-only retry after a cold Native handshake.
        await page.waitForFunction(id => [...document.querySelectorAll('[data-testid="channel-connection-instance"]')].some(element => element.getAttribute('data-connection-id') === id), process.env.KCODER_E2E_DEPLOYED_EXPECT_CONNECTION_ID, { timeout: 75000 });
      } catch (error) {
        await Promise.all(reads);
        await context.writeArtifactJson('deployed-connection-unavailable.json', {
          entry: pin.entry, entrySha256, channelsChunkSha256,
          nativeMutationsObserved: mutations.length, servers: [...observedServers], scopes: [...observedScopes.values()],
          visibleErrors: await page.locator('[role="alert"]').allTextContents(), connectionInstances: observations,
        });
        await page.screenshot({ path: context.pathInArtifacts('deployed-connection-unavailable.png'), fullPage: true });
        throw error;
      }
      connectionInstances = await cards.count();
      if (process.env.KCODER_E2E_DEPLOYED_BACKGROUND_RUNNING === '1') {
        const id = process.env.KCODER_E2E_DEPLOYED_EXPECT_CONNECTION_ID;
        const index = (await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-connection-id')))).indexOf(id);
        assert.ok(index >= 0);
        const card = cards.nth(index);
        const revision = (await card.locator('details').first().textContent()).split('·').at(-1).trim();
        const labels = await Promise.all(['en', 'zh-CN'].map(async locale =>
          JSON.parse(await readFile(new URL(`../../../renderer/src/i18n/locales/${locale}/connectivity.json`, import.meta.url), 'utf8')).connections.backgroundRunning));
        await page.waitForFunction(({ id, labels }) => {
          const element = document.querySelector(`[data-testid="channel-background-${id}"]`);
          return element && labels.includes(element.textContent);
        }, { id, labels }, { timeout: 45000 });
        assert.ok(backgroundReads.some(ref => ref?.id === id && ref.revision === revision), 'Running label must follow an exact original connection read');
        nativeBackgroundRead = { connectionId: id, revision, verifiedNativeOwnerRunning: true };
      }
      if (process.env.KCODER_E2E_DEPLOYED_CHAT_DIRECTORY_READ === '1') {
        const id = process.env.KCODER_E2E_DEPLOYED_EXPECT_CONNECTION_ID;
        const index = (await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-connection-id')))).indexOf(id);
        assert.ok(index >= 0);
        const card = cards.nth(index);
        const revision = (await card.locator('details').first().textContent()).split('·').at(-1).trim();
        assert.match(revision, /^[1-9][0-9]*$/);
        const before = chatReads.length;
        await card.getByRole('button', { expanded: false }).click();
        const directory = card.getByTestId('channel-external-chats');
        const emptyLabels = await Promise.all(['en', 'zh-CN'].map(async locale =>
          JSON.parse(await readFile(new URL(`../../../renderer/src/i18n/locales/${locale}/connectivity.json`, import.meta.url), 'utf8')).chatTasks.empty));
        await page.waitForFunction(({ index, emptyLabels }) => {
          const panel = document.querySelectorAll('[data-testid="channel-connection-instance"]')[index]?.querySelector('[data-testid="channel-external-chats"]');
          return panel && (panel.querySelectorAll('li').length > 0
            || [...panel.querySelectorAll('[role="status"]')].some(element => emptyLabels.includes(element.textContent)));
        }, { index, emptyLabels }, { timeout: 45000 });
        assert.equal(await directory.getByRole('alert').count(), 0, 'The original connection chat read must settle successfully');
        const reads = chatReads.slice(before);
        assert.ok(reads.length > 0, 'The browser must read original chat observations');
        assert.ok(reads.every(read => read.connectionId === id && read.revision === revision), 'Chat reads must retain the selected connection ID and revision');
        chatDirectoryRead = { connectionId: id, revision, originalRead: true,
          observedChats: await directory.locator('li').count(), mutations: 0 };
      }
    }
  }

  await Promise.all(reads);
  assert.equal(entrySha256, pin.entrySha256, 'The actual browser must execute the reviewed mounted entry');
  if (pin.channelsChunkSha256) assert.equal(channelsChunkSha256, pin.channelsChunkSha256, 'The actual channels chunk must match the reviewed multi-connection build');
  assert.deepEqual(failures, [], 'Mounted static resources failed');
  assert.deepEqual(pageErrors, [], 'Deployed renderer threw uncaught errors');
  assert.deepEqual(mutations, [], 'Read inspection unexpectedly issued a Native mutation');
  await page.screenshot({ path: context.pathInArtifacts('deployed-channels.png'), fullPage: true });
  const proof = { actualPublicRoute: true, mountedPath: prefix, entry: pin.entry, entrySha256, channelsChunkSha256,
    staticFailures: failures.length, uncaughtErrors: pageErrors.length, nativeMutationsObserved: mutations.length, httpFailures,
    ownedBrowser: true, selfSigned, connectionInstances, chatDirectoryRead, nativeBackgroundRead, expertPickerRead, taskEntryRead, unusedDraftRemovalRead,
    realFeishuEndToEnd: false, modelBehaviorTested: false };
  await context.writeArtifactJson('deployed-desktop-read-proof.json', proof);
  return proof;
});
