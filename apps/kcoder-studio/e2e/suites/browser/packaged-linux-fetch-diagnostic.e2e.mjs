import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startPackagedDesktop } from '../../harness/packaged-desktop.mjs';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { verifyManifest } from '../../../../../scripts/release/artifact-manifest.mjs';
import { webNativeBinaryIdentity, webNativeModelOnlySettings } from '../../harness/web-search-native-session.mjs';
import { openPageGatewayRpc, initializeRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { acceptNativeToolApproval, observeNativeUiFrames } from '../../harness/native-tool-approval.mjs';
import { packagedFetchOptions } from '../../harness/packaged-fetch-case.mjs';

assert.equal(process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK, '1', 'Explicit one-fetch public network consent is required');
const options = packagedFetchOptions();
const { root, url } = options;
await runE2E(import.meta.url, {
  testId: `actual-packaged-linux-one-fetch-terminal-${options.caseId}`,
  tier: 'manual-live',
  modelPolicy: 'One explicitly authorized fixed URL WebFetch; zero WebSearch and paid models. Local two-step protocol, normal ASK, no page scripts or article/task-quality analysis. Errors remain errors.',
  budgets: { publicFetch: 1, publicSearch: 0, fixtureModelSteps: 2, wallClockMs: 140000 },
  retainSuccessEvidence: true,
}, async context => {
  const runStart = performance.now();
  context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(140000)]);
  await verifyManifest(resolve(root, 'resources'), { expectedCommit: options.expectedCommit });
  const binaryIdentity = await webNativeBinaryIdentity(resolve(root, 'resources/bin/kcoder'));
  assert.equal(binaryIdentity.sha256, options.expectedCliSha256, 'The embedded CLI must match the declared final artifact');
  assert.equal(binaryIdentity.fixtureBuild, false, 'Use a final default-feature package');
  await context.writeArtifactJson('fixed-fetch-input.json', { ...options, binaryIdentity, publicSearch: 0, publicFetch: 1, paidModels: 0 });
  const display = await startOwnedDisplay(context);
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'one-fetch-diag' });
  let calls = 0, steps = 0;
  const model = await startApprovalModelFixture(context, {
    modelList: { ids: ['owned-search-model'] },
    responseSteps: ({ body }) => {
      if (!(body.tools || []).some(tool => (tool.function?.name || tool.name) === 'WebFetch')) {
        return [{ delta: { content: '固定诊断' }, finishReason: 'stop' }];
      }
      assert.ok(++steps <= 2, 'No extra model protocol generation or fetch replay');
      const results = (body.messages || []).filter(message => message.role === 'tool');
      if (!results.length) {
        assert.equal(++calls, 1);
        return [{ delta: { tool_calls: [{ index: 0, id: 'one-native-fetch-diag', type: 'function',
          function: { name: 'WebFetch', arguments: JSON.stringify({ url, prompt: options.toolPrompt }) },
        }] }, finishReason: 'tool_calls' }];
      }
      return [{ delta: { content: '已收到本次工具终态。NATIVE_FETCH_DIAG_TERMINAL' }, finishReason: 'stop' }];
    },
  });
  const settingsFile = await context.writeStateJson('home/settings.json', webNativeModelOnlySettings({ modelUrl: model.baseUrl }));
  const settingsBytes = await readFile(settingsFile);
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: '单次Fetch诊断', transport: 'local',
    command: resolve(root, 'resources/bin/kcoder'), workspace: workspace.path, settingsFile }]);
  let desktop, rpc, timer, threadId, nativePid, nativeStartTicks;
  let frames = [];
  const cpu = [], snapshots = [];
  const findThread = () => {
    for (const { frame } of frames) {
      if (frame.params?.threadId) threadId = frame.params.threadId;
      if (frame.result?.thread?.id) threadId = frame.result.thread.id;
    }
    return threadId;
  };
  const sample = async () => {
    if (!nativePid) return;
    try {
      const text = await readFile(`/proc/${nativePid}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      if (nativeStartTicks !== undefined && startTicks !== nativeStartTicks) {
        clearInterval(timer);
        cpu.push({ atMs: Math.round(performance.now() - runStart), pid: nativePid, ownerIdentityChanged: true });
        return;
      }
      nativeStartTicks = startTicks;
      cpu.push({ atMs: Math.round(performance.now() - runStart), pid: nativePid, state: fields[0],
        userTicks: Number(fields[11]), systemTicks: Number(fields[12]), startTicks });
    } catch {
      cpu.push({ atMs: Math.round(performance.now() - runStart), pid: nativePid, exited: true });
    }
  };
  try {
    desktop = await startPackagedDesktop(context, { root, label: 'native-fetch-diag', entry: 'AppRun', servers,
      workspace: workspace.path, environment: { DISPLAY: display.display, XAUTHORITY: display.authority } });
    const page = desktop.page;
    frames = observeNativeUiFrames(page, { now: () => Math.round(performance.now() - runStart) });
    const origin = new URL(page.url()).origin;
    rpc = await openPageGatewayRpc(context, page, { baseUrl: origin, wsUrl: origin.replace('http:', 'ws:') }, 'one fetch diag reader');
    await initializeRpc(rpc, 'one-fetch-diag');
    const resource = await rpc.request('server/resources/read', {});
    nativePid = resource.processId;
    assert.equal(await realpath(`/proc/${nativePid}/exe`), await realpath(resolve(root, 'resources/bin/kcoder')));
    await sample();
    timer = setInterval(() => void sample(), 500);
    context.addCleanup('stop native-only CPU sampling', () => clearInterval(timer));
    await page.getByTestId('chat-message-input').fill(options.userPrompt);
    await page.getByTestId('send-message-button').click();
    const approval = await acceptNativeToolApproval(page, frames, 'WebFetch', { signal: context.abortSignal, timeoutMs: 30000 });
    threadId = approval.params.threadId;
    const turnId = approval.params.turnId;
    snapshots.push({ phase: 'afterPermission', value: await rpc.request('thread/read', { threadId, limit: 100 }) });
    const completion = await waitFor(() => frames.find(row => row.direction === 'received'
      && row.frame.method === 'turn/completed' && row.frame.params?.threadId === threadId && row.frame.params?.turnId === turnId),
    Math.max(1000, 135000 - (performance.now() - runStart)), 'native turn terminal after permitted single Fetch', 100, context.abortSignal);
    await sample();
    snapshots.push({ phase: 'terminal', value: await rpc.request('thread/read', { threadId, limit: 100 }) });
    const scoped = frames.filter(row => row.direction === 'received' && row.frame.params?.threadId === threadId && row.frame.params?.turnId === turnId);
    const started = scoped.filter(row => row.frame.method === 'item/started' && row.frame.params?.item?.type === 'toolCall');
    const tools = scoped.filter(row => row.frame.method === 'item/completed' && row.frame.params?.item?.type === 'toolCall');
    assert.equal(started.length, 1);
    assert.equal(tools.length, 1);
    assert.equal(started[0].frame.params.item.name, 'WebFetch');
    assert.equal(started[0].frame.params.item.input.url, url);
    assert.equal(tools[0].frame.params.item.id, started[0].frame.params.item.id);
    assert.equal(calls, 1);
    assert.equal(steps, 2);
    const receipts = tools.flatMap(row => row.frame.params.item.webSources ? [row.frame.params.item.webSources] : []);
    for (const receipt of receipts) {
      assert.equal(receipt.identity.threadId, threadId);
      assert.equal(receipt.identity.turnId, turnId);
      assert.equal(receipt.toolCallId, started[0].frame.params.item.id);
    }
    const readSucceeded = receipts.some(receipt => receipt.operation === 'fetch'
      && receipt.sources.some(source => ['read', 'partial'].includes(source.readStatus)));
    for (const toggle of ['final-processing-toggle', 'processing-summary-toggle', 'processing-activity-group-toggle']) {
      for (const button of await page.getByTestId(toggle).all()) if (await button.getAttribute('aria-expanded') === 'false') await button.click();
    }
    for (const card of await page.getByTestId('native-web-sources').all()) {
      const toggle = card.getByRole('button').first();
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    }
    await page.screenshot({ path: context.pathInArtifacts('single-native-fetch-terminal.png'), fullPage: true });
    assert.deepEqual(await readFile(settingsFile), settingsBytes);
    await context.writeArtifactJson('single-fetch-diagnostic.json', { ...options, binaryIdentity, publicSearch: 0, publicFetch: 1,
      paidModels: 0, fixtureSteps: steps, readSucceeded, nativePid, nativeStartTicks, cpu, frames, snapshots, receipts, approval, completion,
      productNetworkStage: 'unknown unless actual tool terminal identifies it; no DNS/connect/TLS/body trace was emitted',
      elapsedMs: Math.round(performance.now() - runStart) });
    assert.ok(readSucceeded, 'A native terminal was retained, but the fixed source was not readable; do not count this as a successful read');
    return { caseId: options.caseId, singleFetchTerminalObserved: true, readSucceeded, publicFetch: 1, publicSearch: 0, paidModels: 0 };
  } catch (error) {
    findThread();
    if (threadId && rpc) {
      try { snapshots.push({ phase: 'beforeCleanupFailure', value: await rpc.request('thread/read', { threadId, limit: 100 }, 5000) }); }
      catch (snapshotError) { snapshots.push({ phase: 'snapshotUnavailable', error: String(snapshotError) }); }
    }
    await sample();
    if (desktop) await desktop.page.screenshot({ path: context.pathInArtifacts('single-native-fetch-failure.png'), fullPage: true }).catch(() => {});
    await context.writeArtifactJson('single-fetch-diagnostic-failure.json', { ...options, binaryIdentity, error: String(error), calls, steps,
      nativePid, nativeStartTicks, cpu, frames, snapshots, stage: 'unknown without product trace; no inference from wait duration' });
    throw error;
  } finally {
    clearInterval(timer);
    await closeRpcAndWait(rpc);
    if (desktop) await desktop.stop();
  }
});
