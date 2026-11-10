import test from 'node:test';
import assert from 'node:assert/strict';
import { routeMigrationSourceSession } from './migration-source-session-routing.js';

const request = { sessionId: '22222222-2222-4222-8222-222222222222', purpose: 'source', targetId: 'local' };
function fixture() {
  const calls = [];
  const captureCurrent = () => ({ ownerId: 'authenticated-owner' });
  return { calls, owner: {
    async open(value) { calls.push(['open', value]); },
    read(value) { calls.push(['read', value]); return { status: 'ready', launching: false, ownedChildren: 1 }; },
    async release(value) { calls.push(['release', value]); return { status: 'released' }; },
  }, async resolveSelection(value) {
    calls.push(['resolve', value]);
    return { target: { id: value.targetId, runtime: 'kcoder', transport: 'local' }, workspacePath: value.workspacePath, captureCurrent };
  } };
}

test('open resolves only selectors and returns observation, never the private lease', async () => {
  const context = fixture();
  assert.deepEqual(await routeMigrationSourceSession('open', request, context), { status: 'ready', launching: false, ownedChildren: 1 });
  assert.deepEqual(context.calls.map(([name]) => name), ['resolve', 'open', 'read']);
  assert.deepEqual(context.calls[0][1], { targetId: 'local', workspacePath: undefined });
});

test('read and close never open or rediscover a Native session', async () => {
  for (const operation of ['read', 'close']) {
    const context = fixture();
    await routeMigrationSourceSession(operation, { ...request, purpose: 'target_recovery', workspacePath: 'C:\\work' }, context);
    assert.deepEqual(context.calls.map(([name]) => name), ['resolve', operation === 'close' ? 'release' : 'read']);
    assert.equal(context.calls[1][1].purpose, 'target-recovery');
  }
});

test('invalid frames cannot resolve targets or spawn processes', async () => {
  for (const payload of [null, { ...request, principal: { kind: 'localOs' } }, { ...request, sessionId: 'wizard' },
    { ...request, targetId: '' }, { ...request, targetId: 'x\n' }, { ...request, workspacePath: null },
    { ...request, workspacePath: 'x'.repeat(2049) }, { ...request, purpose: 'anything' }]) {
    const context = fixture();
    await assert.rejects(routeMigrationSourceSession('open', payload, context));
    assert.equal(context.calls.length, 0);
  }
});

test('denied or changed target resolution never invokes the owner', async () => {
  for (const resolved of [null, { target: { id: 'peer' }, captureCurrent() {} },
    { target: { id: 'local' }, workspacePath: '/different', captureCurrent() {} }]) {
    const context = fixture();
    context.resolveSelection = async () => resolved;
    await assert.rejects(routeMigrationSourceSession('open', request, context));
    assert.equal(context.calls.length, 0);
  }
});

test('lost open response is not retried by the route', async () => {
  const context = fixture();
  context.owner.open = async () => { context.calls.push(['open']); throw new Error('outcome unknown'); };
  await assert.rejects(routeMigrationSourceSession('open', request, context), /outcome unknown/);
  assert.deepEqual(context.calls.map(([name]) => name), ['resolve', 'open']);
});

test('discovery uses existing source lease and never opens a replacement', async () => {
  for (const [kind, params, method] of [
    ['projects', { source: 'codex' }, 'migration/projects/discover'],
    ['projects_page', { catalogId: 'owned', pageIndex: 1 }, 'migration/projects/sources'],
    ['project_roots', { catalogId: 'owned', sourceHandle: 'item', pageIndex: 0 }, 'migration/projects/source-roots'],
    ['configuration', { sources: ['claude-code'] }, 'migration/discover'],
    ['definitions', { sources: ['codex'], pageIndex: 0 }, 'migration/definitions/discover'],
    ['uploaded_select', { operationId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64) }, 'migration/source/upload/select'],
    ['memory', { source: 'claude-code' }, 'migration/memory/discover'],
    ['memory_page', { catalogId: 'owned-memory', cursor: null }, 'migration/memory/sources'],
    ['source_bindings', { sourceIds: ['opaque'] }, 'migration/source/bindings'],
    ['history', { source: 'codex' }, 'migration/history/discover'],
    ['history_families', { source: 'codex' }, 'migration/history/families/discover'],
    ['history_page', { catalogId: 'catalog', cursor: null }, 'migration/history/sources'],
  ]) {
    const context = fixture();
    context.owner.request = async (options, actual, body) => {
      context.calls.push(['request', options]); assert.equal(actual, method); assert.deepEqual(body, params);
      return { sources: [] };
    };
    assert.deepEqual(await routeMigrationSourceSession('query', { session: request, query: { kind, params } }, context), { sources: [] });
    assert.deepEqual(context.calls.map(([name]) => name), ['resolve', 'request']);
  }
});

test('discovery cannot become a generic RPC tunnel or target recovery operation', async () => {
  for (const payload of [
    { session: request, query: { kind: 'source_bindings', params: { sourceIds: ['same', 'same'] } } },
    { session: request, query: { kind: 'source_bindings', params: { sourceIds: ['opaque'], root: '/private' } } },
    { session: request, query: { kind: 'execute', params: { method: 'turn/start' } } },
    { session: request, query: { kind: 'configuration', params: { sourcePath: '/private' } } },
    { session: { ...request, purpose: 'target_recovery' }, query: { kind: 'configuration', params: {} } },
  ]) {
    const context = fixture();
    await assert.rejects(routeMigrationSourceSession('query', payload, context));
    assert.ok(context.calls.every(([name]) => name === 'resolve'));
  }
});

