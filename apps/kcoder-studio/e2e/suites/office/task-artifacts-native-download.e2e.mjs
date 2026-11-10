import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, isTurnCompletion, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { nativeOfficeSpawnEnvironment, prepareNativeOfficeLaunch } from '../../../src/integrations/office/resource-host.mjs';
import { claimPrompt, claimTitle, claimSpecification, discoveryCall, documentCall, discoveryResult, toolResult, toolSteps } from './native-download-model.mjs';
import { enableNativeOfficeInPage } from './native-setup-flow.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'task-workspace-native-artifact-browser-claim', tier: 'full-integration',
  modelPolicy: 'deterministic Provider tool selection validates actual Native generation, public RPC, authenticated Studio, attachment chunks and browser download; no model quality or native save-dialog claim',
  retainSuccessEvidence: true,
}, async context => {
  assert.equal(process.platform, 'linux', 'Requires the existing verified Linux native local parent');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'current KCoder app-server');
  assert.ok(process.env.KCODER_OFFICE_NATIVE_NODE_LAUNCH, 'Explicit actual staged standalone-Node launch observation required');
  const observation = JSON.parse(await readFile(process.env.KCODER_OFFICE_NATIVE_NODE_LAUNCH, 'utf8'));
  assert.equal(observation.runtime?.mode, 'standalone_node');
  const launch = await prepareNativeOfficeLaunch({ componentRoot: observation.componentRoot,
    expectedManifestSha256: observation.manifestSha256, expectedMode: 'standalone_node' });
  await context.writeArtifactJson('native-office-resource-input.json', {
    manifestSha256: observation.manifestSha256, mode: 'standalone_node',
    actualNodeVersion: process.versions.node, source: 'explicit sealed component input; native launcher independently verifies every file',
  });
  const specification = claimSpecification(context.seed);
  const protocolErrors = [];
  let generated;
  let mainRequests = 0;
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body, requestNumber }) => {
    try {
      assert.ok(requestNumber <= 8, 'Provider request budget exceeded');
      if (!JSON.stringify(body.messages ?? []).includes(claimPrompt))
        return [{ delta: { content: 'No new durable preferences.' } }, { finishReason: 'stop' }];
      mainRequests++;
      const result = toolResult(body, documentCall);
      if (result) {
        assert.equal(result.format, 'docx', JSON.stringify(result));
        assert.ok(typeof result.artifactRef?.id === 'string');
        assert.match(result.sha256, /^[a-f0-9]{64}$/);
        assert.ok(!JSON.stringify(body.messages).includes(specification.paragraphs[1].text), 'Saved canonical source must be projected at the actual Provider boundary');
        generated = result;
        return [{ delta: { content: 'Actual native DOCX saved. Use the Office page to request download.' } }, { finishReason: 'stop' }];
      }
      if (toolResult(body, discoveryCall)) {
        assert.equal(discoveryResult(body).tools[0].name, 'OfficeDocument');
        return toolSteps(documentCall, 'tool_execute', { tool_name: 'OfficeDocument', arguments: { specification, sourceRefs: [] } });
      }
      return toolSteps(discoveryCall, 'tool_search', { query: 'OfficeDocument', limit: 1 });
    } catch (error) {
      protocolErrors.push(String(error.message));
      return [{ delta: { content: 'OFFICE_FIXTURE_PROTOCOL_FAILURE' } }, { finishReason: 'stop' }];
    }
  } });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'task-artifact-browser-claim' });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', {
    active_provider: 'office-protocol', permission_mode: 'bypass', max_retries: 0,
    session_memory: { enabled: false }, integrations: { office: { enabled: false } },
    providers: { 'office-protocol': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'office-protocol', context_window_tokens: 1048576,
      max_output_tokens: 262144, output_headroom_tokens: 8192, no_proxy: true, discover_models: false } },
  });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Native Office fixture', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true,
    ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { gatewayRoot: process.env.KCODER_E2E_GATEWAY_ROOT } : {}),
    env: { KCODER_CONFIG_DIR: profile, ...nativeOfficeSpawnEnvironment(launch) } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const pageErrors = [];
  const wire = [];
  const exports = [];
  const lists = [];
  const taskSnapshots = [];
  const artifactReads = [];
  let nextSocket = 0;
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('websocket', socket => {
    const socketId = ++nextSocket;
    const pending = new Map();
    socket.on('framesent', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (!frame.method) return;
        pending.set(String(frame.id), { method: frame.method, params: frame.params });
        wire.push({ socketId, method: frame.method, ...(frame.method === 'attachment/read/chunk' ? { offset: frame.params?.offset, length: frame.params?.length } : {}) });
      } catch { /* Non-JSON WS frames are outside this fixture's evidence. */ }
    });
    socket.on('framereceived', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        const request = pending.get(String(frame.id));
        if (!request) return;
        pending.delete(String(frame.id));
        if (request.method === 'integrations/artifact/export') exports.push(frame.result);
        if (request.method === 'integrations/artifact/list') lists.push(frame.result);
        if (request.method === 'integrations/artifact/read') artifactReads.push({ reference: request.params?.payload?.reference, reply: frame.result });
        if (request.method === 'integrations/tasks/readWorkspace' && frame.result?.status === 'completed') taskSnapshots.push(frame.result.result);
      } catch { /* Do not retain raw socket payloads or authentication material. */ }
    });
  });
  await page.addInitScript(() => {
    window.__officeClaimBlobs = [];
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = value => {
      const url = original(value);
      if (value instanceof Blob && value.type.includes('wordprocessingml.document')) {
        const entry = { bytes: value.size, mediaType: value.type, done: false };
        window.__officeClaimBlobs.push(entry);
        void value.arrayBuffer().then(async bytes => {
          entry.pk = Array.from(new Uint8Array(bytes).slice(0, 2));
          entry.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join('');
          entry.done = true;
        }).catch(() => { entry.failed = true; });
      }
      return url;
    };
  });
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    const rpcToken = await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content');
    assert.ok(rpcToken, 'Authenticated document must expose its actual RPC CSRF token');
    context.registerSecret(rpcToken);
    const cookies = await page.context().cookies(gateway.baseUrl);
    const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
    context.registerSecret(cookie);
    await enableNativeOfficeInPage(context, page, gateway.baseUrl);
    assert.equal(model.requests.length, 0, 'Enabling Office must not call a model');
    assert.ok(!wire.some(item => item.method === 'thread/start' || item.method === 'turn/start'), 'Enabling Office must not create a task');
    assert.ok(wire.some(item => item.method === 'settings/integrations/office/save'), 'The actual settings save must cross the normal command connection');
    const seed = await openRpc(gatewayRpcUrl(gateway, 'local', rpcToken), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup('close native Office seed RPC', () => closeRpcAndWait(seed));
    const initialized = await seed.request('initialize', { protocolVersion: '2026-07-27',
      clientInfo: { name: 'native-office-browser-seed', version: '1' },
      capabilities: { experimental: { integrationScopeV1: true, officeWorkspaceV1: true,
        studioWorkModesV1: true, threadStreamContextV1: true, taskWorkspaceV1: true } } });
    assert.equal(initialized.capabilities?.experimental?.officeWorkspaceV1, true);
    const { thread } = await seed.request('thread/start', { cwd: workspace, studioWorkMode: 'kworker' });
    const { turn } = await seed.request('turn/start', { threadId: thread.id,
      clientPresentation: { version: 1, studioWorkMode: 'kworker', inlineWidgets: false },
      input: [{ type: 'text', text: claimPrompt }] }, 30_000);
    const completed = await seed.waitFor(message => isTurnCompletion(message, thread.id, turn.id), 120_000, 'actual Native Office turn');
    assert.equal(completed.params?.turn?.status ?? completed.params?.status, 'completed');
    assert.deepEqual(protocolErrors, []);
    assert.ok(generated, 'The actual generator receipt must reach the next Provider request');
    assert.equal(mainRequests, 3, 'Exactly discovery, native generation and final response');
    await seed.request('thread/metadata/update', { threadId: thread.id, title: claimTitle });
    await closeRpcAndWait(seed, 'native Office seed RPC');
    // The UI owns another actual connection and must read fixed historical data.
    await page.reload({ waitUntil: 'domcontentloaded' });
    const worker = page.getByRole('button', { name: 'KWorker', exact: true });
    if (await worker.count()) await worker.click();
    await page.getByTestId('task-workspace-button').click();
    await page.waitForURL(url => url.pathname === '/tasks');
    const taskSpace = page.getByTestId('native-task-workspace');
    await taskSpace.waitFor({ timeout: 30_000 });
    const office = page.getByTestId('task-artifact-viewer');
    const openOriginalArtifact = async () => {
      if (await office.count()) return;
      const select = taskSpace.getByTestId('task-workspace-thread-select');
      const choice = await waitFor(() => select.locator('option').evaluateAll((options, threadId) => options.find(option => {
        try { return JSON.parse(option.value)[0] === threadId; } catch { return false; }
      })?.value, thread.id), 30_000, 'actual original task indexed for task workspace', 50, context.abortSignal);
      assert.ok(choice, 'The actual original task must exist in the ordinary task index');
      await select.selectOption(choice);
      await taskSpace.getByTestId('task-workspace-observation').waitFor({ timeout: 30_000 });
      const observed = taskSnapshots.at(-1);
      assert.ok(observed?.artifactRefs?.some(ref => ref.kind === 'artifact' && ref.id === generated.artifactRef.id && ref.revision === String(generated.artifactRef.revision)), 'Native task observation must provide the exact original artifact revision');
      await taskSpace.getByTestId('task-workspace-open-artifacts').click();
      await office.waitFor({ timeout: 30_000 });
      await office.getByRole('heading', { name: claimTitle, exact: true }).waitFor({ timeout: 30_000 });
    };
    const listReadsBefore = lists.length;
    await openOriginalArtifact();
    const row = office.locator('li[data-office-kind="document"]').filter({ has: page.getByRole('heading', { name: claimTitle, exact: true }) });
    assert.equal(lists.length, listReadsBefore, 'A fixed task artifact entry must not silently list latest files');
    assert.ok(artifactReads.some(value => value.reference?.id === generated.artifactRef.id && value.reference?.revision === generated.artifactRef.revision && value.reply?.status === 'completed'));
    const before = model.requests.length;
    await page.screenshot({ path: context.pathInArtifacts('native-task-artifact-before-download.png'), fullPage: true });
    const downloadPromise = page.waitForEvent('download', { timeout: 45_000 });
    await row.getByRole('button', { name: /下载|Download/i }).click();
    const download = await downloadPromise;
    const downloadStatus = office.getByTestId('task-artifact-download-status');
    await downloadStatus.waitFor();
    assert.equal(await downloadStatus.getAttribute('data-status'), 'download_requested');
    const saved = context.pathInArtifacts('claimed-native-office.docx');
    await download.saveAs(saved);
    assert.equal(await download.failure(), null);
    await page.waitForFunction(() => window.__officeClaimBlobs?.some(item => item.done), undefined, { timeout: 15_000 });
    const blobs = await page.evaluate(() => window.__officeClaimBlobs.filter(item => item.done));
    assert.equal(blobs.length, 1);
    await waitFor(() => exports.length === 1, 10_000, 'actual export receipt', 20, context.abortSignal);
    const receipt = exports[0]?.result?.export;
    assert.equal(exports[0]?.status, 'completed');
    assert.equal(receipt?.reference?.id, generated.artifactRef.id);
    assert.equal(receipt?.reference?.revision, generated.artifactRef.revision);
    assert.equal(receipt?.sha256, generated.sha256);
    assert.ok(receipt.bytes > 256 * 1024, 'Actual DOCX must force attachment chunk fallback');
    const bytes = await readFile(saved);
    assert.deepEqual(Array.from(bytes.subarray(0, 2)), [80, 75]);
    assert.equal(bytes.length, receipt.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.sha256);
    assert.equal(blobs[0].sha256, receipt.sha256);
    assert.equal(blobs[0].bytes, receipt.bytes);
    assert.deepEqual(blobs[0].pk, [80, 75]);
    assert.ok(wire.some(item => item.method === 'attachment/read/chunk'));
    assert.equal(lists.length, listReadsBefore, 'Download must keep the fixed artifact selector');
    assert.equal(model.requests.length, before, 'Artifact reads and downloads must not call a model');
    assert.equal(await page.evaluate(() => Boolean(window.kcoderDesktopHost)), false, 'Browser download is not an Electron save confirmation');
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: context.pathInArtifacts('native-task-artifact-download-requested.png'), fullPage: true });
    await page.setViewportSize({ width: 430, height: 960 });
    await page.waitForTimeout(300);
    // Responsive shell remounts may clear only the local selection. Re-open the
    // same actual original reference; do not infer a replacement/latest task.
    await openOriginalArtifact();
    assert.ok(await office.isVisible());
    await page.screenshot({ path: context.pathInArtifacts('native-task-artifact-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.waitForTimeout(300);
    await openOriginalArtifact();
    assert.ok(await office.isVisible());
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.screenshot({ path: context.pathInArtifacts('native-task-artifact-dark.png'), fullPage: true });
    await context.writeArtifactJson('native-task-artifact-browser-claim.json', {
      schemaVersion: 1, fixtureProtocolOnly: true, actualNativeGeneration: true,
      authenticatedGateway: true, separateUiConnection: true, originalTaskReference: thread.id, fixedTaskArtifactRead: true, latestArtifactLookup: false, artifactId: generated.artifactRef.id,
      revision: receipt.reference.revision, bytes: receipt.bytes, sha256: receipt.sha256,
      browserDownloadState: 'download_requested', harnessSavedCompleteBytes: true,
      attachmentChunkReads: wire.filter(item => item.method === 'attachment/read/chunk').map(({ offset, length }) => ({ offset, length })),
      providerMainRequests: mainRequests, generatedThrough: 'actual native OfficeDocument via tool_search/tool_execute',
      limits: ['Deterministic Provider selections are protocol evidence, not model quality.',
        'Browser download_requested does not prove an Electron save dialog completed or was cancelled.',
        'No Windows/native desktop acceptance is claimed.'],
    });
    return { actualNativeGeneration: true, actualArtifactCollection: true, completeBrowserBlob: true,
      browserDownloadState: 'download_requested', bytes: receipt.bytes, sha256: receipt.sha256 };
  } catch (error) {
    await context.writeArtifactJson('native-task-artifact-browser-failure.json', {
      error: String(error.message), protocolErrors, pageErrors, wireMethods: wire.map(item => item.method),
      providerRequests: model.requests.length, generatorReceiptObserved: Boolean(generated),
      body: (await page.locator('body').innerText().catch(() => '')).slice(0, 12000),
    });
    await page.screenshot({ path: context.pathInArtifacts('native-task-artifact-browser-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await page.close(); }
});
