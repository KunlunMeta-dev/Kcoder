import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { MigrationSourceSessionOwner } from './migration-source-session-owner.js';
import { WorkspaceAppServerBroker } from './workspace-app-server-broker.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const target = { id: 'owned-local', runtime: 'kcoder', transport: 'local', command: '/owned/kcoder', cwd: '/owned/workspace' };
const digest = value => createHash('sha256').update(value).digest('hex');

function fixture(t, { old = false, projects = false, instructions = false, families = false, preparations = false, managed = false, sourceBindings = false, codexLayers = false, configurationLayers = false, sourceConfigurationLayers = configurationLayers, selectedDirectory = false, memory = false, definitions = false, plugins = false, pluginProjects = false, uploaded = false, uploadedPlugins = false, maxSessions = 8, initializeTimeoutMs = 500, cleanupTimeoutMs = 500 } = {}) {
  const records = [], terminated = [], hooks = {};
  let scope = { ownerId: 'owned-login', generation: 1, targetFingerprint: digest('owned-target'), principal: { kind: 'localOs' } };
  const calls = [];
  const launch = async options => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const resource = { child, broker: null, options, closed: false, frames: [] };
    child.kill = () => false;
    child.stdin = new Writable({ write(bytes, _encoding, finish) {
      for (const line of bytes.toString('utf8').trim().split('\n')) {
        const request = JSON.parse(line); resource.frames.push(request); calls.push(request.method);
        queueMicrotask(async () => {
          if (hooks.beforeResponse) await hooks.beforeResponse(resource, request);
          if (resource.closed) return;
          const experimental = { migrationSourceTransferParentLaunchV1: !old,
            migrationSourceDirectoryV1: selectedDirectory, migrationProjectsV1: projects,
            migrationMemoryV1: memory, migrationDefinitionsV1: definitions, migrationLocalPluginsV1: plugins, migrationSourceTransferPluginsV1: plugins, migrationPluginProjectsV1: pluginProjects,
            migrationSourceUploadedV1: uploaded,
            migrationSourceUploadedPluginsV1: uploadedPlugins,
            migrationHistoryFamilyIndexV1: families,
            migrationInstructionSourcesV1: instructions,
            migrationSourceTransferPrivateCredentialPreparationsV1: preparations,
            migrationSourceTransferPrivateCredentialsV1: preparations,
            migrationSourceCodexLayersV1: codexLayers,
            migrationSourceConfigurationLayersV1: sourceConfigurationLayers, migrationConfigurationLayersV1: configurationLayers,
            migrationSourceBindingsV1: sourceBindings, migrationSourceTransferInternalV1: managed || options.phase === 'migration', migrationSourceTransferTargetRecoveryV1: true };
          const result = request.method === 'initialize' ? { capabilities: { experimental } }
            : request.method === 'migration/discover' ? { sourceId: 'ref-' + records.indexOf(resource) }
              : { instance: records.indexOf(resource) };
          const response = hooks.response?.(request) ?? { result };
          child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }) + '\n');
        });
      }
      finish();
    } });
    resource.broker = new WorkspaceAppServerBroker({ child,
      adapter: { rawPassthrough: true, toUpstream: message => ({ upstream: [message], client: [] }),
        fromUpstream: message => ({ upstream: [], client: [message] }) }, maxMessageBytes: 2 * 1024 * 1024,
      retentionParentV1: managed, migrationSourceParentV1: options.phase === 'migration' });
    records.push(resource); if (!hooks.skipAdoption) options.adopt(resource);
    if (hooks.beforeLaunchReturn) await hooks.beforeLaunchReturn(resource);
    return resource;
  };
  const terminate = async resource => {
    terminated.push(resource);
    if (hooks.terminate) return hooks.terminate(resource);
    resource.closed = true; resource.child.emit('close', 0, null);
    return { status: 'stopped' };
  };
  const owner = new MigrationSourceSessionOwner({ launch, terminate, maxSessions, initializeTimeoutMs, cleanupTimeoutMs });
  t.after(async () => {
    hooks.terminate = null;
    await owner.close();
    assert.ok(records.every(record => record.closed), 'every owned fixture process closed');
  });
  const options = { sessionId: randomUUID(), purpose: 'source', target, captureCurrent: () => scope };
  return { owner, options, records, terminated, calls, hooks,
    change: value => { scope = { ...scope, ...value }; } };
}

