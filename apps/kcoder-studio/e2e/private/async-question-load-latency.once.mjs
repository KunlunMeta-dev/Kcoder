import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { startChromium } from '../harness/chromium.mjs';
import { runE2E } from '../harness/run-context.mjs';

process.umask(0o077);

const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000;
const targetTitle = '用你的ask工具随便问几个问题';
const defaultTaskId = 'kcoder:expert-preview:NssAk';
const expectedTitle = process.env.KCODER_E2E_ASYNC_EXPECTED_TITLE ?? targetTitle;
const requireExactTitleMatch = process.env.KCODER_E2E_ASYNC_EXPECTED_TITLE !== undefined;
const panelWaitTimeoutMs = Number(process.env.KCODER_E2E_ASYNC_PANEL_WAIT_TIMEOUT_MS ?? 120_000);
assert.ok(Number.isSafeInteger(panelWaitTimeoutMs) && panelWaitTimeoutMs >= 30_000 && panelWaitTimeoutMs <= 300_000);
const emptyRpcScope = () => ({
  serverId: null,
  deviceId: null,
  channel: null,
  workspacePathSha256: null,
  cwdSha256: null,
});
const safeScopeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ? value
  : null;
const hashPathScope = value => typeof value === 'string' && value.length > 0
  ? createHash('sha256').update(value, 'utf8').digest('hex')
  : null;
const initializeScope = (scope, params) => {
  const values = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  return {
    serverId: scope.serverId ?? safeScopeId(values.serverId ?? values.server),
    deviceId: scope.deviceId ?? safeScopeId(values.deviceId),
    channel: scope.channel ?? safeScopeId(values.channel),
    workspacePathSha256: scope.workspacePathSha256 ?? hashPathScope(values.workspacePath),
    cwdSha256: scope.cwdSha256 ?? hashPathScope(values.cwd),
  };
};
const websocketScope = value => {
  try {
    const search = new URL(value).searchParams;
    return {
      serverId: safeScopeId(search.get('serverId') ?? search.get('server')),
      deviceId: safeScopeId(search.get('deviceId')),
      channel: safeScopeId(search.get('channel')),
      workspacePathSha256: hashPathScope(search.get('workspacePath')),
      cwdSha256: hashPathScope(search.get('cwd')),
    };
  } catch {
    return emptyRpcScope();
  }
};

