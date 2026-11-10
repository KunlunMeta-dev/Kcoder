import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'task-collaboration-actual-native-authoring', tier: 'full-integration',
  modelPolicy: 'Model-independent actual native draft CAS/fixed-version save via authenticated Gateway and browser. The loopback Provider must receive zero generation calls; this does not assess role execution or model quality.',
  retainSuccessEvidence: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'current KCoder app-server');
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'AUTHORING_MUST_NOT_CALL_MODEL' });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'native-collaboration-authoring' });
  const { path: peerWorkspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'native-collaboration-peer' });
  const settings = {
    active_provider: 'authoring-protocol', permission_mode: 'bypass', max_retries: 0,
    session_memory: { enabled: false },
    providers: { 'authoring-protocol': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'authoring-protocol', context_window_tokens: 128000,
      max_output_tokens: 4096, output_headroom_tokens: 8192, no_proxy: true, discover_models: false } },
  };
  const settingsFile = await context.writeStateJson('profile/settings.json', settings);
  const peerSettingsFile = await context.writeStateJson('peer-profile/settings.json', settings);
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Authoring target A', transport: 'local', command: binary, workspace, settingsFile },
    { id: 'peer', label: 'Authoring target B', transport: 'local', command: binary, workspace: peerWorkspace, settingsFile: peerSettingsFile },
  ]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true,
    ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}),
    env: { KCODER_CONFIG_DIR: context.pathInState('profile') } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1400, height: 1050 } });
  await page.emulateMedia({ colorScheme: 'light' });
  const pageErrors = [], wire = [], receipts = [], held = new Map();
  const fault = { dropNext: null, holdTargets: new Set(), dropped: [], released: [] };
  const ownedRoutes = new Set();
  // Existing suite pattern: the owned browser transport forwards genuine native
  // requests/results. Only selected successful ACK frames are held or dropped.
  await page.routeWebSocket('**/rpc?**', route => {
    const serverId = new URL(route.url()).searchParams.get('server');
    const upstream = route.connectToServer();
    const pending = new Map();
    ownedRoutes.add(route);
    route.onMessage(message => {
      try {
        const frame = JSON.parse(String(message));
        if (typeof frame.method === 'string') {
          pending.set(String(frame.id), frame.method);
          wire.push({ serverId, method: frame.method });
        }
      } catch { /* Transport bytes are forwarded unchanged; no raw frames retained. */ }
      upstream.send(message);
    });
    upstream.onMessage(message => {
      let frame, method;
      try {
        frame = JSON.parse(String(message)); method = pending.get(String(frame.id));
        pending.delete(String(frame.id));
      } catch { /* The real client handles malformed frames. */ }
      if (method?.startsWith('workflow/') && frame?.result && !frame.error) {
        const value = frame.result;
        receipts.push({ serverId, method, ...(typeof value.id === 'string' ? { id: value.id, revision: value.revision, savedVersion: value.savedVersion ?? null } : {}) });
        if (method === fault.dropNext) {
          fault.dropNext = null;
          fault.dropped.push({ serverId, method, id: value.id, revision: value.revision });
          route.close({ code: 1011, reason: 'owned committed authoring ACK interruption' });
          upstream.close();
          return;
        }
        if (method === 'workflow/collaboration/catalog' && fault.holdTargets.delete(serverId)) {
          assert.ok(!held.has(serverId), 'One bounded held catalog result per original target');
          held.set(serverId, () => {
            held.delete(serverId); fault.released.push(serverId);
            try { route.send(message); } catch { /* A cancelled old caller may already be closed. */ }
          });
          return;
        }
      }
      route.send(message);
    });
  });
  context.addCleanup('release owned authoring fault routes', async () => {
    for (const release of [...held.values()]) release();
    for (const route of ownedRoutes) { try { route.close(); } catch { /* Already closed by its owned browser. */ } }
    ownedRoutes.clear();
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  let readRpc;
  const cases = [];
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    const csrf = await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content');
    assert.ok(csrf); context.registerSecret(csrf);
    const cookie = (await page.context().cookies(gateway.baseUrl)).map(item => `${item.name}=${item.value}`).join('; ');
    context.registerSecret(cookie);
    readRpc = await openRpc(gatewayRpcUrl(gateway, 'local', csrf), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup('close native authoring library verification RPC', () => closeRpcAndWait(readRpc));
    const initialized = await readRpc.request('initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'actual-authoring-library-reader', version: '1' },
      capabilities: { experimental: { workflowCanvasV1: true, workflowCollaborationV1: true, workflowGraphV2: true } } });
    assert.equal(initialized.capabilities?.experimental?.workflowCollaborationV1, true);
    const initialThreads = await readRpc.request('thread/list', { limit: 10 });
    assert.equal(initialThreads.threads.length, 0, 'Authoring must not need a fabricated parent conversation');

    const openForm = async () => {
      await page.goto(`${gateway.baseUrl}/tasks`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('native-task-workspace').waitFor({ timeout: 30000 });
      await page.getByRole('combobox', { name: '运行目标', exact: true }).selectOption('local');
      await page.getByTestId('task-workspace-create-collaboration').click();
      return page.getByTestId('collaboration-creator');
    };
    const fill = async (form, title) => {
      await form.getByTestId('collaboration-prepare').waitFor({ state: 'visible', timeout: 30000 });
      await waitFor(() => form.getByTestId('collaboration-prepare').isEnabled(), 30000, 'actual native collaboration catalog');
      await form.getByTestId('collaboration-scheme').selectOption('draft_verify');
      await form.getByTestId('collaboration-title').fill(title);
      await form.getByTestId('collaboration-objective').fill('根据明确提供的材料起草报告；运行时必须显式提供 brief 输入。');
      await form.getByTestId('collaboration-criteria').fill('报告引用原材料证据。\n原生文件独立回读后验收。');
      await form.getByTestId('collaboration-path').fill('reports/verified-report.md');
      await form.getByTestId('collaboration-inherit-model').check();
    };
    const count = method => wire.filter(entry => entry.serverId === 'local' && entry.method === method).length;

    let form = await openForm();
    assert.ok((await form.innerText()).includes('实际模型将在之后运行时由执行会话确认'));
    await fill(form, `原生协作固定版本-${context.seed}`);
    await page.screenshot({ path: context.pathInArtifacts('native-collaboration-authoring-light.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.screenshot({ path: context.pathInArtifacts('native-collaboration-authoring-dark.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await form.getByTestId('collaboration-prepare').click();
    await form.getByTestId('collaboration-save').waitFor({ timeout: 30000 });
    const created = receipts.find(entry => entry.method === 'workflow/create');
    const applied = receipts.find(entry => entry.method === 'workflow/collaboration/apply');
    assert.ok(created?.id); assert.equal(applied?.id, created.id); assert.ok(applied.revision > created.revision);
    await form.getByTestId('collaboration-save').click();
    await waitFor(async () => (await form.getByTestId('collaboration-authoring-status').innerText()).includes('已保存版本 1'), 30000, 'actual fixed workflow version saved');
    const actual = await readRpc.request('workflow/read', { id: created.id });
    assert.equal(actual.id, created.id); assert.equal(actual.status, 'saved'); assert.equal(actual.savedVersion, 1);
    const fixed = await readRpc.request('workflow/export', { id: created.id, version: 1 });
    assert.equal(fixed.id, created.id); assert.equal(fixed.savedVersion, 1);
    assert.deepEqual(fixed.nodes, actual.nodes);
    const writer = fixed.nodes.find(node => node.config?.collaborationRole?.role === 'writer');
    assert.ok(writer); assert.deepEqual(writer.allowedWritePaths, ['reports/verified-report.md']);
    assert.equal(writer.config.artifactRequirements[0].path, 'reports/verified-report.md');
    assert.ok(fixed.nodes.some(node => node.config?.collaborationRole?.role === 'verifier'));
    assert.ok(fixed.nodes.some(node => node.id.startsWith('check_')), 'Actual native compiler must supply independent file readback');
    assert.deepEqual(fixed.inputSchema.required, ['brief']);
    await assert.rejects(access(resolve(workspace, 'reports/verified-report.md')), 'Saving the definition must not execute its writer');
    assert.equal(count('workflow/create'), 1); assert.equal(count('workflow/collaboration/apply'), 1); assert.equal(count('workflow/save'), 1);
    cases.push({ case: 'actual-create-cas-fixed-version', id: actual.id, version: actual.savedVersion, nodeCount: actual.nodes.length, noExecution: true });

    // Crossing the real mobile breakpoint remounts the normal layout. Capture
    // its own unsent form instead of pretending an old React owner persisted.
    await page.setViewportSize({ width: 430, height: 932 });
    form = await openForm();
    await fill(form, `窄屏未提交方案-${context.seed}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Narrow authoring must contain controls without document overflow');
    await page.screenshot({ path: context.pathInArtifacts('native-collaboration-authoring-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1400, height: 1050 });

    form = await openForm();
    await fill(form, `原生创建失回执-${context.seed}`);
    const createBefore = count('workflow/create');
    fault.dropNext = 'workflow/create';
    await form.getByTestId('collaboration-prepare').click();
    await waitFor(async () => (await form.getByTestId('collaboration-error').innerText()).includes('写入结果尚未确认'), 30000, 'lost original create acknowledgement is unknown');
    assert.equal(await form.getByTestId('collaboration-prepare').isDisabled(), true);
    assert.equal(await form.getByTestId('collaboration-read-original').count(), 0, 'No original id was acknowledged; never guess latest');
    const lostCreate = fault.dropped.find(entry => entry.method === 'workflow/create');
    assert.ok(lostCreate?.id);
    const committedCreate = await readRpc.request('workflow/read', { id: lostCreate.id });
    assert.equal(committedCreate.nodes.length, 0);
    assert.equal(count('workflow/create'), createBefore + 1, 'A committed create with lost ACK must not be repeated');
    await form.getByTestId('collaboration-open-library').click();
    await page.getByTestId('workflow-workspace').waitFor({ timeout: 30000 });
    cases.push({ case: 'lost-create-ack', id: committedCreate.id, actualCommitted: true, createRequests: 1, unknownKept: true, normalLibraryAvailable: true });

    form = await openForm();
    await fill(form, `原生方案失回执-${context.seed}`);
    const applyBefore = count('workflow/collaboration/apply'), applyCreateBefore = count('workflow/create');
    fault.dropNext = 'workflow/collaboration/apply';
    await form.getByTestId('collaboration-prepare').click();
    await waitFor(async () => (await form.getByTestId('collaboration-error').innerText()).includes('写入结果尚未确认'), 30000, 'lost original apply acknowledgement is unknown');
    assert.equal(await form.getByTestId('collaboration-original-draft').count(), 1);
    const lostApply = fault.dropped.find(entry => entry.method === 'workflow/collaboration/apply');
    assert.ok(lostApply?.id);
    const committedApply = await readRpc.request('workflow/read', { id: lostApply.id });
    assert.ok(committedApply.nodes.length > 0);
    const peerWriter = structuredClone(committedApply.nodes.find(node => node.config?.collaborationRole?.role === 'writer'));
    assert.ok(peerWriter);
    peerWriter.prompt += '\nPEER_DIFFERENT_PLAN: require a separate source comparison.';
    const peerChanged = await readRpc.request('workflow/upsertNode', {
      id: lostApply.id, expectedRevision: committedApply.revision, node: peerWriter,
    });
    assert.ok(peerChanged.revision > committedApply.revision);
    const observedReadsBefore = count('workflow/read');
    await form.getByTestId('collaboration-read-original').click();
    await waitFor(async () => count('workflow/read') === observedReadsBefore + 1 &&
      receipts.some(entry => entry.method === 'workflow/read' && entry.id === lostApply.id && entry.revision === peerChanged.revision) &&
      await form.getByTestId('collaboration-read-original').isEnabled(), 30000, 'explicit observation of the same original draft completes');
    assert.equal(await form.getByTestId('collaboration-save').isDisabled(), true, 'Different peer content is not this apply action receipt');
    assert.equal(count('workflow/collaboration/apply'), applyBefore + 1);
    assert.equal(count('workflow/create'), applyCreateBefore + 1);
    assert.ok((await form.getByTestId('collaboration-error').innerText()).includes('写入结果尚未确认'));
    const actualPeerGraph = await readRpc.request('workflow/read', { id: lostApply.id });
    assert.equal(actualPeerGraph.revision, peerChanged.revision);
    assert.ok(actualPeerGraph.nodes.find(node => node.id === peerWriter.id)?.prompt.includes('PEER_DIFFERENT_PLAN'));
    cases.push({ case: 'lost-apply-ack-peer-edit', id: lostApply.id, actualCommitted: true, applyRequests: 1, peerRevision: peerChanged.revision, unknownKeptAfterObservation: true });

    fault.holdTargets.add('local');
    form = await openForm();
    await waitFor(() => held.has('local'), 30000, 'actual original-target catalog response held');
    fault.holdTargets.add('peer');
    await page.getByRole('combobox', { name: '运行目标', exact: true }).selectOption('peer');
    await page.getByTestId('native-task-workspace').waitFor();
    await page.getByTestId('task-workspace-create-collaboration').click();
    form = page.getByTestId('collaboration-creator');
    await waitFor(() => held.has('peer'), 30000, 'actual new-target catalog response held');
    held.get('local')();
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    assert.equal(await form.getByTestId('collaboration-prepare').isDisabled(), true, 'Late old-target response must not settle the new owner');
    assert.ok((await form.innerText()).includes('peer'));
    assert.equal(await form.getByTestId('collaboration-title').inputValue(), '');
    held.get('peer')();
    await waitFor(() => form.getByTestId('collaboration-prepare').isEnabled(), 30000, 'actual new-target response settles only its owner');
    cases.push({ case: 'late-original-target-catalog', oldTargetDiscarded: true, actualPeerAccepted: true });

    assert.equal(model.requests.length, 0, 'Creating/preparing/saving/reading must not call a model');
    assert.ok(!wire.some(entry => ['thread/start', 'thread/resume', 'turn/start'].includes(entry.method)), 'The authoring flow must not start or resume an execution');
    assert.equal((await readRpc.request('thread/list', { limit: 10 })).threads.length, 0);
    assert.deepEqual(pageErrors, []);
    await context.writeArtifactJson('native-collaboration-authoring-evidence.json', {
      schemaVersion: 1, actualAuthenticatedGateway: true, actualNativeWorkflowStore: true,
      cases, methods: wire, modelCalls: model.requests.length, ghostThreads: 0,
      screenshots: ['native-collaboration-authoring-light.png', 'native-collaboration-authoring-dark.png', 'native-collaboration-authoring-narrow.png'],
      limitations: ['No role execution, paid-model quality, native Electron save/dialog or foreign platform behavior is asserted.'],
    });
    return { actualNativeFixedVersion: true, modelCalls: 0, noExecutionStarted: true, cases: cases.length };
  } catch (error) {
    await context.writeArtifactJson('native-collaboration-authoring-failure.json', {
      error: String(error.message), pageErrors, methods: wire, receipts, faults: { dropped: fault.dropped, released: fault.released },
      modelCalls: model.requests.length, body: (await page.locator('body').innerText().catch(() => '')).slice(0, 12000),
    });
    await page.screenshot({ path: context.pathInArtifacts('native-collaboration-authoring-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    for (const release of [...held.values()]) release();
    await closeRpcAndWait(readRpc);
    await page.close();
  }
});