test('an operation keeps discovery and transfer on one dedicated child and never shares another operation', async t => {
  const f = fixture(t);
  const first = await f.owner.open(f.options);
  assert.deepEqual(f.records.map(record => record.options.phase), ['probe', 'migration']);
  assert.ok(f.records[0].closed);
  assert.strictEqual(await f.owner.open(f.options), first);
  const found = await first.request('migration/discover', { sources: ['claude-code'] });
  assert.equal(found.sourceId, 'ref-1');
  const response = await first.endpoint.request('identity', {});
  assert.equal(response.instance, 1);
  await assert.rejects(first.request('turn/start', {}), { reason: 'source_transfer_method_unavailable' });
  const second = await f.owner.open({ ...f.options, sessionId: randomUUID() });
  assert.notStrictEqual(first, second); assert.equal(f.records.length, 4);
  await first.release(); assert.ok(f.records[1].closed); assert.ok(!f.records[3].closed);
  assert.equal((await first.release()).status, 'released');
});

test('an old Native probe never receives the hidden flag and cleanup is confirmed before rejection', async t => {
  const f = fixture(t, { old: true });
  await assert.rejects(f.owner.open(f.options), { reason: 'source_transfer_unsupported_native' });
  assert.equal(f.records.length, 1); assert.equal(f.records[0].options.phase, 'probe');
  assert.ok(f.records[0].closed); assert.equal(f.owner.size, 0);
});

test('target recovery initializes without bootstrap and cannot be used as a full peer or discovery child', async t => {
  const f = fixture(t);
  const lease = await f.owner.open({ ...f.options, purpose: 'target-recovery' });
  assert.deepEqual(f.calls, ['initialize', 'initialize']);
  await assert.rejects(lease.endpoint.request('identity', {}), { reason: 'source_transfer_outcome_unknown' });
  await assert.rejects(lease.request('migration/discover', {}), { reason: 'source_transfer_method_unavailable' });
  await assert.rejects(lease.endpoint.request('peer/accept', {}), { reason: 'source_transfer_outcome_unknown' });
  await lease.endpoint.request('peer/recover-target', { requestId: randomUUID() });
  assert.equal(f.calls.filter(method => method.endsWith('/peer/recover-target')).length, 1);
  assert.ok(!f.calls.some(method => method.endsWith('/identity')));
});

test('target recovery permits preparation status without granting identity or peer bootstrap', async t => {
  const f = fixture(t, { preparations: true });
  const lease = await f.owner.open({ ...f.options, purpose: 'target-recovery' });
  await lease.endpoint.request('peer/recover-target', { requestId: randomUUID() });
  const result = await lease.endpoint.request('target/private/prepare-status', { jobId: randomUUID() });
  assert.equal(result.instance, 1);
  assert.equal(f.calls.filter(method => method.endsWith('/target/private/prepare-status')).length, 1);
  await assert.rejects(lease.endpoint.request('identity', {}), { reason: 'source_transfer_outcome_unknown' });
  await assert.rejects(lease.endpoint.request('peer/accept', {}), { reason: 'source_transfer_outcome_unknown' });
  assert.ok(!f.calls.some(method => method.endsWith('/identity') || method.endsWith('/peer/accept')));
});

test('Codex family discovery needs its independent capability and cannot tunnel through a target', async t => {
  const old = fixture(t);
  const oldLease = await old.owner.open(old.options);
  await assert.rejects(oldLease.request('migration/history/families/discover', { source: 'codex' }), { reason: 'source_transfer_unsupported_native' });
  assert.ok(!old.calls.includes('migration/history/families/discover'));
  const f = fixture(t, { families: true });
  const lease = await f.owner.open(f.options);
  await assert.rejects(lease.request('migration/history/families/discover', { source: 'claude-code' }), { reason: 'source_transfer_invalid_request' });
  assert.ok(!f.calls.includes('migration/history/families/discover'));
  await lease.request('migration/history/families/discover', { source: 'codex' });
  assert.equal(f.calls.filter(method => method === 'migration/history/families/discover').length, 1);
  const targetLease = await f.owner.open({ ...f.options, sessionId: randomUUID(), purpose: 'target' });
  await assert.rejects(targetLease.request('migration/history/families/discover', { source: 'codex' }), { reason: 'source_transfer_method_unavailable' });
});

