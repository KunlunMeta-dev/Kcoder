import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MigrationSourceTransferService } from './migration-source-transfer-service.js';
import { MigrationSourceBridgeError } from './migration-source-private.js';
const sha = value => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const selected = [{ kind: 'configuration', sourceId: 'original-native-ref' }];
const fail = reason => { throw new MigrationSourceBridgeError(reason); };

function fixture() {
  const leases = new Map(), disk = new Map(), calls = [], state = { run: 0, finish: 0, sourceReads: 0, hold: null, loseClaim: false };
  function session(purpose, name = purpose) {
    const options = { sessionId: randomUUID(), purpose };
    const lease = { alive: true, released: 0,
      endpoint: { captured: { ownerId: 'server-login', generation: 1, targetFingerprint: sha(name), principal: { kind: 'localOs' } } },
      assertCurrent() { if (!this.alive) fail('source_transfer_authority_changed'); },
      async release() { this.alive = false; this.released++; return { status: 'released' }; } };
    leases.set(options.sessionId, lease); return options;
  }
  const source = session('source'), target = session('target');
  const owner = { async existingLease(options) {
    calls.push(['lease', options.purpose]); const lease = leases.get(options.sessionId);
    if (!lease) fail('source_transfer_session_unavailable'); lease.assertCurrent(); return lease;
  } };
  const projection = context => ({ requestId: context.requestId, phase: disk.get(context.requestId)?.ready ? 'ready' : 'pending',
    ...(context.source ? {} : { scope: 'target', sourceObserved: false }), receipt: disk.get(context.requestId)?.ready ? { fixture: true } : null });
  function bridge() {
    const gateway = randomUUID();
    return {
      async savedSelections() { return selected; },
      async read(context) { state.sourceReads++; return projection(context); }, async readTarget(context) { return projection(context); },
      async claimAttempt(options) {
        calls.push(['claim', options.attemptId]);
        let journal = disk.get(options.requestId);
        if (!journal) { journal = { attempts: new Map(), selectionDigest: null, ready: false, lease: null }; disk.set(options.requestId, journal); }
        const entry = { attemptId: options.attemptId, kind: options.kind, callDigest: options.callDigest, selectionDigest: options.selectionDigest ?? null };
        const old = journal.attempts.get(options.attemptId);
        if (old && JSON.stringify(old) !== JSON.stringify(entry)) fail('source_transfer_attempt_conflict');
        if (!old && journal.lease) fail('source_transfer_attempt_busy');
        if (!old && entry.kind === 'run') {
          if (journal.selectionDigest && journal.selectionDigest !== entry.selectionDigest) fail('source_transfer_request_changed');
          journal.selectionDigest = entry.selectionDigest;
        }
        if (!old) { journal.attempts.set(entry.attemptId, entry); journal.lease = gateway; }
        const result = { admitted: !old, view: { tracked: true, bindingDigest: sha('actual Native grant scope'),
          selectionDigest: journal.selectionDigest, attempt: entry, running: Boolean(journal.lease) } };
        if (state.loseClaim) { state.loseClaim = false; fail('source_transfer_outcome_unknown'); }
        return result;
      },
      async releaseAttempt(options) {
        const journal = disk.get(options.requestId), released = journal?.lease === gateway;
        if (released) journal.lease = null; return { released };
      },
      async run(context) {
        state.run++; context.onProgress({ requestId: context.requestId, phase: 'capturing' });
        if (state.hold) await state.hold.promise;
        if (context.signal.aborted) fail('source_transfer_interrupted');
        disk.get(context.requestId).ready = true; return projection(context);
      },
      async cancel(context) { return { ...projection(context), phase: 'cancelled' }; },
      async cancelTarget(context) { return { ...projection(context), phase: 'cancelled' }; },
      async resumeTarget(context) { return projection(context); },
      async finishTarget(context) { state.finish++; disk.get(context.requestId).ready = true; return projection(context); },
    };
  }
  const options = { requestId: randomUUID(), attemptId: randomUUID(), source, target, selections: selected };
  return { owner, bridge, state, calls, disk, session, leases, options };
}
async function settled(service) { for (let i = 0; i < 100 && service.running; i++) await tick(); assert.equal(service.running, 0); }

