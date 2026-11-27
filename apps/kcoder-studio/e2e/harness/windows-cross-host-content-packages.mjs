import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeRpcAndWait } from './rpc.mjs';
import { awaitCrossHostReady, requireCrossHostContentCapabilities } from './windows-cross-host-content-contract.mjs';
import { allItems, completed } from './windows-cross-host-content-assets.mjs';

export const CROSS_HOST_INSTRUCTION_TARGETS = Object.freeze({
  'claude-code': { '': 'cross-host-instructions/claude/root', child: 'cross-host-instructions/claude/root/child' },
  codex: { '': 'cross-host-instructions/codex/root', child: 'cross-host-instructions/codex/root/child' },
});

async function ready(call, until, pair, selections, label) {
  const request = { ...pair, attemptId: randomUUID(), selections };
  await call('source-transfer', 'run', request, true);
  const value = await awaitCrossHostReady({ call, until, pair, label });
  return { pair, receipt: value.result.receipt, attemptId: request.attemptId };
}

/** Capture is an explicit source mutation; roots/cwd remain independent of target directory maps. */
export async function prepareCrossHostPackageTransfers({ call, until, from, to, metadata, capabilities, openPair, closePair }) {
  for (const peer of ['source', 'target']) requireCrossHostContentCapabilities(capabilities?.[peer], ['instructions', 'plugin']);
  const results = [];
  for (const vendor of ['claude-code', 'codex']) {
    const root = metadata.instructionRoots[vendor]; assert.ok(typeof root === 'string' && root.length > 0);
    const session = await openPair({ kind: 'instructions', vendor, sourceWorkspace: root });
    try {
    const captureId = randomUUID();
    const capture = await call('source-session', 'query', { session: session.source, query: { kind: 'instructions_capture', params: {
      captureId, source: vendor, format: 'static_v2', sourceRoot: root, sourceCwd: root, includeDescendants: true, confirmStaticSubset: true,
    } } });
    assert.equal(capture.captureId, captureId); assert.equal(capture.formatRevision, 'scoped-instructions/v2'); assert.equal(capture.completeAuthorizedStaticChain, true);
    assert.ok(capture.totalItems >= 2 && capture.totalItems <= 128);
    const page = await call('source-session', 'query', { session: session.source, query: { kind: 'instructions_page', params: { captureId, pageIndex: 0 } } });
    assert.ok(page.items.length <= 10 && page.items.some(item => item.relativeScope === 'child'));
    const selected = page.items.find(item => item.disposition === 'selected'); assert.ok(selected);
    for (const representation of ['original', 'compiled']) {
      const body = await call('source-session', 'query', { session: session.source, query: { kind: 'instructions_body', params: { captureId, itemId: selected.itemId, representation, offset: 0 } } });
      assert.equal(body.enabledByPreview, false); assert.ok(Buffer.from(body.bytesBase64, 'base64').length <= 16384);
    }
    const transfer = await ready(call, until, { requestId: randomUUID(), source: session.source, target: session.target }, [{ kind: 'instructions', captureId }], `owned ${vendor} graph receipt`);
    results.push({ ...transfer, kind: 'instructions', vendor, from, to, captureId, sourceRevision: capture.sourceRevision });
    } finally { await closePair(session); }
  }
  const pluginSession = await openPair({ kind: 'plugin' });
  try {
  const plugins = await call('source-session', 'query', { session: pluginSession.source, query: { kind: 'plugins', params: { sources: ['claude-code'], includeProject: false } } });
  assert.ok(plugins.candidates.length > 0 && plugins.candidates.length <= 10); assert.equal(plugins.nextCursor, null); assert.deepEqual(plugins.problems, []);
  const chosen = plugins.candidates.filter(item => item.name === 'cross-host-static'); assert.equal(chosen.length, 1);
  results.push({ ...await ready(call, until, { requestId: randomUUID(), source: pluginSession.source, target: pluginSession.target }, [{ kind: 'plugin', candidateId: chosen[0].candidateId }], 'owned static plugin receipt'), kind: 'plugin', from, to });
  } finally { await closePair(pluginSession); }
  return results;
}

async function receivedGraph(rpc, target) {
  const rows = [];
  for (let pageIndex = 0; pageIndex < 13; pageIndex++) {
    const page = await rpc.request('migration/instructions/page', { target, pageIndex }); assert.ok(page.items.length <= 10);
    rows.push(...page.items); if (page.nextPage == null) return rows;
  }
  throw new Error('Owned instruction graph page bound exceeded');
}

/** Target mappings use fixed pre-created owned directories; no source path becomes target authority. */
export function crossHostInstructionMappings(rows, vendor, entryId) {
  const choices = rows.filter(item => item.disposition === 'selected'); assert.ok(choices.length >= 2 && choices.length <= 128);
  return { entryId, items: choices.map(item => {
    assert.equal(item.completeAuthorizedStaticChain, true);
    const targetRelativeScope = CROSS_HOST_INSTRUCTION_TARGETS[vendor]?.[item.relativeScope];
    assert.ok(targetRelativeScope, 'an unreviewed source scope cannot derive a target directory');
    return { itemId: item.itemId, targetRelativeScope };
  }) };
}