test('scope changes during the probe prevent the flagged launch and discard late discovery results', async t => {
  const f = fixture(t), hold = deferred();
  f.hooks.beforeResponse = async (_resource, request) => { if (request.method === 'initialize') await hold.promise; };
  const opening = f.owner.open(f.options);
  while (!f.calls.includes('initialize')) await tick();
  f.change({ generation: 2 }); hold.resolve();
  await assert.rejects(opening, { reason: 'source_transfer_authority_changed' });
  assert.equal(f.records.length, 1); assert.ok(f.records[0].closed);
  f.hooks.beforeResponse = null;
  const lease = await f.owner.open(f.options), late = deferred();
  f.hooks.beforeResponse = async (_resource, request) => { if (request.method === 'migration/discover') await late.promise; };
  const reading = lease.request('migration/discover');
  while (!f.calls.includes('migration/discover')) await tick();
  f.change({ ownerId: 'new-login' }); late.resolve();
  await assert.rejects(reading, { reason: 'source_transfer_authority_changed' });
});

test('cancelled opening cleans a late child and keeps its reserved capacity until launch settles', async t => {
  const f = fixture(t, { maxSessions: 1 }), hold = deferred(), signal = new AbortController();
  f.hooks.beforeLaunchReturn = async () => hold.promise;
  const opening = f.owner.open({ ...f.options, signal: signal.signal });
  while (f.records.length === 0) await tick();
  signal.abort();
  await assert.rejects(opening, { reason: 'source_transfer_authority_changed' });
  await assert.rejects(f.owner.open({ ...f.options, sessionId: randomUUID() }), { reason: 'source_transfer_session_limit' });
  hold.resolve();
  for (let i = 0; i < 20 && f.owner.size; i++) await tick();
  assert.ok(f.records[0].closed); assert.equal(f.owner.size, 0);
});

test('cleanup status without a close event retains ownership and forbids capacity reuse', async t => {
  const f = fixture(t, { maxSessions: 1 });
  const lease = await f.owner.open(f.options);
  f.hooks.terminate = async resource => { resource.child.exitCode = 0; return { status: 'stopped' }; };
  assert.equal((await lease.release()).status, 'unknown');
  assert.equal(f.owner.size, 1);
  assert.throws(() => lease.assertCurrent(), { reason: 'source_transfer_authority_changed' });
  await assert.rejects(f.owner.open({ ...f.options, sessionId: randomUUID() }), { reason: 'source_transfer_session_limit' });
  f.hooks.terminate = null;
  assert.equal((await lease.release()).status, 'released'); assert.equal(f.owner.size, 0);
});

test('a stale lease release cannot terminate a replacement operation with the same UUID', async t => {
  const f = fixture(t), old = await f.owner.open(f.options);
  await old.release();
  const current = await f.owner.open(f.options);
  await old.release();
  current.assertCurrent(); assert.ok(!f.records.at(-1).closed);
});

test('managed account sessions retain the authenticated parent and never downgrade to a local flag', async t => {
  const f = fixture(t, { managed: true });
  await f.owner.open({ ...f.options, target: { ...target, transport: 'ssh', security: { identity: { mode: 'kcoder-account' } } } });
  assert.equal(f.records.length, 1); assert.equal(f.records[0].options.phase, 'probe');
  assert.deepEqual(f.calls, ['initialize']);
});

test('UUID knowledge cannot read or release another authenticated owner or generation', async t => {
  const f = fixture(t), lease = await f.owner.open(f.options);
  const stranger = { ...f.options, captureCurrent: () => ({ ...lease.captured, ownerId: 'another-login' }) };
  assert.throws(() => f.owner.read(stranger), { reason: 'source_transfer_authority_changed' });
  await assert.rejects(f.owner.release(stranger), { reason: 'source_transfer_authority_changed' });
  assert.ok(!f.records.at(-1).closed); lease.assertCurrent();
  const next = { ...f.options, captureCurrent: () => ({ ...lease.captured, generation: 2 }) };
  await assert.rejects(f.owner.release(next), { reason: 'source_transfer_authority_changed' });
  assert.equal(f.owner.read(f.options).status, 'ready');
  assert.equal((await f.owner.release(f.options)).status, 'released');
});

test('the server sweep reclaims an idle revoked scope without any subsequent client request', async t => {
  const f = fixture(t), lease = await f.owner.open(f.options);
  f.change({ generation: 2 });
  assert.deepEqual(await f.owner.sweep(), { results: [{ status: 'released' }] });
  assert.ok(f.records.at(-1).closed); assert.equal(f.owner.size, 0);
  assert.throws(() => lease.assertCurrent(), { reason: 'source_transfer_authority_changed' });
});

