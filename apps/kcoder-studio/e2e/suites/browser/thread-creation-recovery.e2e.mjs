import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { makeThreadStartAckGateWrapper, readThreadStartGateEvents, waitForThreadStartGateEvent } from '../../harness/thread-start-ack-gate.mjs';
import { requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

process.umask(0o077);
assert.ok(process.env.KCODER_E2E_KCODER_BIN, 'KCODER_E2E_KCODER_BIN must pin the supplied source-bound CLI');
assert.ok(process.env.KCODER_E2E_KCODER_BIN_SHA256, 'KCODER_E2E_KCODER_BIN_SHA256 must pin the supplied source-bound CLI bytes');
assert.ok(process.env.KCODER_E2E_RENDERER_ROOT, 'KCODER_E2E_RENDERER_ROOT must pin the supplied renderer bundle');
await assertRendererBuildFresh({ buildRoot: process.env.KCODER_E2E_RENDERER_ROOT });

await runE2E(import.meta.url, {
  testId: 'renderer-recovers-no-project-kworker-after-owned-app-server-disconnect', tier: 'full-integration',
  modelPolicy: 'real browser, owned Gateway and pinned CLI; one controlled app-server process exit after durable thread/start and before its reply; loopback scripted Provider; validates creation/fork receipt recovery and one explicit initial send, not model quality',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'creation' });
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'CREATION_RECOVERED' });
  const config = context.pathInState('config');
  await context.writeStateJson('config/settings.json', { active_provider: 'fixture', max_retries: 0,
    hooks: { SessionStart: [{ hooks: [{ type: 'command', shell: 'sh', timeout: 5,
      command: 'sleep 1; printf x >> creation-startup-count.txt' }] }] },
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      default_model: 'fixture-model', context_window_tokens: 64000, output_headroom_tokens: 1024,
      max_output_tokens: 1024, no_proxy: true } } });
  const key = 'synthetic-creation-receipt'; context.registerSecret(key);
  await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key } });
  const binary = await requireExecutable(resolve(process.env.KCODER_E2E_KCODER_BIN), 'supplied source-bound KCoder CLI');
  const binarySha256 = await sha256File(binary);
  assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256, 'the CLI must match the frozen source-bound identity');
  const gateDir = context.pathInState('thread-start-gate');
  await mkdir(gateDir, { recursive: true, mode: 0o700 });
  const gateEventsPath = context.pathInArtifacts('thread-start-gate-events.jsonl');
  const gateWrapperPath = context.pathInState('thread-start-ack-gate.cjs');
  await writeFile(gateWrapperPath, makeThreadStartAckGateWrapper({
    backendBinary: binary,
    gateDir,
    gateEventsPath,
  }), { mode: 0o700 });
  const settingsFile = resolve(config, 'settings.json');
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local', label: 'Creation Recovery', runtime: 'kcoder', transport: 'local',
    command: gateWrapperPath, workspace, settingsFile,
  }]);
  const home = context.pathInState('home');
  let gateway;
  try {
    gateway = await startGateway(context, {
      workspace,
      serversFile,
      kcoderBin: binary,
      auth: true,
      startTimeoutMs: 300_000,
      env: { KCODER_CONFIG_DIR: config, KCODER_HOME: home },
    });
  } catch (error) {
    if (String(error?.stack ?? error).includes('Device authorization local store lock unavailable')) {
      const storeRoot = resolve(home, '.config', 'kcoder-studio', 'mobile-device-auth');
      const info = await lstat(storeRoot).catch(() => null);
      let lockPort = null;
      let listener = 'store directory unavailable';
      if (info) {
        const storageIdentity = `local-file:${info.dev}:${info.ino}`;
        lockPort = 49152 + (parseInt(createHash('sha256').update(storageIdentity).digest('hex').slice(0, 8), 16) % 16384);
        try {
          listener = execFileSync('ss', ['-ltnp', 'sport', '=', `:${lockPort}`], {
            encoding: 'utf8', timeout: 3000,
          }).trim();
        } catch (listenerError) {
          listener = String(listenerError?.stdout || listenerError?.message || 'ss unavailable').trim();
        }
      }
      await context.writeArtifactJson('startup-mobile-store-lock-collision.json', {
        storeRoot,
        storeDirectory: info ? { device: info.dev, inode: info.ino, uid: info.uid } : null,
        lockPort,
        listener,
      });
    }
    throw error;
  }
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const statusResponses = [];
  const browserSockets = [];
  const startupDiagnostics = { console: [], pageErrors: [], failedRequests: [], badResponses: [] };
  const diagnosticPath = raw => {
    try {
      const url = new URL(raw);
      return `${url.origin}${url.pathname}`;
    } catch {
      return '<unparseable-url>';
    }
  };
  const diagnosticText = raw => String(raw)
    .replaceAll(gateway.authToken, '[redacted]')
    .replace(/https?:\/\/[^\s"'`]+/g, value => diagnosticPath(value))
    .slice(0, 1200);
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      startupDiagnostics.console.push({ type: message.type(), text: diagnosticText(message.text()) });
    }
  });
  page.on('pageerror', error => {
    startupDiagnostics.pageErrors.push({ name: error.name, message: diagnosticText(error.message) });
  });
  page.on('requestfailed', request => {
    startupDiagnostics.failedRequests.push({
      url: diagnosticPath(request.url()),
      failure: diagnosticText(request.failure()?.errorText ?? 'unknown'),
    });
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      startupDiagnostics.badResponses.push({ url: diagnosticPath(response.url()), status: response.status() });
    }
  });
  page.on('websocket', socket => {
    const record = { path: new URL(socket.url()).pathname, closed: false };
    browserSockets.push(record);
    socket.on('close', () => { record.closed = true; });
  });
  page.on('response', async response => {
    if (new URL(response.url()).pathname !== '/api/servers/status') return;
    try {
      const payload = await response.json();
      statusResponses.push({
        httpStatus: response.status(),
        statuses: Array.isArray(payload.statuses)
          ? payload.statuses.map(({ id, status, latencyMs }) => ({ id, status, latencyMs }))
          : null,
      });
    } catch {
      statusResponses.push({ httpStatus: response.status(), invalidJson: true });
    }
  });
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    const probe = window.__creationProbe = {
      sequence: 0,
      requests: [],
      responses: [],
      serverEvents: [],
      sockets: [],
    };
    let socketId = 0;
    window.WebSocket = class extends Original {
      #pending = new Map();
      constructor(...args) {
        super(...args);
        const id = ++socketId;
        probe.sockets.push({ id, state: 'created' });
        this.addEventListener('open', () => probe.sockets.push({ id, state: 'open' }));
        this.addEventListener('close', () => probe.sockets.push({ id, state: 'closed' }));
        this.addEventListener('message', event => {
          if (typeof event.data !== 'string') return;
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.method === 'server/disconnected' || message.method === 'server/transportError') {
            probe.serverEvents.push({ sequence: ++probe.sequence, method: message.method });
          }
          if (!Number.isSafeInteger(message.id)) return;
          const request = this.#pending.get(String(message.id));
          if (!request) return;
          if (request.method === 'thread/fork' && message.result?.thread?.id && probe.dropNextForkReply) {
            probe.dropNextForkReply = false;
            probe.lostForkThreadId = message.result.thread.id;
            // Drop only this owned successful reply, before the runtime sees it.
            event.stopImmediatePropagation();
            this.close(1000, 'owned fork acknowledgement loss');
            return;
          }
          if (request.method === 'thread/creation/read') {
            const receipt = message.result?.receipt;
            probe.responses.push({
              sequence: ++probe.sequence,
              method: request.method,
              clientRequestId: request.clientRequestId,
              status: receipt?.status ?? (message.error ? 'error' : 'missing'),
              threadId: receipt?.threadId ?? null,
              errorCode: message.error?.code ?? null,
            });
          } else if (request.method === 'turn/receipt/read') {
            probe.responses.push({
              sequence: ++probe.sequence,
              method: request.method,
              clientMessageId: request.clientMessageId,
              status: message.result?.turn?.status ?? (message.error ? 'error' : 'missing'),
              turnId: message.result?.turn?.id ?? null,
              errorCode: message.error?.code ?? null,
            });
          }
          this.#pending.delete(String(message.id));
        });
      }
      send(data) {
        if (typeof data !== 'string') return super.send(data);
        let request; try { request = JSON.parse(data); } catch { return super.send(data); }
        if (typeof request.method !== 'string') return super.send(data);
        const params = request.params || {};
        const record = {
          sequence: ++probe.sequence,
          method: request.method,
          requestId: Number.isSafeInteger(request.id) ? request.id : null,
          clientRequestId: typeof params.clientRequestId === 'string' ? params.clientRequestId : null,
          clientMessageId: typeof params.clientMessageId === 'string' ? params.clientMessageId : null,
          threadId: typeof params.threadId === 'string' ? params.threadId : null,
          cwd: typeof params.cwd === 'string' ? params.cwd : null,
          studioWorkMode: typeof params.studioWorkMode === 'string'
            ? params.studioWorkMode
            : typeof params.clientPresentation?.studioWorkMode === 'string'
              ? params.clientPresentation.studioWorkMode
              : null,
        };
        probe.requests.push(record);
        if (Number.isSafeInteger(request.id)) this.#pending.set(String(request.id), record);
        return super.send(data);
      }
    };
  });
  await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForURL(url => !url.pathname.startsWith('/login')),
    page.locator('button[type="submit"]').click(),
  ]);
  try {
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
  } catch (error) {
    const dom = await page.evaluate(() => ({
      path: location.pathname,
      title: document.title,
      readyState: document.readyState,
      rootPresent: Boolean(document.querySelector('#root')),
      rootChildCount: document.querySelector('#root')?.childElementCount ?? 0,
      bodyTextLength: document.body?.innerText?.length ?? 0,
      testIds: [...document.querySelectorAll('[data-testid]')].slice(0, 40).map(node => node.getAttribute('data-testid')),
      moduleScripts: [...document.scripts].map(script => {
        try { return new URL(script.src).pathname; } catch { return 'inline'; }
      }),
    }));
    await context.writeArtifactJson('sidebar-startup-diagnostics.json', {
      timeoutMs: 60000,
      error: diagnosticText(error.message),
      dom,
      events: startupDiagnostics,
    });
    await page.screenshot({ path: context.pathInArtifacts('sidebar-startup-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  }
  await page.waitForTimeout(2500);
  const targetProbe = await page.evaluate(async () => {
    const bridge = window.__KCODER_STUDIO_E2E__;
    let runtimeStatus = { available: false };
    if (bridge?.invokeRuntimeCommand) {
      try {
        const status = await bridge.invokeRuntimeCommand('local_executor_status');
        runtimeStatus = {
          available: true,
          deviceId: status?.deviceId ?? null,
          running: status?.running ?? null,
          ready: status?.ready ?? null,
        };
      } catch (error) {
        runtimeStatus = { available: true, errorName: error instanceof Error ? error.name : 'Error' };
      }
    }
    const projectRows = [...document.querySelectorAll('[data-testid="project-item"]')].map(item => ({
      text: (item.textContent ?? '').trim().slice(0, 120),
      deviceStatus: item.querySelector('[data-testid^="project-device-status-"]')?.textContent?.trim().slice(0, 80) ?? null,
      createDisabled: item.querySelector('[data-testid="project-new-conversation-button"]')?.disabled ?? null,
    }));
    return {
      selectedServerId: localStorage.getItem('kcoder-studio:selected-server'),
      runtimeStatus,
      projectRows,
      standaloneChatButton: Boolean(document.querySelector('[data-testid="runtime-chat-section-new-chat-button"]')),
    };
  });
  await context.writeArtifactJson('creation-target-probe.json', {
    expectedTargetId: 'local',
    statusResponses,
    workbench: targetProbe,
  });
  const worker = page.getByTestId('studio-work-mode-switcher').first().getByRole('button', { name: 'KWorker', exact: true });
  await worker.waitFor({ state: 'visible', timeout: 30000 });
  await worker.click();
  await waitFor(async () => await worker.getAttribute('aria-pressed') === 'true', 30000, 'explicit KWorker selection', 50, context.abortSignal);
  await page.getByTestId('runtime-chat-section-new-chat-button').click();
  await page.getByTestId('project-chat-composer').waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(await page.getByTestId('standalone-storage-hint').count(), 0);
  const composer = page.getByTestId('chat-message-input');
  await composer.waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('studio-work-mode-switcher').first().getByRole('button', { name: 'KWorker', exact: true }).getAttribute('aria-pressed'), 'true',
    'KWorker must remain selected for the no-project task');
  await page.waitForFunction(
    () => {
      const controls = document.querySelector('[data-testid="composer-toolbar-model-controls"]');
      return Boolean(controls && controls.getAttribute('aria-busy') !== 'true');
    },
    null,
    { timeout: 60000 },
  );
  const composerProbe = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="chat-message-input"]');
    const disabledAncestors = [];
    for (let node = input; node; node = node.parentElement) {
      if (node.getAttribute('aria-disabled') === 'true' || node.matches('fieldset:disabled')) {
        disabledAncestors.push({
          tag: node.tagName,
          testId: node.getAttribute('data-testid'),
          ariaDisabled: node.getAttribute('aria-disabled'),
          disabled: node.matches('fieldset:disabled'),
        });
      }
    }
    return {
      modelControlsBusy: document.querySelector('[data-testid="composer-toolbar-model-controls"]')?.getAttribute('aria-busy') ?? null,
      modelSelectorDisabled: document.querySelector('[data-testid="model-selector-button"]')?.disabled ?? null,
      modelLabel: document.querySelector('[data-testid="model-selector-current"]')?.textContent?.trim().slice(0, 120) ?? null,
      contentEditable: input?.getAttribute('contenteditable') ?? null,
      ariaDisabled: input?.getAttribute('aria-disabled') ?? null,
      disabledAncestors,
      disabledReason: document.querySelector('[data-testid="composer-disabled-reason"]')?.textContent?.trim().slice(0, 200) ?? null,
    };
  });
  await context.writeArtifactJson('creation-composer-probe.json', composerProbe);
  if (!(await composer.isEnabled())) {
    await page.screenshot({ path: context.pathInArtifacts('creation-composer-disabled.png') });
    throw new Error(`Standalone composer is not ready: ${JSON.stringify(composerProbe)}`);
  }
  const unacceptedPrompt = 'CREATE_ONCE';
  const creationRoot = resolve(home, 'Documents', 'KCoder');
  await mkdir(creationRoot, { recursive: true, mode: 0o700 });
  await composer.click();
  await page.keyboard.insertText(unacceptedPrompt);
  await chmod(creationRoot, 0o500);
  try {
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('chat-input-error').waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await composer.innerText(), unacceptedPrompt,
      'a workspace-creation failure before task acceptance must preserve the exact composer draft');
    const preAcceptanceProbe = await page.evaluate(() => window.__creationProbe);
    assert.equal(preAcceptanceProbe.requests.filter(request => request.method === 'thread/start').length, 0,
      'pre-acceptance workspace failure must not start a runtime task');
    assert.equal(preAcceptanceProbe.requests.filter(request => request.method === 'thread/creation/read').length, 0,
      'pre-acceptance workspace failure must not query a nonexistent creation receipt');
    assert.equal(model.requests.length, 0, 'pre-acceptance workspace failure must not call the provider');
    assert.equal(await page.getByTestId('message-user').filter({ hasText: unacceptedPrompt }).count(), 0,
      'an unaccepted composer draft must not appear in the transcript');
    await page.screenshot({ path: context.pathInArtifacts('creation-blocked-draft-retained.png') });
  } finally {
    await chmod(creationRoot, 0o700);
  }

  await page.getByTestId('send-message-button').dblclick();
  const held = await waitForThreadStartGateEvent(context, gateEventsPath, 1, 'held', 60000);
  await page.waitForTimeout(350);
  const beforeDisconnect = await page.evaluate(() => window.__creationProbe);
  const startRequestsBeforeDisconnect = beforeDisconnect.requests.filter(request => request.method === 'thread/start');
  assert.equal(startRequestsBeforeDisconnect.length, 1, 'two quick Send clicks must not create two task-start requests');
  assert.equal(startRequestsBeforeDisconnect[0].studioWorkMode, 'kworker', 'thread/start must carry the explicitly selected KWorker mode');
  assert.ok(startRequestsBeforeDisconnect[0].clientRequestId, 'thread/start must use a stable creation identity');
  assert.ok(held.threadId, 'the ack gate must observe a backend-created thread before fault injection');
  const createdWorkspace = resolve(startRequestsBeforeDisconnect[0].cwd || '');
  const workspaceRelative = relative(creationRoot, createdWorkspace);
  assert.ok(workspaceRelative && workspaceRelative !== '..' && !workspaceRelative.startsWith(`..${sep}`),
    `thread/start must target this run's no-project workspace under its isolated Home: ${createdWorkspace}`);
  const startupMarker = resolve(createdWorkspace, 'creation-startup-count.txt');
  const pendingUserMessages = await page.getByTestId('message-user').evaluateAll(elements => elements.map(element => ({
    messageId: element.getAttribute('data-message-id'),
    text: element.querySelector('[data-testid="user-message-content"]')?.textContent?.trim().slice(0, 200)
      ?? element.textContent?.trim().slice(0, 200)
      ?? '',
  })));
  assert.ok(pendingUserMessages.length <= 1,
    'the pending create may project at most one optimistic user message before the thread/start acknowledgement');
  if (pendingUserMessages.length === 1) {
    assert.ok(pendingUserMessages[0].text.includes(unacceptedPrompt),
      'the one pending user article must correspond to the retained initial draft');
  }
  const pendingTurnStarts = beforeDisconnect.requests.filter(request => request.method === 'turn/start');
  assert.equal(pendingTurnStarts.length, 0,
    'the held thread/start acknowledgement must prevent the initial turn from being sent');
  assert.equal(model.requests.length, 0, 'thread creation alone must not start a Provider turn');
  await context.writeArtifactJson('creation-pending-message-probe.json', {
    creationRequestId: startRequestsBeforeDisconnect[0].clientRequestId,
    clientMessageId: startRequestsBeforeDisconnect[0].clientMessageId,
    optimisticUserMessages: pendingUserMessages,
    turnStarts: pendingTurnStarts.length,
    providerRequests: model.requests.length,
  });

  const brokerBefore = await findOwnedRuntimeBroker({
    gatewayPid: gateway.child.pid,
    wrapperPath: gateWrapperPath,
    binary,
    settingsFile,
    workspacePath: createdWorkspace,
  });
  await context.writeArtifactJson('creation-disconnect-process-identity.json', {
    cliSha256: binarySha256,
    gatewayPid: gateway.child.pid,
    taskWorkspace: createdWorkspace,
    heldThreadId: held.threadId,
    creationRequestId: startRequestsBeforeDisconnect[0].clientRequestId,
    brokerBefore,
  });
  const wrapperBeforeSignal = await readProcIdentity(brokerBefore.wrapper.pid);
  const childBeforeSignal = await readProcIdentity(brokerBefore.backend.pid);
  assertSameOwnedProcess(wrapperBeforeSignal, brokerBefore.wrapper, 'owned runtime broker before signaling');
  assertSameOwnedProcess(childBeforeSignal, brokerBefore.backend, 'pinned CLI child before signaling');
  const faultEvidence = {
    heldThreadId: held.threadId,
    creationRequestId: startRequestsBeforeDisconnect[0].clientRequestId,
    gateReleased: false,
    backend: { pid: brokerBefore.backend.pid, signal: 'SIGKILL' },
    wrapper: { pid: brokerBefore.wrapper.pid, signal: 'SIGKILL' },
  };
  const startupHookMarkerBeforeCrash = await readFile(startupMarker, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  faultEvidence.startupHookMarkerBeforeCrash = startupHookMarkerBeforeCrash;
  try {
    // Keep this run's backend unavailable until the recovery UI is observable.
    await chmod(gateWrapperPath, 0o600);
    process.kill(brokerBefore.backend.pid, 'SIGKILL');
    await context.writeArtifactJson('creation-disconnect-backend-signal.json', { ...faultEvidence, backendSignaled: true });
    await waitFor(async () => {
      const backend = await readProcIdentity(brokerBefore.backend.pid).catch(() => null);
      return !backend || backend.state === 'Z' ? true : null;
    }, 10000, 'the pinned CLI app-server child to exit after SIGKILL', 20, context.abortSignal);
    const wrapperAfterBackendExit = await readProcIdentity(brokerBefore.wrapper.pid);
    assertSameOwnedProcess(wrapperAfterBackendExit, brokerBefore.wrapper,
      'gate wrapper after backend exit and before terminating it');
    process.kill(brokerBefore.wrapper.pid, 'SIGKILL');
    await context.writeArtifactJson('creation-disconnect-fault.json', {
      ...faultEvidence,
      backendSignaled: true,
      wrapperSignaled: true,
    });
    await waitFor(async () => {
      const wrapper = await readProcIdentity(brokerBefore.wrapper.pid).catch(() => null);
      const backend = await readProcIdentity(brokerBefore.backend.pid).catch(() => null);
      return (!wrapper || wrapper.state === 'Z') && (!backend || backend.state === 'Z') ? true : null;
    }, 15000, 'the targeted app-server wrapper and its pinned CLI child to exit', 25, context.abortSignal);
    await waitFor(async () => (await page.evaluate(() => window.__creationProbe.serverEvents))
      .some(event => event.method === 'server/disconnected'), 30000, 'real server/disconnected notification after app-server exit', 50, context.abortSignal);
    const failedCard = page.locator('[data-testid^="runtime-task-creation-error-"]').first();
    await failedCard.waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await composer.innerText(), unacceptedPrompt,
      'a lost thread/start acknowledgement must preserve the not-yet-started composer draft');
    assert.equal(await page.getByTestId('message-user').count(), 0,
      'the initial draft must not appear in the transcript before a turn is accepted');
    assert.equal(model.requests.length, 0, 'no Provider request may occur before the user explicitly resumes the draft');
    await page.screenshot({ path: context.pathInArtifacts('creation-owned-server-disconnected.png') });
    await chmod(gateWrapperPath, 0o700);

    const errorDetails = failedCard.locator('details');
    const errorSummary = errorDetails.locator('summary');
    const errorDetailText = errorDetails.locator('p');
    const collapsedError = {
      role: await failedCard.getAttribute('role'),
      nestedAlertCount: await failedCard.locator('[role="alert"]').count(),
      visibleText: context.redactText(await failedCard.innerText()),
      detailsOpen: await errorDetails.evaluate(element => element.open),
      detailVisible: await errorDetailText.isVisible(),
      summary: await errorSummary.innerText(),
    };
    assert.equal(collapsedError.role, 'alert', 'the task recovery notice is one alert region');
    assert.equal(collapsedError.nestedAlertCount, 0, 'the alert must not nest another live region');
    assert.equal(collapsedError.detailsOpen, false, 'raw task error details start collapsed');
    assert.equal(collapsedError.detailVisible, false, 'raw task error text stays out of the first screen');
    await page.screenshot({ path: context.pathInArtifacts('creation-error-collapsed.png') });
    await errorSummary.click();
    await waitFor(async () => await errorDetails.evaluate(element => element.open), 3000,
      'the task error details disclosure to open', 25, context.abortSignal);
    const expandedErrorText = context.redactText(await errorDetailText.innerText());
    assert.equal(await errorDetailText.isVisible(), true, 'the disclosed task error text must be readable');
    await page.screenshot({ path: context.pathInArtifacts('creation-error-expanded.png') });
    await errorSummary.click();
    await waitFor(async () => !(await errorDetails.evaluate(element => element.open)), 3000,
      'the task error details disclosure to close', 25, context.abortSignal);
    await context.writeArtifactJson('creation-error-disclosure.json', {
      collapsed: collapsedError,
      expanded: { visible: true, textLength: expandedErrorText.length, text: expandedErrorText },
      closedAgain: !(await errorDetails.evaluate(element => element.open)),
    });
    const queryButton = failedCard.getByRole('button', { name: '查询创建状态', exact: true });
    await waitFor(async () => await queryButton.isEnabled(), 60000, 'creation receipt query available after target recovery', 100, context.abortSignal);
    await queryButton.click();
    const openOriginalButton = failedCard.getByRole('button', { name: '打开原会话', exact: true });
    await openOriginalButton.waitFor({ state: 'visible', timeout: 60000 });
    await page.getByText('已找到原会话，但首条消息是否接收尚未确认。请打开后先核对内容。', { exact: true })
      .waitFor({ state: 'visible', timeout: 30000 });
    const afterReceiptProbe = await page.evaluate(() => window.__creationProbe);
    const creationReads = afterReceiptProbe.responses.filter(response => response.method === 'thread/creation/read');
    assert.ok(creationReads.length >= 1, 'the recovery UI must perform an authoritative creation receipt read');
    assert.ok(creationReads.every(response => response.clientRequestId === startRequestsBeforeDisconnect[0].clientRequestId),
      'every receipt read must use the same original creation identity');
    assert.ok(creationReads.some(response => response.status === 'ready' && response.threadId === held.threadId),
      'the authoritative receipt must resolve the same backend-created thread');
    assert.equal(afterReceiptProbe.requests.filter(request => request.method === 'turn/start').length, 0,
      'reading a ready creation receipt must not automatically replay the initial message');
    assert.equal(await page.getByTestId('message-user').count(), 0,
      'receipt reconciliation must not synthesize a transcript message');
    assert.equal(model.requests.length, 0, 'receipt reconciliation must not call the Provider');
    await context.writeArtifactJson('creation-disconnect-receipt-readback.json', {
      heldThreadId: held.threadId,
      creationRequestId: startRequestsBeforeDisconnect[0].clientRequestId,
      serverEvents: afterReceiptProbe.serverEvents,
      creationReads: creationReads.map(({ status, threadId, clientRequestId }) => ({ status, threadId, clientRequestId })),
      turnStartCountBeforeExplicitOpen: afterReceiptProbe.requests.filter(request => request.method === 'turn/start').length,
      providerRequestsBeforeExplicitOpen: model.requests.length,
    });

    const brokerAfterRecovery = await waitFor(async () => {
      const current = await findOwnedRuntimeBroker({
        gatewayPid: gateway.child.pid,
        wrapperPath: gateWrapperPath,
        binary,
        settingsFile,
        workspacePath: createdWorkspace,
      }).catch(() => null);
      return current && current.wrapper.pid !== brokerBefore.wrapper.pid ? current : null;
    }, 30000, 'a new owned CLI broker for the original task workspace', 25, context.abortSignal);
    await openOriginalButton.click();
    await page.waitForFunction(() => {
      const probe = window.__creationProbe;
      return probe.requests.some(request => request.method === 'thread/resume' || request.method === 'thread/read');
    }, null, { timeout: 30000 });
    assert.equal(await page.getByTestId('message-user').count(), 0,
      'the original thread must be empty before the preserved composer draft is explicitly sent');
    assert.equal((await composer.innerText()).trim(), '',
      'read-only recovery must not copy a different composer scope into the original thread');
    assert.equal(model.requests.length, 0, 'the explicit open action must not send the draft');

    // Inspect the retained original draft, then explicitly enter it in the empty thread.
    const coder = page.getByTestId('studio-work-mode-switcher').first().getByRole('button', { name: 'KCoder', exact: true });
    await coder.click();
    await waitFor(async () => await coder.getAttribute('aria-pressed') === 'true' ? true : null,
      15000, 'switching from the original task to the retained blank scope', 25, context.abortSignal);
    await worker.click();
    await waitFor(async () => await worker.getAttribute('aria-pressed') === 'true' ? true : null,
      15000, 'restoring KWorker mode on the retained blank scope', 25, context.abortSignal);
    await waitFor(async () => await composer.innerText() === unacceptedPrompt ? true : null,
      15000, 'the original blank composer draft to remain intact', 25, context.abortSignal);
    const retainedDraftText = await composer.innerText();
    assert.equal(model.requests.length, 0, 'returning to the original draft must not submit it');
    await openOriginalButton.click();
    await waitFor(async () => new URL(page.url()).searchParams.get('taskId') === `kcoder:local:${held.threadId}` ? true : null,
      15000, 'the original recovered task to reopen', 25, context.abortSignal);
    await waitFor(async () => (await composer.innerText()).trim() === '' ? true : null,
      15000, 'the recovered task composer to remain separately empty', 25, context.abortSignal);
    await composer.click();
    await page.keyboard.insertText(retainedDraftText);
    await context.writeArtifactJson('creation-explicit-draft-restore.json', {
      originalBlankDraftPreserved: retainedDraftText === unacceptedPrompt,
      originalThreadInitiallyEmpty: true,
      automaticDraftTransfer: false,
      explicitUserTextEntry: true,
      providerRequestsBeforeManualSend: model.requests.length,
    });
    await page.getByTestId('send-message-button').click();
    await page.getByText('CREATION_RECOVERED', { exact: true }).waitFor({ timeout: 30000 });
    const probe = await page.evaluate(() => window.__creationProbe);
    assert.ok(probe.serverEvents.some(event => event.method === 'server/disconnected'), 'the owned backend exit must reach the browser as server/disconnected');
    const threadStarts = probe.requests.filter(request => request.method === 'thread/start');
    assert.equal(threadStarts.length, 1, 'double-click, receipt read, and explicit open must not create a second thread');
    assert.equal(new Set(threadStarts.map(request => request.clientRequestId)).size, 1, 'the task creation identity must remain stable');
    assert.equal(threadStarts[0].clientRequestId, startRequestsBeforeDisconnect[0].clientRequestId);
    const turnStarts = probe.requests.filter(request => request.method === 'turn/start');
    assert.equal(turnStarts.length, 1, 'the preserved draft must start exactly one turn after explicit recovery');
    assert.equal(turnStarts[0].threadId, held.threadId, 'the recovered draft must be sent to the original thread');
    assert.equal(new Set(creationReads.map(response => response.threadId)).size, 1, 'receipt reconciliation must resolve one thread only');
    const gateEvents = await readThreadStartGateEvents(gateEventsPath);
    const heldThreadIds = gateEvents.filter(event => event.kind === 'held').map(event => event.threadId).filter(Boolean);
    assert.deepEqual([...new Set(heldThreadIds)], [held.threadId], 'the backend creation reservation must materialize one thread');
    assert.equal(await page.getByTestId('message-user').filter({ hasText: unacceptedPrompt }).count(), 1,
      'the recovered create sends the retained draft exactly once');
    const createdDateDirectories = (await readdir(creationRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory());
    assert.equal(createdDateDirectories.length, 1, 'one standalone workspace directory should be created');
    const createdWorkspaceDirectories = (await readdir(resolve(creationRoot, createdDateDirectories[0].name), {
      withFileTypes: true,
    })).filter(entry => entry.isDirectory());
    assert.equal(createdWorkspaceDirectories.length, 1, 'one standalone task workspace should be created');
    const workspaceFromFilesystem = resolve(
      creationRoot,
      createdDateDirectories[0].name,
      createdWorkspaceDirectories[0].name,
    );
    assert.equal(workspaceFromFilesystem, createdWorkspace,
      'the sole standalone workspace directory must match the recovered thread/start target');
    const startupHookMarkerAfterRecovery = await readFile(startupMarker, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    assert.equal(model.requests.length, 1, 'the accepted draft must reach the loopback Provider exactly once');
    assert.equal(await page.getByTestId('message-assistant').filter({ hasText: 'CREATION_RECOVERED' }).count(), 1,
      'the recovered first turn must render one assistant article');
    const allCreationReads = probe.responses.filter(response => response.method === 'thread/creation/read');
    const turnReceiptReads = afterReceiptProbe.requests.filter(request => request.method === 'turn/receipt/read');
    assert.ok(turnReceiptReads.length >= 1, 'recovery must also query the first message receipt');
    assert.equal(new Set(turnReceiptReads.map(request => request.clientMessageId)).size, 1,
      'receipt readbacks must use one stable initial clientMessageId');
    await context.writeArtifactJson('creation-disconnect-recovery.json', {
      cliSha256: binarySha256,
      heldThreadId: held.threadId,
      creationRequestId: threadStarts[0].clientRequestId,
      initialClientMessageIds: turnReceiptReads.map(request => request.clientMessageId),
      finalUserMessageCount: await page.getByTestId('message-user').filter({ hasText: unacceptedPrompt }).count(),
      finalAssistantArticleCount: await page.getByTestId('message-assistant').filter({ hasText: 'CREATION_RECOVERED' }).count(),
      providerRequests: model.requests.length,
      startupHookMarkerBeforeCrash,
      startupHookMarkerAfterRecovery,
      gatewayWebsocket: { browserEvents: browserSockets, rpcEvents: probe.sockets },
      beforeBroker: brokerBefore,
      recoveredBroker: brokerAfterRecovery,
      threadStartRequests: threadStarts.length,
      turnStartRequests: turnStarts.length,
      receiptReads: allCreationReads.map(({ status, threadId }) => ({ status, threadId })),
      gateEvents: gateEvents.map(({ kind, index, threadId }) => ({ kind, index, threadId })),
      appServerDisconnectedObserved: probe.serverEvents.some(event => event.method === 'server/disconnected'),
    });
    await page.screenshot({ path: context.pathInArtifacts('creation-recovered.png') });
    await page.evaluate(() => { window.__creationProbe.dropNextForkReply = true; });
    await page.getByTestId('message-assistant').last().hover();
    await page.getByTestId('fork-message-button').last().click();
    await waitFor(async () => {
      const probe = await page.evaluate(() => window.__creationProbe);
      return probe.lostForkThreadId ? probe.lostForkThreadId : null;
    }, 30000, 'one owned successful fork reply to be dropped', 50, context.abortSignal);
    const lostForkThreadId = await page.evaluate(() => window.__creationProbe.lostForkThreadId);
    await page.waitForURL(url => url.searchParams.get('taskId') === `kcoder:local:${lostForkThreadId}`, { timeout: 60000 });
    const forkProbe = await page.evaluate(() => window.__creationProbe);
    const forkRequests = forkProbe.requests.filter(row => row.method === 'thread/fork');
    assert.equal(forkRequests.length, 1, 'a lost fork reply must be recovered by reading, without a second fork');
    assert.ok(forkRequests[0].clientRequestId, 'the actual UI fork must carry a stable creation request ID');
    assert.ok(forkProbe.responses.some(row => row.method === 'thread/creation/read' &&
      row.clientRequestId === forkRequests[0].clientRequestId && row.threadId === lostForkThreadId && row.status === 'ready'),
      'the fork must be recovered through its original durable receipt');
    await page.getByTestId('message-user').filter({ hasText: unacceptedPrompt }).waitFor({ timeout: 30000 });
    assert.equal(model.requests.length, 1, 'fork recovery must not send a new Provider request');
    await context.writeArtifactJson('fork-acknowledgement-recovery.json', {
      lostForkThreadId, forkRequests: forkRequests.length, requestId: forkRequests[0].clientRequestId,
      readyReceiptObserved: true, actualUiOpenedOriginalFork: true, providerRequests: model.requests.length,
    });
    await page.screenshot({ path: context.pathInArtifacts('fork-recovered.png') });
    return {
      forkRecovery: { threadId: lostForkThreadId, replyDropped: true, recoveredByRead: true },
      preAcceptanceFailure: {
        composerDraftPreserved: true,
        transcriptMessages: 0,
        threadStarts: 0,
        providerRequests: 0,
      },
      acceptedUnknownRecovery: {
        threadStarts: 1,
        creationQueries: allCreationReads.length,
        startupHookMarkerBytesBeforeCrash: startupHookMarkerBeforeCrash,
        startupHookMarkerBytesAfterRecovery: startupHookMarkerAfterRecovery,
        modelRequests: 1,
        transcriptMessages: 1,
        serverDisconnectedObserved: true,
        brokerPidChanged: brokerBefore.wrapper.pid !== brokerAfterRecovery.wrapper.pid,
        gatewayWebsocketOpened: probe.sockets.filter(socket => socket.state === 'open').length,
        gatewayWebsocketClosed: probe.sockets.filter(socket => socket.state === 'closed').length,
      },
    };
  } catch (error) {
    await chmod(gateWrapperPath, 0o700).catch(() => {});
    await page.screenshot({ path: context.pathInArtifacts('creation-recovery-failure.png'), fullPage: true }).catch(() => {});
    const diagnostic = await page.evaluate(() => ({
      path: location.pathname,
      visibleText: document.body.innerText.slice(0, 12000),
      probe: window.__creationProbe,
    })).catch(() => null);
    await context.writeArtifactJson('creation-recovery-failure.json', diagnostic).catch(() => {});
    throw error;
  }
});

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function directChildren(pid) {
  const raw = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
  return raw.trim() ? raw.trim().split(/\s+/).map(value => Number(value)) : [];
}

