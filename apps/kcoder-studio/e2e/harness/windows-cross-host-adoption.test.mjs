import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { seedCrossHostAdoptionSource, CROSS_HOST_HISTORY_RELATIVE,
  exerciseCrossHostAdoption } from './windows-cross-host-adoption.mjs';

const fixture = new URL('../fixtures/migration/history-source-compressed.jsonl', import.meta.url);
const originalFixture = new URL('../fixtures/migration/history-source-compressed.jsonl.zst', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function owned(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-cross-host-adoption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('three synthetic source classes retain compressed original bytes without executing source hooks', async t => {
  const root = await owned(t);
  const original = await readFile(originalFixture), decoded = await readFile(fixture);
  for (const label of ['windows', 'linux']) {
    const source = join(root, label), marker = join(root, `${label}-never-executed`);
    const result = await seedCrossHostAdoptionSource(source, label, marker, original, decoded);
    assert.equal(result.files.length, 3);
    assert.deepEqual(await readFile(join(source, CROSS_HOST_HISTORY_RELATIVE)), original);
    assert.equal(result.historyOriginalSha256, sha(original));
    assert.equal(result.historyDecodedSha256, sha(decoded));
    for (const item of result.files) {
      const saved = await readFile(join(source, item.path));
      assert.equal(sha(saved), item.sha256); assert.equal(saved.length, item.bytes);
    }
    await assert.rejects(access(marker), { code: 'ENOENT' });
    assert.equal(JSON.stringify(result).includes('hooks'), false, 'retained metadata does not expose source commands');
  }
});

test('invalid archived representation and mismatched recorded identity reject before creating any source files', async t => {
  const root = await owned(t);
  const original = await readFile(originalFixture), decoded = await readFile(fixture);
  const changed = Buffer.from(decoded.toString().replace('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001'));
  for (const args of [ [original, changed], [Buffer.from('not-zstd'), decoded], [original, Buffer.alloc(65536)] ])
    await assert.rejects(seedCrossHostAdoptionSource(root, 'linux', join(root, 'marker'), ...args));
  assert.deepEqual(await readdir(root), []);
});

test('failed ordinary planning closes its exact owned RPC and cannot advance to publication', async () => {
  const received = ['configuration', 'work_asset', 'history'].map((kind, index) => ({ class: kind, entryId: `${index}`,
    ...(kind === 'work_asset' ? { category: 'skill' } : {}), ...(kind === 'history' ? { projectScoped: true } : {}) }));
  const state = { workerState: 'stopped', phase: 'preview_ready', completedSources: 3,
    jobs: [{ jobId: 'owned-job', source: 'claude-code', previewReady: true }, { jobId: 'owned-history', source: 'codex', previewReady: true }] };
  let closed = 0; const calls = [];
  const rpc = { socket: { readyState: 1, constructor: { CLOSED: 3 },
    addEventListener(_name, handler) { this.onClose = handler; } },
    close() { closed++; this.socket.readyState = 3; this.socket.onClose(); },
    async request(method) {
      calls.push(method);
      if (method === 'migration/items') return { items: [{ id: 'p', category: 'provider' }, { id: 's', category: 'skill' }] };
      if (method === 'migration/batch/read') return { state: { job: { sequence: 1 } } };
      if (method === 'migration/batch/plan') throw new Error('owned-plan-refused');
      assert.fail(`unexpected write ${method}`);
    } };
  const adoptionId = 'frozen-adoption';
  await assert.rejects(exerciseCrossHostAdoption({
    async call(_area, operation, params) {
      if (operation === 'received') return { items: received, totalSources: 3, nextPage: null };
      if (operation === 'adoption-prepare') return { state: { adoptionId: params.locator.adoptionId } };
      if (operation === 'adoption-read') return { state };
      assert.fail(`unexpected operation ${operation}`);
    }, until: async callback => callback(), connect: async () => rpc,
    closeRecovery: async () => assert.fail('failed preparation must not replace unrelated recovery'),
    reopenRecovery: async () => assert.fail('no implicit recovery'),
    recovery: {}, pair: { requestId: adoptionId }, receipt: { manifestSha256: 'a'.repeat(64) },
    from: 'windows', to: 'linux', files: { read: async () => Buffer.from('{}'), exists: async () => false }, expected: {},
  }), /owned-plan-refused/);
  assert.equal(closed, 1);
  assert.deepEqual(calls, ['migration/items', 'migration/batch/read', 'migration/batch/plan']);
});