test('HTTP admission follows durable acceptance while the copy stays asynchronous and duplicate HTTP attempts never rerun', async () => {
  const f = fixture(), service = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge() });
  f.state.hold = deferred();
  assert.equal((await service.run(f.options)).coordinatorState, 'running');
  assert.ok(f.disk.get(f.options.requestId).attempts.has(f.options.attemptId));
  await service.run(f.options); assert.equal(f.state.run, 1); assert.equal(f.calls.filter(c => c[0] === 'claim').length, 1);
  await assert.rejects(service.run({ ...f.options, selections: [{ kind: 'configuration', sourceId: 'replacement' }] }),
    { reason: 'source_transfer_request_changed' });
  f.state.hold.resolve(); await settled(service);
  assert.equal((await service.read(f.options)).result.phase, 'ready');
});

test('a fresh Gateway reconciles an old accepted attempt and never runs it even if its original invocation never started', async () => {
  const f = fixture(), first = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge() });
  f.state.loseClaim = true;
  assert.equal((await first.run(f.options)).coordinatorState, 'unknown'); assert.equal(f.state.run, 0);
  const restarted = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge() });
  const recovered = await restarted.run(f.options);
  assert.equal(recovered.coordinatorState, 'unknown'); assert.equal(recovered.errorCode, 'source_transfer_attempt_unconfirmed');
  assert.equal(f.state.run, 0);
  await restarted.run({ ...f.options, attemptId: randomUUID() }); await settled(restarted);
  assert.equal(f.state.run, 1);
});

test('Native admission rejects changed semantics for an old attempt after a Gateway restart', async () => {
  const f = fixture(), service = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge() });
  await service.run(f.options); await settled(service);
  const restarted = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge() });
  const changed = await restarted.run({ ...f.options, selections: [{ kind: 'configuration', sourceId: 'other-native-ref' }] });
  assert.equal(changed.errorCode, 'source_transfer_attempt_conflict'); assert.equal(f.state.run, 1);
});

test('restoring the original Native intent across a fresh session and login generation preserves attempt semantics', async () => {
  const f = fixture(), first = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge() });
  await first.run(f.options); await settled(first);
  const source = f.session('source', 'source'), target = f.session('target', 'target');
  for (const options of [source, target]) {
    const scope = f.leases.get(options.sessionId).endpoint.captured;
    scope.generation = 2; scope.ownerId = 'fresh-authenticated-login';
  }
  const restarted = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge() });
  const { selections, ...saved } = f.options;
  const restored = await restarted.run({ ...saved, source, target });
  assert.equal(restored.errorCode, 'source_transfer_attempt_unconfirmed'); assert.equal(f.state.run, 1);
});

test('same session IDs cannot serve a different request and scope failure closes only this operation source and target', async () => {
  const f = fixture(), service = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge() });
  f.state.hold = deferred(); await service.run(f.options);
  await assert.rejects(service.read({ ...f.options, requestId: randomUUID() }), { reason: 'source_transfer_session_in_use' });
  const peer = f.session('source', 'peer'), peerLease = f.leases.get(peer.sessionId);
  const source = f.leases.get(f.options.source.sessionId), target = f.leases.get(f.options.target.sessionId);
  // A target-only read must not replace the active paired cleanup context.
  await service.targetRead(f.options); target.alive = false;
  await service.sweep(); assert.ok(source.released > 0 && target.released > 0); assert.equal(peerLease.released, 0);
  f.state.hold.resolve(); await settled(service);
});