async function readProcIdentity(pid) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Owned app-server PID verification requires Linux /proc');
  const base = `/proc/${pid}`;
  const statText = await readFile(`${base}/stat`, 'utf8');
  const end = statText.lastIndexOf(')');
  const fields = statText.slice(end + 2).trim().split(/\s+/);
  const statusText = await readFile(`${base}/status`, 'utf8');
  const uid = Number(statusText.match(/^Uid:\s+(\d+)/m)?.[1]);
  const identity = {
    pid,
    state: fields[0],
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    startTime: Number(fields[19]),
    uid,
  };
  if (identity.state === 'Z') return identity;
  const [cwd, exe, cmdline] = await Promise.all([
    realpath(`${base}/cwd`),
    realpath(`${base}/exe`),
    readFile(`${base}/cmdline`),
  ]);
  return { ...identity, cwd, exe, args: cmdline.toString().split('\0').filter(Boolean) };
}

function assertSameOwnedProcess(actual, expected, label) {
  assert.ok(actual, `${label}: process identity is unavailable`);
  assert.notEqual(actual.state, 'Z', `${label}: process is already a zombie`);
  for (const field of ['pid', 'startTime', 'ppid', 'pgid', 'uid', 'cwd', 'exe']) {
    assert.equal(actual[field], expected[field], `${label}: ${field} changed`);
  }
  assert.deepEqual(actual.args, expected.args, `${label}: argv changed`);
}