test('a launcher returning a late unadopted handle is cleaned after cancellation without releasing the slot early', async t => {
  const f = fixture(t, { maxSessions: 1 }), hold = deferred(), signal = new AbortController();
  f.hooks.skipAdoption = true; f.hooks.beforeLaunchReturn = async () => hold.promise;
  const opening = f.owner.open({ ...f.options, signal: signal.signal });
  while (f.records.length === 0) await tick();
  signal.abort(); await assert.rejects(opening, { reason: 'source_transfer_authority_changed' });
  assert.equal(f.owner.size, 1); assert.ok(!f.records[0].closed);
  hold.resolve();
  for (let i = 0; i < 20 && f.owner.size; i++) await tick();
  assert.ok(f.records[0].closed); assert.equal(f.owner.size, 0);
});

test('an unconfirmed probe cleanup never permits the flagged child to launch', async t => {
  const f = fixture(t, { maxSessions: 1 });
  f.hooks.terminate = async () => ({ status: 'stopped' });
  await assert.rejects(f.owner.open(f.options), { reason: 'source_transfer_cleanup_unconfirmed' });
  assert.equal(f.records.length, 1); assert.equal(f.records[0].options.phase, 'probe');
  assert.equal(f.owner.size, 1);
});

test('a stalled cleanup has a bounded unknown result and keeps ownership until the real close', async t => {
  const f = fixture(t, { cleanupTimeoutMs: 5 }), lease = await f.owner.open(f.options), hold = deferred();
  f.hooks.terminate = async () => hold.promise;
  assert.equal((await lease.release()).status, 'unknown'); assert.equal(f.owner.size, 1);
  f.records.at(-1).closed = true; f.records.at(-1).child.emit('close', 0, null); hold.resolve();
  for (let i = 0; i < 20 && f.owner.size; i++) await tick();
  assert.equal(f.owner.size, 0);
});

test('initialize timeout never starts a new flagged child or leaves the probe unowned', async t => {
  const f = fixture(t, { initializeTimeoutMs: 5 }), hold = deferred();
  f.hooks.beforeResponse = async () => hold.promise;
  await assert.rejects(f.owner.open(f.options), { reason: 'source_transfer_outcome_unknown' });
  assert.equal(f.records.length, 1); assert.ok(f.records[0].closed); assert.equal(f.owner.size, 0);
  hold.resolve();
});

test('a faulty launcher cannot reuse or terminate a different operation child', async t => {
  const f = fixture(t), first = await f.owner.open(f.options), resource = f.records.at(-1);
  f.owner.launch = async () => resource;
  await assert.rejects(f.owner.open({ ...f.options, sessionId: randomUUID() }), { reason: 'source_transfer_owned_child_conflict' });
  first.assertCurrent(); assert.ok(!resource.closed); assert.equal(f.owner.size, 1);
});

test('existing-session discovery never launches missing or released sessions and keeps the same source refs', async t => {
  const f = fixture(t);
  await assert.rejects(f.owner.request(f.options, 'migration/discover'), { reason: 'source_transfer_session_unavailable' });
  assert.equal(f.records.length, 0);
  const lease = await f.owner.open(f.options);
  assert.deepEqual(await f.owner.request(f.options, 'migration/discover'), await lease.request('migration/discover'));
  assert.equal(f.records.length, 2);
  await lease.release();
  await assert.rejects(f.owner.request(f.options, 'migration/discover'), { reason: 'source_transfer_session_unavailable' });
  assert.equal(f.records.length, 2);
});

test('existing-session discovery rejects another owner, wrong purpose and an opening record without sending a request', async t => {
  const f = fixture(t), hold = deferred();
  f.hooks.beforeLaunchReturn = async () => hold.promise;
  const opening = f.owner.open(f.options);
  await assert.rejects(f.owner.request(f.options, 'migration/discover'), { reason: 'source_transfer_session_unavailable' });
  hold.resolve(); const lease = await opening;
  const before = f.calls.length;
  await assert.rejects(f.owner.request({ ...f.options, captureCurrent: () => ({ ...lease.captured, ownerId: 'peer' }) },
    'migration/discover'), { reason: 'source_transfer_authority_changed' });
  assert.equal(f.calls.length, before);
  await f.owner.open({ ...f.options, purpose: 'target' });
  await assert.rejects(f.owner.request({ ...f.options, purpose: 'target' }, 'migration/discover'), { reason: 'source_transfer_method_unavailable' });
  assert.ok(!f.calls.includes('migration/discover'));
});


