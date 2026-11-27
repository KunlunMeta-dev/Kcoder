import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { get } from 'node:http';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { loadavg } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { observeAuthReads } from '../../harness/auth-read-cost.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { fillComposerText, readComposerDiagnostics } from '../../harness/composer-input.mjs';
import { createChromiumLauncher } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { openPageGatewayRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { gatewayRequestCounts, observeGatewayRequests, createModelCatalogReadSampler, summarizeReadDomains } from '../../harness/gateway-request-counts.mjs';
import { freezeLargeHistoryRenderer, hashHistoryFile } from '../../harness/migration-large-history.mjs';
import { waitForSelectedModel } from '../../harness/model-selector.mjs';
import { observeNavigationSockets } from '../../harness/navigation-socket-diagnostics.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

const environmentSummaryCommands = ['git_branch', 'git_branch_diff_shortstat'];
const environmentCommands = [...environmentSummaryCommands, 'git_remote_url'];
const messageReadMethods = ['thread/agentMessage/policy/read', 'thread/agentMessage/targets'];
const isHomeNavigationPhase = name => name === 'startup' || /^reload-home(?:-sample-[23])?$/.test(name);

await runE2E(import.meta.url, { testId: 'desktop-request-cost', tier: 'full-integration',
  modelPolicy: 'Actual authenticated desktop renderer/Gateway/Rust with gated loopback SSE and real browser tab visibility. Content-free HTTP/RPC counts, not live-provider or installed-platform latency.' }, async context => {
  const hostLoadBefore = loadavg();
  assert.equal(process.platform, 'linux', 'UNMET_PREREQUISITE: owned Linux display');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'Native app-server');
  const sourceBuild = process.env.KCODER_E2E_RENDERER_ROOT || resolve(repoRoot, 'apps/kcoder-studio/renderer/dist');
  const freshness = await assertRendererBuildFresh({ buildRoot: sourceBuild });
  const renderer = await freezeLargeHistoryRenderer(context, sourceBuild, context.pathInState('renderer'));
  const binarySha = await hashHistoryFile(binary);
  if (process.env.KCODER_E2E_KCODER_BIN_SHA256) assert.equal(binarySha, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  if (process.env.KCODER_TARGET_DIR) {
    const library = resolve(process.env.KCODER_TARGET_DIR, 'debug/libkcoder_native_storage.so');
    await context.writeArtifactJson('native-storage-resource.json', { library, sha256: await hashHistoryFile(library) });
  }
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'desktop-request-cost' });
  const profile = context.pathInState('profile'), data = context.pathInState('gateway-data');
  await Promise.all([profile, data].map(path => mkdir(path, { mode: 0o700 })));
  let streaming = false, finish = false, startedAt = 0;
  const model = await startApprovalModelFixture(context, { responseSteps: ({ requestNumber, body }) => {
    if (requestNumber === 2) {
      assert.ok(body.tools?.some(tool => tool.function?.name === 'read'), 'owned tool turn must advertise read');
      return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'owned-metadata-read', type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ file_path: 'README.md' }) } }] } },
      { finishReason: 'tool_calls' }];
    }
    if (requestNumber === 3) {
      assert.ok(body.messages?.some(message => message.role === 'tool' &&
        typeof message.content === 'string' && message.content.includes('KCoder E2E')),
      'owned file read must actually return its fixture content before the follow-up');
      const readyAt = performance.now() + 2000;
      return [{ delta: { role: 'assistant', content: 'TOOL_METADATA_COMPLETE' } },
        { ready: () => performance.now() >= readyAt, finishReason: 'stop' }];
    }
    assert.equal(requestNumber, 1, 'bounded plain turn plus one owned tool round trip');
    return [
    ...Array.from({ length: 72 }, (_, index) => ({
      ready: () => streaming && performance.now() >= startedAt + index * 500,
      delta: { ...(index === 0 ? { role: 'assistant', reasoning_content: 'Inspecting the owned fixture.' } : {}), content: index === 71
        ? 'DESKTOP_COST_LAST\n\nInline $x^2$ and display:\n\n$$\nx^3\n$$\n\n```mermaid\ngraph TD\n  A[First] --> B[Second]\n```\n\n```ts\nconst syntaxReady = 42\n```\n\n```md\n# Wrapped code source\n```' : 'sample ' },
    })), { ready: () => finish, finishReason: 'stop' },
  ]; } });
  const settings = await context.writeStateJson('models.json', { active_provider: 'fixture', credential_store: 'file',
    max_retries: 0, max_tokens: 512, permission_mode: 'yolo', allowed_tools: ['read'],
    tools: { profile: 'nano', disabled: [] }, session_memory: { enabled: false },
    integrations: { office: { enabled: false }, connectivity: { enabled: false }, services: { enabled: false } },
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      authentication: { mode: 'none' }, default_model: 'fixture', discover_models: false, no_proxy: true,
      context_window_tokens: 128000, output_headroom_tokens: 1024, max_output_tokens: 512, request_timeout_secs: 90 } } });
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Desktop cost target', transport: 'local',
    command: binary, workspace: workspace.path, settingsFile: settings }]);
  const gateway = await startGateway(context, { auth: true, workspace: workspace.path, serversFile: servers, kcoderBin: binary,
    passEnv: ['KCODER_TARGET_DIR'],
    env: { KCODER_CONFIG_DIR: profile, KCODER_HOME: profile, KCODER_STUDIO_DATA_DIR: data,
      KCODER_STUDIO_WEB_ROOT: renderer.root, KCODER_E2E_AUTH_OBSERVE: '1' } });
  const authCounts = observeAuthReads(context, gateway.child.stdout);
  const html = await readFile(resolve(renderer.root, 'index.html'), 'utf8');
  const mainScripts = [...html.matchAll(/<script\b([^>]*)>/g)].filter(([, attrs]) =>
    /\btype=["']module["']/.test(attrs) && !/\basync(?:\s|=|$)/.test(attrs));
  assert.equal(mainScripts.length, 1, 'the frozen HTML must identify one main module entry');
  const mainSrc = mainScripts[0][1].match(/\bsrc=["']([^"']+)["']/);
  assert.ok(mainSrc, 'the main module must reference an owned resource');
  const initialEntry = new URL(mainSrc[1], gateway.baseUrl);
  assert.equal(initialEntry.origin, gateway.baseUrl);
  assert.match(initialEntry.pathname, /^\/assets\/[A-Za-z0-9_.-]+\.js$/);
  const display = await startOwnedDisplay(context);
  // Playwright otherwise forces every attached page visible, even in a background tab.
  const launch = createChromiumLauncher({ chromiumDriver: {
    connectOverCDP: (endpoint, options) => chromium.connectOverCDP(endpoint, { ...options, noDefaults: true }),
  } });
  const browser = await launch(context, { label: 'desktop-cost-browser', headless: false, display: display.display,
    env: { XAUTHORITY: display.authority } });
  const page = await browser.newPersistentPage(); await page.setViewportSize({ width: 1280, height: 800 });
  const [cover] = await Promise.all([page.waitForEvent('popup', { timeout: 5000 }),
    page.evaluate(() => { window.open('about:blank', '_blank'); })]);
  await cover.bringToFront();
  await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 5000 }).toBe('hidden');
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 5000 }).toBe('visible');
  await context.writeArtifactJson('visibility-preflight.json', { headless: false, playwrightDefaultOverrides: false,
    backgroundHidden: true, foregroundVisible: true });
  const phases = [], counts = { turnStarts: 0, completions: 0, deltas: 0, wsOpened: 0, wsClosed: 0 };
  const betweenPhases = { name: 'between-phases', status: 'observed', ...gatewayRequestCounts(), rpc: {}, rpcRequests: {}, notifications: {}, commands: {} };
  const initialAuth = authCounts();
  const workspacePanelAsset = /\/(?:FileWorkspacePanel|EmbeddedLocalTerminal|RemoteTerminal|SshTerminalPane|FileChangesReviewPanel)-/;
  const sockets = [];
  const goalReadTargets = new Map();
  const sampleModelCatalogRead = createModelCatalogReadSampler();
  let current = null, threadId, terminalStatus, verified = false;
  const bump = (group, key) => { const phase = current ?? betweenPhases; phase[group][key] = (phase[group][key] || 0) + 1; };
  const { validate: validateRequests, directoryReads } = await observeGatewayRequests(context, page, gateway.baseUrl, () => current ?? betweenPhases);
  const navigationSockets = await observeNavigationSockets(page, { gatewayBaseUrl: gateway.baseUrl,
    workspacePath: workspace.path, getPhase: () => current?.name ?? null });
  context.addCleanup('detach navigation socket diagnostics', () => navigationSockets.stop());
  page.on('websocket', socket => {
    counts.wsOpened++;
    const observation = sockets.length < 256
      ? { ordinal: counts.wsOpened, openedIn: current?.name ?? null, closedIn: null, closed: false, rpc: {}, notifications: {},
        registryReplies: { completed: 0, failed: 0 }, taskObservationReplies: { completed: 0, failed: 0 },
        agentMessageReplies: { completed: 0, failed: 0 }, mcpDirectoryReplies: { completed: 0, failed: 0 },
        composerCatalogReplies: { completed: 0, failed: 0 },
        historyReplies: { completed: 0, failed: 0 }, environmentReplies: { completed: 0, failed: 0 },
        transcriptReplies: { completed: 0, failed: 0 }, viewAttachmentReplies: { completed: 0, failed: 0 },
        goalReplies: { completed: 0, failed: 0 }, expertCatalogReplies: { completed: 0, failed: 0 },
        storageReplies: { completed: 0, failed: 0 }, providerReplies: { completed: 0, failed: 0 },
        templateReplies: { completed: 0, failed: 0 }, toolSelectionReplies: { completed: 0, failed: 0 },
        automationReplies: { completed: 0, failed: 0 },
        workflowCatalogReplies: { completed: 0, failed: 0 },
        workspaceSearchReplies: { completed: 0, failed: 0 },
        workListReplies: { completed: 0, failed: 0 },
        clockReplies: { completed: 0, failed: 0 }, historySourceReplies: { completed: 0, failed: 0 },
        modelReplies: { completed: 0, failed: 0 }, modelCatalogReads: [], modelCatalogOverflow: 0,
        toolCatalogTimeline: [], toolCatalogOverflow: 0,
        receiptReplies: { completed: 0, failed: 0 }, receiptTimeline: [], receiptOverflow: 0,
        historyTimeline: [], historyOverflow: 0, workActivityTimeline: [], workActivityOverflow: 0 } : null;
    if (observation) sockets.push(observation);
    const observedReads = new Map();
    const receiptEvent = (event, status = null) => {
      if (!observation) return;
      if (observation.receiptTimeline.length >= 128) { observation.receiptOverflow++; return; }
      observation.receiptTimeline.push({ event, status, phase: current?.name ?? null, atMs: performance.now() });
    };
    const workActivity = event => {
      if (!observation) return;
      if (observation.workActivityTimeline.length >= 128) { observation.workActivityOverflow++; return; }
      observation.workActivityTimeline.push({ event, phase: current?.name ?? null, atMs: performance.now() });
    };
    socket.on('close', () => { workActivity('socket-closed'); counts.wsClosed++; if (observation) {
      observation.closed = true; observation.closedIn = current?.name ?? null;
    } });
    for (const [event, group] of [['framesent', 'rpc'], ['framereceived', 'notifications']]) socket.on(event, frame => {
      let value; try { value = JSON.parse(String(frame.payload)); } catch { return; }
      if (observation && event === 'framereceived' && value?.method === undefined && observedReads.has(value?.id)) {
        const read = observedReads.get(value.id); observedReads.delete(value.id);
        const outcome = Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error') &&
          (read.group !== 'environmentReplies' || value.result?.success === true) ? 'completed' : 'failed';
        observation[read.group][outcome]++;
        if (read.phase) (read.phase.replies[read.group] ??= { completed: 0, failed: 0 })[outcome]++;
        if (read.group === 'automationReplies' && read.phase && value.error?.code === -32602)
          read.phase.automationInvalidParams = (read.phase.automationInvalidParams || 0) + 1;
        if (read.group === 'workspaceSearchReplies' && read.phase && outcome === 'completed' &&
          value.result?.files?.some(file => file.fileName === 'README.md')) read.phase.workspaceReadmeFound = true;
        if (read.catalogRead) Object.assign(read.catalogRead, { completedAtMs: performance.now(), outcome });
        if (read.historyRead) Object.assign(read.historyRead, { completedAtMs: performance.now(), outcome });
        if (read.group === 'receiptReplies') receiptEvent('reply',
          ['running', 'completed', 'failed', 'interrupted'].includes(value.result?.receipt?.status)
            ? value.result.receipt.status : outcome === 'failed' ? 'error' : 'missing');
      }
      if (typeof value?.method !== 'string' || !/^[A-Za-z0-9_./-]{1,128}$/.test(value.method)) return;
      if (observation && event === 'framesent') {
        const group = ['runtime.workspaces.list', 'runtime.worktrees.list'].includes(value.method) ? 'registryReplies'
          : ['thread/list', 'thread/goal/status/readMany'].includes(value.method) ? 'historyReplies'
            : value.method === 'gateway/thread/attach' ? 'viewAttachmentReplies'
            : value.method === 'thread/read/indexed' ? 'transcriptReplies'
            : value.method === 'thread/goal/get' ? 'goalReplies'
            : value.method === 'integrations/assistant/list' ? 'expertCatalogReplies'
            : value.method === 'mcp/list' ? 'mcpDirectoryReplies'
            : ['skills/list', 'plugin/list'].includes(value.method) ? 'composerCatalogReplies'
            : ['thread/expert', 'agent/list', 'tools/catalog'].includes(value.method) ? 'taskObservationReplies'
            : messageReadMethods.includes(value.method) ? 'agentMessageReplies'
            : value.method === 'workflow/storage/read' ? 'storageReplies'
              : value.method === 'runtime.providers.list' ? 'providerReplies'
                : value.method === 'settings/templates/list' ? 'templateReplies'
                  : value.method === 'cron/list' ? 'automationReplies'
                  : value.method === 'workflow/list' ? 'workflowCatalogReplies'
                  : value.method === 'runtime.workspace.search' ? 'workspaceSearchReplies'
                  : value.method === 'work/list' ? 'workListReplies'
                  : value.method === 'settings/tools/selection/read' ? 'toolSelectionReplies'
                    : value.method === 'server/resources/read' ? 'clockReplies'
                      : value.method === 'migration/history/continuation/source' ? 'historySourceReplies'
                        : value.method === 'turn/receipt/read' ? 'receiptReplies'
                          : value.method === 'runtime.models.list' ? 'modelReplies'
                            : value.method === 'device/execute' && environmentCommands.includes(value.params?.command_key)
                              ? 'environmentReplies' : null;
        if (group) observedReads.set(value.id, { group, phase: current });
        if (group === 'historyReplies' || value.method === 'agent/list') {
          if (observation.historyTimeline.length >= 128) observation.historyOverflow++;
          else {
            const read = { method: value.method, phase: current?.name ?? null, atMs: performance.now(), outcome: 'pending' };
            observation.historyTimeline.push(read); observedReads.get(value.id).historyRead = read;
          }
        }
        if (group === 'goalReplies') {
          if (!goalReadTargets.has(observation)) goalReadTargets.set(observation, new Set());
          goalReadTargets.get(observation).add(value.params?.threadId);
        }
        if (value.method === 'runtime.models.list') {
          if (observation.modelCatalogReads.length >= 32) observation.modelCatalogOverflow++;
          else {
            const scope = sampleModelCatalogRead(value.params);
            if (!scope) observation.modelCatalogOverflow++;
            else {
              const read = { phase: current?.name ?? null, atMs: performance.now(), ...scope };
              observation.modelCatalogReads.push(read);
              observedReads.get(value.id).catalogRead = read;
            }
          }
        }
      }
      const toolLifecycle = event === 'framesent' && value.method === 'tools/catalog' ? 'catalog-read'
        : event === 'framereceived' && value.params?.threadId === threadId
          ? value.method === 'turn/started' ? 'turn-started'
            : value.method === 'turn/completed' ? 'turn-completed'
              : value.method === 'item/event' && value.params?.event?.type === 'tool_input_progress' ? 'tool-input-progress'
                : value.params?.item?.type === 'toolCall' && value.method === 'item/started' ? 'tool-started'
                  : value.params?.item?.type === 'toolCall' && value.method === 'item/completed' ? 'tool-completed' : null
          : null;
      if (event === 'framereceived' && value.method === 'gateway/runtimeActivity/changed')
        workActivity('gateway-invalidation');
      if (toolLifecycle === 'turn-started' || toolLifecycle === 'turn-completed') workActivity(toolLifecycle);
      if (observation && toolLifecycle) {
        if (observation.toolCatalogTimeline.length >= 128) observation.toolCatalogOverflow++;
        else observation.toolCatalogTimeline.push({ event: toolLifecycle, phase: current?.name ?? null, atMs: performance.now() });
      }
      if (observation) observation[group][value.method] = (observation[group][value.method] || 0) + 1;
      bump(group, value.method);
      if (event === 'framesent' && value.id != null) bump('rpcRequests', value.method);
      if (event === 'framesent' && value.method === 'runtime.providers.list' && current) {
        const reads = current.providerReadScopes ??= { original: 0, unscoped: 0, other: 0 };
        const scope = value.params?.threadId;
        reads[scope ? scope === threadId ? 'original' : 'other' : 'unscoped']++;
      }
      if (event === 'framesent' && value.method === 'turn/receipt/read') receiptEvent('read');
      if (event === 'framesent' && value.method === 'device/execute' &&
        ['git_branch', 'git_branch_diff_shortstat', 'git_remote_url', 'git_is_worktree', 'git_status_porcelain'].includes(value.params?.command_key))
        bump('commands', value.params.command_key);
      if (event === 'framesent' && value.method === 'turn/start') { counts.turnStarts++; threadId = value.params?.threadId; }
      if (event === 'framereceived' && value.params?.threadId === threadId) {
        if (value.method === 'turn/started') receiptEvent('turn-started');
        if (value.method === 'turn/completed') receiptEvent('turn-completed');
        if (value.method === 'turn/completed') { terminalStatus = value.params.turn.status; counts.completions++; }
        if (value.method === 'item/delta') counts.deltas++;
      }
    });
  });
  async function phase(name, operation) {
    const before = authCounts(), beforeCounts = { ...counts };
    const value = { name, status: 'failed', startMs: performance.now(), ...gatewayRequestCounts(), rpc: {}, rpcRequests: {}, replies: {}, notifications: {}, commands: {} };
    phases.push(value); current = value;
    try { await operation(); validateRequests(); value.status = 'passed'; }
    finally {
      value.durationMs = performance.now() - value.startMs;
      const after = authCounts(); value.auth = Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
      value.transport = Object.fromEntries(Object.keys(counts).map(key => [key, counts[key] - beforeCounts[key]])); current = null;
      await context.writeArtifactJson(`phases/${name}.json`, value);
    }
  }
  const pause = ms => delay(ms, undefined, { signal: context.abortSignal });
  async function measureHomeReady(kind, originMs = 0) {
    await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible', timeout: 90000 });
    const sidebarMs = await page.evaluate(() => performance.now()) - originMs;
    await expect(page.getByTestId('chat-message-input')).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId('chat-message-input')).toBeEditable({ timeout: 60000 });
    await expect(page.getByTestId('model-selector-button')).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId('model-selector-button')).toBeEnabled({ timeout: 60000 });
    const composerEditableMs = await page.evaluate(() => performance.now()) - originMs;
    assert.ok(sidebarMs >= 0 && composerEditableMs >= sidebarMs);
    current.firstScreen = { kind, sidebarMs, composerEditableMs,
      boundary: 'Observed visible sidebar, editable composer and enabled model chooser; before networkidle' };
  }
  const waitForDirectoryReplies = () => waitFor(() => sockets.every(socket =>
    socket.historyReplies.completed + socket.historyReplies.failed ===
      (socket.rpc['thread/list'] || 0) + (socket.rpc['thread/goal/status/readMany'] || 0) &&
    socket.registryReplies.completed + socket.registryReplies.failed ===
      (socket.rpc['runtime.workspaces.list'] || 0) + (socket.rpc['runtime.worktrees.list'] || 0)),
  15000, 'workspace registry, history and batch Goal Native replies', 50, context.abortSignal);
  const waitForHomeDirectory = async () => {
    await waitFor(() => sockets.some(socket => socket.openedIn === current.name && socket.rpc['thread/list'] > 0),
      15000, 'current document initial history request', 50, context.abortSignal);
    await waitForDirectoryReplies();
  };
  async function resumeWithHeldChannelRead() {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const requests = new Set(), responses = [];
    const routePath = url => url.origin === gateway.baseUrl && url.pathname === '/api/channels';
    const hold = async route => { requests.add(route.request()); await held; await route.continue(); };
    const receive = response => { if (requests.has(response.request())) responses.push(response); };
    await cover.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
    page.on('response', receive);
    await page.route(routePath, hold);
    try {
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
      await waitFor(() => (current.http['GET /api/channels'] || 0) === 1,
        10000, 'owned channel observers waiting on their real HTTP reads', 20, context.abortSignal);
      // Hold transport to cover overlapping foreground hints without replacing Gateway responses.
      await page.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });
      release();
      await waitFor(() => responses.length === 1,
        10000, 'original channel reads receiving actual Gateway responses', 20, context.abortSignal);
      for (const response of responses) {
        assert.equal(response.status(), 200);
        assert.equal(await response.finished(), null);
      }
      // networkidle may already have been reached before the intercepted request was released.
      await pause(600);
      await page.waitForLoadState('networkidle');
      assert.equal(current.http['GET /api/channels'], 1,
        'foreground hints and independent observers must share one unfinished Gateway inventory read');
    } finally {
      release();
      page.off('response', receive);
      await page.unroute(routePath, hold);
    }
  }
  try {
    await phase('startup', async () => {
      let release, held = false, routeFailure;
      const ready = new Promise(resolve => { release = resolve; });
      const script = url => url.origin === initialEntry.origin && url.pathname === initialEntry.pathname;
      const hold = async route => {
        held = true;
        await ready;
        await route.continue().catch(error => { routeFailure = error; });
      };
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.route(script, hold);
      try {
        await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
        await page.locator('input[name="token"]').fill(gateway.authToken);
        await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 60000, waitUntil: 'commit' }),
          page.locator('button[type="submit"]').click({ noWaitAfter: true })]);
        await waitFor(() => held, 15000, 'owned initial workbench script held', 20, context.abortSignal);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expect(page.locator('#kcoder-boot-loading')).toBeVisible();
        await expect(page.locator('#kcoder-boot-loading')).toHaveCSS('background-color', 'rgb(17, 19, 22)');
        await expect(page.getByTestId('desktop-sidebar')).toHaveCount(0);
        current.bootIsolation = { workbenchHeld: true, themeRestored: true, placeholderVisible: true, workbenchNotMounted: true };
        const entryReleasedAtMs = await page.evaluate(() => performance.now());
        release();
        await measureHomeReady('cold-entry-release', entryReleasedAtMs);
        await page.getByTestId('project-item').filter({ hasText: 'Desktop cost target' }).first().waitFor({ state: 'visible', timeout: 60000 });
        await page.waitForLoadState('networkidle');
        await waitForHomeDirectory();
        if (routeFailure) throw routeFailure;
      } finally {
        release();
        await page.unroute(script, hold);
        await page.emulateMedia({ colorScheme: null });
      }
    });
    assert.equal(phases[0].http['GET /api/experience/conversations'], 1,
      'a participating startup reads its current Gateway capability once');
    await phase('compiled-asset-wire', async () => {
      const entry = initialEntry;
      assert.ok(phases.find(sample => sample.name === 'startup').assets[entry.pathname],
        'wire compression checks use the actual initial module from the frozen HTML');
      assert.equal(entry.origin, gateway.baseUrl);
      assert.match(entry.pathname, /^\/assets\/[A-Za-z0-9_.-]+\.js$/);
      const cookie = (await page.context().cookies(gateway.baseUrl))
        .filter(value => value.name === 'kcoder_studio_session').map(value => `${value.name}=${value.value}`).join('; ');
      assert.ok(cookie); context.registerSecret(cookie);
      const raw = encoding => new Promise((resolve, reject) => {
        get(entry, { headers: { Cookie: cookie, 'accept-encoding': encoding }, signal: context.abortSignal }, response => {
          const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
      });
      const plain = await raw('identity'), gzip = await raw('gzip');
      assert.equal(plain.status, 200); assert.equal(gzip.status, 200);
      assert.equal(gzip.headers['content-encoding'], 'gzip');
      assert.deepEqual(gunzipSync(gzip.body), plain.body);
      assert.ok(gzip.body.length < plain.body.length);
      current.compiledAsset = { path: entry.pathname, sha256: createHash('sha256').update(plain.body).digest('hex'),
        identityBytes: plain.body.length, gzipBytes: gzip.body.length };
    });
    for (const name of ['reload-home', 'reload-home-sample-2', 'reload-home-sample-3']) {
      await phase(name, async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await measureHomeReady('warm-navigation');
        await page.waitForLoadState('networkidle');
        await waitForHomeDirectory();
      });
    }
    assert.ok(phases[0].firstSeenGatewayResponses.script > 0, 'resource observation must see actual Gateway response identities');
    for (const sample of phases.filter(sample => isHomeNavigationPhase(sample.name))) {
      assert.ok(sample.assets[initialEntry.pathname], `${sample.name}: the consolidated main entry must load`);
      assert.ok(Object.keys(sample.assets).filter(path => path.endsWith('.js')).length <= 16,
        `${sample.name}: initial code must not split back into scores of script requests`);
      assert.equal(Object.keys(sample.assets).filter(path => /\/ui-icons-/.test(path)).length, 1,
        `${sample.name}: initial UI icons must share a compiled resource`);
      assert.equal(Object.keys(sample.assets).some(path => /\/(?:createLucideIcon|plus|x|chevron-down|loader-circle)-/.test(path)),
        false, `${sample.name}: common initial icons must not need separate resource requests`);
    }
    for (const sample of phases) assert.equal(Object.keys(sample.assets).some(path => /\/Workflow(?:Canvas|ExecutionCanvas|ConversationCanvas)-/.test(path)),
      false, `${sample.name}: unopened workflow canvases must not load at home`);
    for (const sample of phases) assert.equal(Object.keys(sample.assets).some(path => /\/(?:MarkdownMermaidRenderer|mermaid\.core)-/.test(path)),
      false, `${sample.name}: homepage without diagrams must not load the Mermaid renderer or engine`);
    for (const sample of phases) assert.equal(Object.keys(sample.assets).some(path => /\/MigrationDialogContent-/.test(path)),
      false, `${sample.name}: unopened migration must not load its content`);
    for (const sample of phases) assert.equal(Object.keys(sample.assets).some(path => workspacePanelAsset.test(path)),
      false, `${sample.name}: unopened workspace panels must not preload at home`);
    for (const sample of phases) assert.equal(sample.rpc['settings/tools/selection/read'] || 0, 0,
      `${sample.name}: unopened tool settings must not populate an unused startup projection`);
    for (const sample of phases) assert.equal(Object.keys(sample.assets).some(path => /\/(?:markdownMathPlugin|katex)-/.test(path)),
      false, `${sample.name}: prose-only home must not load the math renderer`);
    for (const sample of phases) assert.equal(Object.keys(sample.assets).some(path => /\/markdownSyntaxHighlighter-/.test(path)),
      false, `${sample.name}: homepage without code must not load syntax highlighting`);
    for (const sample of phases) assert.equal(Object.keys(sample.assets).some(path => /\/(?:KCoderAccountStartup|KCoderServersSettingsPage)-/.test(path)),
      false, `${sample.name}: ready home must not preload account setup or runtime-target settings`);
    for (const sample of phases) assert.equal(Object.keys(sample.assets).some(path => /\/(?:ImportedHistoryContent|useMigrationTranscript)-/.test(path)),
      false, `${sample.name}: a conversation without imported history must not load its historical display`);
    await phase('idle-home', () => pause(32000));
    assert.equal(phases.at(-1).rpc['runtime.providers.list'] || 0, 0,
      'workspace discovery at home must not reread the same target profile for first-use onboarding');
    const draftTemplates = phases.find(sample => sample.name === 'reload-home');
    assert.ok(draftTemplates.rpc['settings/templates/list'] > 0, 'new conversations still read template choices');
    assert.equal(draftTemplates.replies.templateReplies?.completed, draftTemplates.rpc['settings/templates/list']);
    assert.equal(draftTemplates.replies.templateReplies.failed, 0);
    await phase('task-expert-picker-on-demand', async () => {
      await page.getByTestId('task-expert-control').getByRole('button').first().click();
      const dialog = page.getByTestId('expert-task-dialog');
      await expect(dialog).toBeVisible();
      await waitFor(() => current.replies.expertCatalogReplies?.completed === 1,
        15000, 'task expert picker actual Native catalog response', 50, context.abortSignal);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      assert.equal(current.rpcRequests['agentDefinitions/scope/read'], 1);
      assert.equal(current.rpcRequests['integrations/assistant/list'], 1);
      assert.equal(current.replies.expertCatalogReplies.failed, 0);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      assert.equal(counts.turnStarts, 0, 'opening and closing a picker must not create a task');
      assert.equal(model.requests.length, 0, 'reading the expert picker must not ask the model');
    });
    await phase('collapsed-sidebar-hidden-observation', async () => {
      await page.getByTestId('collapse-sidebar-button').click();
      await expect(page.getByTestId('desktop-sidebar-preview')).toHaveAttribute('aria-hidden', 'true');
      await page.waitForLoadState('networkidle');
      for (const route of ['GET /api/servers', 'GET /api/kcoder-account'])
        assert.equal(current.http[route] || 0, 0, 'hidden primary/preview sidebars must not request display data');
    });
    await phase('sidebar-preview-observation', async () => {
      await page.getByTestId('desktop-sidebar-hover-edge').hover();
      await expect(page.getByTestId('desktop-sidebar-preview')).toHaveAttribute('aria-hidden', 'false');
      await page.waitForLoadState('networkidle');
      for (const route of ['GET /api/servers', 'GET /api/kcoder-account'])
        assert.equal(current.http[route] || 0, 1, 'the visible preview must read its display data once');
    });
    await phase('sidebar-restored-observation', async () => {
      await page.getByTestId('expand-sidebar-button').click();
      await page.getByTestId('collapse-sidebar-button').waitFor();
      await page.waitForLoadState('networkidle');
    });
    await phase('hidden-home-reload', async () => {
      await cover.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('desktop-sidebar').waitFor({ state: 'attached', timeout: 60000 });
      await page.waitForLoadState('networkidle');
      assert.equal(current.http['GET /api/kcoder-account'] || 0, 0,
        'a newly mounted hidden sidebar must defer its account display read');
      assert.equal(current.http['GET /api/servers/status'] || 0, 0,
        'hidden bootstrap must defer the full device health display check');
      assert.equal(current.rpc['runtime.models.list'] || 0, 0,
        'hidden startup must defer model catalog display reads');
      const directory = directoryReads.requests.filter(read => read.phase === current.name);
      const baseline = directory.filter(read => read.initiator.some(frame => frame.functionName === 'ensureBaseline'));
      assert.ok(baseline.length <= 1, 'hidden bootstrap may still establish its plugin target lifetime baseline');
      assert.equal(current.http['GET /api/servers'] - baseline.length, 2,
        'hidden bootstrap preserves Runtime and selected-target reads without another display health read');
      for (const command of environmentCommands)
        assert.equal(current.commands[command] || 0, 0,
          'a newly mounted hidden pane must defer its environment display commands');
    });
    await phase('restored-reloaded-home', async () => {
      const health = page.waitForResponse(response => response.url() === `${gateway.baseUrl}/api/servers/status`);
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
      assert.equal((await health).status(), 200, 'visible bootstrap must receive current device health');
      await page.waitForLoadState('networkidle');
      assert.equal(current.http['GET /api/servers/status'], 1, 'visible bootstrap starts full health once');
      assert.equal(current.http['GET /api/kcoder-account'], 1,
        'foregrounding the reloaded sidebar must obtain the current account once');
      await waitFor(() => sockets.flatMap(socket => socket.modelCatalogReads)
        .some(read => read.phase === current.name && read.outcome === 'completed'),
        15000, 'foreground current model catalog receipt', 20, context.abortSignal);
      await waitFor(() => current.replies.environmentReplies?.completed >= environmentSummaryCommands.length,
        15000, 'foreground environment command Native success responses', 20, context.abortSignal);
      assert.equal(current.replies.environmentReplies.failed, 0);
      for (const command of environmentSummaryCommands)
        assert.equal(current.commands[command], 1,
          'foregrounding the reloaded pane must read its current summary once');
      assert.equal(current.commands.git_remote_url || 0, 0,
        'closed environment actions must not read the unused PR remote');
    });
    await phase('home-hidden-profile-invalidation', async () => {
      await cover.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
      await page.evaluate(() => window.dispatchEvent(new Event('kcoder:servers-changed')));
      await pause(1000);
      assert.equal(current.http['GET /api/servers'], 1,
        'configuration changes retain the runtime command-owner directory verification while hidden');
      assert.equal(current.http['GET /api/kcoder-account'] || 0, 0,
        'hidden sidebar display reads must wait until foreground');
      assert.equal(current.rpc['runtime.providers.list'] || 0, 0,
        'hidden first-use display must defer the provider read after configuration invalidation');
      await page.evaluate(() => {
        for (let index = 0; index < 100; index++)
          window.dispatchEvent(new Event('kcoder:local-model-settings-changed'));
      });
      await pause(200);
      assert.equal(current.rpc['runtime.models.list'] || 0, 0,
        'hidden model-setting changes must wait for display demand');
    });
    await phase('home-restored-profile-read', async () => {
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
      await waitFor(() => current.replies.providerReplies?.completed === 1,
        15000, 'first-use profile Native response after returning to the homepage', 20, context.abortSignal);
      await pause(600);
      assert.equal(current.rpc['runtime.providers.list'], 1, 'returning must reconcile the original target profile once');
      assert.equal(current.replies.providerReplies.failed, 0);
    });
    await phase('home-configuration-notification-burst', async () => {
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => {
        for (let index = 0; index < 100; index++)
          window.dispatchEvent(new Event('kcoder:servers-changed'));
      });
      await waitFor(() => current.replies.providerReplies?.completed === 1,
        15000, 'latest first-use profile read after the configuration notification burst', 20, context.abortSignal);
      await page.waitForLoadState('networkidle');
      assert.equal(current.http['GET /api/servers'], 1,
        'one same-turn configuration notification cohort needs one fresh directory HTTP read');
      assert.equal(current.rpc['runtime.providers.list'], 1,
        'superseded first-use discoveries must not read intermediate provider profiles');
      assert.equal(current.replies.providerReplies.failed, 0);
      assert.equal(counts.turnStarts, 0, 'configuration observations must not submit a turn');
      assert.equal(model.requests.length, 0, 'configuration observations must not request a model');
    });
    await phase('home-unrelated-target-notification', async () => {
      await page.waitForLoadState('networkidle');
      const directory = page.waitForResponse(response => response.url() === `${gateway.baseUrl}/api/servers`);
      await page.evaluate(() => {
        for (let index = 0; index < 100; index++) window.dispatchEvent(new CustomEvent('kcoder:servers-changed', {
          detail: { targetId: 'unrelated-owned-notification-target' },
        }));
      });
      assert.equal((await directory).status(), 200);
      // Reserve a quiet window: an already-reached networkidle state cannot prove
      // that a follow-up Native read will remain absent after directory completion.
      await pause(600);
      await page.waitForLoadState('networkidle');
      assert.equal(current.http['GET /api/servers'], 1,
        'runtime command-owner verification remains current after a target notice');
      assert.equal(current.rpc['runtime.providers.list'] || 0, 0,
        'another target configuration must not reread the displayed first-use profile');
      assert.equal(counts.turnStarts, 0);
      assert.equal(model.requests.length, 0);
    });
    await phase('home-local-model-settings-notification', async () => {
      await page.evaluate(() => {
        for (let index = 0; index < 100; index++)
          window.dispatchEvent(new Event('kcoder:local-model-settings-changed'));
      });
      await waitFor(() => current.replies.modelReplies?.completed === 1,
        15000, 'current workspace model catalog Native reply after local settings notification cohort', 20, context.abortSignal);
      await pause(600);
      assert.equal(current.rpc['runtime.models.list'], 1,
        'a local model settings change rereads only its current model scope');
      assert.equal(current.replies.modelReplies.failed, 0);
      const reads = sockets.flatMap(socket => socket.modelCatalogReads.filter(read => read.phase === current.name));
      assert.equal(reads.length, 1);
      assert.equal(new Set(reads.map(read => read.scopeOrdinal)).size, 1,
        'local settings notifications must not resurrect an obsolete startup model scope');
      assert.equal(reads.filter(read => read.explicitWorkspace).length, 1,
        'the settled workspace must not borrow the earlier device-only catalog');
      assert.ok(reads.every(read => read.explicitDevice && !read.explicitTask && !read.threadBound && read.outcome === 'completed'));
      assert.equal(counts.turnStarts, 0);
      assert.equal(model.requests.length, 0, 'model catalog reconciliation must not call the model');
    });
    await phase('open-channel-page', async () => {
      await page.getByTestId('channels-button').click();
      await expect(page.getByTestId('octop-channels-workspace')).toBeVisible();
      await page.waitForLoadState('networkidle');
      assert.equal(current.http['GET /api/channels'], 1, 'opening an empty channel page reads inventory once');
    });
    await phase('channel-page-foreground-read', () => resumeWithHeldChannelRead());
    for (const tab of ['settings', 'history']) {
      await phase(`automation-${tab}-hidden-reply`, async () => {
        const turnsBefore = counts.turnStarts, modelRequestsBefore = model.requests.length;
        await page.evaluate(() => {
          const send = WebSocket.prototype.send;
          const probe = window.__desktopAutomationRead = { attempts: 0, held: null,
            release: (invalid = false) => { const held = probe.held; probe.held = null; held?.(invalid); },
            restore: () => { WebSocket.prototype.send = send; probe.release(); } };
          WebSocket.prototype.send = function(data) {
            let frame; try { frame = JSON.parse(String(data)); } catch { return send.call(this, data); }
            if (frame.method === 'cron/list' && ++probe.attempts === 1) {
              probe.held = invalid => send.call(this, invalid
                ? JSON.stringify({ ...frame, params: { ...frame.params, creationContext: 'invalid-owned-read' } }) : data);
              return;
            }
            return send.call(this, data);
          };
        });
        try {
          if (tab === 'settings') await page.getByTestId('automations-button').click();
          else await page.getByTestId('automation-tab-history').click();
          await expect(page.getByTestId('scheduled-tasks-panel')).toBeVisible();
          await page.waitForFunction(() => Boolean(window.__desktopAutomationRead.held), undefined, { timeout: 15000 });
          await cover.bringToFront();
          await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
          await page.evaluate(() => window.__desktopAutomationRead.release(true));
          await waitFor(() => current.replies.automationReplies?.failed === 1,
            15000, 'actual retired cron/list Native invalid-params reply', 20, context.abortSignal);
          assert.equal(current.automationInvalidParams, 1);
          await pause(600);
          await expect(page.getByTestId('scheduled-tasks-panel').getByRole('alert')).toHaveCount(0);
          await page.bringToFront();
          await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
          await waitFor(() => current.replies.automationReplies?.completed === 1,
            15000, 'one current cron/list Native reply after foregrounding', 20, context.abortSignal);
          await pause(600);
          assert.equal(current.rpc['cron/list'], 2, 'the retired read and one fresh foreground query remain distinct');
          assert.equal(current.rpc['workflow/list'] || 0, 0, 'disabled schedule management does not enumerate workflows');
          await expect(page.getByTestId('scheduled-tasks-panel').getByRole('alert')).toHaveCount(0);
          assert.ok(Object.keys(current.assets).every(path => !/\/(WorkflowCanvas|WorkflowExecutionCanvas)-/.test(path)),
            'schedule settings and empty history must not prefetch an unopened workflow canvas');
          assert.equal(counts.turnStarts, turnsBefore);
          assert.equal(model.requests.length, modelRequestsBefore, 'observing schedules must not run a model');
        } finally {
          await page.evaluate(() => { window.__desktopAutomationRead.restore(); delete window.__desktopAutomationRead; });
        }
      });
    }
    await phase('automation-history-sequential-cadence', async () => {
      await page.evaluate(() => {
        const send = WebSocket.prototype.send;
        const probe = window.__desktopAutomationCadence = { attempts: 0, held: null,
          release: () => { const held = probe.held; probe.held = null; held?.(); },
          restore: () => { WebSocket.prototype.send = send; probe.release(); } };
        WebSocket.prototype.send = function(data) {
          let frame; try { frame = JSON.parse(String(data)); } catch { return send.call(this, data); }
          if (frame.method === 'cron/list' && ++probe.attempts === 1) {
            probe.held = () => send.call(this, data);
            return;
          }
          return send.call(this, data);
        };
      });
      try {
        await page.getByTestId('automation-runs-refresh').click();
        await page.waitForFunction(() => Boolean(window.__desktopAutomationCadence.held), undefined, { timeout: 15000 });
        // Cross the old five-second interval while the real manual read is pending.
        await pause(6000);
        assert.equal(await page.evaluate(() => window.__desktopAutomationCadence.attempts), 1);
        await page.evaluate(() => window.__desktopAutomationCadence.release());
        await waitFor(() => current.replies.automationReplies?.completed === 1,
          15000, 'held manual cron/list Native reply', 20, context.abortSignal);
        await pause(4200);
        assert.equal(current.rpc['cron/list'], 1,
          'automatic history refresh must wait five seconds after the pending manual read completes');
        await waitFor(() => current.replies.automationReplies?.completed === 2,
          4000, 'next sequential cron/list Native reply', 20, context.abortSignal);
        assert.equal(current.rpc['cron/list'], 2);
        assert.equal(current.replies.automationReplies.failed, 0);
        assert.equal(counts.turnStarts, 0);
        assert.equal(model.requests.length, 0, 'schedule display cadence must not invoke the model');
      } finally {
        await page.evaluate(() => { window.__desktopAutomationCadence.restore(); delete window.__desktopAutomationCadence; });
      }
    });
    await phase('automation-workflow-selection-only', async () => {
      await page.getByTestId('automation-tab-settings').click();
      await waitFor(() => current.replies.automationReplies?.completed === 1,
        15000, 'ordinary job list on returning to settings', 20, context.abortSignal);
      await page.getByTestId('scheduled-task-kind').selectOption('workflow');
      await expect(page.getByTestId('scheduled-workflow-choice')).toBeVisible();
      await waitFor(() => current.replies.workflowCatalogReplies?.completed === 1,
        15000, 'actual saved-workflow catalog for the selection form', 20, context.abortSignal);
      assert.equal(current.rpc['workflow/list'], 1);
      for (const method of ['integrations/scope/read', 'settings/integrations/knowledge/read'])
        assert.equal(current.rpc[method] || 0, 0, 'selection-only form must not construct an unused integration client');
      assert.equal(counts.turnStarts, 0);
      assert.equal(model.requests.length, 0);
    });
    await phase('automation-inbox-without-unrelated-polling', async () => {
      await page.getByTestId('automation-tab-inbox').click();
      await expect(page.getByTestId('scheduled-tasks-panel').getByTestId('knowledge-feature-setup')).toBeVisible();
      await pause(16000);
      for (const method of ['cron/list', 'workflow/list'])
        assert.equal(current.rpc[method] || 0, 0, 'the inbox does not consume ordinary jobs or workflow catalogs');
      assert.equal(current.rpc['integrations/scope/read'], 1);
      assert.equal(current.rpc['settings/integrations/knowledge/read'], 1);
      assert.equal(counts.turnStarts, 0);
      assert.equal(model.requests.length, 0);
    });
    await phase('configure-process-clock-presentation', async () => {
      const accountDisplayResponse = response => response.url() === `${gateway.baseUrl}/api/kcoder-account` &&
        response.request().method() === 'GET';
      const [menuRead] = await Promise.all([
        page.waitForResponse(accountDisplayResponse, { timeout: 15000 }),
        page.getByTestId('desktop-sidebar').getByTestId('settings-button').click(),
      ]);
      assert.equal(menuRead.status(), 200);
      const menuReads = current.http['GET /api/kcoder-account'] || 0;
      assert.equal(menuReads, 1, 'opening the settings menu reads current account display once');
      await page.getByTestId('settings-menu-button').click();
      const mode = page.getByTestId('general-process-display-three-level-v1');
      await mode.click();
      await expect(mode).toHaveAttribute('aria-pressed', 'true');
      await expect(mode).toBeEnabled();
      const [returnRead] = await Promise.all([
        page.waitForResponse(accountDisplayResponse, { timeout: 15000 }),
        page.getByTestId('settings-back-button').click(),
      ]);
      assert.equal(returnRead.status(), 200);
      await expect(page.getByTestId('desktop-sidebar')).toBeVisible();
      await page.waitForLoadState('networkidle');
      const returnReads = (current.http['GET /api/kcoder-account'] || 0) - menuReads;
      assert.equal(returnReads, 1, 'returning to the sidebar reads its current account display once');
      current.accountDisplayReads = { menuOpen: menuReads, returnToSidebar: returnReads };
    });
    await phase('create-and-send', async () => {
      const project = page.getByTestId('project-item').filter({ hasText: 'Desktop cost target' }).first();
      await project.hover(); await project.getByTestId('project-new-conversation-button').click();
      const composer = page.getByTestId('chat-message-input');
      await composer.waitFor({ state: 'visible', timeout: 30000 });
      await waitForSelectedModel(page, 'fixture');
      await composer.click(); await page.keyboard.insertText('DESKTOP_COST_PROMPT');
      await page.getByTestId('send-message-button').click();
      await waitFor(() => model.requests.length >= 1, 30000, 'first user click reaching owned model', 50, context.abortSignal);
      assert.equal(counts.turnStarts, 1, 'one click must submit exactly one turn/start');
      await waitFor(() => current.replies.historySourceReplies?.completed === 1,
        15000, 'ordinary task provenance response', 50, context.abortSignal);
      assert.equal(current.rpc['migration/history/continuation/source'], 1);
      assert.equal(current.replies.historySourceReplies.failed, 0);
    });
    assert.ok((phases.at(-1).rpc['settings/templates/list'] || 0) <= 2,
      'creating an unbound task must not add a catalog read beyond its draft choices');
    await phase('stream-visible', async () => {
      startedAt = performance.now(); streaming = true;
      await page.getByTestId('message-assistant').filter({ hasText: 'sample' }).first().waitFor({ state: 'visible', timeout: 15000 });
      await expect(page.getByTestId('turn-process-elapsed')).toBeVisible();
      await page.evaluate(() => {
        const element = document.querySelector('[data-testid="turn-process-elapsed"]');
        const probe = window.__desktopClockProbe = { updates: 0 };
        probe.observer = new MutationObserver(() => { probe.updates++; });
        probe.observer.observe(element, { childList: true, characterData: true, subtree: true });
      });
      const composer = page.getByTestId('chat-message-input');
      await composer.fill('@README');
      await expect(page.locator('[data-testid^="workspace-mention-option-"]').filter({ hasText: 'README.md' }).first()).toBeVisible();
      await waitFor(() => current.replies.workspaceSearchReplies?.completed === 1,
        15000, 'actual workspace mention Native search result', 20, context.abortSignal);
      await pause(18000);
      assert.equal(current.rpc['runtime.workspace.search'], 1, 'stream updates must not repeat an unchanged mention search');
      assert.equal(current.replies.workspaceSearchReplies.failed, 0);
      assert.equal(current.workspaceReadmeFound, true, 'the original owned workspace must supply README.md');
      assert.equal(counts.turnStarts, 1, 'mention lookup must not send the draft or submit another turn');
      assert.equal(model.requests.length, 1);
      await context.writeArtifactJson('workspace-mention-before-clear.json', await readComposerDiagnostics(page));
      await fillComposerText(page, '', { signal: context.abortSignal });
      const cleared = await readComposerDiagnostics(page);
      await context.writeArtifactJson('workspace-mention-after-clear.json', cleared);
      assert.equal(cleared.serialized?.bytes, 0, 'clearing must update the actual editor document');
      await expect(page.locator('[data-testid^="workspace-mention-option-"]')).toHaveCount(0);
      assert.ok(await page.evaluate(() => window.__desktopClockProbe.updates > 0), 'visible clock must advance');
      assert.equal(current.replies.clockReplies?.completed, 1);
      assert.equal(current.replies.clockReplies.failed, 0);
      assert.ok(current.commands.git_branch_diff_shortstat >= 1, 'running summary still checks actual changes');
      assert.equal(current.commands.git_remote_url || 0, 0, 'running closed actions must not poll the PR remote');
    });
    await phase('composer-menu-open-before-hide', async () => {
      await page.getByTestId('chat-message-input').fill('@README');
      await expect(page.getByTestId('local-skill-autocomplete')).toBeVisible();
      await waitFor(() => current.replies.workspaceSearchReplies?.completed === 1,
        15000, 'open composer workspace search', 20, context.abortSignal);
      assert.equal(current.rpc['runtime.workspace.search'], 1);
      assert.equal(current.rpc['skills/list'] || 0, 0, 'unchanged completed menu skill metadata is reused');
      assert.equal(current.rpc['plugin/list'] || 0, 0, 'unchanged completed menu plugin metadata is reused');
    });
    await phase('composer-native-peer-invalidation', async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('kcoder:tools-catalog-invalidated', { detail: { deviceId: 'peer-cost-target' } })));
      await pause(300);
      await expect(page.getByTestId('local-skill-autocomplete')).toBeVisible();
      for (const method of ['skills/list', 'plugin/list'])
        assert.equal(current.rpc[method] || 0, 0, `peer notification must not read ${method}`);
    });
    await phase('composer-native-visible-invalidation', async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('kcoder:tools-catalog-invalidated', { detail: { deviceId: 'local' } })));
      await waitFor(() => current.replies.composerCatalogReplies?.completed === 2,
        15000, 'current target tools notification actual Native menu replies', 20, context.abortSignal);
      assert.equal(current.rpc['skills/list'], 1);
      assert.equal(current.rpc['plugin/list'], 1);
      assert.equal(current.replies.composerCatalogReplies.failed, 0);
      assert.equal(current.rpc['runtime.workspace.search'] || 0, 0, 'tool changes do not alter the workspace query');
    });
    await cover.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 5000 }).toBe('hidden');
    await phase('composer-native-hidden-invalidation', async () => {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('kcoder:tools-catalog-invalidated', { detail: { deviceId: 'local' } })));
      await pause(700);
      for (const method of ['skills/list', 'plugin/list', 'runtime.workspace.search'])
        assert.equal(current.rpc[method] || 0, 0, `hidden Native notification must defer ${method}`);
    });
    await phase('composer-native-returned', async () => {
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 5000 }).toBe('visible');
      await waitFor(() => current.replies.composerCatalogReplies?.completed === 2 && current.replies.workspaceSearchReplies?.completed === 1,
        15000, 'return after Native menu invalidation', 20, context.abortSignal);
      assert.equal(current.rpc['skills/list'], 1);
      assert.equal(current.rpc['plugin/list'], 1);
      assert.equal(current.rpc['runtime.workspace.search'], 1);
      assert.equal(current.replies.composerCatalogReplies.failed, 0);
      assert.equal(current.replies.workspaceSearchReplies.failed, 0);
    });
    await cover.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 5000 }).toBe('hidden');
    await phase('composer-menu-hidden-invalidation', async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('kcoder:local-plugin-skills-changed')));
      await pause(1000);
      for (const method of ['skills/list', 'plugin/list', 'runtime.workspace.search'])
        assert.equal(current.rpc[method] || 0, 0, `hidden menu must defer ${method}`);
    });
    await phase('composer-menu-returned', async () => {
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 5000 }).toBe('visible');
      await waitFor(() => current.replies.composerCatalogReplies?.completed === 2 && current.replies.workspaceSearchReplies?.completed === 1,
        15000, 'visible dirty composer Native metadata and workspace search replies', 20, context.abortSignal);
      assert.equal(current.rpc['skills/list'], 1);
      assert.equal(current.rpc['plugin/list'], 1);
      assert.equal(current.rpc['runtime.workspace.search'], 1);
      assert.equal(current.replies.composerCatalogReplies.failed, 0);
      assert.equal(current.replies.workspaceSearchReplies.failed, 0);
      assert.equal(current.workspaceReadmeFound, true);
      await fillComposerText(page, '', { signal: context.abortSignal });
      await expect(page.getByTestId('local-skill-autocomplete')).toHaveCount(0);
    });
    await phase('environment-actions-on-demand', async () => {
      const toggle = page.getByTestId('environment-info-button').filter({ visible: true }).first();
      await toggle.click();
      await expect(page.getByTestId('environment-info-popover')).toBeVisible();
      await waitFor(() => current.replies.environmentReplies?.completed >= 6 && current.commands.git_remote_url >= 2,
        15000, 'explicit environment actions current Native replies', 20, context.abortSignal);
      assert.equal(current.commands.git_remote_url, 2, 'opening and the existing running poll both obtain the PR remote while actions are visible');
      assert.equal(current.replies.environmentReplies.failed, 0);
      await expect(page.getByTestId('create-pull-request-button')).toBeVisible();
      await toggle.click();
      await expect(page.getByTestId('environment-info-popover')).toHaveCount(0);
    });
    await cover.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 5000 }).toBe('hidden');
    await phase('stream-hidden', async () => {
      const before = await page.evaluate(() => window.__desktopClockProbe.updates);
      await pause(12000);
      assert.equal(await page.evaluate(() => window.__desktopClockProbe.updates), before,
        'hidden transcript must not update its elapsed clock');
      assert.equal(current.rpc['server/resources/read'] || 0, 0);
    });
    await phase('stream-restored', async () => {
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 5000 }).toBe('visible');
      const before = await page.evaluate(() => window.__desktopClockProbe.updates);
      await pause(8000);
      assert.ok(await page.evaluate(() => window.__desktopClockProbe.updates) > before,
        'foreground clock must resume from the target');
      assert.equal(current.rpc['server/resources/read'], 1);
      assert.equal(current.replies.clockReplies?.completed, 1);
      assert.equal(current.replies.clockReplies.failed, 0);
      await page.evaluate(() => { window.__desktopClockProbe.observer.disconnect(); delete window.__desktopClockProbe; });
    });
    assert.equal(phases.at(-1).http['GET /api/channels'], 1,
      'foregrounding the same observed task must reconcile channel indicators once');
    await phase('configure-process-clock-two-level', async () => {
      await page.getByTestId('desktop-sidebar').getByTestId('settings-button').click();
      await page.getByTestId('settings-menu-button').click();
      const mode = page.getByTestId('general-process-display-two-level-v1');
      await mode.click();
      await expect(mode).toHaveAttribute('aria-pressed', 'true');
      await expect(mode).toBeEnabled();
      await page.getByTestId('settings-back-button').click();
      await expect(page.getByTestId('message-assistant').filter({ hasText: 'sample' }).first()).toBeVisible();
      await expect(page.getByTestId('final-processing-toggle')).toHaveCount(0);
      await waitFor(() => current.replies.clockReplies?.completed >= 1,
        15000, 'two-level process target clock response', 50, context.abortSignal);
      assert.equal(current.replies.clockReplies.failed, 0);
      assert.equal(current.http['GET /api/experience/conversations'] || 0, 0,
        'changing process display does not change experience participation or reread its capability');
      assert.ok((current.http['GET /api/servers'] || 0) <= 1,
        'explicit appearance settings may reconcile sidebar account targets once');
    });
    assert.equal(phases.at(-1).transport.wsOpened, 0, 'changing process display must reuse existing connections');
    await phase('open-workflow-during-turn', async () => {
      await page.getByTestId('workflows-button').click();
      await expect(page.getByTestId('workflow-workspace')).toBeVisible();
      await page.waitForLoadState('networkidle');
      assert.equal(current.rpc['workflow/storage/read'] || 0, 0, 'closed advanced settings must not read storage');
    });
    assert.ok(Object.keys(phases.at(-1).assets).some(path => /\/WorkflowCanvas-/.test(path)),
      'opening the workflow library must still load the real canvas');
    await phase('running-task-retained-hidden', async () => {
      assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
      assert.equal(counts.completions, 0, 'the original turn must still be running');
      await pause(12000);
    });
    const runningHidden = phases.at(-1);
    assert.equal(runningHidden.rpc['server/resources/read'] || 0, 0, 'retained hidden process must not sample its clock');
    assert.equal(runningHidden.rpc['device/execute'] || 0, 0,
      'retained hidden running task must pause periodic environment execution');
    for (const method of ['thread/expert', 'agent/list'])
      assert.equal(runningHidden.rpc[method] || 0, 0, `retained hidden running task must not request ${method}`);
    await phase('retained-hidden-focus-return', async () => {
      await cover.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
      await pause(1000);
      assert.equal(current.rpc['server/resources/read'] || 0, 0, 'tab focus must not sample a retained hidden conversation');
    });
    assert.equal(phases.at(-1).rpc['tools/catalog'] || 0, 0,
      'foregrounding another page must not query the hidden task tool catalog');
    await phase('return-to-running-task', async () => {
      await page.locator('[data-testid^="runtime-local-task-row-"]:visible').first().click();
      await expect(page.getByTestId('message-assistant').filter({ hasText: 'DESKTOP_COST_LAST' }).first()).toBeVisible();
      await waitFor(() => (current.commands.git_branch || 0) > 0,
        15000, 'returning task environment observation', 50, context.abortSignal);
      await waitFor(() => current.replies.clockReplies?.completed === 1,
        15000, 'returning original task clock response', 50, context.abortSignal);
      assert.equal(current.rpc['server/resources/read'], 1);
      assert.equal(current.replies.clockReplies.failed, 0);
    });
    await phase('open-draft-before-background-terminal', async () => {
      const project = page.getByTestId('project-item').filter({ hasText: 'Desktop cost target' }).first();
      await project.hover(); await project.getByTestId('project-new-conversation-button').click();
      await expect(page.getByTestId('chat-message-input')).toBeVisible();
      await expect(page.getByTestId('send-message-button')).toBeDisabled();
      await page.waitForLoadState('networkidle');
      assert.equal(counts.turnStarts, 1, 'opening an unsent draft must not start another turn');
    });
    await phase('background-terminal-reconciliation', async () => {
      finish = true;
      await waitFor(() => counts.completions === 1, 15000, 'original background task terminal', 50, context.abortSignal);
      await waitFor(() => current.replies.historyReplies?.completed >= 2,
        15000, 'background terminal directory and Goal status responses', 50, context.abortSignal);
      await pause(500);
      assert.equal(current.http['GET /api/servers'] || 0, 0, 'background terminal must not independently refresh devices');
      assert.equal(current.http['GET /api/servers/status'] || 0, 0);
      assert.equal(current.rpc['thread/list'], 1, 'one shared scheduled background work-list reconciliation');
      assert.equal(current.rpc['thread/goal/status/readMany'], 1);
      assert.equal(current.replies.historyReplies.failed, 0);
      assert.equal(counts.turnStarts, 1);
    });
    await phase('return-to-completed-task', async () => {
      await page.locator('[data-testid^="runtime-local-task-row-"]:visible').first().click();
      await expect(page.getByTestId('message-assistant').filter({ hasText: 'DESKTOP_COST_LAST' }).first()).toBeVisible();
      await waitFor(() => current.replies.transcriptReplies?.completed === 1,
        15000, 'cold return original transcript Native response', 50, context.abortSignal);
      assert.equal(current.replies.transcriptReplies.failed, 0);
      await page.waitForLoadState('networkidle');
    });
    await phase('terminal', async () => {
      await expect(page.getByTestId('message-assistant').filter({ hasText: 'DESKTOP_COST_LAST' }).first()).toBeVisible({ timeout: 15000 });
      finish = true;
      await waitFor(() => counts.completions === 1, 15000, 'owned UI terminal delivery', 50, context.abortSignal);
      assert.equal(terminalStatus, 'completed');
      await page.locator('[data-streamdown="mermaid-block"]').scrollIntoViewIfNeeded({ timeout: 30000 });
      await expect(page.locator('[data-streamdown="mermaid"] svg').first()).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('markdown-mermaid-loading')).toHaveCount(0);
      await expect(page.locator('.katex').first()).toBeVisible();
      await expect(page.locator('.katex-display')).toBeVisible();
      await expect(page.getByTestId('markdown-math-unavailable')).toHaveCount(0);
      const syntax = page.getByTestId('markdown-code-block').filter({ hasText: 'const syntaxReady = 42' });
      await expect(syntax.locator('code span').first()).toBeVisible();
      const markdown = page.getByTestId('markdown-code-block').filter({ hasText: '# Wrapped code source' });
      await expect(markdown.locator('code span').first()).toBeVisible();
      const wrap = markdown.getByTestId('markdown-code-wrap-button');
      await expect(wrap).toHaveAttribute('aria-pressed', 'false');
      await wrap.click();
      await expect(wrap).toHaveAttribute('aria-pressed', 'true');
      await expect(markdown.locator('code')).toHaveCSS('white-space', 'pre-wrap');
      await page.waitForLoadState('networkidle');
      assert.ok(phases.some(sample => Object.keys(sample.assets).some(path => /\/markdownSyntaxHighlighter-/.test(path))),
        'actual code must load its highlighting module');
    });
    await phase('idle-after-turn', () => pause(12000));
    assert.equal(counts.turnStarts, 1); assert.equal(counts.completions, 1); assert.ok(counts.deltas >= 50);
    for (const sample of phases.filter(value => value.name.startsWith('stream-'))) {
      assert.equal(sample.rpc['turn/receipt/read'] || 0, 0, `${sample.name}: continuous output must defer receipt checks`);
    }
    for (const sample of phases.filter(value => ['stream-hidden', 'stream-restored', 'idle-after-turn'].includes(value.name))) {
      assert.equal(sample.rpc['settings/templates/list'] || 0, 0, `${sample.name}: unchanged task address must not reload templates`);
      assert.equal(sample.rpc['session/modes'] || 0, 0, `${sample.name}: unchanged task address must not reload modes`);
    }
    assert.equal(phases.find(value => value.name === 'stream-hidden').rpc['device/execute'] || 0, 0,
      'hidden page must pause periodic environment execution');
    assert.ok(model.requests.length >= 1 && model.requests.length <= 3);
    await phase('open-workflow-library', async () => {
      await page.getByTestId('workflows-button').click();
      await expect(page.getByTestId('workflow-workspace')).toBeVisible();
      await page.waitForLoadState('networkidle');
      assert.equal(current.rpc['workflow/storage/read'] || 0, 0, 'the library has no advanced metadata consumer');
    });
    await phase('retained-task-hidden', async () => {
      assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
      await pause(35000);
      await expect(page.getByTestId('workflow-workspace')).toBeVisible();
      assert.equal(current.rpc['workflow/storage/read'] || 0, 0, 'an idle library must not poll hidden capacity details');
    });
    const retained = phases.at(-1);
    for (const method of ['thread/expert', 'thread/resume', 'agent/list'])
      assert.equal(retained.rpc[method] || 0, 0, `hidden task must not request ${method}`);
    assert.equal(retained.transport.wsOpened, 0, 'hidden task must not recreate its channel');
    assert.ok(phases.find(sample => sample.name === 'stream-visible').rpc['agent/list'] > 0,
      'visible subagent discovery must remain enabled');
    assert.ok(counts.wsOpened <= 256, 'socket observation capacity');
    const goalSockets = sockets.filter(socket => socket.rpc['thread/goal/get']);
    assert.ok(goalSockets.some(socket => socket.rpc['turn/start'] === 1),
      'the active task must read Goal through its original turn channel');
    for (const socket of goalSockets) {
      assert.deepEqual([...goalReadTargets.get(socket)], [threadId], 'Goal reads must remain on the original task');
      if (socket.rpc['turn/start'] || socket.rpc['thread/resume']) continue;
      assert.ok(socket.rpc['device/execute'],
        'cold return must borrow the already held matching workspace command for its Goal read');
      assert.equal(socket.goalReplies.failed, 0);
    }
    assert.equal(phases.find(sample => sample.name === 'return-to-completed-task').rpc.initialize, 1,
      'cold return initializes only its task connection; Goal borrows the held workspace command');
    const registrySockets = sockets.filter(socket => socket.rpc['runtime.workspaces.list']);
    assert.ok(registrySockets.some(socket => socket.rpc['device/execute']),
      'registry reads must reuse an existing command channel');
    assert.equal(registrySockets.filter(socket => !isHomeNavigationPhase(socket.openedIn) &&
      !socket.rpc['device/execute']).length, 0, 'warm registry reads must not create dedicated sockets');
    for (const socket of registrySockets) {
      assert.equal(socket.registryReplies.failed, 0, 'registry reads must not fail on the borrowed connection');
      assert.equal(socket.registryReplies.completed,
        socket.rpc['runtime.workspaces.list'] + socket.rpc['runtime.worktrees.list'],
        'each registry request must receive its Native result');
    }
    let metadataFixture;
    await phase('workflow-metadata-fixture', async () => {
      const rpc = await openPageGatewayRpc(context, page, gateway, 'close owned workflow metadata fixture RPC');
      try {
        const initialized = await rpc.request('initialize', { protocolVersion: '2026-07-27',
          clientInfo: { name: 'desktop-cost-workflow-metadata', version: '1' },
          capabilities: { experimental: { workflowCanvasV1: true, workflowStorageV1: true } } });
        assert.equal(initialized.capabilities.experimental.workflowCanvasV1, true);
        metadataFixture = await rpc.request('workflow/create', { title: 'Owned metadata read demand' });
        assert.equal(typeof metadataFixture.id, 'string');
        await context.writeArtifactJson('workflow-metadata-fixture.json', { definitionId: metadataFixture.id,
          revision: metadataFixture.revision, owner: 'this run owned profile', controlRequests: ['initialize', 'workflow/create'],
          executed: false, cleanup: 'owned Home removed after its Gateway stops; no personal workflow modified' });
      } finally { await closeRpcAndWait(rpc, 'owned workflow metadata fixture'); }
      await page.evaluate(value => window.dispatchEvent(new CustomEvent('kcoder:workflow-definition-changed', {
        detail: { serverId: 'local', definitionId: value.id, revision: value.revision, updatedAtMs: value.updatedAtMs },
      })), metadataFixture);
      await page.getByTestId(`workflow-library-${metadataFixture.id}`).click();
      await expect(page.getByTestId('workflow-advanced-toggle')).toBeEnabled();
      await page.waitForLoadState('networkidle');
      assert.equal(current.rpc['workflow/storage/read'] || 0, 0, 'selecting a definition does not open its advanced settings');
    });
    await phase('workflow-advanced-demand', async () => {
      await page.evaluate(() => {
        const send = WebSocket.prototype.send;
        const probe = window.__desktopSnapshotProbe = { triggered: false,
          restore: () => { WebSocket.prototype.send = send; } };
        WebSocket.prototype.send = function(data) {
          const result = send.call(this, data);
          let frame; try { frame = JSON.parse(String(data)); } catch { return result; }
          if (frame.method === 'workflow/storage/read') {
            probe.restore(); probe.triggered = true;
            // Observe the real request while its snapshot is pending; leave every wire frame unchanged.
            window.dispatchEvent(new Event('online'));
            document.dispatchEvent(new Event('visibilitychange'));
          }
          return result;
        };
      });
      try {
        await page.getByTestId('workflow-advanced-toggle').click();
        await expect(page.getByTestId('workflow-settings-dialog')).toBeVisible();
        await waitFor(() => current.replies.storageReplies?.completed === 1,
          15000, 'opened advanced settings original storage snapshot', 20, context.abortSignal);
        assert.equal(await page.evaluate(() => window.__desktopSnapshotProbe.triggered), true);
        await pause(600);
        assert.equal(current.rpc['workflow/storage/read'], 1, 'foreground hints during a snapshot do not duplicate it');
        await waitFor(() => current.replies.storageReplies?.completed === 2,
          17000, 'visible advanced settings existing metadata cadence', 20, context.abortSignal);
        assert.equal(current.rpc['workflow/storage/read'], 2);
        assert.equal(current.replies.storageReplies.failed, 0);
        await expect(page.getByTestId('workflow-verification')).toHaveAttribute('aria-busy', 'false');
        await page.getByTestId('workflow-settings-done').click();
        await expect(page.getByTestId('workflow-settings-dialog')).toHaveCount(0);
      } finally {
        await page.evaluate(() => { window.__desktopSnapshotProbe.restore(); delete window.__desktopSnapshotProbe; });
      }
    });
    await phase('workflow-advanced-closed', async () => {
      await pause(16000);
      assert.equal(current.rpc['workflow/storage/read'] || 0, 0, 'closing advanced settings stops capacity polling');
      assert.equal(current.rpc['workflow/verification/read'] || 0, 0);
      await expect(page.getByTestId('workflow-advanced-toggle')).toBeVisible();
      assert.equal(counts.turnStarts, 1);
      assert.equal(model.requests.length, 1);
    });
    // Returning may establish another legitimate task owner; it must not replay the turn.
    await phase('return-to-task', async () => {
      await page.locator('[data-testid^="runtime-local-task-row-"]:visible').first().click();
      await page.getByTestId('message-assistant').filter({ hasText: 'DESKTOP_COST_LAST' }).first()
        .waitFor({ state: 'visible', timeout: 30000 });
      await waitFor(() => current.rpc['thread/expert'] > 0 && current.rpc['agent/list'] > 0,
        15000, 'returning task expert and agent observations', 50, context.abortSignal);
      await page.waitForLoadState('networkidle');
    });
    assert.equal(counts.turnStarts, 1, 'returning must not resubmit the turn');
    assert.equal(model.requests.length, 1, 'returning must not ask the model again');
    for (const sample of phases.filter(sample => ['return-to-task', 'return-to-completed-task'].includes(sample.name))) {
      assert.equal(sample.rpc['gateway/thread/attach'], 1,
        `${sample.name}: restoration and pane mounting share the original connection's view registration`);
      assert.deepEqual(sample.replies.viewAttachmentReplies, { completed: 1, failed: 0 },
        `${sample.name}: the single view registration must receive its actual Gateway acknowledgement`);
    }
    // A new draft resolves its workspace once; an explicit cold task needs no closed-picker directory.
    const creationTransitions = new Set(['open-draft-before-background-terminal']);
    for (const sample of phases.filter(sample => creationTransitions.has(sample.name))) {
      assert.equal(sample.http['GET /api/servers'], 1, `${sample.name}: one authoritative target picker read`);
      const reads = directoryReads.requests.filter(read => read.phase === sample.name);
      assert.equal(reads.length, 1);
      assert.equal(reads[0].status, 200, `${sample.name}: the mounted target picker must receive a fresh Gateway response`);
      assert.ok(reads[0].initiator.length > 0,
        `${sample.name}: the target directory read must originate from the owned renderer`);
    }
    // Explicit settings saves have their own bounded reads; this budget covers unchanged views.
    for (const sample of phases.slice(phases.findIndex(sample => sample.name === 'stream-visible'))
      .filter(sample => !sample.name.startsWith('configure-') && !creationTransitions.has(sample.name)))
      assert.equal(sample.http['GET /api/servers'] || 0, 0,
        `${sample.name}: unchanged target observers must not reload the directory on output or navigation`);
    assert.equal(await hashHistoryFile(binary), binarySha, 'fixed Native input');
    assert.equal(directoryReads.overflow, 0, 'directory initiator observation capacity');
    assert.ok(directoryReads.requests.some(row => row.initiator.length > 0), 'directory callers must be observable');
    await phase('open-channel-picker', async () => {
      await page.getByRole('button', { name: /绑定通道|Bind channel/ }).first().click();
      await expect(page.getByTestId('task-channel-binding-dialog')).toBeVisible();
      await page.waitForLoadState('networkidle');
      assert.equal(current.http['GET /api/channels'], 1, 'opening the picker must read its authorized inventory');
    });
    // Sidebar and picker retain independent lifetimes while sharing the actual unfinished GET.
    await phase('channel-picker-foreground-read', () => resumeWithHeldChannelRead());
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('task-channel-binding-dialog')).not.toBeVisible();
    assert.equal(counts.turnStarts, 1, 'channel observation must not submit another turn');
    assert.equal(model.requests.length, 1, 'channel observation must not ask the model again');
    for (const sample of phases) assert.equal(Object.keys(sample.assets).some(path => workspacePanelAsset.test(path)),
      false, `${sample.name}: idle and normal conversation must not preload unopened workspace panels`);
    for (const sample of phases) assert.equal(Object.keys(sample.assets).some(path => /\/(?:ImportedHistoryContent|useMigrationTranscript)-/.test(path)),
      false, `${sample.name}: ordinary streaming and restored tasks must not preload historical display code`);
    await phase('open-workspace-files-on-demand', async () => {
      await page.getByTestId('toggle-right-workspace-panel-button').click();
      await page.getByTestId('right-workspace-file-option').click();
      const tree = page.getByTestId('workspace-file-tree');
      await expect(tree).toBeVisible({ timeout: 30000 });
      const readme = tree.locator('button[data-item-path$="README.md"]').first();
      await expect(readme).toBeVisible();
      await readme.click();
      await expect(page.getByTestId('workspace-file-preview-code-view')).toContainText('KCoder E2E', { timeout: 30000 });
      await page.waitForLoadState('networkidle');
      assert.ok(Object.keys(current.assets).some(path => /\/FileWorkspacePanel-/.test(path)),
        'opening files must load the actual file panel');
      await page.screenshot({ path: context.pathInArtifacts('workspace-files-on-demand.png') });
    });
    await phase('open-workspace-terminal-on-demand', async () => {
      await page.getByTestId('right-workspace-new-tab-button').click();
      await page.getByTestId('right-workspace-new-tab-menu').getByTestId('right-workspace-terminal-option').click();
      const terminal = page.getByTestId('remote-terminal').filter({ visible: true }).first();
      await expect(terminal).toBeVisible({ timeout: 30000 });
      await terminal.locator('textarea.xterm-helper-textarea').click();
      await page.keyboard.insertText("printf '__WORKSPACE_%s__\\n' 'PANEL_READY'");
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await terminal.locator('.xterm-rows').innerText()).split('\n')
        .map(line => line.trim()).includes('__WORKSPACE_PANEL_READY__'), { timeout: 30000 }).toBe(true);
      await page.waitForLoadState('networkidle');
      assert.ok(Object.keys(current.assets).some(path => /\/RemoteTerminal-/.test(path)),
        'opening the runtime terminal must load its actual terminal code');
      assert.equal(counts.turnStarts, 1, 'opening workspace panels must not submit another model turn');
      assert.equal(model.requests.length, 1, 'terminal input must not call the model');
      await page.screenshot({ path: context.pathInArtifacts('workspace-terminal-on-demand.png') });
    });
    await waitFor(() => sockets.every(socket => socket.taskObservationReplies.completed + socket.taskObservationReplies.failed ===
      (socket.rpc['thread/expert'] || 0) + (socket.rpc['agent/list'] || 0) + (socket.rpc['tools/catalog'] || 0)),
      15000, 'Native task observation replies', 50, context.abortSignal);
    for (const socket of sockets) assert.equal(socket.taskObservationReplies.failed, 0,
      'visible expert, subagent and tool catalog reads must receive successful Native results');
    await phase('migration-deferred-loading', async () => {
      await page.goto(`${gateway.baseUrl}/settings/general`, { waitUntil: 'domcontentloaded' });
      const trigger = page.getByTestId('general-external-content-import-button');
      await expect(trigger).toBeVisible();
      await page.waitForLoadState('networkidle');
      assert.equal(Object.keys(current.assets).some(path => /\/MigrationDialogContent-/.test(path)), false,
        'visiting general settings must not load unopened migration content');
      let release;
      const held = new Promise(resolve => { release = resolve; });
      let requested = false, handled = false, releaseFailure;
      const routePath = url => url.origin === gateway.baseUrl && /\/assets\/MigrationDialogContent-[^/]+\.js$/.test(url.pathname);
      const hold = async route => {
        requested = true;
        await held;
        try { await route.continue(); }
        catch (error) { releaseFailure = error; }
        finally { handled = true; }
      };
      await page.route(routePath, hold);
      try {
        await trigger.click();
        const dialog = page.getByTestId('migration-dialog');
        await expect(dialog.getByRole('status')).toBeVisible();
        await expect.poll(() => requested).toBe(true);
        await expect(page.getByTestId('migration-dialog-close')).toBeEnabled();
        await page.screenshot({ path: context.pathInArtifacts('migration-loading.png') });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
      } finally {
        release();
        try {
          if (requested) await waitFor(() => handled, 5000, 'held migration resource release', 20, context.abortSignal);
        } finally { await page.unroute(routePath, hold); }
      }
      if (releaseFailure) throw releaseFailure;
      await page.waitForLoadState('networkidle');
      await pause(200);
      await expect(page.getByTestId('migration-dialog')).toHaveCount(0);
      await trigger.click();
      const dialog = page.getByTestId('migration-dialog');
      await expect(dialog.locator('#migration-target')).toHaveValue('local');
      await expect(dialog.getByTestId('migration-quick-history')).toBeVisible();
      await expect(dialog.getByRole('status')).toHaveCount(0);
      await expect(page.getByTestId('migration-dialog-close')).toBeFocused();
      await page.screenshot({ path: context.pathInArtifacts('migration-ready.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      assert.ok(Object.keys(current.assets).some(path => /\/MigrationDialogContent-/.test(path)),
        'opening migration must load the actual compiled content');
    });
    await phase('migration-load-failure', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const trigger = page.getByTestId('general-external-content-import-button');
      await expect(trigger).toBeVisible();
      const routePath = url => url.origin === gateway.baseUrl && /\/assets\/MigrationDialogContent-[^/]+\.js$/.test(url.pathname);
      await page.route(routePath, route => route.abort('failed'));
      try {
        await trigger.click();
        const dialog = page.getByTestId('migration-dialog');
        await expect(dialog.getByRole('alert')).toContainText(/无法加载迁移界面|Could not load migration/);
        await expect(dialog.getByRole('status')).toHaveCount(0);
        await page.screenshot({ path: context.pathInArtifacts('migration-load-failure.png') });
        await page.getByTestId('migration-dialog-close').click();
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
      } finally { await page.unroute(routePath); }
      assert.equal(counts.turnStarts, 1, 'migration presentation must not submit another turn');
      assert.equal(model.requests.length, 1, 'opening or failing migration must not ask the model');
      // Equality alone can pass before the initial directory scan has sent its reads.
      await waitFor(() => sockets.some(socket => socket.openedIn === current.name &&
        socket.rpc['thread/list'] > 0 && socket.rpc['thread/goal/status/readMany'] > 0),
      15000, 'old document initial history and Goal batch requests', 50, context.abortSignal);
      await waitForDirectoryReplies();
    });
    await phase('tool-settings-on-demand', async () => {
      await page.goto(`${gateway.baseUrl}/settings/tools`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('tool-selections-settings-page')).toBeVisible();
      await expect(page.getByTestId('tool-selections-target')).toHaveValue('local');
      await expect(page.getByTestId('tool-selections-pagination')).toBeVisible();
      await expect(page.getByTestId('tool-selections-refresh')).toBeEnabled();
      await waitFor(() => current.replies.toolSelectionReplies?.completed === 1,
        15000, 'on-demand Native tool selection response', 50, context.abortSignal);
      assert.equal(current.rpc['settings/tools/selection/read'], 1);
      assert.equal(current.replies.toolSelectionReplies.failed, 0);
      await page.getByTestId('tool-selections-mode-kworker').click();
      await expect(page.getByTestId('tool-selections-mode-kworker')).toHaveAttribute('aria-selected', 'true');
      assert.equal(current.rpc['settings/tools/selection/read'], 1, 'switching displayed mode reuses the editor snapshot');
      await page.screenshot({ path: context.pathInArtifacts('tool-settings-ready.png') });
    });
    await phase('tool-settings-explicit-refresh', async () => {
      await page.getByTestId('tool-selections-refresh').click();
      await waitFor(() => current.replies.toolSelectionReplies?.completed === 1,
        15000, 'refreshed Native tool selection response', 50, context.abortSignal);
      await expect(page.getByTestId('tool-selections-refresh')).toBeEnabled();
      await expect(page.getByTestId('tool-selections-pagination')).toBeVisible();
      assert.equal(current.rpc['settings/tools/selection/read'], 1);
      assert.equal(current.replies.toolSelectionReplies.failed, 0);
    });
    await phase('runtime-target-settings-on-demand', async () => {
      await page.getByTestId('settings-nav-kcoder-servers').click();
      await expect(page.getByTestId('runtime-target-row-local')).toBeVisible();
      await expect(page.getByTestId('runtime-target-add')).toBeEnabled();
      await expect(page.getByTestId('runtime-target-row-local')).toContainText('Desktop cost target');
      await page.waitForLoadState('networkidle');
      assert.ok(phases.some(sample => Object.keys(sample.assets).some(path => /\/KCoderServersSettingsPage-/.test(path))),
        'runtime-target settings remain loadable after their startup dependency is removed');
      assert.equal(counts.turnStarts, 1, 'reading runtime targets must not start another turn');
      assert.equal(model.requests.length, 1, 'reading runtime targets must not ask the model');
    });
    await phase('execution-defaults-on-demand', async () => {
      await page.getByTestId('settings-nav-execution-defaults').click();
      await expect(page.getByTestId('execution-defaults-settings-page')).toBeVisible();
      await expect(page.getByTestId('execution-settings-target-select')).toHaveValue('local');
      const permission = page.getByTestId('execution-default-permission-select');
      const save = page.getByTestId('execution-default-permission-save');
      await expect(permission).toBeEnabled();
      const original = await permission.inputValue();
      assert.ok(['', 'ask', 'auto', 'accept_edits', 'dont_ask', 'bypass', 'yolo'].includes(original));
      await expect(save).toBeDisabled();
      await permission.selectOption(original === 'ask' ? 'auto' : 'ask');
      await expect(save).toBeEnabled();
      await permission.selectOption(original);
      await expect(save).toBeDisabled();
      assert.equal(current.rpcRequests['settings/execution-defaults/read'], 1,
        'opening the page must consume one real Native defaults response');
      assert.equal(current.rpcRequests['settings/execution-defaults/save'] || 0, 0,
        'editing and reverting an unsent draft must not write the target profile');
      assert.equal(counts.turnStarts, 1);
      assert.equal(model.requests.length, 1);
      await context.writeArtifactJson('execution-defaults-read.json', {
        target: 'owned-local', nativeReadRequests: 1, saveRequests: 0,
        originalPermissionMode: original, unsentDraftReverted: true,
        boundary: 'Actual UI/Gateway/Native profile read; account-switch races remain controlled component tests',
      });
    });
    await phase('context-instructions-cold-read', async () => {
      await page.goto(`${gateway.baseUrl}/settings/context`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('context-runtime-target-select')).toHaveValue('local');
      const input = page.getByTestId('context-studio-instructions-textarea');
      const save = page.getByTestId('context-studio-instructions-save-button');
      await expect(input).toBeEnabled();
      await expect(save).toBeDisabled();
      await expect(page.getByTestId('context-studio-instructions-error')).toHaveCount(0);
      await expect(page.getByTestId('codex-personality-select')).toBeEnabled();
      await expect(page.getByTestId('tool-profile-select')).toBeEnabled();
      const original = await input.inputValue();
      await input.fill(`${original}Owned unsent context draft`);
      await expect(save).toBeEnabled();
      await input.fill(original);
      await expect(save).toBeDisabled();
      assert.ok(current.rpcRequests['runtime.context.get'] >= 1,
        'a cold context page must complete its actual Native instructions read');
      assert.equal(current.rpcRequests['runtime.context.update'] || 0, 0,
        'editing and reverting an unsent draft must not modify Native context');
      assert.equal(counts.turnStarts, 1);
      assert.equal(model.requests.length, 1);
      await context.writeArtifactJson('context-instructions-read.json', {
        coldEntryRead: true, editorReady: true, personalityReady: true, toolProfileReady: true, unsentDraftReverted: true, nativeWrites: 0,
        boundary: 'Actual UI/Gateway/Native cold read; cross-account writes and retirement are controlled contracts',
      });
    });
    await page.waitForLoadState('networkidle');
    await phase('keyboard-client-preferences', async () => {
      await page.getByTestId('settings-nav-keyboard-shortcuts').click();
      await expect(page.getByTestId('keyboard-shortcuts-settings-page')).toBeVisible();
      const record = page.getByTestId('keyboard-shortcut-record-openTerminal');
      await expect(record).toBeEnabled();
      await record.click();
      await page.keyboard.press('Control+Alt+Shift+k');
      await expect(record).toContainText('Ctrl Alt Shift K');
      await expect(page.getByTestId('keyboard-shortcuts-error')).toHaveCount(0);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('kcoder-studio:keybindings-v1') || '[]')
        .some(value => value.command === 'openTerminal' && value.key === 'Control+Alt+Shift+K')), true);
      await page.getByTestId('keyboard-shortcut-reset-openTerminal').click();
      await expect(record).toContainText('Ctrl J');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('kcoder-studio:keybindings-v1') || '[]')
        .some(value => value.command === 'openTerminal')), false);
      assert.deepEqual(current.rpcRequests, {}, 'client shortcut preferences must not issue Native RPCs');
      assert.deepEqual(current.http, {}, 'client shortcut preferences must not read a target directory or health');
      assert.equal(counts.turnStarts, 1);
      assert.equal(model.requests.length, 1);
    });
    await phase('imported-memory-on-demand', async () => {
      await page.getByTestId('settings-nav-context').click();
      const panel = page.getByTestId('imported-memory-panel');
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute('aria-busy', 'false');
      assert.equal(current.rpcRequests['migration/memory/list'] || 0, 0,
        'displaying imported memory must not eagerly read notes');
      await panel.getByRole('button', { name: /^(查看或刷新笔记|View or refresh notes)$/ }).click();
      await expect(panel).toContainText(/此目标尚无迁入的记忆笔记|No imported memory notes on this target/);
      await expect(panel).toHaveAttribute('aria-busy', 'false');
      assert.equal(current.rpcRequests['migration/memory/list'], 1);
      assert.equal(current.rpcRequests['migration/memory/control'] || 0, 0);
      assert.equal(counts.turnStarts, 1);
      assert.equal(model.requests.length, 1);
    });
    await phase('imported-memory-hidden-invalidation', async () => {
      await page.waitForLoadState('networkidle');
      await cover.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
      await page.evaluate(() => window.dispatchEvent(new Event('kcoder:servers-changed')));
      await pause(700);
      await expect(page.getByTestId('imported-memory-panel')).toHaveCount(0);
      assert.equal(current.http['GET /api/servers'], 1,
        'hidden notes display must defer its directory read while the runtime verifies the command owner');
      assert.equal(current.rpcRequests['migration/memory/list'] || 0, 0,
        'configuration invalidation must not reread notes while hidden');
    });
    await phase('imported-memory-restored', async () => {
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
      const panel = page.getByTestId('imported-memory-panel');
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute('aria-busy', 'false');
      assert.equal(current.rpcRequests['migration/memory/list'] || 0, 0,
        'returning to notes must keep list reads on demand');
      await panel.getByRole('button', { name: /^(查看或刷新笔记|View or refresh notes)$/ }).click();
      await expect(panel).toContainText(/此目标尚无迁入的记忆笔记|No imported memory notes on this target/);
      assert.equal(current.rpcRequests['migration/memory/list'], 1);
      assert.equal(current.rpcRequests['migration/memory/control'] || 0, 0);
      assert.equal(counts.turnStarts, 1);
      assert.equal(model.requests.length, 1);
    });
    await phase('plugin-management-on-demand', async () => {
      await page.goto(`${gateway.baseUrl}/plugins/manage`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('kcoder-plugin-target-select')).toHaveValue('local');
      const panel = page.getByRole('tabpanel');
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('status')).toHaveCount(0);
      await expect(panel.getByRole('alert')).toHaveCount(0);
      assert.ok(current.rpcRequests['plugin/list'] >= 1,
        'management inventory must still read the actual Native plugins');
      for (const method of ['plugin/install', 'plugin/enable', 'plugin/disable', 'plugin/uninstall'])
        assert.equal(current.rpcRequests[method] || 0, 0, 'management display must not modify plugins');
      assert.equal(counts.turnStarts, 1);
      assert.equal(model.requests.length, 1);
    });
    await phase('mcp-directory-on-demand', async () => {
      for (let iteration = 1; iteration <= 2; iteration++) {
        await page.getByTestId('kcoder-plugin-tab-mcp').click();
        await expect(page.getByTestId('kcoder-mcp-management')).toBeVisible();
        await waitFor(() => current.replies.mcpDirectoryReplies?.completed === iteration,
          15000, 'actual target MCP inventory response', 20, context.abortSignal);
        await expect(page.getByTestId('kcoder-playwright-preset')).toBeVisible();
        assert.equal(current.rpcRequests['mcp/list'], iteration,
          'opening the MCP panel reads current target configuration once, without caching a completed authorization result');
        await page.getByTestId('kcoder-plugin-search').fill('owned-mcp-filter-with-no-result');
        await page.getByTestId('kcoder-plugin-search').fill('');
        await page.waitForLoadState('networkidle');
        assert.equal(current.rpcRequests['mcp/list'], iteration,
          'filter presentation updates preserve the current directory read lifetime');
        await expect(page.getByTestId('kcoder-mcp-management').getByRole('alert')).toHaveCount(0);
        await page.getByTestId('kcoder-plugin-tab-plugins').click();
        await expect(page.getByTestId('kcoder-mcp-management')).toHaveCount(0);
      }
      assert.equal(current.replies.mcpDirectoryReplies.failed, 0);
      for (const method of ['mcp/install', 'mcp/setEnabled', 'mcp/remove', 'gateway/mcp/login', 'mcp/cancel'])
        assert.equal(current.rpcRequests[method] || 0, 0, 'directory display does not mutate MCP configuration or authorization');
      assert.equal(counts.turnStarts, 1);
      assert.equal(model.requests.length, 1);
    });
    await phase('mcp-directory-refresh-single-owner', async () => {
      await page.getByTestId('kcoder-plugin-tab-mcp').click();
      await expect(page.getByTestId('kcoder-mcp-management')).toBeVisible();
      await waitFor(() => current.replies.mcpDirectoryReplies?.completed === 1,
        15000, 'MCP panel initial Native reply', 20, context.abortSignal);
      await page.getByTestId('kcoder-plugins-refresh').click();
      await page.waitForLoadState('networkidle');
      await waitFor(() => current.replies.mcpDirectoryReplies?.completed >= 2,
        15000, 'MCP explicit refresh Native reply', 20, context.abortSignal);
      assert.equal(current.rpcRequests['mcp/list'], 2,
        'opening then refreshing MCP shares the panel read with the parent count');
      assert.equal(current.replies.mcpDirectoryReplies.failed, 0);
      assert.ok(current.rpcRequests['plugin/list'] >= 1, 'the parent plugin directory still refreshes');
      assert.ok(current.rpcRequests['skills/list'] >= 1, 'the parent skill directory still refreshes');
      await expect(page.getByTestId('kcoder-mcp-management').getByRole('alert')).toHaveCount(0);
      await page.getByTestId('kcoder-plugin-tab-plugins').click();
    });
    await phase('expert-catalog-on-demand', async () => {
      await page.goto(`${gateway.baseUrl}/experts`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('expert-workspace')).toBeVisible();
      await expect(page.getByTestId('expert-catalog-content')).toHaveAttribute('aria-busy', 'false');
      await expect(page.getByTestId('experts-page').getByRole('alert')).toHaveCount(0);
      assert.equal(current.rpcRequests['agentDefinitions/scope/read'], 1,
        'expert catalog must establish one actual Native resource owner');
      assert.equal(current.rpcRequests['integrations/assistant/list'], 1,
        'expert catalog must consume its actual Native list response');
      for (const method of ['integrations/assistant/saveDraft', 'integrations/assistant/saveVersion', 'integrations/assistant/adopt'])
        assert.equal(current.rpcRequests[method] || 0, 0, 'opening experts must not modify or execute an expert');
      assert.equal(counts.turnStarts, 1);
      assert.equal(model.requests.length, 1);
      await context.writeArtifactJson('expert-catalog-read.json', {
        nativeScopeReads: 1, nativeListReads: 1, mutations: 0, ready: true,
        boundary: 'Actual UI/Gateway/Native directory read; profile replacement and preview ownership use controlled races',
      });
    });
    await phase('expert-library-on-demand', async () => {
      await page.getByRole('tab', { name: /^(内置专家|Built-in experts)$/ }).click();
      await expect(page.getByTestId('expert-catalog-content')).toHaveAttribute('aria-busy', 'false');
      assert.ok(current.rpcRequests['integrations/assistant/list'] >= 1,
        'the first library visit must still consume its actual paginated Native catalog');
      assert.equal(current.rpcRequests['agentDefinitions/scope/read'] || 0, 0);
      assert.equal(counts.turnStarts, 1);
      assert.equal(model.requests.length, 1);
    });
    await phase('expert-catalog-return', async () => {
      await page.getByRole('tab', { name: /^(我的专家|My experts)$/ }).click();
      await expect(page.getByTestId('expert-catalog-content')).toHaveAttribute('aria-busy', 'false');
      assert.equal(current.rpcRequests['integrations/assistant/list'] || 0, 0,
        'returning to the same live personal projection must not repeat its read');
      assert.equal(current.rpcRequests['agentDefinitions/scope/read'] || 0, 0);
      assert.equal(counts.turnStarts, 1);
      assert.equal(model.requests.length, 1);
    });
    await phase('math-module-failure', async () => {
      const routePath = url => url.origin === gateway.baseUrl && /\/assets\/(?:markdownMathPlugin|markdownSyntaxHighlighter)-[^/]+\.js$/.test(url.pathname);
      let syntaxFailures = 0;
      await page.route(routePath, route => {
        if (new URL(route.request().url()).pathname.includes('/markdownSyntaxHighlighter-')) syntaxFailures++;
        return route.abort('failed');
      });
      try {
        await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('desktop-sidebar')).toBeVisible();
        await page.locator('[data-testid^="runtime-local-task-row-"]:visible').first().click();
        await expect(page.getByTestId('markdown-math-unavailable').first()).toBeVisible();
        await expect(page.getByTestId('message-assistant').filter({ hasText: 'DESKTOP_COST_LAST' }).first()).toBeVisible();
        await expect(page.locator('.katex')).toHaveCount(0);
        await expect(page.getByTestId('message-assistant').filter({ hasText: '$x^2$' }).first()).toBeVisible();
        // Lazy rendering can replace the diagram node during a read-only scroll.
        await expect(async () => {
          await page.locator('[data-streamdown="mermaid-block"]').scrollIntoViewIfNeeded({ timeout: 2000 });
          await expect(page.locator('[data-streamdown="mermaid"] svg').first()).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 30000 });
        await expect(page.getByTestId('markdown-mermaid-loading')).toHaveCount(0);
        const syntax = page.getByTestId('markdown-code-block').filter({ hasText: 'const syntaxReady = 42' });
        await expect(syntax.locator('code')).toBeVisible();
        await expect(syntax.locator('code span')).toHaveCount(0);
        await syntax.getByTestId('markdown-code-copy-button').click();
        await expect(syntax.getByTestId('markdown-code-copy-success-icon')).toBeVisible();
        const markdown = page.getByTestId('markdown-code-block').filter({ hasText: '# Wrapped code source' });
        await markdown.getByTestId('markdown-code-wrap-button').click();
        await expect(markdown.locator('code')).toHaveCSS('white-space', 'pre-wrap');
        assert.equal(syntaxFailures, 1, 'one failed syntax module fetch retains all plain code blocks without retries');
        current.syntaxModuleFailure = { attempts: syntaxFailures, sourceReadable: true, copyConfirmed: true, wrapConfirmed: true };
        await page.screenshot({ path: context.pathInArtifacts('math-module-failure.png') });
      } finally { await page.unroute(routePath); }
      assert.equal(counts.turnStarts, 1, 'math fallback must not replay a turn');
      assert.equal(model.requests.length, 1, 'math fallback must not ask the model');
    });
    for (const sample of phases) assert.equal(sample.rpc['settings/tools/selection/save'] || 0, 0,
      'opening and refreshing tool settings must not change tool defaults');
    assert.equal(counts.turnStarts, 1, 'reading tool defaults must not start a session');
    assert.equal(model.requests.length, 1, 'reading tool defaults must not ask the model');
    for (const sample of phases) assert.equal(sample.rpc['tools/catalog'] || 0, 0,
      `${sample.name}: text and thinking without tools must not query tool display metadata`);
    await phase('task-board-before-tool-turn', async () => {
      await page.getByTestId('task-workspace-button').click();
      await expect(page.getByTestId('native-task-workspace')).toBeVisible();
      await waitFor(() => current.replies.workListReplies?.completed >= 1,
        15000, 'actual task-board Native work list', 20, context.abortSignal);
      await pause(450);
      assert.equal(current.rpc['work/list'], 1,
        'work-list observation must wait for directory refresh rather than reading on both sides of it');
      assert.equal(current.rpc.initialize || 0, 0,
        'warm task-board observation must reuse the existing workspace connection');
      await page.locator('[data-testid="workspace-page-header"]:visible')
        .getByRole('button', { name: /^(Back|返回)$/ }).click();
      await expect(page.getByTestId('chat-message-input')).toBeVisible();
      await expect(page.getByTestId('native-task-workspace')).toHaveCount(1);
      await expect(page.getByTestId('native-task-workspace')).toBeHidden();
      const composer = page.getByTestId('chat-message-input');
      await composer.click();
      await expect(composer).toBeFocused();
      // Cross the terminal's 300ms activation sizing window after the user has selected the composer.
      await pause(450);
      await expect(composer).toBeFocused();
      assert.equal(current.rpc['terminal/write'] || 0, 0,
        'returning to a task and selecting its composer must not send input to the retained terminal');
    });
    await phase('first-tool-metadata-on-demand', async () => {
      await page.evaluate(() => {
        const send = WebSocket.prototype.send;
        const probe = window.__desktopCatalogProbe = { attempts: 0, held: null,
          release: () => { const held = probe.held; probe.held = null; held?.(); },
          restore: () => { WebSocket.prototype.send = send; probe.release(); } };
        WebSocket.prototype.send = function(data) {
          let frame; try { frame = JSON.parse(String(data)); } catch { return send.call(this, data); }
          if (frame.method === 'tools/catalog' && ++probe.attempts === 1) {
            // Hold only this owned read; lifecycle frames and actual Native tool execution continue.
            probe.held = () => send.call(this, data);
            return;
          }
          return send.call(this, data);
        };
      });
      try {
        const composer = page.getByTestId('chat-message-input');
        await expect(composer).toBeVisible();
        await composer.fill('Read the owned README for the tool metadata check.');
        await expect(composer).toHaveText('Read the owned README for the tool metadata check.');
        await page.getByTestId('send-message-button').click();
        await expect(page.getByTestId('message-assistant').filter({ hasText: 'TOOL_METADATA_COMPLETE' })).toBeVisible({ timeout: 30000 });
        await expect(page.getByTestId('pause-response-button')).toHaveCount(0);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        current.catalogOverlap = await page.evaluate(() => ({
          attemptsBeforeRelease: window.__desktopCatalogProbe.attempts,
          readHeld: Boolean(window.__desktopCatalogProbe.held),
        }));
        assert.deepEqual(current.catalogOverlap, { attemptsBeforeRelease: 1, readHeld: true },
          'tool and terminal lifecycle changes must wait for the unfinished original read');
        await page.evaluate(() => window.__desktopCatalogProbe.release());
        await waitFor(() => counts.completions === 2 && current.rpc['tools/catalog'] === 1,
          15000, 'first actual tool and its on-demand catalog', 50, context.abortSignal);
        await expect(page.getByTestId('pause-response-button')).toHaveCount(0);
        await waitFor(() => sockets.every(socket => socket.taskObservationReplies.completed + socket.taskObservationReplies.failed ===
          (socket.rpc['thread/expert'] || 0) + (socket.rpc['agent/list'] || 0) + (socket.rpc['tools/catalog'] || 0)),
          15000, 'actual tool catalog Native results', 50, context.abortSignal);
        for (const socket of sockets) assert.equal(socket.taskObservationReplies.failed, 0);
        await waitFor(() => sockets.some(socket => socket.receiptTimeline.some(event =>
          event.phase === 'first-tool-metadata-on-demand' && event.event === 'reply' && event.status === 'completed')) &&
          sockets.every(socket => socket.receiptReplies.completed + socket.receiptReplies.failed === (socket.rpc['turn/receipt/read'] || 0)),
          15000, 'original input receipt Native results', 50, context.abortSignal);
        assert.equal(current.rpc['work/list'] || 0, 0, 'the retained hidden task board must not reread on real turn changes');
        assert.equal(current.rpc['integrations/tasks/readWorkspace'] || 0, 0, 'hidden task details must not read another snapshot');
        assert.equal(current.rpc['turn/receipt/read'], 2, 'one input receipt and one terminal reconciliation; no reread of the running projection');
        assert.equal(current.rpc['session/modes'] || 0, 0, 'tool and Memory presentation enrichment must not reload the original session mode');
        assert.equal(current.rpc['thread/goal/get'], 1, 'the settled tool turn rechecks its Goal once; presentation enrichment must not reload it');
        for (const socket of sockets) {
          assert.equal(socket.receiptReplies.failed, 0);
          assert.equal(socket.receiptOverflow, 0, 'receipt timeline must not silently drop events');
          assert.equal(socket.modelCatalogOverflow, 0, 'model catalog scope observations must not silently drop reads');
          assert.equal(socket.toolCatalogOverflow, 0, 'tool catalog lifecycle observations must not silently drop events');
          assert.equal(socket.toolCatalogTimeline.filter(event => event.event === 'catalog-read').length,
            socket.rpc['tools/catalog'] || 0, 'every tools catalog read must retain its lifecycle position');
        }
        assert.equal(counts.turnStarts, 2);
        assert.equal(model.requests.length, 3, 'one plain response and one read tool round trip');
        assert.equal(terminalStatus, 'completed');
        assert.equal(current.rpc['tools/catalog'], 1,
          'tool execution and turn completion do not invalidate unchanged catalog metadata');
      } finally {
        await page.evaluate(() => { window.__desktopCatalogProbe.restore(); delete window.__desktopCatalogProbe; });
      }
    });
    await phase('tool-catalog-notification-burst', async () => {
      await page.evaluate(() => {
        for (let index = 0; index < 100; index++)
          window.dispatchEvent(new Event('kcoder:tools-catalog-invalidated'));
      });
      await waitFor(() => current.rpc['tools/catalog'] === 1 && sockets.every(socket =>
        socket.taskObservationReplies.completed + socket.taskObservationReplies.failed ===
          (socket.rpc['thread/expert'] || 0) + (socket.rpc['agent/list'] || 0) + (socket.rpc['tools/catalog'] || 0)),
      15000, 'one latest tools catalog Native reply after notification burst', 50, context.abortSignal);
      await pause(600);
      assert.equal(current.rpc['tools/catalog'], 1,
        'one same-turn invalidation cohort must dispatch only its latest catalog read');
      for (const socket of sockets) assert.equal(socket.taskObservationReplies.failed, 0);
      assert.equal(counts.turnStarts, 2);
      assert.equal(model.requests.length, 3, 'display metadata refresh must not invoke the model');
    });
    await phase('history-turn-navigation-layout', async () => {
      // The split retains its chosen chat width; close it before testing the wide navigation.
      await page.getByTestId('toggle-right-workspace-panel-button').click();
      await page.setViewportSize({ width: 1600, height: 900 });
      await expect.poll(() => page.getByTestId('desktop-chat-scroll')
        .evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(1024);
      await expect(page.getByTestId('message-turn-navigation')).toBeVisible();
      await pause(600);
    });
    await phase('history-turn-navigation', async () => {
      const markers = page.getByTestId('message-turn-navigation-marker');
      await expect(markers).toHaveCount(2);
      for (let index = 0; index < 8; index++) await markers.nth(index % 2).hover();
      await markers.first().click();
      await expect(page.getByTestId('message-user').filter({ hasText: 'DESKTOP_COST_PROMPT' }))
        .toBeInViewport();
      await markers.last().click();
      await expect(page.getByTestId('message-user').filter({ hasText: 'Read the owned README for the tool metadata check.' }))
        .toBeInViewport();
      await expect(page.getByTestId('message-turn-navigation-preview').last())
        .toContainText('TOOL_METADATA_COMPLETE');
      await pause(600);
      assert.deepEqual(current.http, {}, 'loaded turn navigation must not reread HTTP directories');
      assert.deepEqual(current.rpc, {}, 'loaded turn navigation must not load history or invoke tools');
      assert.equal(counts.turnStarts, 2);
      assert.equal(model.requests.length, 3, 'navigation must not submit another model request');
    });
    await phase('history-turn-navigation-restore-layout', async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByTestId('toggle-right-workspace-panel-button').click();
      await expect(page.getByTestId('remote-terminal').filter({ visible: true }).first()).toBeVisible();
      await pause(600);
    });
    await phase('task-board-return-after-tool-turn', async () => {
      await page.getByTestId('task-workspace-button').click();
      await expect(page.getByTestId('native-task-workspace')).toBeVisible();
      await waitFor(() => current.replies.workListReplies?.completed >= 1,
        15000, 'current task-board Native work list after returning', 20, context.abortSignal);
      await pause(450);
      assert.equal(current.rpc['work/list'], 1,
        'returning to the task board must read its current work list once after directory refresh');
      assert.equal(current.rpc.initialize || 0, 0,
        'returning to the task board must read afresh over the existing workspace connection');
      await page.locator('[data-testid="workspace-page-header"]:visible')
        .getByRole('button', { name: /^(Back|返回)$/ }).click();
      await expect(page.getByTestId('chat-message-input')).toBeVisible();
      assert.equal(counts.turnStarts, 2);
      assert.equal(model.requests.length, 3);
    });
    await phase('session-message-panel-reads', async () => {
      await page.getByTestId('session-messages-open').click();
      const dialog = page.getByTestId('session-messages-dialog');
      await expect(dialog).toBeVisible();
      await waitFor(() => current.replies.agentMessageReplies?.completed === 1,
        15000, 'original task disabled message policy Native reply', 20, context.abortSignal);
      const policy = dialog.getByTestId('session-message-policy-enable');
      await expect(policy).toBeEnabled();
      await expect(dialog.getByTestId('session-message-policy-wake')).toHaveCount(0);
      assert.equal(current.rpc['thread/agentMessage/targets'] || 0, 0,
        'disabled workspace policy must not discover receivers');
      // Change only this run-owned workspace through the actual revision-checked control.
      await policy.click();
      await waitFor(() => current.replies.agentMessageReplies?.completed === 3,
        15000, 'enabled message policy and directory Native replies', 20, context.abortSignal);
      await expect(dialog.getByTestId('session-message-policy-wake')).toBeVisible();
      await expect(dialog.getByTestId('session-message-policy-wake')).not.toBeChecked();
      const refresh = dialog.getByRole('button', { name: /^(刷新|Refresh)$/ });
      await expect(refresh).toBeEnabled();
      await expect(dialog.locator('[role="alert"]:visible')).toHaveCount(0);
      assert.equal(current.rpc['thread/agentMessage/policy/read'], 2);
      assert.equal(current.rpc['thread/agentMessage/targets'], 1);
      await refresh.click();
      await waitFor(() => current.replies.agentMessageReplies?.completed === 5,
        15000, 'explicit message panel refresh Native replies', 20, context.abortSignal);
      await expect(refresh).toBeEnabled();
      assert.equal(current.rpc['thread/agentMessage/policy/read'], 3);
      assert.equal(current.rpc['thread/agentMessage/targets'], 2);
      await policy.click();
      await waitFor(() => current.replies.agentMessageReplies?.completed === 6,
        15000, 'original disabled policy restored and read from Native', 20, context.abortSignal);
      await expect(policy).toBeEnabled();
      await expect(dialog.getByTestId('session-message-policy-wake')).toHaveCount(0);
      await expect(dialog.locator('[role="alert"]:visible')).toHaveCount(0);
      assert.equal(current.rpc['thread/agentMessage/policy/read'], 4);
      assert.equal(current.rpc['thread/agentMessage/targets'], 2);
      assert.equal(current.rpc['thread/agentMessage/policy/save'], 2);
      assert.equal(current.replies.agentMessageReplies.failed, 0);
      assert.equal(current.rpc['thread/agentMessage/send'] || 0, 0);
      current.messagePolicy = { initiallyDisabled: true, explicitlyEnabled: true,
        restoredDisabled: true, wakeIdleEnabled: false, messagesSent: 0 };
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      assert.equal(model.requests.length, 3, 'reading the existing message panel must not ask the model');
    });
    await phase('on-demand-pane-diagnostics', async () => {
      const draft = 'Owned diagnostic draft';
      const composer = page.getByTestId('chat-message-input');
      await composer.click();
      await page.keyboard.insertText(draft);
      await page.keyboard.press('Control+Alt+Shift+P');
      await page.locator('[data-command-id="open-debug-panel"]').click();
      const panel = page.getByRole('dialog', { name: 'Debug panel', exact: true });
      await expect(panel).toBeVisible();
      const inspect = () => panel.locator('pre').first().evaluate(node => {
        const snapshot = JSON.parse(node.textContent);
        return { sameTask: Boolean(snapshot.pane?.currentRuntimeTask?.taskId &&
          snapshot.pane.currentRuntimeTask.taskId === snapshot.workbench?.currentRuntimeTask?.taskId),
        messageCount: snapshot.pane?.messageSummary?.total,
        memoryMessageCount: snapshot.pane?.memory?.messages?.count,
        paneInputLength: snapshot.pane?.inputLength,
        workbenchInputLength: snapshot.workbench?.composer?.currentInputLength,
        directoryTaskCount: snapshot.workbench?.runtimeWorkSummary?.totalTasks,
        bootstrapping: snapshot.workbench?.isBootstrapping,
        activeAssistant: Boolean(snapshot.pane?.messageSummary?.activeAssistantMessage),
        busy: snapshot.pane?.status?.isBusy };
      });
      const first = await inspect();
      assert.equal(first.sameTask, true);
      assert.ok(first.messageCount > 0);
      assert.equal(first.memoryMessageCount, first.messageCount, 'first requested snapshot must calculate current memory diagnostics');
      assert.equal(first.paneInputLength, draft.length);
      assert.equal(first.workbenchInputLength, draft.length, 'workbench snapshot must calculate the current draft on demand');
      assert.ok(first.directoryTaskCount > 0);
      assert.equal(first.bootstrapping, false);
      assert.equal(first.activeAssistant, false);
      assert.equal(first.busy, false);
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
      assert.deepEqual(await inspect(), first);
      await panel.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect(composer).toHaveText(draft);
      await fillComposerText(page, '', { signal: context.abortSignal });
      current.diagnostics = first;
      for (const method of ['session/modes', 'tools/catalog', 'turn/start', 'turn/receipt/read'])
        assert.equal(current.rpc[method] || 0, 0, `diagnostic snapshot must not issue ${method}`);
    });
    await phase('fork-dialog-display-preferences', async () => {
      await page.getByTestId('desktop-sidebar').getByTestId('settings-button').click();
      await page.getByTestId('settings-menu-button').click();
      const experimental = page.getByTestId('general-experimental-features-toggle');
      await expect(experimental).toHaveAttribute('aria-checked', 'false');
      await experimental.click();
      await expect(experimental).toHaveAttribute('aria-checked', 'true');
      await expect(experimental).toBeEnabled();
      await page.getByTestId('settings-back-button').click();
      await expect(page.getByTestId('fork-runtime-task-button')).toBeVisible();
      await page.waitForLoadState('networkidle');
      assert.equal(current.http['GET /api/experience/conversations'] || 0, 0,
        'experimental display preferences do not reread experience configuration');
    });
    await phase('fork-dialog-on-demand', async () => {
      const originalUrl = page.url();
      assert.ok(threadId);
      for (let index = 0; index < 2; index++) {
        await page.getByTestId('fork-runtime-task-button').click();
        await expect(page.getByTestId('task-fork-dialog')).toBeVisible();
        await expect(page.getByTestId('task-fork-dialog')).toContainText(`kcoder:local:${threadId}`);
        // This owned Gateway has only its original device, so no other target can be selected.
        await expect(page.getByTestId('task-fork-confirm-button')).toBeDisabled();
        await page.getByTestId('task-fork-close-button').click();
        await expect(page.getByTestId('task-fork-dialog')).toHaveCount(0);
      }
      assert.equal(page.url(), originalUrl);
      for (const method of ['runtime.workspaces.list', 'runtime.worktrees.list', 'thread/list', 'thread/fork', 'turn/start'])
        assert.equal(current.rpc[method] || 0, 0, `opening and closing the fork selector must not issue ${method}`);
      assert.deepEqual(current.http, {}, 'fork target display must use the current directory projection');
      assert.equal(counts.turnStarts, 2);
      assert.equal(model.requests.length, 3, 'opening the fork selector must not request the model');
    });
    await phase('provider-task-settings-on-demand', async () => {
      await page.getByTestId('desktop-sidebar').getByTestId('settings-button').click();
      const entry = page.getByTestId('settings-nav-model-settings');
      if (!await entry.isVisible()) await page.getByTestId('settings-menu-button').click();
      await entry.click();
      await expect(page.getByTestId('provider-target')).toHaveValue('local');
      await expect(page.getByTestId('provider-new')).toBeEnabled();
      await waitFor(() => current.replies.providerReplies?.completed === 1,
        15000, 'one actual task-scoped provider settings response', 50, context.abortSignal);
      assert.equal(current.rpcRequests['runtime.providers.list'], 1,
        'Runtime capability negotiation must not read the profile before its task scope');
      assert.deepEqual(current.providerReadScopes, { original: 1, unscoped: 0, other: 0 });
      assert.equal(current.replies.providerReplies.failed, 0);
      for (const method of ['runtime.providers.probe', 'runtime.providers.upsert', 'runtime.providers.delete', 'runtime.providers.validate'])
        assert.equal(current.rpcRequests[method] || 0, 0, 'opening settings must not test or modify a provider');
      assert.equal(counts.turnStarts, 2);
      assert.equal(model.requests.length, 3);
    });
    await waitForDirectoryReplies();
    for (const sample of phases) for (const method of ['cron/create', 'cron/delete'])
      assert.equal(sample.rpc[method] || 0, 0, 'schedule display checks must not create or delete jobs');
    for (const socket of sockets) assert.equal(socket.historyReplies.failed, 0);
    for (const socket of sockets) {
      assert.equal(socket.workActivityOverflow, 0, 'work activity timeline must not silently drop triggers');
      assert.equal(socket.historyOverflow, 0, 'directory read timeline must not silently drop requests');
      assert.equal(socket.historyTimeline.length,
        (socket.rpc['thread/list'] || 0) + (socket.rpc['thread/goal/status/readMany'] || 0) + (socket.rpc['agent/list'] || 0),
        'every history, Goal-directory and subagent-list query must retain its bounded timing observation');
      assert.ok(socket.historyTimeline.every(read => read.outcome === 'completed' && Number.isFinite(read.completedAtMs)),
        'directory query timing requires a successful Native reply, not only a sent frame');
    }
    await waitFor(() => sockets.every(socket => socket.goalReplies.completed + socket.goalReplies.failed ===
      (socket.rpc['thread/goal/get'] || 0)), 15000, 'actual Goal read Native replies', 50, context.abortSignal);
    for (const socket of sockets) assert.equal(socket.goalReplies.failed, 0);
    assert.ok(sockets.some(socket => socket.rpc['thread/list'] && socket.rpc['device/execute']),
      'workspace history must borrow an existing matching command connection');
    for (const sample of phases.filter(value => ['terminal', 'first-tool-metadata-on-demand', 'on-demand-pane-diagnostics'].includes(value.name)))
      assert.equal(sample.rpc.initialize || 0, 0, `${sample.name}: warm history reconciliation must not initialize a new connection`);
    await waitFor(() => directoryReads.requests.length === [...phases, betweenPhases]
      .reduce((sum, phase) => sum + (phase.http['GET /api/servers'] || 0), 0) &&
      directoryReads.healthRequests.length === [...phases, betweenPhases]
        .reduce((sum, phase) => sum + (phase.http['GET /api/servers/status'] || 0), 0),
    5000, 'all directory and health wire requests retain their passive initiators', 20, context.abortSignal);
    assert.equal(directoryReads.overflow, 0);
    assert.ok(directoryReads.healthRequests.some(row => row.initiator.length > 0));
    const navigationTiming = navigationSockets.snapshot();
    assert.equal(navigationTiming.overflow, 0, 'navigation read timing must remain bounded without dropping evidence');
    assert.ok(navigationTiming.documents.filter(row => Number.isFinite(row.startedAtMonotonic)).length >= 4,
      'actual warm navigations need Chromium document-start timestamps');
    assert.ok(navigationTiming.sockets.some(socket => socket.route.matches && socket.sentReads.length > 0),
      'ordinary runtime routes must retain passive read timing');
    assert.ok(navigationTiming.sockets.flatMap(socket => socket.sentReads).every(row => Number.isFinite(row.sentAtMonotonic)),
      'read timing cannot be inferred from observation order');
    verified = true;
  } finally {
    if (!page.isClosed()) await page.evaluate(() => { window.__desktopClockProbe?.observer.disconnect(); delete window.__desktopClockProbe; });
    await context.writeArtifactJson('directory-read-initiators.json', directoryReads);
    await context.writeArtifactJson('navigation-socket-diagnostics.json', navigationSockets.snapshot());
    const finalAuth = authCounts();
    betweenPhases.auth = Object.fromEntries(Object.keys(finalAuth).map(field => [field,
      finalAuth[field] - initialAuth[field] - phases.reduce((sum, phase) => sum + (phase.auth?.[field] ?? 0), 0)]));
    for (const count of Object.values(betweenPhases.auth))
      assert.ok(count >= 0, 'auth observation windows must not overlap');
    await context.writeArtifactJson('read-domain-metrics.json', {
      ...summarizeReadDomains([...phases, betweenPhases]), hostLoad: { before: hostLoadBefore, after: loadavg() },
      boundary: 'Owned foreground workflow before teardown; gaps between named phases included; no public/installed/live-model latency claim',
    });
    await context.writeArtifactJson('desktop-request-cost.json', { verified, binarySha, renderer, freshness, phases, counts, sockets,
      modelRequests: model.requests.length, scope: 'Owned Linux headful desktop renderer; genuine tab visibility; no installed/public/live-model performance claim' });
    if (!verified && !page.isClosed()) await page.screenshot({ path: context.pathInArtifacts('desktop-request-cost-failure.png') });
  }
});