async function findOwnedRuntimeBroker({ gatewayPid, wrapperPath, binary, settingsFile, workspacePath }) {
  if (process.platform !== 'linux') throw new Error('UNMET_PREREQUISITE: /proc process identity is required for bounded app-server fault injection');
  const expectedNode = await realpath(process.execPath);
  const expectedBinary = await realpath(binary);
  const expectedTail = ['--settings-file', settingsFile, '--cwd', workspacePath, 'app-server'];
  const candidates = [];
  for (const pid of await directChildren(gatewayPid)) {
    const wrapper = await readProcIdentity(pid).catch(() => null);
    if (!wrapper || wrapper.state === 'Z' || wrapper.ppid !== gatewayPid || wrapper.pgid !== gatewayPid ||
        wrapper.uid !== process.getuid() || wrapper.cwd !== workspacePath || wrapper.exe !== expectedNode ||
        !wrapper.args.includes(wrapperPath)) continue;
    const wrapperIndex = wrapper.args.indexOf(wrapperPath);
    if (JSON.stringify(wrapper.args.slice(wrapperIndex + 1)) !== JSON.stringify(expectedTail)) continue;
    const backends = [];
    for (const childPid of await directChildren(pid)) {
      const backend = await readProcIdentity(childPid).catch(() => null);
      if (!backend || backend.state === 'Z' || backend.ppid !== pid || backend.pgid !== gatewayPid ||
          backend.uid !== process.getuid() || backend.cwd !== workspacePath || backend.exe !== expectedBinary ||
          JSON.stringify(backend.args.slice(-expectedTail.length)) !== JSON.stringify(expectedTail)) continue;
      backends.push(backend);
    }
    if (backends.length === 1) candidates.push({ wrapper, backend: backends[0] });
  }
  assert.equal(candidates.length, 1,
    `expected one exact run-owned app-server wrapper for ${workspacePath}; found ${candidates.length}`);
  return candidates[0];
}