test('source binding descriptions require their independent Native capability before dispatch', async t => {
  const old = fixture(t), lease = await old.owner.open(old.options);
  await assert.rejects(lease.request('migration/source/bindings', { sourceIds: ['opaque'] }), { reason: 'source_transfer_source_bindings_update_required' });
  assert.ok(!old.calls.includes('migration/source/bindings'));
  const current = fixture(t, { sourceBindings: true }), selected = await current.owner.open(current.options);
  await selected.request('migration/source/bindings', { sourceIds: ['opaque'] });
  assert.equal(current.calls.filter(method => method === 'migration/source/bindings').length, 1);
  const target = await current.owner.open({ ...current.options, purpose: 'target', sessionId: randomUUID() });
  await assert.rejects(target.request('migration/source/bindings', { sourceIds: ['opaque'] }), { reason: 'source_transfer_method_unavailable' });
});

test('source Codex layers need the independent capability and cannot tunnel through a target child', async t => {
  const old = fixture(t), lease = await old.owner.open(old.options);
  for (const method of ['migration/codex/layers/select', 'migration/codex/layers/read']) {
    await assert.rejects(lease.request(method, {}), { reason: 'source_transfer_codex_layers_update_required' });
    assert.ok(!old.calls.includes(method));
  }
  const current = fixture(t, { codexLayers: true }), source = await current.owner.open(current.options);
  await source.request('migration/codex/layers/select', { sourceId: 'opaque', includeProject: true });
  await source.request('migration/codex/layers/read', { target: { kind: 'source', sourceId: 'derived' }, pageIndex: 1 });
  const target = await current.owner.open({ ...current.options, purpose: 'target', sessionId: randomUUID() });
  await assert.rejects(target.request('migration/codex/layers/select', {}), { reason: 'source_transfer_method_unavailable' });
  assert.equal(current.calls.filter(method => method === 'migration/codex/layers/select').length, 1);
});

test('directory selection is capability gated and available only on the original source child', async t => {
  const method = 'migration/source/directory/select';
  const params = { selectionId: randomUUID(), source: 'codex', directory: '/owned/product' };
  const old = fixture(t), oldLease = await old.owner.open(old.options);
  await assert.rejects(oldLease.request(method, params), { reason: 'source_transfer_directory_update_required' });
  assert.ok(!old.calls.includes(method));
  const current = fixture(t, { selectedDirectory: true }), source = await current.owner.open(current.options);
  await source.request(method, params);
  assert.equal(current.calls.filter(value => value === method).length, 1);
  const target = await current.owner.open({ ...current.options, purpose: 'target', sessionId: randomUUID() });
  await assert.rejects(target.request(method, params), { reason: 'source_transfer_method_unavailable' });
  current.change({ generation: 2 });
  await assert.rejects(source.request(method, params), { reason: 'source_transfer_authority_changed' });
  assert.equal(current.calls.filter(value => value === method).length, 1);
});

test('directory errors expose only reviewed codes and never private parser or path text', async t => {
  const f = fixture(t, { selectedDirectory: true }), source = await f.owner.open(f.options);
  for (const [message, expected] of [
    ['migration_selected_root_changed', 'source_transfer_directory_changed'],
    ['migration_selected_root_already_discovered', 'source_transfer_directory_in_use'],
    ['PRIVATE_DIRECTORY_CANARY /owned/private', 'source_transfer_outcome_unknown'],
    [{ toString: 'PRIVATE_DIRECTORY_CANARY' }, 'source_transfer_outcome_unknown'],
  ]) {
    f.hooks.response = request => request.method === 'migration/source/directory/select' ? { error: { code: -32047, message } } : undefined;
    await assert.rejects(source.request('migration/source/directory/select', {}), { reason: expected });
  }
});

test('memory discovery requires its own capability and original source owner', async t => {
  const old = fixture(t), lease = await old.owner.open(old.options);
  for (const method of ['migration/memory/discover', 'migration/memory/sources']) {
    await assert.rejects(lease.request(method, {}), { reason: 'source_transfer_memory_update_required' });
    assert.ok(!old.calls.includes(method));
  }
  const current = fixture(t, { memory: true }), source = await current.owner.open(current.options);
  await source.request('migration/memory/discover', { source: 'claude-code' });
  await source.request('migration/memory/sources', { catalogId: 'owned', cursor: null });
  const target = await current.owner.open({ ...current.options, purpose: 'target', sessionId: randomUUID() });
  await assert.rejects(target.request('migration/memory/discover', {}), { reason: 'source_transfer_method_unavailable' });
  current.change({ generation: 2 });
  await assert.rejects(source.request('migration/memory/sources', { catalogId: 'owned' }), { reason: 'source_transfer_authority_changed' });
});


