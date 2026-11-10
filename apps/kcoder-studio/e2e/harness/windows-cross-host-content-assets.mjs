import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeRpcAndWait } from './rpc.mjs';
import { awaitCrossHostReady, crossHostContentSelection, requireCrossHostContentCapabilities } from './windows-cross-host-content-contract.mjs';

async function sourcePages(call, session, kind, vendor) {
  const rows = [], seen = new Set();
  let query = kind === 'memory' ? { kind, params: { source: vendor } } : { kind, params: { sources: [vendor] } };
  let catalog;
  for (let index = 0; index < 64; index++) {
    const page = await call('source-session', 'query', { session, query });
    const values = kind === 'memory' ? page.items : page.sources;
    assert.ok(Array.isArray(values) && values.length <= 10);
    assert.ok(Array.isArray(page.problems) && page.problems.length === 0);
    catalog ??= page.catalogId; assert.equal(page.catalogId, catalog);
    for (const row of values) {
      assert.ok(!seen.has(row.sourceId)); seen.add(row.sourceId); rows.push(row);
    }
    assert.ok(rows.length <= 64);
    const next = kind === 'memory' ? page.nextCursor : page.nextPage;
    if (next == null) return rows;
    query = kind === 'memory' ? { kind: 'memory_page', params: { catalogId: catalog, cursor: next } }
      : { kind, params: { sources: [vendor], catalogId: catalog, pageIndex: next } };
  }
  throw new Error('Owned content discovery exceeded its bounded pages');
}

/** Call before the original source children are closed; every result retains its own attempt. */
export async function prepareCrossHostAssetTransfers({ call, until, from, to, capabilities, openPair, closePair }) {
  for (const peer of ['source', 'target']) requireCrossHostContentCapabilities(capabilities?.[peer], ['memory', 'definitions']);
  const transfers = [];
  for (const kind of ['memory', 'definitions']) {
    const session = await openPair({ kind });
    try {
    const selected = [];
    for (const vendor of ['claude-code', 'codex']) {
      const rows = await sourcePages(call, session.source, kind, vendor);
      assert.ok(rows.length > 0, `the owned ${vendor} ${kind} fixture was not discovered`);
      selected.push(...rows.map(row => crossHostContentSelection(kind, row.sourceId)));
    }
    const pair = { requestId: randomUUID(), source: session.source, target: session.target };
    const request = { ...pair, attemptId: randomUUID(), selections: selected };
    await call('source-transfer', 'run', request, true);
    const observed = await awaitCrossHostReady({ call, until, pair, label: `${from}->${to} ${kind} original receipt` });
    const repeated = await call('source-transfer', 'run', request);
    assert.deepEqual(repeated.result.receipt, observed.result.receipt);
    transfers.push({ kind, from, to, pair, receipt: observed.result.receipt, selectedSources: selected.length, attemptId: request.attemptId });
    } finally { await closePair(session); }
  }
  return transfers;
}

export async function allItems(rpc, jobId) {
  const items = [], seen = new Set();
  for (let pageIndex = 0; pageIndex <= 102; pageIndex++) {
    const page = await rpc.request('migration/items', { jobId, pageIndex });
    assert.ok(page.items.length <= 10);
    for (const item of page.items) { assert.ok(!seen.has(item.id)); seen.add(item.id); items.push(item); }
    if (!page.nextCursor) return items;
  }
  throw new Error('Owned content inventory exceeded its bounded pages');
}

export async function completed(rpc, jobId, until, expectedItems) {
  return until(async () => {
    const value = await rpc.request('migration/batch/read', { jobId });
    if (value.workerRunning) return false;
    assert.equal(value.workerError, null); assert.equal(value.state.job.hasUnconfirmedOutcomes, false);
    assert.ok(['completed', 'completed_with_issues'].includes(value.state.job.status), 'a stopped failed/unknown job cannot count as publication');
    assert.equal(value.state.job.committedItems, expectedItems); return value;
  }, 'original content batch publication stopped', 30000);
}

async function memoryRows(rpc, jobId) {
  const found = [];
  for (let pageIndex = 0; pageIndex <= 102; pageIndex++) {
    const page = await rpc.request('migration/memory/list', { pageIndex }); assert.ok(page.items.length <= 10);
    found.push(...page.items.filter(row => row.provenance?.migrationJobId === jobId));
    if (page.nextPage == null) return found;
  }
  throw new Error('Owned memory record pages exceeded the bound');
}

/** One original grant can contain many logical assets; receiving pages stay tied to its receipt. */
export async function readCrossHostReceivedAssets({ transfer, call, recovery }) {
  const rows = [], seen = new Set(); let total;
  for (let pageIndex = 0; pageIndex <= 102; pageIndex++) {
    const page = await call('source-transfer', 'received', { target: recovery, requestId: transfer.pair.requestId, manifestSha256: transfer.receipt.manifestSha256, pageIndex });
    total ??= page.totalSources; assert.equal(page.totalSources, total); assert.ok(page.items.length <= 10);
    assert.equal(page.receipt.requestId, transfer.pair.requestId); assert.equal(page.receipt.manifestSha256, transfer.receipt.manifestSha256);
    for (const row of page.items) { assert.ok(!seen.has(row.entryId)); seen.add(row.entryId); rows.push(row); }
    if (page.nextPage === null) { assert.equal(rows.length, total); return { items: rows, totalSources: total }; }
    assert.equal(page.nextPage, pageIndex + 1);
  }
  throw new Error('Original received asset page bound exceeded');
}