test('operation capacity and independent run budget fail before another invocation or child launch', async () => {
  const f = fixture(), service = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge(), maxOperations: 2, maxRunning: 1 });
  f.state.hold = deferred(); await service.run(f.options);
  const second = { ...f.options, requestId: randomUUID(), attemptId: randomUUID(), source: f.session('source', 's2'), target: f.session('target', 't2') };
  await assert.rejects(service.run(second), { reason: 'source_transfer_running_limit' });
  await assert.rejects(service.read({ ...second, requestId: randomUUID(), source: f.session('source', 's3'), target: f.session('target', 't3') }),
    { reason: 'source_transfer_operation_limit' });
  assert.equal(f.state.run, 1); f.state.hold.resolve(); await settled(service);
});

test('a missing observation cache is unknown and read never schedules a run', async () => {
  const f = fixture(), service = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge() });
  const value = await service.read(f.options);
  assert.equal(value.coordinatorState, 'unknown'); assert.equal(value.observation, 'observed'); assert.equal(f.state.run, 0);
  assert.equal(f.calls.filter(c => c[0] === 'claim').length, 0);
});

test('target-only finish and resume use durable attempts without looking up or contacting the source', async () => {
  const f = fixture(), service = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge() });
  const options = { requestId: f.options.requestId, target: f.options.target, attemptId: randomUUID() };
  await service.targetFinish(options); await settled(service);
  assert.equal(f.state.finish, 1); assert.equal(f.state.sourceReads, 0);
  const next = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge() });
  await next.targetFinish(options); assert.equal(f.state.finish, 1);
  await service.targetResume({ ...options, attemptId: randomUUID(), expectedAdmissionControl: {
    sequence: 2, cancelWatermark: 1, cancelled: true, ready: false }, expectedOperationControl: null });
  await settled(service); assert.ok(f.calls.filter(c => c[0] === 'lease').every(c => c[1] === 'target'));
});

test('repeated recovery sessions have a bounded retained binding budget without evicting existing receipts', async () => {
  const f = fixture(), service = new MigrationSourceTransferService({ owner: f.owner, bridge: f.bridge(), maxOperations: 1 });
  let last;
  for (let index = 0; index < 64; index++) {
    if (last) f.leases.get(last.sessionId).alive = false;
    last = f.session('target-recovery', 'target');
    await service.targetRead({ requestId: f.options.requestId, target: last });
  }
  const overflow = f.session('target-recovery', 'target');
  await assert.rejects(service.targetRead({ requestId: f.options.requestId, target: overflow }),
    { reason: 'source_transfer_session_binding_limit' });
  // Saturation never removes an old binding or schedules a transfer to recover it.
  assert.equal((await service.targetRead({ requestId: f.options.requestId, target: last })).requestId, f.options.requestId);
  await assert.rejects(service.targetRead({ requestId: randomUUID(), target: last }),
    { reason: 'source_transfer_session_in_use' });
  assert.equal(f.state.run, 0);
  assert.equal(f.state.sourceReads, 0);
  assert.equal(f.calls.filter(call => call[0] === 'claim').length, 0);
});

test('private credential metadata uses the original session/request fence and never opens another child', async () => {
  const f = fixture(), bridge = f.bridge();
  let privateCalls = 0;
  bridge.privateCredentialsChannel = async context => ({ assertCurrent() {
    context.target.captured.ownerId && f.leases.get(f.options.target.sessionId).assertCurrent();
  }, target: async operation => {
    assert.equal(operation, 'private/read'); privateCalls++;
    return { offer: { context: { requestId: context.requestId, offerId: '12345678-1234-4123-8123-123456789012' },
      suite: 'hpke-x25519-hkdf-sha256-aes256gcm-v1', publicKey: 'A'.repeat(43) + '=' },
    envelope: null, control: { sequence: 1, cancelWatermark: 0, cancelled: false, ready: false },
    writerRunning: false, received: false, keyReleased: false };
  } });
  const service = new MigrationSourceTransferService({ owner: f.owner, bridge });
  const options = { ...f.options, offerId: '12345678-1234-4123-8123-123456789012' };
  assert.equal((await service.privateRead(options)).phase, 'offered');
  assert.equal(privateCalls, 1);
  assert.ok(f.calls.every(([kind, purpose]) => kind === 'lease' && purpose === 'target'));
  await assert.rejects(service.privateRead({ ...options, requestId: randomUUID() }), { reason: 'source_transfer_session_in_use' });
  assert.equal(privateCalls, 1);
  f.leases.get(options.target.sessionId).alive = false;
  await assert.rejects(service.privateRead(options), { reason: 'source_transfer_authority_changed' });
  assert.equal(privateCalls, 1);
});

