import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, statfs, writeFile } from 'node:fs/promises';
import { cpus, loadavg, release, totalmem } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from './gateway.mjs';
import { startChromium } from './chromium.mjs';
import { startApprovalModelFixture } from './approval-model.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from './rpc.mjs';
import { repoRoot, waitFor } from './run-context.mjs';
import { LARGE_HISTORY_LIMITS, freezeLargeHistoryRenderer, linuxAvailableMemory, startLargeHistoryRssSampler } from './migration-large-history.mjs';
import { startSmallAssetCancelDomObservation } from './migration-cancel-dom-observation.mjs';
import { observeSmallAssetFinish, observeSmallAssetRead, startSmallAssetDiagnostics } from './migration-small-assets-observation.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const SAFE_ERRORS = new Set(['migration_revision_conflict', 'migration_journal_busy', 'migration_settings_busy', 'migration_invalid_transition', 'migration_wrong_target',
  'migration_busy', 'migration_operation_failed', 'migration_batch_control_invalid_command', 'migration_batch_control_capacity_reached',
  'migration_batch_control_changed', 'migration_batch_control_unknown', 'migration_batch_cancel_command_changed']);
export const SMALL_ASSET_COUNTS = Object.freeze([128, 1024]);
export const SMALL_ASSET_LIMITS = Object.freeze({ ...LARGE_HISTORY_LIMITS, firstFeedbackMs: 2000 });

export function smallAssetObservationBudget(count) {
  assert.ok(SMALL_ASSET_COUNTS.includes(count));
  // These are bounded normal-dev functional observation allowances, not throughput targets.
  return { totalMs: count === 1024 ? 20 * 60000 : SMALL_ASSET_LIMITS.deadlineMs,
    resumeMs: 390000, undoMs: count === 1024 ? 12 * 60000 : 390000 };
}

export function smallAssetCounts(value) {
  if (value === undefined) return SMALL_ASSET_COUNTS;
  assert.ok(value === '128' || value === '1024', 'Choose exactly 128 or 1024 small assets');
  return [Number(value)];
}

export function migrationPerformanceCase(value) {
  if (value === undefined || value === 'history-500mib') return 'history-500mib';
  assert.equal(value, 'small-assets', 'unknown migration performance case'); return value;
}

/** Every small package remains within the actual 1024-asset/4096-node product limits. */
export async function writeSmallAssetFixture(root, count) {
  assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 1024);
  assert.ok(isAbsolute(root)); const parent = await lstat(dirname(root));
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && await realpath(dirname(root)) === dirname(root), 'fixture parent must be an owned ordinary path');
  await mkdir(root, { mode: 0o700 }); await mkdir(resolve(root, 'skills'), { mode: 0o700 });
  const files = [], names = [];
  for (let index = 0; index < count; index++) {
    const name = `q2-small-${String(index).padStart(4, '0')}`; names.push(name);
    await mkdir(resolve(root, 'skills', name), { mode: 0o700 });
    for (const [leaf, text] of [['SKILL.md', `---\nname: ${name}\ndescription: Review only supplied static material\n---\nQ2_SMALL_ASSET_${index}\nNo source program or Hook is authorized.\n`], ['note.txt', `Q2_STATIC_SUPPORT_${index}\n`]]) {
      const bytes = Buffer.from(text), path = `skills/${name}/${leaf}`;
      await writeFile(resolve(root, path), bytes, { flag: 'wx', mode: 0o600 }); files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  return { root, assets: count, payloadFiles: files.length, directoryEntries: count * 3, names, files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), manifestSha256: sha(JSON.stringify(files)),
    cacheCondition: 'Source was generated immediately before this case; warm filesystem cache, no cold-cache claim.' };
}

export async function verifySmallAssetFixture(fixture) {
  for (const entry of fixture.files) {
    assert.ok(/^skills\/q2-small-\d{4}\/(?:SKILL\.md|note\.txt)$/.test(entry.path));
    const file = resolve(fixture.root, entry.path), info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
    const bytes = await readFile(file); assert.ok(bytes.length === entry.bytes && sha(bytes) === entry.sha256, 'small-asset source bytes changed');
  }
  return true;
}

