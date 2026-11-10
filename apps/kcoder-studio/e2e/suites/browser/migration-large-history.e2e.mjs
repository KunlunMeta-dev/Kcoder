import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { runE2E, repoRoot, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { LARGE_HISTORY_BYTES, LARGE_HISTORY_RECORDS, LARGE_HISTORY_LIMITS as limits,
  writeLargeHistoryFixture, hashHistoryFile, linuxAvailableMemory, linuxReadCharacters,
  startLargeHistoryRssSampler, freezeLargeHistoryRenderer } from '../../harness/migration-large-history.mjs';
import { migrationPerformanceCase, runSmallAssetsPerformance } from '../../harness/migration-small-assets.mjs';
import { readMigrationRendererBaseline } from '../../harness/migration-renderer-baseline.mjs';

const performanceCase = migrationPerformanceCase(process.env.KCODER_E2E_MIGRATION_PERF_CASE);
assert.ok(process.env.KCODER_E2E_MIGRATION_SMALL_ASSET_COUNT === undefined || performanceCase === 'small-assets',
  'a selected small-asset count cannot replace the original 500MiB workload');
assert.equal(process.env.KCODER_E2E_MIGRATION_LARGE_HISTORY, '1', 'manual 500MiB client performance consent is required');
assert.equal(process.platform, 'linux', 'this measurement requires actual Linux /proc attribution');
assert.match(process.env.KCODER_E2E_KCODER_BIN_SHA256 ?? '', /^[a-f0-9]{64}$/);
const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit source-pinned KCoder app-server');
const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
assert.equal(binarySha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
const baselineProof = process.env.KCODER_E2E_MIGRATION_RENDERER_BASELINE;
assert.ok(!baselineProof || performanceCase === 'small-assets', 'retained baseline admission is limited to the small-assets case');
const renderer = baselineProof ? await readMigrationRendererBaseline({ proofFile: baselineProof,
  proofSha256: process.env.KCODER_E2E_MIGRATION_RENDERER_BASELINE_SHA256, rendererRoot: process.env.KCODER_E2E_RENDERER_ROOT }) : await assertRendererBuildFresh();

if (performanceCase === 'small-assets') {
  await runE2E(import.meta.url, { testId: 'migration-many-small-assets-browser-cancel-resume', tier: 'manual-live',
    modelPolicy: 'actual Linux Browser/Gateway/Native 128/1024 small-asset batches, first feedback/RSS/active cancel/same-job resume/owned Undo;1024 normal-dev functional observation owner20min/Undo12min, not a throughput target; no model, vendor code,500MiB history or cold-cache claim' },
  context => runSmallAssetsPerformance(context, { binary, binarySha256, rendererAdmission: renderer, rendererRoot: process.env.KCODER_E2E_RENDERER_ROOT || resolve(repoRoot, 'apps/kcoder-studio/renderer/dist') }));
} else {
await runE2E(import.meta.url, { testId: 'migration-500mib-browser-archive-cancel-resume', tier: 'manual-live',
  modelPolicy: 'actual Browser/Gateway/Native archive and normalization, owned 500MiB streaming fixture; no model turns or source execution; not unified batch, Electron or cross-platform performance' }, async context => {
  const started = performance.now(), remaining = () => Math.max(1, limits.deadlineMs - (performance.now() - started));
  const signal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(limits.deadlineMs)]);
  const targetDirectory = resolve(repoRoot, 'target');
  assert.notEqual((await statfs(targetDirectory, { bigint: true })).type, 0x1021994n, 'a disk filesystem is required; do not allocate this fixture on tmpfs');
  const scratch = await context.createOwnedScratchDirectory('migration-500mib', { baseDirectory: targetDirectory,
    requiredBytes: 4n * 1024n ** 3n, reserveBytes: 2n * 1024n ** 3n,
    requiredMemoryBytes: 2n * 1024n ** 3n, availableMemoryBytes: await linuxAvailableMemory() });
  const rendererSnapshot = await freezeLargeHistoryRenderer(context,
    process.env.KCODER_E2E_RENDERER_ROOT || resolve(repoRoot, 'apps/kcoder-studio/renderer/dist'), resolve(scratch.path, 'renderer'));
  assert.equal((await assertRendererBuildFresh()).distMtime, renderer.distMtime, 'renderer changed after freshness admission');
  const sourceRoot = resolve(scratch.path, 'sources/claude'), profile = resolve(scratch.path, 'profile');
  const marker = resolve(scratch.path, 'old-tool-executed');
  const source = await writeLargeHistoryFixture(sourceRoot, marker);
  assert.equal(source.bytes, LARGE_HISTORY_BYTES);
  await context.writeArtifactJson('migration-large-history-input.json', { bytes: source.bytes, sha256: source.sha256,
    records: source.records, payloadBytes: source.payloadBytes, generationBufferBytes: source.generationBufferBytes,
    cacheCondition: source.cacheCondition, limits, binarySha256, renderer, rendererSnapshot,
    hardware: { kernel: release(), arch: process.arch, node: process.version, logicalCpuCount: cpus().length,
      cpuModels: [...new Set(cpus().map(value => value.model))], totalMemoryBytes: totalmem() } });
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { responseSteps: () => [{ delta: { role: 'assistant', content: 'UNEXPECTED_MODEL_REQUEST' }, finishReason: 'stop' }] });
  await mkdir(profile, { mode: 0o700 });
  await writeFile(resolve(profile, 'settings.json'), JSON.stringify({ credential_store: 'file', hooks: {}, mcp_servers: [],
    active_provider: 'fixture', providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 1024,
      output_headroom_tokens: 1024, no_proxy: true, discover_models: false } } }), { mode: 0o600 });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = context.pathInState('large-history-launcher');
  await writeFile(launcher, `#!/bin/sh\nexport HOME=${quote(resolve(scratch.path, 'sources'))}\nexport KCODER_CONFIG_DIR=${quote(profile)}\nexport CLAUDE_CONFIG_DIR=${quote(sourceRoot)}\nexport CODEX_HOME=${quote(resolve(scratch.path, 'absent-codex'))}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
  const serversFile = await context.writeStateJson('large-history-servers.json', [{ id: 'large-history-target', label: 'Large history fixture',
    transport: 'local', command: launcher, workspace }]);
  const gateway = await startGateway(context, { label: 'large-history-gateway', workspace, serversFile, kcoderBin: binary,
    env: { KCODER_STUDIO_WEB_ROOT: rendererSnapshot.root } });
  const browser = await startChromium(context, { label: 'large-history-browser' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  context.addCleanup('close large-history page', () => page.close());
  page.setDefaultTimeout(30_000);
  const observations = [], pending = new Map();
  let frameViolation = null, maxFrameBytes = 0;
  page.on('websocket', socket => {
    socket.on('framesent', frame => {
      const bytes = Buffer.byteLength(frame.payload); maxFrameBytes = Math.max(maxFrameBytes, bytes);
      if (bytes > 2 * 1024 * 1024) { frameViolation = 'request frame exceeded2MiB'; return; }
      try {
        const outer = JSON.parse(frame.payload);
        for (let value = outer, depth = 0; value && typeof value === 'object' && depth < 3; value = value.params, depth++) {
          if (typeof value.method !== 'string' || !value.method.startsWith('migration/history/')) continue;
          const item = { method: value.method, jobId: value.params?.jobId, requestId: value.params?.requestId,
            expectedSequence: value.params?.expectedSequence, sentAt: performance.now() };
          observations.push(item); pending.set(outer.id, item); break;
        }
      } catch { /* Non-migration frames are outside this metadata trace. */ }
    });
    socket.on('framereceived', frame => {
      const bytes = Buffer.byteLength(frame.payload); maxFrameBytes = Math.max(maxFrameBytes, bytes);
      if (bytes > 2 * 1024 * 1024) { frameViolation = 'response frame exceeded2MiB'; return; }
      try {
        const value = JSON.parse(frame.payload), item = pending.get(value.id);
        if (!item) return;
        pending.delete(value.id);
        const result = value.result;
        Object.assign(item, { receivedAt: performance.now(), errorCode: value.error?.code,
          responseJobId: result?.job?.jobId, stage: result?.job?.stage, workerRunning: result?.workerRunning,
          cancelRequested: result?.job?.cancelRequested, sequence: result?.job?.sequence,
          pageItems: result?.items?.length, bodyBytes: typeof result?.text === 'string' ? Buffer.byteLength(result.text) : undefined });
      } catch { /* Preserve only bounded public metadata, never source text. */ }
    });
  });
  const token = await waitForGatewayRpcToken(context, gateway);
  const observer = await openRpc(gatewayRpcUrl(gateway, 'large-history-target', token));
  context.addCleanup('close large-history observer', () => closeRpcAndWait(observer));
  await initializeRpc(observer, 'large-history-performance-observer');
  const resources = await observer.request('server/resources/read');
  assert.ok(Number.isSafeInteger(resources.processId) && resources.processId > 0, 'the authoritative processId must be an OS PID');
  await page.goto(`${gateway.baseUrl}/settings/general`);
  await page.getByTestId('general-external-content-import-button').click();
  const dialog = page.getByTestId('migration-dialog');
  await selectAdvancedMigration(dialog, 'history');
  const panel = dialog.getByTestId('migration-history');
  const rss = await startLargeHistoryRssSampler(context, { browserPid: browser.child.pid, gatewayPid: gateway.child.pid,
    nativePid: resources.processId, nativeBinary: binary });
  const healthy = () => { rss.assertHealthy(); assert.equal(frameViolation, null); };
  try {
    const discoverAt = performance.now();
    await panel.getByRole('button', { name: '查找历史会话', exact: true }).click();
    await panel.getByText(source.title, { exact: true }).waitFor({ timeout: Math.min(30_000, remaining()) });
    const discoveryMs = performance.now() - discoverAt;
    assert.equal(await panel.getByRole('button', { name: '保存档案', exact: true }).count(), 1);
    await panel.getByRole('button', { name: '保存档案', exact: true }).click();
    const created = await waitFor(() => { healthy(); return observations.find(value => value.method === 'migration/history/create' && value.responseJobId); }, 30_000, 'accepted owned archive job', 50, signal);
    const jobId = created.responseJobId;
    let firstLongRead;
    const activeLong = await waitFor(async () => {
      healthy();
      const value = await observer.request('migration/history/read', { jobId });
      if (!value.workerRunning && value.job.stage === 'normalized') throw new Error('fixture missed active long-record cancellation; completion is not a cancellation pass');
      if (value.workerRunning && value.progress?.phase === 'normalizing' && value.progress.processed === 27 && value.progress.total === 28) {
        const readCharacters = await linuxReadCharacters(resources.processId);
        firstLongRead ??= readCharacters;
        if (readCharacters - firstLongRead >= 8 * 1024 * 1024) return value;
      }
      return null;
    }, Math.min(180_000, remaining()), 'Native actively consumes the single remaining long record', 100, signal);
    const cancelAt = performance.now();
    await panel.getByRole('button', { name: '取消归档', exact: true }).click();
    const acknowledged = await waitFor(() => observations.find(value => value.method === 'migration/history/cancel' && value.receivedAt),
      Math.min(10_000, remaining()), 'cancel intent receipt', 20, signal);
    await panel.getByText(/^(?:正在安全边界取消…|归档作业已取消)$/).first().waitFor({ timeout: Math.min(10_000, remaining()) });
    const cancelIntentVisibleMs = performance.now() - cancelAt;
    const stopped = await waitFor(async () => {
      const value = await observer.request('migration/history/read', { jobId });
      return !value.workerRunning && value.job.stage === 'cancelled' ? value : null;
    }, Math.min(10_000, remaining()), 'authoritative worker stopped at safe boundary', 20, signal);
    await panel.getByText('归档作业已取消', { exact: true }).waitFor({ timeout: Math.min(10_000, remaining()) });
    const stoppedAt = performance.now();
    assert.equal(stopped.workerRunning, false); assert.equal(stopped.job.stage, 'cancelled');
    assert.equal(stopped.job.normalization.normalizedRecords, 27);
    const cancelIntentMs = acknowledged.receivedAt - cancelAt, cancelStoppedMs = stoppedAt - cancelAt;
    await context.writeArtifactJson('migration-large-history-cancel.json', { jobId, beforeSequence: activeLong.job.sequence,
      stoppedSequence: stopped.job.sequence, normalizedRecords: stopped.job.normalization.normalizedRecords,
      actualLongRecordReadAdvanceAtLeastBytes: 8 * 1024 * 1024, cancelIntentMs, cancelIntentVisibleMs, cancelStoppedMs,
      authoritativeStopped: true, workerRunning: false });
    assert.ok(cancelIntentVisibleMs <= limits.cancelIntentMs, 'visible cancel intent exceeded the declared1s target');
    assert.ok(cancelStoppedMs <= limits.cancelStoppedMs, 'actual safe stop exceeded the declared5s budget');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByTestId('general-external-content-import-button').click();
    await selectAdvancedMigration(dialog, 'history');
    await panel.getByRole('button', { name: '归档记录', exact: true }).click();
    await panel.getByRole('button', { name: new RegExp(jobId) }).click();
    await panel.getByRole('button', { name: '恢复归档', exact: true }).click();
    await panel.getByText('档案已保存并解析', { exact: true }).waitFor({ timeout: Math.min(240_000, remaining()) });
    const completed = await observer.request('migration/history/read', { jobId });
    assert.equal(completed.workerRunning, false); assert.equal(completed.job.jobId, jobId);
    assert.equal(completed.job.normalization.normalizedRecords, LARGE_HISTORY_RECORDS);
    assert.equal(completed.job.normalization.recordsWithDiagnostics, 0, 'the fixed synthetic record forms must normalize without hidden partial-conversion diagnostics');
    const transcript = panel.getByTestId('migration-transcript');
    await transcript.getByTestId('historical-record').first().waitFor();
    const pages = [];
    for (let index = 0; index < 3; index++) {
      const expected = index < 2 ? 10 : 8;
      await waitFor(async () => (await transcript.getByTestId('historical-record').count()) === expected, 10_000, 'bounded transcript page', 50, signal);
      pages.push(await transcript.getByTestId('historical-record').count());
      if (index < 2) {
        const before = await transcript.getByTestId('historical-record').first().textContent();
        await transcript.getByRole('button', { name: '下一页', exact: true }).last().click();
        await waitFor(async () => (await transcript.getByTestId('historical-record').first().textContent()) !== before, 10_000, 'next immutable transcript page', 50, signal);
      }
    }
    const longRow = transcript.getByTestId('historical-record').last();
    await longRow.getByRole('button', { name: '分页查看完整内容', exact: true }).click();
    await waitFor(() => observations.some(value => value.method === 'migration/history/text' && value.bodyBytes > 0),
      10_000, 'bounded long-record text window', 50, signal);
    assert.ok(observations.filter(value => value.bodyBytes).every(value => value.bodyBytes <= 65536));
    assert.ok((await longRow.textContent()).length < 70_000, 'the DOM must contain a bounded window, never the whole500MiB record');
    healthy();
    const memory = await rss.stop();
    assert.equal(memory.fault, null);
    await context.writeArtifactJson('migration-large-history-roundtrip.json', { sourceBytes: source.bytes, sourceSha256: source.sha256,
      jobId, records: LARGE_HISTORY_RECORDS, pageSizes: pages, discoveryMs, cancelIntentMs, cancelIntentVisibleMs, cancelStoppedMs,
      stoppedSequence: stopped.job.sequence, finalSequence: completed.job.sequence, sameJobAfterExplicitResume: true,
      maximumObservedFrameBytes: maxFrameBytes, maximumBodyBytes: Math.max(...observations.map(value => value.bodyBytes ?? 0)),
      modelRequests: model.requests.length, sourceUnchanged: await hashHistoryFile(source.file) === source.sha256,
      historicalToolExecuted: await readFile(marker).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }),
      elapsedMs: performance.now() - started, cacheCondition: source.cacheCondition,
      scope: 'Actual Linux Browser/Gateway/Native archive and normalization only. Not unified batch, Electron, Windows/macOS, safe continuation or cold-cache performance.' });
    assert.equal(await hashHistoryFile(source.file), source.sha256);
    assert.equal(model.requests.length, 0);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.ok(memory.peakDeltaBytes.native <= limits.nativeDeltaBytes, 'Native RSS delta exceeded128MiB');
    assert.ok(memory.peakDeltaBytes.gateway <= limits.gatewayDeltaBytes, 'Gateway RSS delta exceeded128MiB');
    assert.ok(memory.nativeLifetimeHwmBytes - memory.baseline.nativeHwm <= limits.nativeDeltaBytes, 'Native high-water RSS growth exceeded128MiB between samples');
    assert.ok(memory.gatewayLifetimeHwmBytes - memory.baseline.gatewayHwm <= limits.gatewayDeltaBytes, 'Gateway high-water RSS growth exceeded128MiB between samples');
    assert.ok(memory.peakDeltaBytes.browser <= limits.browserDeltaBytes, 'Browser aggregate RSS delta exceeded256MiB');
    const runs = observations.filter(value => ['migration/history/create', 'migration/history/run', 'migration/history/resume', 'migration/history/cancel'].includes(value.method));
    assert.equal(runs.filter(value => value.method === 'migration/history/create').length, 1);
    assert.equal(runs.filter(value => value.method === 'migration/history/cancel').length, 1);
    assert.equal(runs.filter(value => value.method === 'migration/history/resume').length, 1);
    assert.ok(runs.filter(value => value.method !== 'migration/history/create').every(value => value.jobId === jobId));
    await context.writeArtifactJson('migration-large-history-rpc-metadata.json', { operations: runs, maxFrameBytes,
      note: 'Only IDs, sequences, bounded response sizes and timings retained; no source body.' });
    return { sourceBytes: source.bytes, normalizedRecords: LARGE_HISTORY_RECORDS, sameJobResume: true,
      pageSizes: pages, cancelIntentMs, cancelStoppedMs, sourceUnchanged: true, modelRequests: 0, historicalToolReplays: 0 };
  } catch (error) {
    await context.writeArtifactJson('migration-large-history-failure-metadata.json', { message: error.message,
      observations, frameViolation, maxFrameBytes, elapsedMs: performance.now() - started });
    await page.screenshot({ path: context.pathInArtifacts('failure-viewport.png'), fullPage: false }).catch(() => {});
    throw error;
  }
});
}