test('a target scope revocation stops only the private request owned pair while its source reply is pending', async () => {
  const f = fixture(), bridge = f.bridge(), pending = deferred(), calls = [];
  const peer = f.session('source', 'unrelated');
  const options = { ...f.options, offerId: randomUUID(), manifestSha256: 'a'.repeat(64), entryId: 'e0000-0000',
    consent: { apiKeys: true, mcpPrivateFields: false }, selections: [{ kind: 'provider', sourceName: 'provider', targetName: 'imported',
      selector: { kind: 'claude_configuration' }, endpoint: 'https://example.invalid', apiFormat: 'anthropic' }] };
  let offer;
  bridge.privateCredentialsChannel = async () => {
    const assertCurrent = () => { for (const session of [options.source, options.target]) f.leases.get(session.sessionId).assertCurrent(); };
    return { assertCurrent, target: async (method, params) => {
      calls.push(method);
      if (method === 'private/offer') offer = { context: { requestId: options.requestId, offerId: options.offerId,
        manifestSha256: options.manifestSha256, entryId: options.entryId, selections: params.selections },
      suite: 'hpke-x25519-hkdf-sha256-aes256gcm-v1', publicKey: 'A'.repeat(43) + '=' };
      return { offer, envelope: null, control: { sequence: 1, cancelWatermark: 0, cancelled: false, ready: false },
        writerRunning: false, received: false, keyReleased: false };
    }, source: async method => { calls.push(method); await pending.promise; return {}; } };
  };
  const service = new MigrationSourceTransferService({ owner: f.owner, bridge });
  const work = service.privateRun(options);
  const rejection = assert.rejects(work, { reason: 'source_transfer_authority_changed' });
  while (!calls.includes('private/seal')) await tick();
  f.leases.get(options.target.sessionId).alive = false;
  await service.sweep();
  assert.equal(f.leases.get(options.source.sessionId).released, 1);
  assert.equal(f.leases.get(options.target.sessionId).released, 1);
  assert.equal(f.leases.get(peer.sessionId).released, 0);
  pending.resolve(); await rejection;
  assert.equal(calls.includes('private/accept'), false);
});

test('source-only private read needs no live target lease and retains original source session/request ownership', async () => {
  const f = fixture(), bridge = f.bridge();
  bridge.privateCredentialsChannel = () => assert.fail('source-only read must not pair or bootstrap');
  let reads = 0;
  bridge.privateCredentialSourceChannel = async context => {
    assert.ok(context.source); assert.equal(Object.hasOwn(context, 'target'), false);
    return { assertCurrent() {}, source: async (operation, params) => {
      assert.equal(operation, 'private/observe'); assert.equal(params.offerId, '12345678-1234-4123-8123-123456789012'); reads++;
      return { control: { sequence: 3, cancelWatermark: 2, cancelled: true, ready: true }, writerRunning: true };
    } };
  };
  const service = new MigrationSourceTransferService({ owner: f.owner, bridge });
  const options = { ...f.options, offerId: '12345678-1234-4123-8123-123456789012' };
  f.leases.get(options.target.sessionId).alive = false;
  const value = await service.privateSourceRead(options);
  assert.equal(value.phase, 'cancelling'); assert.equal(value.sourceControl.cancelWatermark, 2);
  assert.deepEqual(f.calls, [['lease', 'source']]);
  await assert.rejects(service.privateSourceRead({ ...options, requestId: randomUUID() }), { reason: 'source_transfer_session_in_use' });
  assert.equal(reads, 1);
  f.leases.get(options.source.sessionId).alive = false;
  await assert.rejects(service.privateSourceRead(options), { reason: 'source_transfer_authority_changed' });
  assert.equal(reads, 1);
});