test('uploaded source selection is separately gated and never offers a general upload tool tunnel', async t => {
  const params = { operationId: randomUUID(), manifestSha256: digest('owned uploaded manifest') };
  const old = fixture(t), oldLease = await old.owner.open(old.options);
  await assert.rejects(oldLease.request('migration/source/upload/select', params), { reason: 'source_transfer_uploaded_update_required' });
  assert.ok(!old.calls.includes('migration/source/upload/select'));
  const current = fixture(t, { uploaded: true }), lease = await current.owner.open(current.options);
  await lease.request('migration/source/upload/select', params);
  assert.equal(current.calls.filter(method => method === 'migration/source/upload/select').length, 1);
  for (const method of ['migration/source/upload/product/run', 'migration/source/upload/part', 'migration/source/upload/select/other'])
    await assert.rejects(lease.request(method, params), { reason: 'source_transfer_method_unavailable' });
});


test('source Claude layer reports need their own capability and cannot query saved target jobs', async t => {
  const old = fixture(t), previous = await old.owner.open(old.options);
  await assert.rejects(previous.request('migration/configuration/layers', { target: { kind: 'source', sourceId: 'opaque' }, pageIndex: 0 }), { reason: 'source_transfer_configuration_layers_update_required' });
  assert.ok(!old.calls.includes('migration/configuration/layers'));
  for (const options of [{ configurationLayers: true, sourceConfigurationLayers: false }, { configurationLayers: false, sourceConfigurationLayers: true }]) {
    const incompatible = fixture(t, options), lease = await incompatible.owner.open(incompatible.options);
    await assert.rejects(lease.request('migration/configuration/layers', { target: { kind: 'source', sourceId: 'opaque' }, pageIndex: 0 }), { reason: 'source_transfer_configuration_layers_update_required' });
    assert.ok(!incompatible.calls.includes('migration/configuration/layers'));
  }
  const current = fixture(t, { configurationLayers: true }), source = await current.owner.open(current.options);
  for (const params of [{ target: { kind: 'job', jobId: 'peer' }, pageIndex: 0 }, { target: { kind: 'source', sourceId: 'opaque' }, path: '/private' }]) {
    await assert.rejects(source.request('migration/configuration/layers', params), { reason: 'source_transfer_invalid_request' });
  }
  assert.ok(!current.calls.includes('migration/configuration/layers'));
  await source.request('migration/configuration/layers', { target: { kind: 'source', sourceId: 'opaque' }, pageIndex: 1 });
  assert.equal(current.calls.filter(method => method === 'migration/configuration/layers').length, 1);
  const target = await current.owner.open({ ...current.options, purpose: 'target', sessionId: randomUUID() });
  await assert.rejects(target.request('migration/configuration/layers', { target: { kind: 'source', sourceId: 'opaque' } }), { reason: 'source_transfer_method_unavailable' });
});


test('passive definitions use a separate source capability and cannot read target jobs', async t => {
  const old = fixture(t), oldLease = await old.owner.open(old.options);
  await assert.rejects(oldLease.request('migration/definitions/discover', {}), { reason: 'source_transfer_definitions_update_required' });
  assert.ok(!old.calls.includes('migration/definitions/discover'));
  const current = fixture(t, { definitions: true }), lease = await current.owner.open(current.options);
  await lease.request('migration/definitions/discover', { sources: ['codex'], pageIndex: 0 });
  for (const method of ['migration/definitions/report','migration/definitions/body'])
    await assert.rejects(lease.request(method, { jobId: 'peer-target', itemId: 'private' }), { reason: 'source_transfer_method_unavailable' });
  current.change({ generation: 2 });
  await assert.rejects(lease.request('migration/definitions/discover', {}), { reason: 'source_transfer_authority_changed' });
});