/** Source-independent receipts become original ordinary batches; Ready alone never proves import. */
export async function finishCrossHostAssetTransfers({ transfers, call, until, recovery, connect, files }) {
  const original = JSON.parse(await files.read('settings.json')), results = [];
  for (const transfer of transfers) {
    const { kind, from, to, pair, receipt } = transfer;
    const received = await readCrossHostReceivedAssets({ transfer, call, recovery });
    assert.equal(received.totalSources, kind === 'memory' ? 12 : 5);
    assert.ok(received.items.every(row => row.class === 'work_asset' && (kind === 'memory' ? row.category === 'memory' : ['agent', 'hook'].includes(row.category))));
    const locator = { target: recovery, requestId: pair.requestId, adoptionId: randomUUID() };
    await call('source-transfer', 'adoption-prepare', { locator, manifestSha256: receipt.manifestSha256, selections: received.items.map(row => ({ entryId: row.entryId })) });
    const ready = await until(async () => {
      const value = (await call('source-transfer', 'adoption-read', locator)).state;
      if (value.workerState === 'running') return false;
      assert.equal(value.workerState, 'stopped'); assert.equal(value.phase, 'preview_ready'); return value;
    }, 'owned received asset preview', 30000);
    assert.equal(ready.completedSources, received.totalSources); assert.equal(ready.jobs.length, 2);
    assert.deepEqual(JSON.parse(await files.read('settings.json')), original);
    for (const preview of ready.jobs) {
      let rpc = await connect();
      try {
        const items = await allItems(rpc, preview.jobId);
        assert.ok(items.length > 0 && items.every(item => kind === 'memory' ? item.category === 'memory' : ['agent', 'hook'].includes(item.category)));
        if (kind === 'memory') assert.equal(items.length, preview.source === 'claude-code' ? 11 : 1);
        const choices = items.map((item, index) => ({ kind: 'asset', itemId: item.id, targetName: `received-${from}-${kind}-${preview.source}-${index}`, enableAfterImport: false,
          ...(kind === 'memory' ? { memoryMapping: preview.source === 'codex' ? 'current_workspace' : 'global' } : {}) }));
        const before = await rpc.request('migration/batch/read', { jobId: preview.jobId });
        const planned = await rpc.request('migration/batch/plan', { jobId: preview.jobId, expectedSequence: before.state.job.sequence, choices, includeDefaultItems: false, reuseExisting: false });
        const detail = await rpc.request('migration/items', { jobId: preview.jobId, pageIndex: 0 }); assert.ok(detail.planned.every(row => row.enabled === false));
        assert.deepEqual(JSON.parse(await files.read('settings.json')), original);
        await rpc.request('migration/batch/run', { jobId: preview.jobId, expectedSequence: planned.job.sequence, planId: planned.batch.planId, requestId: randomUUID(), mode: 'apply' });
        const published = await completed(rpc, preview.jobId, until, items.length);
        if (kind === 'memory') {
          const notes = await memoryRows(rpc, preview.jobId); assert.equal(notes.length, items.length);
          assert.ok(notes.every(row => !row.enabled && row.provenance?.factsVerified === false && row.scope.kind === (preview.source === 'codex' ? 'project' : 'global')));
          const text = await rpc.request('migration/memory/read', { id: notes[0].id, offset: 0 }); assert.ok(Buffer.byteLength(text.text) <= 8192); assert.match(text.text, /UNVERIFIED_CROSS_HOST_NOTE/);
        } else {
          for (const item of items) {
            const report = await rpc.request('migration/definitions/report', { jobId: preview.jobId, itemId: item.id, pageIndex: 0 });
            assert.ok(report.report.fields.length <= 10); assert.equal(report.report.executionAllowed, false);
            const body = await rpc.request('migration/definitions/body', { jobId: preview.jobId, itemId: item.id, offset: 0 });
            assert.ok(Buffer.from(body.bytesBase64, 'base64').length <= 16384); assert.match(body.sha256, /^[a-f0-9]{64}$/);
          }
        }
        await closeRpcAndWait(rpc); rpc = await connect();
        const reopened = await rpc.request('migration/batch/read', { jobId: preview.jobId }); assert.equal(reopened.state.batch.planId, planned.batch.planId);
        await rpc.request('migration/batch/run', { jobId: preview.jobId, expectedSequence: reopened.state.job.sequence, planId: planned.batch.planId, requestId: randomUUID(), mode: 'rollback' });
        const undone = await until(async () => { const value = await rpc.request('migration/batch/read', { jobId: preview.jobId }); if (value.workerRunning) return false; assert.equal(value.state.job.status, 'rolled_back'); return value; }, 'original received content Undo', 30000);
        if (kind === 'memory') assert.equal((await memoryRows(rpc, preview.jobId)).length, 0);
        assert.deepEqual(JSON.parse(await files.read('settings.json')), original);
        results.push({ kind, direction: `${from}->${to}`, jobId: preview.jobId, requestId: pair.requestId, adoptionId: locator.adoptionId,
          manifestSha256: receipt.manifestSha256, importedItems: items.length, publishedStatus: published.state.job.status, defaultDisabled: true,
          sourceAbsentBeforeAdoption: true, reopenedOriginalPlan: true, undoStatus: undone.state.job.status, factsVerified: kind === 'memory' ? false : null });
      } finally { await closeRpcAndWait(rpc); }
    }
  }
  return results;
}