export async function finishCrossHostPackageTransfers({ transfers, call, until, recovery, connect, files }) {
  const original = JSON.parse(await files.read('settings.json')), results = [];
  for (const transfer of transfers) {
    let rpc = await connect();
    try {
      const { kind, vendor, pair, receipt, from, to } = transfer;
      const received = await call('source-transfer', 'received', { target: recovery, requestId: pair.requestId, manifestSha256: receipt.manifestSha256, pageIndex: 0, includeInstructions: true, includePlugins: true });
      assert.equal(received.items.length, 1); assert.equal(received.totalSources, 1); assert.equal(received.items[0].class, kind);
      const entryId = received.items[0].entryId, locator = { target: recovery, requestId: pair.requestId, adoptionId: randomUUID() };
      const graphTarget = { kind: 'received', requestId: pair.requestId, manifestSha256: receipt.manifestSha256, entryId };
      const mapping = kind === 'instructions' ? crossHostInstructionMappings(await receivedGraph(rpc, graphTarget), vendor, entryId) : null;
      await call('source-transfer', 'adoption-prepare', { locator, manifestSha256: receipt.manifestSha256,
        selections: [{ entryId, ...(mapping ? { projectMapping: 'current_workspace' } : {}) }], ...(mapping ? { instructionMappings: [mapping] } : {}) });
      const ready = await until(async () => {
        const value = (await call('source-transfer', 'adoption-read', locator)).state; if (value.workerState === 'running') return false;
        assert.equal(value.workerState, 'stopped'); assert.equal(value.phase, 'preview_ready'); return value;
      }, 'original target package adoption preview', 30000);
      assert.equal(ready.jobs.length, 1); assert.deepEqual(JSON.parse(await files.read('settings.json')), original);
      const preview = ready.jobs[0], items = await allItems(rpc, preview.jobId); assert.ok(items.length > 0);
      assert.ok(items.every(item => item.category === kind));
      const choices = items.map((item, index) => kind === 'plugin' ? { kind: 'plugin', itemId: item.id, targetName: `received-${from}-static-plugin` }
        : { kind: 'asset', itemId: item.id, targetName: `received-${from}-${vendor}-instruction-${index}`, enableAfterImport: false });
      const before = await rpc.request('migration/batch/read', { jobId: preview.jobId });
      const plan = await rpc.request('migration/batch/plan', { jobId: preview.jobId, expectedSequence: before.state.job.sequence, choices, includeDefaultItems: false, reuseExisting: false });
      await rpc.request('migration/batch/run', { jobId: preview.jobId, expectedSequence: plan.job.sequence, planId: plan.batch.planId, requestId: randomUUID(), mode: 'apply' });
      const published = await completed(rpc, preview.jobId, until, items.length);
      let pluginId, operationId;
      let portableModeSeparation = null;
      if (kind === 'plugin') {
        const children = (await rpc.request('migration/plugin/list', {})).items.filter(row => row.batchJobId === preview.jobId); assert.equal(children.length, 1);
        operationId = children[0].operationId;
        const plugin = (await rpc.request('migration/plugin/read', { operationId })).job; assert.equal(plugin.imported, true);
        pluginId = plugin.targetId; assert.equal((await rpc.request('plugin/read', { pluginId })).plugin.enabled, false);
        const journal = JSON.parse(await files.read(`plugin-migrations-v1/${operationId}/job.json`));
        const received = journal.binding.received.binding, origin = received.entry.content.origin.package;
        assert.equal(received.receipt.manifestSha256, receipt.manifestSha256);
        assert.equal(origin.files, journal.package.files); assert.equal(origin.bytes, journal.package.bytes);
        if (from === 'linux' && to === 'windows') assert.notEqual(origin.sha256, journal.package.sha256, 'source0700 provenance and Windows physical package revision remain distinct');
        portableModeSeparation = { sourcePackageSha256: origin.sha256, targetPackageSha256: journal.package.sha256, sourceStatic0700: from === 'linux', fileAndByteCountsPreserved: true };
      } else {
        const target = { kind: 'job', jobId: preview.jobId }, saved = await receivedGraph(rpc, target);
        assert.ok(saved.length >= 2);
        for (const item of saved.filter(row => row.disposition === 'selected')) for (const representation of ['original', 'compiled']) {
          const body = await rpc.request('migration/instructions/body', { target, itemId: item.itemId, representation, offset: 0 }); assert.equal(body.enabledByPreview, false); assert.ok(Buffer.from(body.bytesBase64, 'base64').length <= 16384);
        }
      }
      await closeRpcAndWait(rpc); rpc = await connect();
      const reopened = await rpc.request('migration/batch/read', { jobId: preview.jobId }); assert.equal(reopened.state.batch.planId, plan.batch.planId);
      await rpc.request('migration/batch/run', { jobId: preview.jobId, expectedSequence: reopened.state.job.sequence, planId: plan.batch.planId, requestId: randomUUID(), mode: 'rollback' });
      const undone = await until(async () => { const value = await rpc.request('migration/batch/read', { jobId: preview.jobId }); if (value.workerRunning) return false; assert.equal(value.state.job.status, 'rolled_back'); return value; }, 'original package owned Undo', 30000);
      if (operationId) assert.equal((await rpc.request('migration/plugin/read', { operationId })).job.stage, 'undone');
      if (pluginId) assert.ok(!(await rpc.request('plugin/list', { all: true })).plugins.some(item => item.id === pluginId));
      assert.deepEqual(JSON.parse(await files.read('settings.json')), original);
      results.push({ kind, vendor: vendor ?? null, direction: `${from}->${to}`, requestId: pair.requestId, adoptionId: locator.adoptionId, jobId: preview.jobId,
        manifestSha256: receipt.manifestSha256, publishedStatus: published.state.job.status, importedItems: items.length, disabled: true,
        dataOnlyTargetMapping: !!mapping, sourceAbsentBeforeAdoption: true, reopenedOriginalPlan: true, undoStatus: undone.state.job.status, pluginId: pluginId ?? null, portableModeSeparation });
    } finally { await closeRpcAndWait(rpc); }
  }
  return results;
}