test('plugin sources need independent transfer and explicit project support without exposing job mutation', async t => {
  const old = fixture(t), oldLease = await old.owner.open(old.options);
  await assert.rejects(oldLease.request('migration/plugin/discover', {}), { reason: 'source_transfer_plugins_update_required' });
  assert.ok(!old.calls.includes('migration/plugin/discover'));
  const f = fixture(t, { plugins: true }), lease = await f.owner.open(f.options);
  await assert.rejects(lease.request('migration/plugin/discover', { includeProject: true }), { reason: 'source_transfer_plugin_projects_update_required' });
  await lease.request('migration/plugin/discover', { sources: ['codex'], cursor: null });
  for (const method of ['migration/plugin/plan', 'migration/plugin/capture', 'migration/plugin/apply', 'migration/plugin/undo'])
    await assert.rejects(lease.request(method, {}), { reason: 'source_transfer_method_unavailable' });
  const current = fixture(t, { plugins: true, pluginProjects: true }), authorized = await current.owner.open(current.options);
  await authorized.request('migration/plugin/discover', { sources: ['claude-code'], includeProject: true });
});

test('uploaded plugin discovery needs its own capability even when ordinary plugins and uploaded roots are supported', async t => {
  const input = { sources: ['claude-code'], includeUploaded: true };
  const old = fixture(t, { plugins: true, uploaded: true }), oldLease = await old.owner.open(old.options);
  await assert.rejects(oldLease.request('migration/plugin/discover', input), { reason: 'source_transfer_uploaded_update_required' });
  assert.ok(!old.calls.includes('migration/plugin/discover'));
  const current = fixture(t, { plugins: true, uploaded: true, uploadedPlugins: true }), lease = await current.owner.open(current.options);
  await lease.request('migration/plugin/discover', input);
  assert.deepEqual(current.records[1].frames.find(frame => frame.method === 'migration/plugin/discover').params, input);
});


test('instruction capture is independently negotiated, same-child, request-bound, and never a target/path read tunnel', async t => {
  const id = randomUUID();
  const input = { captureId: id, source: 'claude-code', format: 'static_v2', sourceRoot: '/owned/source', sourceCwd: '/owned/source/work', confirmStaticSubset: true };
  const old = fixture(t), oldLease = await old.owner.open(old.options);
  await assert.rejects(oldLease.request('migration/instructions/capture', input), { reason: 'source_transfer_instructions_update_required' });
  assert.ok(!old.calls.includes('migration/instructions/capture'));
  const f = fixture(t, { instructions: true }), lease = await f.owner.open(f.options);
  const result = { captureId: id, source: 'claude-code', formatRevision: 'scoped-instructions/v2', sourceRevision: 'a'.repeat(64), totalItems: 0, completeAuthorizedStaticChain: true, dynamicScopePresent: false, remainingMs: 600000 };
  f.hooks.response = () => ({ result });
  assert.deepEqual(await lease.request('migration/instructions/capture', input), result);
  assert.equal(f.records[1].frames.filter(frame => frame.method === 'migration/instructions/capture').length, 1);
  for (const params of [{ target: { kind: 'job', jobId: 'mig-' + 'a'.repeat(32) } }, { target: { kind: 'source', captureId: id }, sourceRoot: '/private' }]) {
    await assert.rejects(lease.request('migration/instructions/page', params), { reason: 'source_transfer_invalid_request' });
  }
  assert.ok(!f.calls.includes('migration/instructions/page'));
  f.hooks.response = () => ({ result: { ...result, captureId: randomUUID() } });
  await assert.rejects(lease.request('migration/instructions/capture', input), { reason: 'source_transfer_invalid_response' });
});

test('lost instruction capture acknowledgement stays unknown and late result cannot cross login generation', async t => {
  const f = fixture(t, { instructions: true, initializeTimeoutMs: 50 }), lease = await f.owner.open(f.options);
  const input = { captureId: randomUUID(), source: 'codex', format: 'static_v2', sourceRoot: '/owned/source', sourceCwd: '/owned/source', confirmStaticSubset: true };
  const pending = deferred();
  f.hooks.beforeResponse = async (_resource, frame) => { if (frame.method === 'migration/instructions/capture') await pending.promise; };
  await assert.rejects(lease.request('migration/instructions/capture', input), { reason: 'source_transfer_outcome_unknown' });
  assert.equal(f.calls.filter(method => method === 'migration/instructions/capture').length, 1);
  f.change({ generation: 2 });
  pending.resolve();
  await assert.rejects(lease.request('migration/instructions/capture', input), { reason: 'source_transfer_authority_changed' });
  assert.equal(f.calls.filter(method => method === 'migration/instructions/capture').length, 1);
});


