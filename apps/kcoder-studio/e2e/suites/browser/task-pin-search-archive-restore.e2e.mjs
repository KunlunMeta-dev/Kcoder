import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

const title = 'B24 pin search archive restore';
const promptMarker = 'B24_TRANSCRIPT_SEARCH_MARKER_20261113';
const replyMarker = 'B24_SCRIPTED_PROVIDER_REPLY_20261113';
const expectedForbiddenResourceError = 'Failed to load resource: the server responded with a status of 403 (Forbidden)';
const expectedAdminDenialPaths = new Set(['/api/kcoder-account', '/api/channels']);

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'task-pin-search-archive-restore-cross-gateway-discovery',
  tier: 'full-integration',
  modelPolicy: 'model-independent browser/Gateway/app-server lifecycle; one owned loopback scripted Provider response, no real model claim',
  retainSuccessEvidence: true,
}, async context => {
  const binaryPath = process.env.KCODER_E2E_KCODER_BIN;
  const expectedBinarySha = process.env.KCODER_E2E_KCODER_BIN_SHA256;
  assert.ok(binaryPath, 'KCODER_E2E_KCODER_BIN must pin the supplied source-bound CLI');
  assert.ok(expectedBinarySha, 'KCODER_E2E_KCODER_BIN_SHA256 must pin the supplied source-bound CLI bytes');
  const binary = await requireExecutable(binaryPath, 'source-bound task lifecycle CLI');
  const binaryHasher = createHash('sha256');
  for await (const chunk of createReadStream(binary)) binaryHasher.update(chunk);
  const binarySha = binaryHasher.digest('hex');
  assert.equal(binarySha, expectedBinarySha, 'the source-bound CLI must match its supplied SHA-256 pin');

  const fixture = await startApprovalModelFixture(context, {
    textOnly: true,
    textOnlyResponse: () => replyMarker,
  });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', {
    instanceId: 'task-pin-search-archive-restore',
  });
  const home = context.pathInState('home');
  const temporaryDirectory = context.pathInState('tmp');
  const configDir = context.pathInState('config');
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(temporaryDirectory, { recursive: true, mode: 0o700 }),
    mkdir(configDir, { recursive: true, mode: 0o700 }),
  ]);
  const settingsFile = await context.writeStateJson('config/settings.json', {
    active_provider: 'b24-scripted-fixture',
    max_retries: 0,
    providers: {
      'b24-scripted-fixture': {
        api_format: 'openai_chat_completions',
        authentication: { mode: 'none' },
        endpoint: fixture.baseUrl,
        default_model: 'b24-scripted-fixture',
        context_window_tokens: 128000,
        output_headroom_tokens: 256,
        max_output_tokens: 256,
        request_timeout_secs: 60,
        no_proxy: true,
        discover_models: false,
      },
    },
  });
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local',
    label: 'B24 owned workspace',
    transport: 'local',
    command: binary,
    workspace,
    settingsFile,
  }]);
  const gatewayEnvironment = {
    HOME: home,
    USERPROFILE: home,
    KCODER_HOME: home,
    KCODER_CONFIG_DIR: configDir,
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
  };
  const gatewayOptions = {
    workspace,
    serversFile,
    kcoderBin: binary,
    env: gatewayEnvironment,
    startTimeoutMs: 300_000,
  };

  const firstGatewayLabel = 'b24-task-lifecycle-gateway-first';
  const firstGateway = await startGateway(context, {
    ...gatewayOptions,
    label: firstGatewayLabel,
  });
  const first = await openRuntimeRpc(context, firstGateway, 'b24-task-lifecycle-first');
  const started = await first.request('thread/start', {});
  const threadId = started.thread?.id;
  assert.ok(threadId, 'the owned app-server must create the task thread');
  const taskId = `kcoder:local:${threadId}`;
  const turn = await first.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: promptMarker }],
  });
  await first.waitFor(
    message => message.method === 'turn/completed'
      && message.params?.threadId === threadId
      && message.params?.turnId === turn.turn?.id,
    30_000,
    'B24 scripted task completion',
  );
  await first.request('thread/metadata/update', { threadId, title });
  assert.equal(fixture.requests.length, 1, 'seeding the successful task must make one scripted Provider request');
  await first.close();
  await waitFor(
    () => first.socket.readyState === first.socket.constructor.CLOSED,
    5_000,
    'seed Gateway RPC closed before the browser attaches to the original thread',
    50,
    context.abortSignal,
  );

  const browser = await startChromium(context, { label: 'b24-task-lifecycle-chromium' });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  context.addCleanup('close B24 task lifecycle browser page', () => page.close());
  const pageErrors = [];
  const consoleErrors = [];
  const failedResponses = [];
  page.on('pageerror', error => pageErrors.push(context.redactText(error.message)));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(context.redactText(message.text().slice(0, 1000)));
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      failedResponses.push({
        status: response.status(),
        method: response.request().method(),
        resourceType: response.request().resourceType(),
        url: context.redactText(response.url()).slice(0, 1000),
      });
    }
  });

  let stage = 'initial-open';
  try {
    await page.goto(firstGateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('project-item-button').first().waitFor({ state: 'visible', timeout: 30_000 });
    for (const projectButton of await page.getByTestId('project-item-button').all()) {
      if (await projectButton.getAttribute('aria-expanded') !== 'true') await projectButton.click();
    }

    const rowId = `runtime-local-task-row-${taskId}`;
    const row = page.getByTestId(rowId);
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    stage = 'pin-task';
    await row.hover();
    const pinButton = page.getByTestId(`runtime-local-task-mark-${taskId}`);
    await pinButton.waitFor({ state: 'visible', timeout: 5_000 });
    await pinButton.click();
    const pinnedWorkspaceState = await waitFor(async () => {
      const response = await localRuntimeRequest(page, 'runtime.tasks.list', {});
      return hasPinnedTask(response, taskId, workspace) ? response : null;
    }, 15_000, 'the original task pinned in its workspace list', 100, context.abortSignal);
    assertTaskPinned(pinnedWorkspaceState, taskId, workspace);
    const pinnedRow = page.getByTestId('sidebar-pinned-section').getByTestId(rowId);
    await pinnedRow.waitFor({ state: 'visible', timeout: 15_000 });

    stage = 'search-and-reopen';
    await searchAndOpen(page, title, promptMarker, replyMarker);
    assertSearchAddress(await localRuntimeRequest(page, 'runtime.tasks.search', { query: promptMarker, limit: 20 }), {
      deviceId: 'local',
      taskId,
      threadId,
      workspacePath: workspace,
    });

    stage = 'archive-task';
    await pinnedRow.hover();
    const archiveButton = pinnedRow.getByTestId(`runtime-local-task-archive-${taskId}`);
    await archiveButton.waitFor({ state: 'visible', timeout: 5_000 });
    await archiveButton.click();
    stage = 'search-archive-and-restore';
    const archivedTasks = await waitFor(async () => {
      const response = await localRuntimeRequest(page, 'runtime.archived_conversations.list', {
        deviceId: 'local',
        workspacePath: workspace,
        search: title,
        source: 'local',
      });
      return response.items?.some(item => item.threadId === threadId && item.taskId === taskId)
        ? response
        : null;
    }, 30_000, 'the original task in the archived conversations list', 100, context.abortSignal);
    const archivedTask = archivedTasks.items.find(item => item.threadId === threadId && item.taskId === taskId);
    assert.equal(archivedTask.title, title);
    assert.equal(archivedTask.workspacePath, workspace);

    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-menu-button').click();
    await page.getByTestId('settings-category-archived').click();
    await page.getByTestId('archived-search-input').fill(title);
    const archivedOpen = page.locator('[data-testid^="archived-open-button-"]').filter({ hasText: title });
    await archivedOpen.waitFor({ state: 'visible', timeout: 30_000 });
    await archivedOpen.click();
    const preview = page.getByTestId('archived-preview');
    await preview.getByText(promptMarker, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    await preview.getByText(replyMarker, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('archived-preview-close').click();
    await archivedOpen.waitFor({ state: 'visible' });
    await page.locator('[data-testid^="archived-unarchive-button-"]').click();
    await archivedOpen.waitFor({ state: 'detached', timeout: 30_000 });
    const restoredTasks = await waitFor(async () => {
      const response = await localRuntimeRequest(page, 'runtime.tasks.list', {});
      return hasPinnedTask(response, taskId, workspace) ? response : null;
    }, 30_000, 'the original restored task in the active pinned workspace list', 100, context.abortSignal);
    assertTaskPinned(restoredTasks, taskId, workspace);

    stage = 'normal-reopen-after-restore';
    await page.goto(firstGateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible', timeout: 30_000 });
    await searchAndOpen(page, title, promptMarker, replyMarker);
    assertTaskPinned(await localRuntimeRequest(page, 'runtime.tasks.list', {}), taskId, workspace);

    stage = 'reconstruct-gateway-and-app-server';
    await page.goto('about:blank');
    await context.stopOwned(firstGatewayLabel);

    const secondGatewayLabel = 'b24-task-lifecycle-gateway-reconstructed';
    const secondGateway = await startGateway(context, {
      ...gatewayOptions,
      label: secondGatewayLabel,
    });
    const second = await openRuntimeRpc(context, secondGateway, 'b24-task-lifecycle-reconstructed');
    const listed = await second.request('thread/list', { archived: false, limit: 100 });
    const discoveredThread = listed.threads?.find(thread => thread.id === threadId);
    assert.ok(discoveredThread, 'a new Gateway/app-server process must discover the original active thread');
    const history = await second.request('thread/read', { threadId, limit: 100 });
    const historyJson = JSON.stringify(history.messages ?? []);
    assert.ok(historyJson.includes(promptMarker), 'the original user message must remain readable after reconstruction');
    assert.ok(historyJson.includes(replyMarker), 'the original assistant reply must remain readable after reconstruction');
    assert.ok((await pinnedTaskIds(second)).includes(threadId), 'the reconstructed app-server must retain the pinned task ID');
    await second.close();
    await waitFor(
      () => second.socket.readyState === second.socket.constructor.CLOSED,
      5_000,
      'reconstructed Gateway RPC closed before the browser reopens the original thread',
      50,
      context.abortSignal,
    );

    stage = 'browser-search-after-reconstruction';
    await page.goto(secondGateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('sidebar-pinned-section').getByTestId(rowId).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    await searchAndOpen(page, title, promptMarker, replyMarker);
    assertSearchAddress(await localRuntimeRequest(page, 'runtime.tasks.search', { query: promptMarker, limit: 20 }), {
      deviceId: 'local',
      taskId,
      threadId,
      workspacePath: workspace,
    });
    assertTaskPinned(await localRuntimeRequest(page, 'runtime.tasks.list', {}), taskId, workspace);
    const ownedGatewayOrigins = new Set([firstGateway.baseUrl, secondGateway.baseUrl].map(value => new URL(value).origin));
    const expectedAdminDenials = failedResponses.filter(response => {
      try {
        const url = new URL(response.url);
        return response.status === 403
          && response.method === 'GET'
          && response.resourceType === 'fetch'
          && ownedGatewayOrigins.has(url.origin)
          && expectedAdminDenialPaths.has(url.pathname);
      } catch {
        return false;
      }
    });
    assert.equal(
      expectedAdminDenials.length,
      failedResponses.length,
      'only the isolated profile’s unauthenticated admin endpoints may return HTTP 403',
    );
    assert.deepEqual(pageErrors, [], 'the browser page must not report JavaScript errors');
    assert.ok(
      consoleErrors.every(error => error === expectedForbiddenResourceError),
      'the browser console must not report errors beyond the explicitly denied admin resource requests',
    );
    assert.equal(
      consoleErrors.length,
      expectedAdminDenials.length,
      'every expected admin denial must have exactly one matching browser resource error',
    );
    assert.equal(fixture.requests.length, 1, 'search, archive, restore and reconstruction must not call the Provider again');

    await context.writeArtifactJson('task-pin-search-archive-restore.json', {
      cliSha256: binarySha,
      taskId,
      threadId,
      deviceId: 'local',
      workspacePath: workspace,
      pinVisibleBeforeAndAfterGatewayReconstruction: true,
      transcriptSearchAndNormalReopen: true,
      archivePreviewAndRestore: true,
      discoveredAfterNewGatewayAndAppServer: true,
      transcriptReadAfterReconstruction: true,
      providerRequestCount: fixture.requests.length,
      pageErrors,
      consoleErrors,
      expectedAdminDenials,
      failedResponses,
    });
    return {
      taskId,
      threadId,
      pinVisibleBeforeAndAfterGatewayReconstruction: true,
      transcriptSearchAndNormalReopen: true,
      archivePreviewAndRestore: true,
      discoveredAfterNewGatewayAndAppServer: true,
      providerRequestCount: fixture.requests.length,
    };
  } catch (error) {
    await context.writeArtifactJson('task-pin-search-archive-restore-failure.json', {
      stage,
      error: context.redactText(error instanceof Error ? error.message : String(error)),
      taskId,
      threadId,
      pageErrors,
      consoleErrors,
      failedResponses,
      providerRequestCount: fixture.requests.length,
    });
    await page.screenshot({ path: context.pathInArtifacts('task-pin-search-archive-restore-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await page.close();
  }
});

async function openRuntimeRpc(context, gateway, label) {
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token), { timeoutMs: 60_000 });
  context.addCleanup(`close ${label} RPC`, () => rpc.close());
  await initializeRpc(rpc, label);
  return rpc;
}

async function pinnedTaskIds(rpc) {
  const response = await rpc.request('runtime.workspaces.list', {});
  assert.ok(Array.isArray(response.pinnedTaskIds), 'the current target must return its pinned task IDs');
  return response.pinnedTaskIds;
}

async function localRuntimeRequest(page, method, params) {
  return page.evaluate(
    ({ requestMethod, requestParams }) => window.__KCODER_STUDIO_E2E__.invokeRuntimeCommand('local_executor_request', {
      method: requestMethod,
      params: requestParams,
    }),
    { requestMethod: method, requestParams: params },
  );
}

function assertSearchAddress(response, expected) {
  assert.equal(response.items?.length, 1, 'the unique transcript marker must return one task');
  const address = response.items[0].address;
  assert.deepEqual({
    deviceId: address.deviceId,
    taskId: address.taskId,
    threadId: address.threadId,
    workspacePath: address.workspacePath,
  }, expected, 'search must retain the original task target and workspace ownership');
}

function assertTaskPinned(response, taskId, workspacePath) {
  const workspace = response.workspaces?.find(item =>
    item.deviceId === 'local' && item.workspacePath === workspacePath
  );
  assert.ok(workspace, 'the original target/workspace must remain in the task list');
  const task = workspace.tasks?.find(item => item.taskId === taskId);
  assert.ok(task, 'the original task must remain in the original target/workspace');
  assert.equal(task.pinned, true, 'the original task must remain pinned');
}

function hasPinnedTask(response, taskId, workspacePath) {
  return Boolean(response.workspaces?.some(item =>
    item.deviceId === 'local'
      && item.workspacePath === workspacePath
      && item.tasks?.some(task => task.taskId === taskId && task.pinned === true)
  ));
}

async function searchAndOpen(page, expectedTitle, prompt, reply) {
  await page.getByTestId('runtime-search-button').click();
  const input = page.getByTestId('workbench-search-input');
  await input.waitFor({ state: 'visible' });
  await input.fill(prompt);
  const result = page.getByTestId('workbench-search-result-0');
  await result.waitFor({ state: 'visible', timeout: 30_000 });
  assert.ok((await result.innerText()).includes(prompt), 'search result must identify the matching transcript content');
  await result.click();
  await page.getByTestId('workbench-search-overlay').waitFor({ state: 'detached' });
  await page.getByTestId('workbench-pane-task-title').getByText(expectedTitle, { exact: true }).waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  await page.getByTestId('message-user').filter({ hasText: prompt }).waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('message-assistant').filter({ hasText: reply }).waitFor({ state: 'visible', timeout: 30_000 });
}
