import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareCrossHostAssetTransfers, finishCrossHostAssetTransfers, readCrossHostReceivedAssets } from './windows-cross-host-content-assets.mjs';

const capabilities = { source: { migrationMemoryV1: true, migrationDefinitionsV1: true }, target: { migrationMemoryV1: true, migrationDefinitionsV1: true } };
const source = { sessionId: 'original-source', purpose: 'source' }, target = { sessionId: 'original-target', purpose: 'target' };

test('missing either peer content capability refuses before discovery or any transfer write', async () => {
  for (const peer of ['source', 'target']) {
    const value = structuredClone(capabilities); value[peer].migrationMemoryV1 = false;
    await assert.rejects(prepareCrossHostAssetTransfers({ capabilities: value, source, target, call: () => assert.fail('no RPC before capabilities'), until: () => assert.fail('no worker before capabilities') }), /UNMET_PREREQUISITE/);
  }
});

test('a terminal source transfer failure cannot be polled or rerun until green', async () => {
  const operations = []; let observed = 0;
  await assert.rejects(prepareCrossHostAssetTransfers({ capabilities, source, target, from: 'windows', to: 'linux',
    openPair: async () => ({ source, target }), closePair: async () => {},
    call: async (lane, operation, params) => {
      operations.push(`${lane}/${operation}`);
      if (operation === 'query') return { catalogId: params.query.params.source, items: [{ sourceId: `source-${params.query.params.source}` }], nextCursor: null, problems: [] };
      if (operation === 'run') return;
      if (operation === 'read') return { result: { phase: 'failed' } };
      assert.fail('unexpected operation');
    }, until: async read => { observed++; return read(); },
  }), /terminal failure/);
  assert.equal(observed, 1); assert.equal(operations.filter(value => value === 'source-transfer/run').length, 1);
});

test('each independent content request discovers and transfers in its own exact source/target pair, then closes that pair once', async () => {
  let count = 0; const opened = [], closed = [], sent = [], receipts = new Map();
  const transfers = await prepareCrossHostAssetTransfers({ capabilities, from: 'windows', to: 'linux',
    openPair: async ({ kind }) => { const session = { source: { sessionId: `${kind}-source-${++count}` }, target: { sessionId: `${kind}-target-${count}` } }; opened.push(session); return session; },
    closePair: async session => closed.push(session), until: read => read(), call: async (_lane, operation, params) => {
      if (operation === 'query') {
        const kind = params.query.kind; assert.equal(params.session, opened.at(-1).source);
        return { catalogId: `${kind}-${params.query.params.source ?? params.query.params.sources[0]}`, problems: [], nextCursor: null, nextPage: null,
          ...(kind === 'memory' ? { items: [{ sourceId: params.query.params.source }] } : { sources: [{ sourceId: params.query.params.sources[0] }] }) };
      }
      if (operation === 'run') {
        assert.equal(params.source, opened.at(-1).source); assert.equal(params.target, opened.at(-1).target);
        sent.push(params); if (!receipts.has(params.requestId)) receipts.set(params.requestId, { requestId: params.requestId, manifestSha256: 'a'.repeat(64) });
        return { result: { receipt: receipts.get(params.requestId) } };
      }
      if (operation === 'read') return { result: { phase: 'ready', receipt: receipts.get(params.requestId) } };
      assert.fail(operation);
    } });
  assert.equal(transfers.length, 2); assert.deepEqual(closed, opened); assert.equal(new Set(transfers.map(value => value.pair.source.sessionId)).size, 2);
  assert.equal(sent.length, 4); assert.equal(sent[0].attemptId, sent[1].attemptId); assert.equal(sent[2].attemptId, sent[3].attemptId);
});

test('a failed original content plan closes only its RPC and never publishes or starts another job', async () => {
  let closed = 0; const methods = [];
  const rpc = { socket: { readyState: 1, constructor: { CLOSED: 3 }, addEventListener(_name, fn) { this.onClose = fn; } },
    close() { closed++; this.socket.readyState = 3; this.socket.onClose(); },
    async request(method) {
      methods.push(method);
      if (method === 'migration/items') return { items: [{ id: 'owned-note', category: 'memory' }], nextCursor: null };
      if (method === 'migration/batch/read') return { state: { job: { sequence: 1 } } };
      if (method === 'migration/batch/plan') throw new Error('owned-plan-refused');
      assert.fail(`unexpected publication ${method}`);
    } };
  await assert.rejects(finishCrossHostAssetTransfers({
    transfers: [{ kind: 'memory', from: 'linux', to: 'windows', selectedSources: 2, pair: { requestId: 'original-request' }, receipt: { manifestSha256: 'a'.repeat(64) } }],
    recovery: target, connect: async () => rpc, files: { read: async () => Buffer.from('{}') }, until: read => read(),
    call: async (_lane, operation, params) => {
      if (operation === 'received') return { totalSources: 12, nextPage: params.pageIndex ? null : 1, receipt: { requestId: params.requestId, manifestSha256: params.manifestSha256 },
        items: Array.from({ length: params.pageIndex ? 2 : 10 }, (_, index) => ({ entryId: `entry-${params.pageIndex * 10 + index}`, class: 'work_asset', category: 'memory' })) };
      if (operation === 'adoption-prepare') return {};
      if (operation === 'adoption-read') return { state: { workerState: 'stopped', phase: 'preview_ready', completedSources: 12,
        jobs: [{ jobId: 'original-job', source: 'codex' }, { jobId: 'peer-job', source: 'claude-code' }] } };
      assert.fail('unexpected recovery');
    },
  }), /owned-plan-refused/);
  assert.equal(closed, 1); assert.deepEqual(methods, ['migration/items', 'migration/batch/read', 'migration/batch/plan']);
});

test('a two-grant memory transfer keeps all twelve received assets over10+2 pages under the original receipt', async () => {
  const transfer = { pair: { requestId: 'original' }, receipt: { requestId: 'original', manifestSha256: 'a'.repeat(64) }, selectedSources: 2 }, observed = [];
  const read = async (_lane, operation, params) => {
    assert.equal(operation, 'received'); assert.equal(params.requestId, transfer.pair.requestId); assert.equal(params.manifestSha256, transfer.receipt.manifestSha256); observed.push(params.pageIndex);
    return { receipt: transfer.receipt, totalSources: 12, nextPage: params.pageIndex ? null : 1,
      items: Array.from({ length: params.pageIndex ? 2 : 10 }, (_, index) => ({ entryId: `entry-${params.pageIndex * 10 + index}` })) };
  };
  assert.equal((await readCrossHostReceivedAssets({ transfer, call: read, recovery: target })).items.length, 12); assert.deepEqual(observed, [0, 1]);
  await assert.rejects(readCrossHostReceivedAssets({ transfer, recovery: target, call: async (...args) => ({ ...await read(...args), receipt: { ...transfer.receipt, requestId: 'foreign' } }) }));
});