/** Only an observed running, partly committed worker can satisfy active cancellation. */
export function activeSmallAssetCheckpoint(value, expectedTotal) {
  const job = value.state.job;
  assert.equal(job.totalItems, expectedTotal); assert.equal(value.workerError, null);
  assert.ok(!['completed', 'completed_with_issues', 'failed', 'cancelled', 'rolled_back', 'interrupted', 'commit_unknown'].includes(job.status), 'fixture missed active cancellation; a completed/stopped job is not a cancellation pass');
  // The public flag also covers the currently Committing action, before its receipt exists.
  if (job.hasUnconfirmedOutcomes) assert.ok(value.workerRunning === true && job.status === 'applying', 'an unowned unknown outcome cannot satisfy active cancellation');
  return value.workerRunning === true && job.status === 'applying' && job.committedItems > 0 && job.committedItems < expectedTotal ? value : false;
}

/** An exact receipt proves this command was accepted; a separate lease read must prove stop. */
export function smallAssetCancellationReceipt(original, operation) {
  assert.equal(operation.method, 'migration/batch/control/cancel'); assert.equal(operation.errorCode, undefined);
  assert.equal(operation.jobId, original.jobId); assert.equal(original.phase, 'tracked');
  assert.match(operation.commandId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  for (const key of ['planId', 'runRequestId', 'admissionSequence']) assert.equal(operation[key], original.generation[key]);
  const control = operation.control; assert.equal(control.jobId, original.jobId); assert.equal(control.phase, 'tracked');
  assert.equal(control.cancelRequested, true); assert.deepEqual(control.generation, original.generation);
  const receipt = control.requestedReceipt; assert.ok(receipt, 'missing exact original cancellation receipt');
  assert.equal(receipt.commandId, operation.commandId);
  for (const key of ['planId', 'runRequestId', 'admissionSequence']) assert.equal(receipt[key], original.generation[key]);
  assert.ok(Number.isSafeInteger(receipt.acceptedSequence) && receipt.acceptedSequence >= receipt.admissionSequence
    && receipt.acceptedSequence <= control.currentSequence);
  return receipt;
}

/** Unified plans expose per-item targets on the paged item API, not legacy single-asset plans. */
export async function smallAssetPlannedTargets(rpc, jobId, count) {
  const targets = [], ids = new Set();
  for (let pageIndex = 0; pageIndex <= 102; pageIndex++) {
    const page = await rpc.request('migration/items', { jobId, pageIndex });
    assert.ok(page.items.length > 0 && page.items.length <= 10); assert.equal(page.planned.length, page.items.length);
    for (const item of page.items) {
      assert.equal(item.category, 'skill'); assert.equal(ids.has(item.id), false); ids.add(item.id);
      const plan = page.planned.find(row => row.itemId === item.id); assert.ok(plan); assert.equal(plan.enabled, false);
      assert.match(plan.targetName, /^[A-Za-z0-9._-]+$/); targets.push(plan.targetName);
    }
    assert.ok(targets.length <= count);
    if (!page.nextCursor) { assert.equal(targets.length, count); assert.equal(new Set(targets).size, count); return targets; }
  }
  throw new Error('Small-asset plan exceeded its bounded Native pages');
}

function memoryWithinBudget(memory) {
  assert.equal(memory.fault, null);
  for (const kind of ['native', 'gateway', 'browser']) assert.ok(Number.isFinite(memory.peakDeltaBytes[kind]) && memory.peakDeltaBytes[kind] <= SMALL_ASSET_LIMITS[`${kind}DeltaBytes`], `${kind} RSS exceeded the declared workload budget`);
  assert.ok(memory.nativeLifetimeHwmBytes - memory.baseline.nativeHwm <= SMALL_ASSET_LIMITS.nativeDeltaBytes);
  assert.ok(memory.gatewayLifetimeHwmBytes - memory.baseline.gatewayHwm <= SMALL_ASSET_LIMITS.gatewayDeltaBytes);
}

async function runCase(context, options, count) {
  const { binary, snapshot, scratch, model } = options, label = `small-assets-${count}`, root = resolve(scratch.path, label);
  await mkdir(root, { mode: 0o700 });
  const fixture = await writeSmallAssetFixture(resolve(root, 'claude'), count);
  const profile = resolve(root, 'profile'), home = resolve(root, 'home'), emptyCodex = resolve(root, 'empty-codex');
  for (const path of [profile, home, emptyCodex]) await mkdir(path, { mode: 0o700 });
  const originalSettings = Buffer.from(JSON.stringify({ credential_store: 'file', hooks: {}, mcp_servers: [], active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl, default_model: 'fixture', discover_models: false, no_proxy: true,
    context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
  } } }));
  await writeFile(resolve(profile, 'settings.json'), originalSettings, { flag: 'wx', mode: 0o600 });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: label });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`, launcher = resolve(root, 'launcher');
  await writeFile(launcher, `#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME=${quote(home)} USERPROFILE=${quote(home)} XDG_CONFIG_HOME=${quote(resolve(home, '.config'))} KCODER_CONFIG_DIR=${quote(profile)} CLAUDE_CONFIG_DIR=${quote(fixture.root)} CODEX_HOME=${quote(emptyCodex)} ${quote(binary)} "$@"\n`, { flag: 'wx', mode: 0o700 });
  const targetId = label, serversFile = await context.writeStateJson(`${label}-servers.json`, [{ id: targetId, label, transport: 'local', command: launcher, workspace }]);
  const gateway = await startGateway(context, { label: `${label}-gateway`, workspace, serversFile, kcoderBin: binary, env: { KCODER_STUDIO_WEB_ROOT: snapshot.root } });
  const browser = await startChromium(context, { label: `${label}-browser` }), page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  context.addCleanup(`close ${label} page`, () => page.close()); page.setDefaultTimeout(30000);
  const operations = [], pending = new Map(); let maximumFrameBytes = 0, invalidFrame = false;
  page.on('websocket', socket => {
    socket.on('framesent', frame => {
      maximumFrameBytes = Math.max(maximumFrameBytes, Buffer.byteLength(frame.payload)); if (maximumFrameBytes > 2 * 1024 * 1024) { invalidFrame = true; return; }
      try {
        const outer = JSON.parse(frame.payload);
        for (let value = outer, depth = 0; value && typeof value === 'object' && depth < 3; value = value.params, depth++) {
          if (!value.method?.startsWith('migration/')) continue;
          const row = { method: value.method, jobId: value.params?.jobId, requestId: value.params?.requestId, mode: value.params?.mode,
            planId: value.params?.planId, runRequestId: value.params?.runRequestId, admissionSequence: value.params?.admissionSequence, commandId: value.params?.commandId,
            expectedSequence: value.params?.expectedSequence, sentAt: performance.now() };
          operations.push(row); pending.set(outer.id, row); break;
        }
      } catch { /* Retain bounded public operation metadata only. */ }
    });
    socket.on('framereceived', frame => {
      maximumFrameBytes = Math.max(maximumFrameBytes, Buffer.byteLength(frame.payload)); if (maximumFrameBytes > 2 * 1024 * 1024) { invalidFrame = true; return; }
      try {
        const value = JSON.parse(frame.payload), row = pending.get(value.id); if (!row) return; pending.delete(value.id);
        Object.assign(row, { receivedAt: performance.now(), errorCode: value.error?.code,
          constantError: value.error ? SAFE_ERRORS.has(value.error.message) ? value.error.message : 'unclassified_native_error' : undefined,
          responseJobId: value.result?.job?.jobId ?? value.result?.state?.job?.jobId,
          sequence: value.result?.job?.sequence ?? value.result?.state?.job?.sequence, status: value.result?.job?.status ?? value.result?.state?.job?.status,
          pageItems: value.result?.items?.length });
        if (row.method.startsWith('migration/batch/control/') && value.result) {
          const control = value.result;
          row.control = { jobId: control.jobId, currentSequence: control.currentSequence, planId: control.planId,
            phase: control.phase, generation: control.generation, cancelRequested: control.cancelRequested, requestedReceipt: control.requestedReceipt };
        }
      } catch { /* No source text or tool input is retained. */ }
    });
  });
  const token = await waitForGatewayRpcToken(context, gateway), url = gatewayRpcUrl(gateway, targetId, token);
  let observer = await openRpc(url); context.addCleanup(`close ${label} observer`, () => closeRpcAndWait(observer));
  const capabilities = (await initializeRpc(observer, label)).capabilities.experimental;
  assert.equal(capabilities.migrationBatchWorkersV1, true);
  assert.equal(capabilities.migrationBatchControlV1, true, 'this Q2 run requires the explicit generation-bound cancellation capability');
  const resources = await observer.request('server/resources/read'); assert.ok(Number.isSafeInteger(resources.processId) && resources.processId > 0);
  await page.goto(`${gateway.baseUrl}/settings/general`); await page.getByTestId('general-external-content-import-button').click();
  const dialog = page.getByTestId('migration-dialog'); await dialog.getByRole('button', { name: '批量迁移', exact: true }).click();
  // Match the original history workload baseline: an empty, ready migration UI.
  const samplerContext = { writeArtifactJsonInternal: (name, value) => context.writeArtifactJsonInternal(`${label}/${name}`, value), addCleanup: (name, action) => context.addCleanup(`${label}: ${name}`, action) };
  const rss = await startLargeHistoryRssSampler(samplerContext, { browserPid: browser.child.pid, gatewayPid: gateway.child.pid, nativePid: resources.processId, nativeBinary: binary });
  const diagnostics = await startSmallAssetDiagnostics(samplerContext, { roots: rss.roots, page });
  let frozenMeasurement;
  const freezeWorkload = () => frozenMeasurement ??= (async () => {
    const memory = await rss.stop(); await diagnostics.stop(); return memory;
  })();
  const healthy = () => { rss.assertHealthy(); assert.equal(invalidFrame, false); };
  const began = performance.now(), observationBudget = smallAssetObservationBudget(count);
  let lastWorkerObservation = null, jobId = null, cancelDomObservation = null;
  const feedback = { unavailableReads: [] };
  const readonlyObserver = { request: (method, params) => observeSmallAssetRead(observer, method, params,
    { trace: feedback.unavailableReads, deadline: performance.now() + 5000, signal: context.abortSignal }) };
  try {
    diagnostics.mark('discovery');
    const discoverAt = performance.now(); await dialog.getByRole('button', { name: '查找可迁移内容', exact: true }).click();
    const skillSource = dialog.getByRole('checkbox', { name: 'Claude Code · 用户技能', exact: true }); await skillSource.waitFor();
    const firstSourceVisibleMs = performance.now() - discoverAt;
    feedback.firstSourceVisibleMs = firstSourceVisibleMs;
    assert.equal(await skillSource.isChecked(), true); assert.ok(firstSourceVisibleMs <= SMALL_ASSET_LIMITS.firstFeedbackMs, 'first source feedback exceeded2s');
    diagnostics.mark('planning');
    const previewAt = performance.now(); await dialog.getByRole('button', { name: '预览所选来源', exact: true }).click();
    await dialog.getByRole('heading', { name: '选择迁移内容', exact: true }).waitFor();
    await waitFor(async () => { healthy(); return await dialog.getByTestId('migration-content-item').count() === 10; }, 30000, 'first ten small assets', 20, context.abortSignal);
    const firstTenVisibleMs = performance.now() - previewAt;
    feedback.firstTenVisibleMs = firstTenVisibleMs;
    assert.ok(firstTenVisibleMs <= SMALL_ASSET_LIMITS.firstFeedbackMs, 'first ten asset rows exceeded2s from preview click');
    const scanned = operations.find(row => row.method === 'migration/batch/scan' && row.responseJobId); assert.ok(scanned);
    jobId = scanned.responseJobId; assert.equal((await readonlyObserver.request('migration/batch/read', { jobId })).state.job.totalItems, count);
    assert.equal(await dialog.getByTestId('migration-content-item').count(), 10);
    await dialog.getByRole('button', { name: '确认所选内容', exact: true }).click(); await dialog.getByRole('heading', { name: '确认批量计划', exact: true }).waitFor();
    diagnostics.mark('apply'); await dialog.getByRole('button', { name: '开始批量迁移', exact: true }).click();
    const active = await waitFor(async () => {
      healthy(); const value = await readonlyObserver.request('migration/batch/read', { jobId });
      lastWorkerObservation = { workerRunning: value.workerRunning, workerError: value.workerError, job: value.state.job, batch: value.state.batch };
      return activeSmallAssetCheckpoint(value, count);
    }, 60000, 'actual partly published small-asset worker', 20, context.abortSignal);
    const originalRun = operations.find(row => row.method === 'migration/batch/run' && row.jobId === jobId && row.mode === 'apply'); assert.ok(originalRun);
    const controlBefore = await readonlyObserver.request('migration/batch/control/read', { jobId });
    assert.equal(controlBefore.jobId, jobId); assert.equal(controlBefore.phase, 'tracked');
    assert.equal(controlBefore.generation.planId, originalRun.planId); assert.equal(controlBefore.generation.runRequestId, originalRun.requestId);
    assert.equal(controlBefore.generation.mode, 'apply');
    assert.ok(Number.isSafeInteger(controlBefore.generation.admissionSequence)
      && controlBefore.generation.admissionSequence > originalRun.expectedSequence
      && controlBefore.generation.admissionSequence <= active.state.job.sequence, 'the original Native admission is independent of later progress revisions');
    cancelDomObservation = await startSmallAssetCancelDomObservation(page);
    diagnostics.mark('cancel');
    const cancelAt = performance.now(); feedback.cancelAutomationStartedAt = cancelAt;
    await dialog.getByRole('button', { name: '取消本次迁移', exact: true }).click();
    const acknowledged = await waitFor(() => operations.find(row => row.method === 'migration/batch/control/cancel' && row.jobId === jobId && row.receivedAt), 10000, 'small-asset exact cancellation receipt', 10, context.abortSignal);
    assert.equal(acknowledged.errorCode, undefined, `cancel rejected: ${acknowledged.constantError ?? 'unknown'}`);
    const cancellationReceipt = smallAssetCancellationReceipt(controlBefore, acknowledged);
    Object.assign(feedback, { cancelRpcSentAt: acknowledged.sentAt, cancelRpcAcceptedAt: acknowledged.receivedAt,
      cancelAcceptedMs: acknowledged.receivedAt - cancelAt, cancellationReceipt, originalGeneration: controlBefore.generation });
    const cancelDom = await cancelDomObservation.rendered(), intentObservedAt = performance.now();
    const cancelIntentVisibleMs = (cancelDom.firstViewportAt ?? cancelDom.firstRenderedAt) - cancelDom.clickAt;
    Object.assign(feedback, { cancelDom, cancelIntentObservedAt: intentObservedAt,
      cancelAutomationObservedMs: intentObservedAt - cancelAt, cancelIntentVisibleMs });
    const stopped = await waitFor(async () => { const value = await readonlyObserver.request('migration/batch/read', { jobId }); return !value.workerRunning && value.state.job.status === 'cancelled' ? value : false; }, 10000, 'actual small-asset worker stopped', 10, context.abortSignal);
    const stoppedAt = performance.now(), cancelStoppedMs = stoppedAt - cancelAt;
    Object.assign(feedback, { cancelStoppedObservedAt: stoppedAt, cancelStoppedMs, stoppedJob: stopped.state.job, workerRunningAfterCancel: stopped.workerRunning });
    await context.writeArtifactJson(`${label}/cancel.json`, { jobId, ...feedback });
    assert.equal(stopped.workerError, null); assert.equal(stopped.state.job.hasUnconfirmedOutcomes, false);
    const observedReceipt = await readonlyObserver.request('migration/batch/control/read', { jobId, commandId: acknowledged.commandId });
    assert.deepEqual(observedReceipt.requestedReceipt, cancellationReceipt);
    assert.equal(cancelDom.clickCount, 1); assert.ok(cancelDom.firstViewportAt !== null, 'cancellation intent must be visible in the active viewport, not merely rendered offscreen');
    assert.ok(cancelIntentVisibleMs <= SMALL_ASSET_LIMITS.cancelIntentMs, 'cancel intent exceeded1s'); assert.ok(cancelStoppedMs <= SMALL_ASSET_LIMITS.cancelStoppedMs, 'safe stop exceeded5s');
    assert.ok(stopped.state.job.committedItems >= active.state.job.committedItems && stopped.state.job.committedItems < count);
    diagnostics.mark('resume');
    const resumeAt = performance.now();
    await dialog.getByRole('button', { name: '核对并继续', exact: true }).click();
    feedback.resumeObservations = [];
    await observeSmallAssetFinish({ visible: timeout => dialog.getByText('已完成保存', { exact: true }).waitFor({ timeout }),
      rpc: readonlyObserver, jobId, run: () => operations.find(row => row.method === 'migration/batch/run' && row.jobId === jobId && row.mode === 'resume'),
      initialSequence: stopped.state.job.sequence, terminalStatus: 'completed', activeStatus: 'applying',
      deadline: began + observationBudget.totalMs, phaseDeadline: resumeAt + observationBudget.resumeMs,
      trace: feedback.resumeObservations, signal: context.abortSignal });
    const completed = await readonlyObserver.request('migration/batch/read', { jobId }); assert.equal(completed.workerRunning, false); assert.equal(completed.state.job.status, 'completed');
    assert.equal(completed.state.job.committedItems, count); assert.equal(completed.state.job.hasUnconfirmedOutcomes, false);
    const targetNames = await smallAssetPlannedTargets(readonlyObserver, jobId, count), sourceIndices = new Set();
    for (const name of targetNames) {
      assert.match(name, /^[A-Za-z0-9._-]+$/);
      const text = await readFile(resolve(profile, 'skills', name, 'SKILL.md'), 'utf8'); assert.ok(text.includes('default_enabled: false'));
      const index = Number(/Q2_SMALL_ASSET_(\d+)/.exec(text)?.[1]); assert.ok(Number.isSafeInteger(index) && index >= 0 && index < count);
      assert.equal(sourceIndices.has(index), false); sourceIndices.add(index);
      assert.equal(await readFile(resolve(profile, 'skills', name, 'note.txt'), 'utf8'), `Q2_STATIC_SUPPORT_${index}\n`);
    }
    diagnostics.mark('reopen');
    await closeRpcAndWait(observer); observer = await openRpc(url); await initializeRpc(observer, `${label}-reopen`);
    const reopened = await readonlyObserver.request('migration/batch/read', { jobId }); assert.deepEqual(reopened.state, completed.state);
    assert.deepEqual((await readonlyObserver.request('migration/batch/control/read', { jobId, commandId: acknowledged.commandId })).requestedReceipt,
      cancellationReceipt, 'new connection recovers the same immutable cancellation command after explicit resume');
    diagnostics.mark('undo'); const undoAt = performance.now();
    await dialog.getByRole('button', { name: '撤销本次导入', exact: true }).click();
    feedback.undoObservations = [];
    await observeSmallAssetFinish({ visible: timeout => dialog.getByText('本次新增内容已撤销', { exact: true }).waitFor({ timeout }),
      rpc: readonlyObserver, jobId, run: () => operations.find(row => row.method === 'migration/batch/run' && row.jobId === jobId && row.mode === 'rollback'),
      initialSequence: reopened.state.job.sequence, terminalStatus: 'rolled_back', activeStatus: 'rolling_back',
      deadline: began + observationBudget.totalMs, phaseDeadline: undoAt + observationBudget.undoMs,
      extensionMs: observationBudget.undoMs - 300000, trace: feedback.undoObservations, signal: context.abortSignal });
    const undone = await readonlyObserver.request('migration/batch/read', { jobId }); assert.equal(undone.workerRunning, false); assert.equal(undone.state.job.status, 'rolled_back');
    for (const name of targetNames) await assert.rejects(access(resolve(profile, 'skills', name)), { code: 'ENOENT' });
    assert.deepEqual(await readFile(resolve(profile, 'settings.json')), originalSettings); assert.equal(await verifySmallAssetFixture(fixture), true); assert.equal(model.requests.length, 0);
    const modes = operations.filter(row => row.method === 'migration/batch/run'); assert.deepEqual(modes.map(row => row.mode), ['apply', 'resume', 'rollback']);
    assert.ok(modes.every(row => row.jobId === jobId)); assert.equal(new Set(modes.map(row => row.requestId)).size, 3);
    assert.equal(operations.filter(row => row.method === 'migration/batch/control/cancel' && row.jobId === jobId).length, 1);
    assert.equal(operations.filter(row => row.method === 'migration/cancel' && row.jobId === jobId).length, 0, 'legacy revision CAS does not prove this new cancellation boundary');
    diagnostics.mark('complete'); const memory = await freezeWorkload(); healthy(); memoryWithinBudget(memory);
    const result = { count, jobId, sourceFiles: fixture.payloadFiles, sourceBytes: fixture.totalBytes, sourceManifestSha256: fixture.manifestSha256,
      cacheCondition: fixture.cacheCondition, firstSourceVisibleMs, firstTenVisibleMs, firstSourceResponseMs: operations.find(row => row.method === 'migration/discover')?.receivedAt - discoverAt,
      scanResponseMs: scanned.receivedAt - previewAt, cancelIntentMs: acknowledged.receivedAt - cancelAt, cancelIntentVisibleMs, cancelStoppedMs,
      cancelledAfterItems: stopped.state.job.committedItems, cancellationReceipt, originalGeneration: controlBefore.generation,
      exactCommandReadback: true, sameJobExplicitResume: true, originalPlanReopened: true, ordinaryOwnedUndo: true,
      sourceUnchanged: true, targetSettingsRestored: true, defaultDisabled: true, modelRequests: 0, elapsedMs: performance.now() - began, maximumFrameBytes, memory,
      observationBudget, resumeObservations: feedback.resumeObservations, undoObservations: feedback.undoObservations, operations };
    await context.writeArtifactJson(`${label}/roundtrip.json`, result); return result;
  } catch (error) {
    // Failure screenshots and diagnostic RPCs must not enter the workload RSS window.
    const memory = await freezeWorkload(); feedback.workloadFrozenBeforeFailureDiagnostics = true;
    feedback.workloadPeakDeltaBytes = memory.peakDeltaBytes;
    if (cancelDomObservation) feedback.cancelDom = await cancelDomObservation.read().catch(() => feedback.cancelDom ?? null);
    if (jobId) {
      try { const value = await readonlyObserver.request('migration/batch/read', { jobId });
        lastWorkerObservation = { workerRunning: value.workerRunning, workerError: value.workerError, job: value.state.job, batch: value.state.batch };
      } catch { /* A failed read never authorizes a replay of the original operation. */ }
    }
    await context.writeArtifactJson(`${label}/failure.json`, { error: error.message, count, feedback, operations, lastWorkerObservation, maximumFrameBytes, invalidFrame, elapsedMs: performance.now() - began });
    await page.screenshot({ path: context.pathInArtifacts(`${label}-failure.png`), fullPage: false }).catch(() => {}); throw error;
  } finally {
    if (cancelDomObservation) await cancelDomObservation.dispose();
    await freezeWorkload(); await closeRpcAndWait(observer); await page.close(); await browser.close(); await context.stopOwned(`${label}-gateway`);
  }
}