test('Codex source queries bind the existing source child and only source provenance can be read', async () => {
  for (const [kind, params, method, expected] of [
    ['codex_layers_select', { sourceId: 'opaque', includeProject: true }, 'migration/codex/layers/select', { sourceId: 'opaque', includeProject: true }],
    ['configuration_layers_read', { sourceId: 'claude-source', pageIndex: 1 }, 'migration/configuration/layers', { target: { kind: 'source', sourceId: 'claude-source' }, pageIndex: 1 }],
    ['codex_layers_read', { sourceId: 'derived', pageIndex: 1 }, 'migration/codex/layers/read', { target: { kind: 'source', sourceId: 'derived' }, pageIndex: 1 }],
  ]) {
    const context = fixture();
    context.owner.request = async (options, actual, body) => { assert.equal(options.sessionId, request.sessionId); assert.equal(actual, method); assert.deepEqual(body, expected); return {}; };
    await routeMigrationSourceSession('query', { session: request, query: { kind, params } }, context);
  }
  for (const params of [{ target: { kind: 'job', jobId: 'peer' } }, { sourceId: 'opaque', path: '/private' }]) {
    const context = fixture();
    await assert.rejects(routeMigrationSourceSession('query', { session: request, query: { kind: 'codex_layers_read', params } }, context));
    assert.equal(context.calls.length, 0);
  }
});

test('explicit directory choice goes only to the selected source runtime without opening a replacement', async () => {
  const params = { selectionId: '11111111-1111-4111-8111-111111111111', source: 'codex', directory: 'C:\\owned\\product' };
  const context = fixture();
  context.owner.request = async (options, method, body) => {
    context.calls.push(['request', options]);
    assert.equal(method, 'migration/source/directory/select'); assert.deepEqual(body, params);
    return { selectionId: params.selectionId, source: params.source, remainingMs: 600000 };
  };
  await routeMigrationSourceSession('query', { session: request, query: { kind: 'directory_select', params } }, context);
  assert.deepEqual(context.calls.map(([name]) => name), ['resolve', 'request']);
  for (const session of [{ ...request, purpose: 'target' }, { ...request, purpose: 'target_recovery' }]) {
    await assert.rejects(routeMigrationSourceSession('query', { session, query: { kind: 'directory_select', params } }, context), { reason: 'source_transfer_method_unavailable' });
  }
  for (const invalid of [{ ...params, directory: 'x'.repeat(4097) }, { ...params, home: '/forged' }, { ...params, selectionId: 'unbound' }]) {
    const blocked = fixture();
    await assert.rejects(routeMigrationSourceSession('query', { session: request, query: { kind: 'directory_select', params: invalid } }, blocked));
    assert.equal(blocked.calls.length, 0);
  }
});


test('uploaded selection cannot inject Native paths, source credentials or transfer authority', async () => {
  const params = { operationId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64) };
  for (const key of ['root', 'profile', 'path', 'home', 'sourceAuthority', 'originalAccount']) {
    const context = fixture();
    await assert.rejects(routeMigrationSourceSession('query', { session: request, query: { kind: 'uploaded_select', params: { ...params, [key]: '/untrusted' } } }, context));
    assert.equal(context.calls.length, 0);
  }
});


test('source configuration report queries reject job and path fields before dispatch', async () => {
  const calls = [];
  const context = { owner: { request: (...args) => calls.push(args) }, resolveSelection: async () => { throw new Error('invalid query must not resolve a target'); } };
  const session = { sessionId: '22222222-2222-4222-8222-222222222222', targetId: 'local', purpose: 'source' };
  for (const params of [{ target: { kind: 'job', jobId: 'peer' } }, { sourceId: 'opaque', path: '/private' }, { sourceId: 'opaque', pageIndex: -1 }]) {
    await assert.rejects(routeMigrationSourceSession('query', { session, query: { kind: 'configuration_layers_read', params } }, context), { reason: 'source_transfer_invalid_request' });
  }
  assert.equal(calls.length, 0);
});


test('instruction capture/page/body preserve the original owned child and never accept destination authority', async () => {
  const captureId = 'a9f28e76-ef84-4ae2-af14-e6d7ba05c45e';
  const cases = [
    ['instructions_capture', { captureId, source: 'codex', format: 'static_v2', sourceRoot: '/owned/source', sourceCwd: '/owned/source', confirmStaticSubset: true }, 'migration/instructions/capture', null],
    ['instructions_page', { captureId, pageIndex: 2 }, 'migration/instructions/page', { target: { kind: 'source', captureId }, pageIndex: 2 }],
    ['instructions_body', { captureId, itemId: 'instruction-owned', representation: 'compiled', offset: 12 }, 'migration/instructions/body', { target: { kind: 'source', captureId }, itemId: 'instruction-owned', representation: 'compiled', offset: 12 }],
  ];
  for (const [kind, params, method, body] of cases) {
    const context = fixture();
    context.owner.request = async (_scope, actual, input) => { assert.equal(actual, method); assert.deepEqual(input, body ?? params); context.calls.push(['request']); return {}; };
    await routeMigrationSourceSession('query', { session: request, query: { kind, params } }, context);
    assert.deepEqual(context.calls.map(([name]) => name), ['resolve', 'request']);
  }
  for (const kind of ['instructions_page', 'instructions_body']) {
    const context = fixture();
    await assert.rejects(routeMigrationSourceSession('query', { session: request, query: { kind, params: { captureId, target: { kind: 'job', jobId: 'mig-' + 'a'.repeat(32) } } } }, context));
    assert.equal(context.calls.length, 0);
  }
});