await runE2E(import.meta.url, {
  testId: 'async-question-deployed-load-latency-readonly',
  tier: 'manual-live',
  modelPolicy: 'One existing public task, read-only navigation and RPC timing only; no answers, task inputs, model calls or platform sends.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_ASYNC_DEPLOYED_READ, '1');
  const url = new URL(process.env.KCODER_E2E_ASYNC_TASK_URL);
  assert.equal(url.protocol, 'https:');
  assert.ok(!url.hash && !url.username && !url.password);
  assert.match(url.pathname, /^\/g\/[a-f0-9]{32}\/runtime-tasks$/);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['deviceId', 'taskId']);
  const taskId = url.searchParams.get('taskId');
  const deviceId = url.searchParams.get('deviceId');
  const expectedTaskId = process.env.KCODER_E2E_ASYNC_EXPECTED_TASK_ID ?? defaultTaskId;
  assert.equal(deviceId, 'expert-preview');
  assert.equal(taskId, expectedTaskId);

  const pid = Number(process.env.KCODER_E2E_ASYNC_GATEWAY_PID);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  assert.equal((await stat(`/proc/${pid}`)).uid, process.getuid());
  const commandLine = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
  assert.ok(commandLine.includes('/apps/kcoder-studio/dev-server.mjs'));
  const environment = Object.fromEntries((await readFile(`/proc/${pid}/environ`, 'utf8'))
    .split('\0').filter(line => line.includes('=')).map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  const token = environment.KCODER_STUDIO_AUTH_TOKEN;
  assert.ok(token);
  context.registerSecret(token);

  const startedAt = nowMs();
  const events = [];
  const httpEvents = [];
  const activeResources = new Map();
  const pending = new Map();
  const socketScopes = new Map();
  const phaseTimes = [];
  const pageErrors = [];
  let activePhase = 'login';
  let socketSequence = 0;
  let requestSequence = 0;
  let persistChain = Promise.resolve();
  let persistErrorName = null;
  let identityTitleMatched = false;
  let taskListRowMatched = false;
  const progressPath = context.pathInState('latency-progress.json');
  const pendingSummary = () => [...pending.values()].map(metadata => ({
    requestNo: metadata.requestNo,
    phase: metadata.phase,
    method: metadata.method,
    taskId: metadata.taskId,
    ...(metadata.threadId ? { threadId: metadata.threadId } : {}),
    sentAtMs: metadata.sentAtMs,
    elapsedMs: Number((nowMs() - startedAt - metadata.sentAtMs).toFixed(1)),
  }));
  const persist = () => {
    const snapshot = {
      task: { deviceId, taskId },
      phase: activePhase,
      phaseTimes: [...phaseTimes],
      rpcEvents: [...events],
      pendingRpc: pendingSummary(),
      httpResources: [...httpEvents],
      pageErrorNames: [...pageErrors],
    };
    persistChain = persistChain.then(async () => {
      try {
        await writeFile(progressPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      } catch (error) {
        persistErrorName ??= error?.name || 'Error';
      }
    });
  };
  context.addCleanup('write final sanitized async question latency evidence', async () => {
    await persistChain;
    await context.writeArtifactJsonInternal('async-question-load-latency.final.json', {
      task: { deviceId, taskId, titleMatched: identityTitleMatched || taskListRowMatched, taskListRowMatched },
      phaseTimes: [...phaseTimes],
      rpcEvents: [...events],
      pendingRpc: pendingSummary(),
      httpResources: [...httpEvents],
      pageErrorNames: [...pageErrors],
      progressPersistErrorName: persistErrorName,
      guardrails: { observedWrites: events.filter(event =>
        event.direction === 'sent' && /^(asyncQuestion\/(answer|cancel)|turn\/(start|steer|stop))$/.test(event.method),
      ).length, modelCalls: 0, platformSends: 0, userTextStored: false, tokenStored: false },
    });
  });
  const persistTimer = setInterval(persist, 1000);
  persistTimer.unref();
  context.addCleanup('stop async question latency progress writer', async () => {
    clearInterval(persistTimer);
    await persistChain;
  });

  const browser = await startChromium(context, { startTimeoutMs: 60_000 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, ignoreHTTPSErrors: true });
  context.addCleanup('close deployed async question latency page', () => page.close());
  page.on('pageerror', error => pageErrors.push(error.name));
  const finishResource = async (request, failed = false) => {
    const resource = activeResources.get(request);
    if (!resource) return;
    activeResources.delete(request);
    let status = null;
    let responseBytes = null;
    try {
      const response = await request.response();
      status = response?.status() ?? null;
      const sizes = await request.sizes();
      responseBytes = Number.isFinite(sizes?.responseBodySize) ? sizes.responseBodySize : null;
    } catch { /* Resource timing stays useful without response-size support. */ }
    const finishedAtMs = Number((nowMs() - startedAt).toFixed(1));
    httpEvents.push({
      phase: resource.phase,
      path: resource.path,
      resourceType: resource.resourceType,
      requestedAtMs: resource.requestedAtMs,
      finishedAtMs,
      durationMs: Number((finishedAtMs - resource.requestedAtMs).toFixed(1)),
      status: failed ? null : status,
      responseBytes,
    });
    persist();
  };
  page.on('request', request => {
    try {
      const resourceUrl = new URL(request.url());
      if (resourceUrl.origin !== url.origin || /\/login\/?$/.test(resourceUrl.pathname)) return;
      activeResources.set(request, {
        phase: activePhase,
        path: resourceUrl.pathname,
        resourceType: request.resourceType(),
        requestedAtMs: Number((nowMs() - startedAt).toFixed(1)),
      });
    } catch { /* Ignore non-HTTP resource URLs. */ }
  });
  page.on('requestfinished', request => { void finishResource(request); });
  page.on('requestfailed', request => { void finishResource(request, true); });
  page.on('websocket', socket => {
    const socketId = `ws${++socketSequence}`;
    socketScopes.set(socketId, websocketScope(socket.url()));
    socket.on('framesent', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (!message || typeof message !== 'object' || typeof message.method !== 'string') return;
        const nestedMethod = typeof message.params?.method === 'string' ? message.params.method : null;
        const logicalMethod = nestedMethod ?? message.method;
        let scope = socketScopes.get(socketId) ?? emptyRpcScope();
        if (logicalMethod === 'initialize') {
          const params = nestedMethod ? message.params?.params : message.params;
          scope = initializeScope(scope, params);
          socketScopes.set(socketId, scope);
        }
        const requestNo = `r${++requestSequence}`;
        const metadata = {
          requestNo,
          socketId,
          scope,
          phase: activePhase,
          method: logicalMethod,
          wireMethod: nestedMethod ? message.method : undefined,
          taskId: typeof message.params?.taskId === 'string' ? message.params.taskId :
            activePhase === 'task-list' ? null : taskId,
          threadId: typeof message.params?.threadId === 'string' ? message.params.threadId : undefined,
          sentAtMs: Number((nowMs() - startedAt).toFixed(1)),
        };
        const hasRequestId = message.id !== undefined && message.id !== null;
        events.push({ direction: hasRequestId ? 'sent' : 'notification-sent', ...metadata });
        if (hasRequestId) pending.set(`${socketId}:${String(message.id)}`, metadata);
        persist();
      } catch { /* Ignore non-JSON WebSocket frames without retaining their payload. */ }
    });
    socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (!message || typeof message !== 'object') return;
        const metadata = message.id === undefined ? null : pending.get(`${socketId}:${String(message.id)}`);
        if (metadata) {
          pending.delete(`${socketId}:${String(message.id)}`);
          const result = message.result;
          const questionLists = [result?.questions, result?.result?.questions]
            .find(value => Array.isArray(value)) ?? null;
          const statuses = {};
          let questionItemCount = 0;
          if (questionLists) {
            for (const question of questionLists) {
              const status = typeof question?.status === 'string' ? question.status : 'unknown';
              statuses[status] = (statuses[status] ?? 0) + 1;
              if (Array.isArray(question?.questions)) questionItemCount += question.questions.length;
            }
          }
          const receivedAtMs = Number((nowMs() - startedAt).toFixed(1));
          events.push({
            direction: 'received',
            phase: metadata.phase,
            requestNo: metadata.requestNo,
            socketId,
            scope: metadata.scope,
            method: metadata.method,
            ...(metadata.wireMethod ? { wireMethod: metadata.wireMethod } : {}),
            taskId: metadata.taskId,
            ...(metadata.threadId ? { threadId: metadata.threadId } : {}),
            sentAtMs: metadata.sentAtMs,
            receivedAtMs,
            durationMs: Number((receivedAtMs - metadata.sentAtMs).toFixed(1)),
            ok: !message.error,
            errorCode: message.error?.code ?? null,
            ...(questionLists ? { questionCount: questionLists.length, questionItemCount, questionStatuses: statuses } : {}),
          });
          persist();
        } else if (typeof message.method === 'string') {
          events.push({
            direction: 'notification',
            phase: activePhase,
            socketId,
            scope: socketScopes.get(socketId) ?? emptyRpcScope(),
            method: message.method,
            taskId: typeof message.params?.taskId === 'string' ? message.params.taskId :
              activePhase === 'task-list' ? null : taskId,
            ...(typeof message.params?.threadId === 'string' ? { threadId: message.params.threadId } : {}),
            receivedAtMs: Number((nowMs() - startedAt).toFixed(1)),
          });
          persist();
        }
      } catch { /* Do not retain response bodies, user text, or credentials. */ }
    });
    socket.on('close', () => {
      const closedAtMs = Number((nowMs() - startedAt).toFixed(1));
      for (const [key, metadata] of pending) {
        if (metadata.socketId !== socketId) continue;
        pending.delete(key);
        events.push({
          direction: 'socket-closed',
          requestNo: metadata.requestNo,
          socketId,
          phase: metadata.phase,
          method: metadata.method,
          scope: metadata.scope,
          taskId: metadata.taskId,
          ...(metadata.threadId ? { threadId: metadata.threadId } : {}),
          sentAtMs: metadata.sentAtMs,
          closedAtMs,
          elapsedMs: Number((closedAtMs - metadata.sentAtMs).toFixed(1)),
          outcome: 'socket-closed-without-response',
        });
      }
      socketScopes.delete(socketId);
      persist();
    });
  });

  const mount = url.pathname.replace(/\/runtime-tasks$/, '');
  const login = new URL(url);
  login.pathname = `${mount}/login`;
  login.search = '';
  await page.goto(login.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([
    page.waitForURL(current => !current.pathname.endsWith('/login'), { waitUntil: 'commit', timeout: 60_000 }),
    page.locator('button[type="submit"]').click(),
  ]);

  const route = `${mount}/runtime-tasks?${url.searchParams.toString()}`;
  const tasksRoute = `${mount}/tasks`;
  const panel = page.getByTestId('async-question-panel');
  const targetRow = page.getByTestId(`runtime-local-task-row-${taskId}`);
  const loadPass = async (pass, { navigate = true, beganAtMs = nowMs(), beforeEventCount = events.length } = {}) => {
    activePhase = pass;
    if (navigate) await page.goto(new URL(route, url.origin).href, { waitUntil: 'commit', timeout: 60_000 });
    const commitAtMs = nowMs();
    phaseTimes.push({
      phase: pass,
      routeCommitMs: Number((commitAtMs - beganAtMs).toFixed(1)),
      ...(pass !== 'initial' ? { elapsedSinceRunStartMs: Number((commitAtMs - startedAt).toFixed(1)) } : {}),
    });
    persist();
    await panel.waitFor({ timeout: panelWaitTimeoutMs });
    const panelAtMs = nowMs();
    const title = page.getByTestId('workbench-pane-task-title');
    let titleMatches = false;
    if (await title.count()) titleMatches = (await title.first().textContent())?.trim() === expectedTitle;
    const rowMatches = await targetRow.count() ?
      (await targetRow.getByText(expectedTitle, { exact: true }).count()) > 0 : false;
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="async-question-refresh"]');
      return button && !button.disabled;
    }, null, { timeout: panelWaitTimeoutMs });
    const readyAtMs = nowMs();
    await panel.getByTestId('async-question-toggle').click().catch(() => {});
    const statuses = await panel.locator('article[data-status]').evaluateAll(
      cards => cards.map(card => card.getAttribute('data-status')),
    ).catch(() => []);
    const questionListEvents = events.slice(beforeEventCount).filter(event =>
      event.direction === 'received' && event.method === 'asyncQuestion/list');
    const result = {
      phase: pass,
      taskId,
      taskTitleMatched: titleMatches,
      taskListRowMatched: rowMatches,
      panelVisibleMs: Number((panelAtMs - beganAtMs).toFixed(1)),
      cardReadyMs: Number((readyAtMs - beganAtMs).toFixed(1)),
      visibleQuestionCardCount: statuses.length,
      visibleStatuses: statuses.reduce((counts, status) => {
        counts[status ?? 'unknown'] = (counts[status ?? 'unknown'] ?? 0) + 1;
        return counts;
      }, {}),
      questionListReadCount: questionListEvents.length,
    };
    phaseTimes.push(result);
    persist();
    return result;
  };

  const initial = await loadPass('initial');
  identityTitleMatched = initial.taskTitleMatched || initial.taskListRowMatched;
  await context.writeArtifactJson('first-sample-initial.json', {
    task: {
      deviceId,
      taskId,
      titleMatched: identityTitleMatched,
      taskTitleMatched: initial.taskTitleMatched,
      taskListRowMatched: initial.taskListRowMatched,
    },
    phaseTimes: [...phaseTimes],
    rpcEvents: [...events],
    httpResources: [...httpEvents],
    pageErrorNames: [...pageErrors],
  });
  if (requireExactTitleMatch && !identityTitleMatched) {
    await context.writeArtifactJson('title-mismatch-stop.json', {
      task: { deviceId, taskId, titleMatched: false },
      phaseTimes: [...phaseTimes],
      rpcEvents: [...events],
      httpResources: [...httpEvents],
      pageErrorNames: [...pageErrors],
      guardrails: { observedWrites: 0, modelCalls: 0, platformSends: 0, userTextStored: false },
    });
    return {
      sampleCount: 1,
      sampleTaskId: taskId,
      taskTitleMatched: false,
      stoppedAfterInitialTitleCheck: true,
      observedWrites: 0,
      modelCalls: 0,
    };
  }
  assert.ok(initial.visibleQuestionCardCount > 0, 'The selected task must still have visible question cards.');

  activePhase = 'task-list';
  await page.evaluate(path => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, tasksRoute);
  await page.waitForURL(current => current.pathname.endsWith('/tasks'), { timeout: 10_000 }).catch(() => {});
  const listRow = page.getByTestId(`runtime-local-task-row-${taskId}`);
  const taskTitleMatches = await listRow.getByText(expectedTitle, { exact: true }).count().catch(() => 0);
  taskListRowMatched = taskTitleMatches === 1;
  identityTitleMatched ||= taskListRowMatched;
  phaseTimes.push({ phase: 'task-list-confirmation', rowVisible: await listRow.isVisible().catch(() => false), titleMatched: taskListRowMatched });
  persist();
  await context.writeArtifactJson('task-list-confirmation.json', {
    task: { deviceId, taskId, titleMatched: taskListRowMatched, taskListRowMatched },
    phaseTimes: [...phaseTimes],
    rpcEvents: [...events],
    httpResources: [...httpEvents],
    pageErrorNames: [...pageErrors],
  });
  activePhase = 'reentry';
  const reentryBeganAtMs = nowMs();
  const beforeReentryEvents = events.length;
  if (taskListRowMatched) await listRow.click();
  else await page.evaluate(path => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, route);
  await page.waitForURL(current => current.pathname.endsWith('/runtime-tasks') &&
    current.searchParams.get('taskId') === taskId, { timeout: 60_000 });
  const reentry = await loadPass('reentry', { navigate: false, beganAtMs: reentryBeganAtMs, beforeEventCount: beforeReentryEvents });
  reentry.routeReentryMs = Number((nowMs() - reentryBeganAtMs).toFixed(1));
  persist();

  activePhase = 'reload';
  const reloadBeganAtMs = nowMs();
  const beforeReloadEvents = events.length;
  await page.reload({ waitUntil: 'commit', timeout: 60_000 });
  const reload = await loadPass('reload', { navigate: false, beganAtMs: reloadBeganAtMs, beforeEventCount: beforeReloadEvents });
  reload.browserReloadMs = Number((nowMs() - reloadBeganAtMs).toFixed(1));

  const observedWrites = events.filter(event => event.direction === 'sent' &&
    /^(asyncQuestion\/(answer|cancel)|turn\/(start|steer|stop))$/.test(event.method));
  assert.deepEqual(observedWrites, []);
  return {
    sampleCount: 1,
    sampleTaskId: taskId,
    taskTitleMatched: taskListRowMatched,
    initialCardReadyMs: initial.cardReadyMs,
    reentryCardReadyMs: reentry.cardReadyMs,
    reloadCardReadyMs: reload.cardReadyMs,
    observedWrites: 0,
    modelCalls: 0,
  };
});