test('history catalog failures expose only reviewed recovery reasons on history observation methods', async t => {
  const f = fixture(t, { families: true });
  const lease = await f.owner.open(f.options);
  for (const [native, reason] of [
    ['history_discovery_family_metadata_changed', 'source_transfer_history_catalog_unavailable'],
    ['history_discovery_catalog_unavailable', 'source_transfer_history_catalog_unavailable'],
    ['history_discovery_expired', 'source_transfer_catalog_expired'],
    ['history_discovery_family_metadata_changed /private/path', 'source_transfer_outcome_unknown'],
  ]) {
    f.hooks.response = () => ({ error: { code: -32000, message: native } });
    await assert.rejects(lease.request('migration/history/sources', { catalogId: 'original', cursor: null }), { reason });
  }
  f.hooks.response = () => ({ error: { code: -32000, message: 'history_discovery_expired' } });
  await assert.rejects(lease.request('migration/discover', { sources: ['codex'] }), { reason: 'source_transfer_outcome_unknown' });
});

test('instruction recovery errors cross HTTP as reviewed source codes without echoing arbitrary Native diagnostics', async t => {
  const f = fixture(t, { instructions: true }), lease = await f.owner.open(f.options);
  const params = { target: { kind: 'source', captureId: randomUUID() } };
  f.hooks.response = () => ({ error: { code: -32047, message: 'migration_instruction_capture_expired' } });
  await assert.rejects(lease.request('migration/instructions/page', params), { reason: 'source_transfer_instruction_capture_expired' });
  f.hooks.response = () => ({ error: { code: -32047, message: 'migration_instruction_capture_expired: /PRIVATE_SOURCE_PATH' } });
  await assert.rejects(lease.request('migration/instructions/page', params), { reason: 'source_transfer_outcome_unknown' });
});


test('project source queries are independently negotiated and validate exact original source catalogs', async t => {
  const old = fixture(t), previous = await old.owner.open(old.options);
  await assert.rejects(previous.request('migration/projects/discover', { source: 'codex' }), { reason: 'source_transfer_projects_update_required' });
  assert.ok(!old.calls.includes('migration/projects/discover'));
  const f = fixture(t, { projects: true }), lease = await f.owner.open(f.options);
  const result = { catalogId: 'owned-projects', source: 'codex', pageIndex: 0, items: [], totalItems: 0, nextPage: null,
    knownRowsComplete: true, formatRevision: 'codex-project-registry/sqlite/1', unobserved: ['source_trust'], problems: [] };
  f.hooks.response = () => ({ result });
  assert.deepEqual(await lease.request('migration/projects/discover', { source: 'codex' }), result);
  for (const method of ['migration/projects/targets', 'migration/projects/target-roots', 'migration/projects/report'])
    await assert.rejects(lease.request(method, { jobId: 'peer' }), { reason: 'source_transfer_method_unavailable' });
  await assert.rejects(lease.request('migration/projects/discover', { source: 'codex', directory: '/private' }), { reason: 'source_transfer_invalid_request' });
  await assert.rejects(lease.request('migration/projects/sources', { catalogId: 'other', pageIndex: 0 }), { reason: 'source_transfer_invalid_response' });
  f.hooks.response = () => ({ error: { message: 'migration_project_source_changed' } });
  await assert.rejects(lease.request('migration/projects/sources', { catalogId: 'owned-projects' }), { reason: 'source_transfer_project_catalog_unavailable' });
  f.change({ generation: 2 });
  await assert.rejects(lease.request('migration/projects/discover', { source: 'codex' }), { reason: 'source_transfer_authority_changed' });
});

test('private transfer errors preserve reviewed contention reasons without leaking arbitrary text', async t => {
  const f = fixture(t), lease = await f.owner.open(f.options);
  const method = 'migration/sourceTransfer/internal/source/state';
  for (const [message, reason] of [
    ['source_transfer_busy', 'source_transfer_busy'],
    ['source_transfer_recovery_required', 'source_transfer_recovery_required'],
    ['source_transfer_busy /owned/private/CANARY', 'source_transfer_outcome_unknown'],
    [{ toString: 'PRIVATE_CANARY' }, 'source_transfer_outcome_unknown'],
  ]) {
    f.hooks.response = request => request.method === method ? { error: { code: -32047, message } } : undefined;
    await assert.rejects(lease.endpoint.request('source/state', { requestId: randomUUID() }), { reason });
  }
});