/** The registered performance entry dispatches here; no independent runner or model workload. */
export async function runSmallAssetsPerformance(context, { binary, binarySha256, rendererRoot, rendererAdmission }) {
  const counts = smallAssetCounts(process.env.KCODER_E2E_MIGRATION_SMALL_ASSET_COUNT);
  const baseDirectory = resolve(repoRoot, 'target');
  assert.notEqual((await statfs(baseDirectory, { bigint: true })).type, 0x1021994n, 'small-asset measurement requires a disk filesystem, not tmpfs');
  const scratch = await context.createOwnedScratchDirectory('migration-small-assets', { baseDirectory, requiredBytes: 4n * 1024n ** 3n, reserveBytes: 2n * 1024n ** 3n,
    requiredMemoryBytes: 2n * 1024n ** 3n, availableMemoryBytes: await linuxAvailableMemory() });
  const snapshot = await freezeLargeHistoryRenderer(context, rendererRoot, resolve(scratch.path, 'renderer'));
  if (rendererAdmission.kind === 'retained-source-baseline') assert.equal(snapshot.manifestSha256,
    rendererAdmission.copyManifestSha256, 'the workload snapshot must match the reviewed baseline output inventory');
  const model = await startApprovalModelFixture(context, { responseSteps: () => [{ delta: { role: 'assistant', content: 'UNEXPECTED_MODEL_CALL' }, finishReason: 'stop' }] });
  await context.writeArtifactJson('migration-small-assets-input.json', { counts, limits: SMALL_ASSET_LIMITS,
    functionalObservationBudgets: counts.map(count => ({ count, ...smallAssetObservationBudget(count) })), binarySha256, renderer: snapshot, rendererAdmission,
    rssBaseline: 'empty migration UI ready, before source discovery; same timing boundary as the original 500MiB workload',
    hardware: { kernel: release(), arch: process.arch, node: process.version, logicalCpuCount: cpus().length, cpuModels: [...new Set(cpus().map(value => value.model))], totalMemoryBytes: totalmem(), loadAverage: loadavg() },
    scope: 'Actual Linux Browser/Gateway/Native unified small-asset batches. Warm generated fixtures only; no Windows/Electron/cold-cache/model claim.' });
  const cases = [];
  for (const count of counts) cases.push(await runCase(context, { binary, snapshot, scratch, model }, count));
  assert.equal(model.requests.length, 0); return { cases, counts, modelRequests: 0, scope: 'selected actual small-asset scales; original 500MiB case was not executed' };
}
