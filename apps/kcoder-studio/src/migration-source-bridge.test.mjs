import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { captureMigrationSourceEndpoint, captureMigrationSourceScope, MigrationSourceBridge } from './migration-source-bridge.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const PREFIX = 'migration/sourceTransfer/internal/';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const selected = [{ kind: 'configuration', sourceId: 'owned-configuration' }];
const state = (overrides = {}) => ({ sequence: 1, cancelWatermark: 0, cancelled: false, ready: false, ...overrides });

test('source initialization observations wait for the one original delayed prepare acknowledgement', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge(), pending = deferred();
  let preparing = false;
  f.hooks.set('source/prepare', async response => { preparing = true; await pending.promise; preparing = false; return response; });
  f.hooks.set('source/state', response => preparing ? { error: { message: 'source_transfer_recovery_required' } } : response);
  const running = bridge.run(f.options).then(value => ({ value }), error => ({ error }));
  while (!preparing) await tick();
  const reading = bridge.read(f.options).then(value => ({ value }), error => ({ error }));
  try {
    await tick();
    assert.equal(f.calls.filter(call => call.method === 'source/state').length, 1,
      'read must not sample an operation between its owned prepare birth and request publication');
  } finally { pending.resolve(); await Promise.all([running, reading]); }
  assert.equal((await running).value?.phase, 'ready');
  assert.equal((await reading).error, undefined);
  assert.ok((await reading).value.sourceState);
  assert.equal(f.calls.filter(call => call.method === 'source/prepare').length, 1);
});

test('source initialization prepare also waits for an earlier same-owner state observation', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge(), pending = deferred();
  let entered = false;
  f.hooks.set('source/state', async response => {
    if (!entered) { entered = true; await pending.promise; }
    return response;
  });
  const reading = bridge.read(f.options).then(value => ({ value }), error => ({ error }));
  while (!entered) await tick();
  const running = bridge.run(f.options).then(value => ({ value }), error => ({ error }));
  try {
    await tick();
    assert.equal(f.calls.filter(call => call.method === 'source/prepare').length, 0,
      'a queued prepare cannot begin while the previous Native state read is unresolved');
  } finally { pending.resolve(); await Promise.all([reading, running]); }
  assert.equal((await running).value?.phase, 'ready');
  assert.equal((await reading).error, undefined);
  assert.equal(f.calls.filter(call => call.method === 'source/prepare').length, 1);
});

test('source initialization ordering does not swallow permanent recovery or replay prepare', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge(), pending = deferred();
  let preparing = false, broken = false;
  f.hooks.set('source/prepare', async () => { preparing = true; await pending.promise; broken = true; return { error: { message: 'source_transfer_recovery_required' } }; });
  f.hooks.set('source/state', response => preparing || broken ? { error: { message: 'source_transfer_recovery_required' } } : response);
  const running = bridge.run(f.options).then(value => ({ value }), error => ({ error }));
  while (!preparing) await tick();
  const reading = bridge.read(f.options).then(value => ({ value }), error => ({ error }));
  await tick(); pending.resolve();
  assert.equal((await running).error?.reason, 'source_transfer_recovery_required');
  assert.equal((await reading).error?.reason, 'source_transfer_recovery_required');
  await assert.rejects(bridge.read(f.options), { reason: 'source_transfer_recovery_required' });
  assert.equal(f.calls.filter(call => call.method === 'source/prepare').length, 1);
  assert.ok(!f.calls.some(call => call.method === 'target/begin'));
});

test('source initialization delayed replies cannot cross an owner generation change', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge(), pending = deferred();
  let preparing = false;
  f.hooks.set('source/prepare', async response => { preparing = true; await pending.promise; return response; });
  const running = bridge.run(f.options).then(value => ({ value }), error => ({ error }));
  while (!preparing) await tick();
  const reading = bridge.read(f.options).then(value => ({ value }), error => ({ error }));
  await tick(); f.scopes.source.generation++; pending.resolve();
  assert.equal((await running).error?.reason, 'source_transfer_authority_changed');
  assert.equal((await reading).error?.reason, 'source_transfer_authority_changed');
  assert.ok(!f.calls.some(call => ['source/capture', 'target/begin'].includes(call.method)));
});

test('source initialization waiting does not hold the independently explicit cancel lane', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge(), pending = deferred();
  let preparing = false;
  f.hooks.set('source/prepare', async response => { preparing = true; await pending.promise; return response; });
  f.hooks.set('source/state', response => preparing ? { error: { message: 'source_transfer_recovery_required' } } : response);
  const running = bridge.run(f.options).then(value => ({ value }), error => ({ error }));
  while (!preparing) await tick();
  try {
    await bridge.cancel({ ...f.options, commandId: randomUUID() });
    assert.equal(f.calls.filter(call => call.method === 'source/cancel').length, 1);
  } finally { pending.resolve(); await running; }
  assert.equal((await running).error?.reason, 'source_transfer_interrupted');
  assert.equal(f.calls.filter(call => call.method === 'source/prepare').length, 1);
});

test('target initialization observations wait for the one original delayed begin acknowledgement', async () => {
  const f = fixture(7, true), bridge = new MigrationSourceBridge(), pending = deferred();
  let beginning = false;
  f.hooks.set('target/begin', async response => { beginning = true; await pending.promise; beginning = false; return response; });
  f.hooks.set('target/summary', response => beginning ? { error: { message: 'source_transfer_recovery_required' } } : response);
  const running = bridge.run(f.options).then(value => ({ value }), error => ({ error }));
  while (!beginning) await tick();
  const before = f.calls.filter(call => call.method === 'target/summary').length;
  const reading = bridge.read(f.options).then(value => ({ value }), error => ({ error }));
  const targetReading = bridge.readTarget(f.options).then(value => ({ value }), error => ({ error }));
  try {
    await tick();
    assert.equal(f.calls.filter(call => call.method === 'target/summary').length, before,
      'read must not sample the target between its owned begin birth and manifest publication');
  } finally { pending.resolve(); await Promise.all([running, reading, targetReading]); }
  assert.equal((await running).value?.phase, 'ready');
  assert.equal((await reading).error, undefined);
  assert.ok((await reading).value.targetState);
  assert.equal((await targetReading).error, undefined);
  assert.equal((await targetReading).value.scope, 'target');
  assert.equal(f.calls.filter(call => call.method === 'target/begin').length, 1);
});

test('target initialization begin waits for an earlier same-owner summary observation', async () => {
  const f = fixture(7, true), bridge = new MigrationSourceBridge(), pending = deferred();
  let entered = false;
  f.hooks.set('target/summary', async response => {
    if (!entered) { entered = true; await pending.promise; }
    return response;
  });
  const reading = bridge.read(f.options).then(value => ({ value }), error => ({ error }));
  while (!entered) await tick();
  const running = bridge.run(f.options).then(value => ({ value }), error => ({ error }));
  try {
    await tick();
    assert.equal(f.calls.filter(call => call.method === 'target/begin').length, 0);
  } finally { pending.resolve(); await Promise.all([reading, running]); }
  assert.equal((await running).value?.phase, 'ready');
  assert.equal((await reading).error, undefined);
  assert.equal(f.calls.filter(call => call.method === 'target/begin').length, 1);
});

test('target initialization ordering preserves permanent recovery without replaying begin', async () => {
  const f = fixture(7, true), bridge = new MigrationSourceBridge(), pending = deferred();
  let beginning = false, broken = false;
  f.hooks.set('target/begin', async () => { beginning = true; await pending.promise; broken = true; return { error: { message: 'source_transfer_recovery_required' } }; });
  f.hooks.set('target/summary', response => beginning || broken ? { error: { message: 'source_transfer_recovery_required' } } : response);
  const running = bridge.run(f.options).then(value => ({ value }), error => ({ error }));
  while (!beginning) await tick();
  const reading = bridge.read(f.options).then(value => ({ value }), error => ({ error }));
  await tick(); pending.resolve();
  assert.equal((await running).error?.reason, 'source_transfer_recovery_required');
  assert.equal((await reading).error?.reason, 'source_transfer_recovery_required');
  await assert.rejects(bridge.readTarget(f.options), { reason: 'source_transfer_recovery_required' });
  assert.equal(f.calls.filter(call => call.method === 'target/begin').length, 1);
  assert.ok(!f.calls.some(call => ['target/part/write', 'target/finish'].includes(call.method)));
});

test('target initialization delayed replies cannot cross an owner generation change', async () => {
  const f = fixture(7, true), bridge = new MigrationSourceBridge(), pending = deferred();
  let beginning = false;
  f.hooks.set('target/begin', async response => { beginning = true; await pending.promise; return response; });
  const running = bridge.run(f.options).then(value => ({ value }), error => ({ error }));
  while (!beginning) await tick();
  const reading = bridge.read(f.options).then(value => ({ value }), error => ({ error }));
  await tick(); f.scopes.target.generation++; pending.resolve();
  assert.equal((await running).error?.reason, 'source_transfer_authority_changed');
  assert.equal((await reading).error?.reason, 'source_transfer_authority_changed');
  assert.ok(!f.calls.some(call => ['source/chunk', 'target/part/write', 'target/finish'].includes(call.method)));
});

test('target initialization waiting still dispatches explicit cancellation independently', async () => {
  for (const method of ['cancel', 'cancelTarget']) {
    const f = fixture(7, true), bridge = new MigrationSourceBridge(), pending = deferred();
    let beginning = false;
    f.hooks.set('target/begin', async response => { beginning = true; await pending.promise; beginning = false; return response; });
    f.hooks.set('target/summary', response => beginning ? { error: { message: 'source_transfer_recovery_required' } } : response);
    const running = bridge.run(f.options).then(value => ({ value }), error => ({ error }));
    while (!beginning) await tick();
    const cancelled = bridge[method]({ ...f.options, commandId: randomUUID() });
    try {
      await tick();
      assert.equal(f.calls.filter(call => call.method === 'target/cancel').length, 1);
    } finally { pending.resolve(); await Promise.all([running, cancelled]); }
    assert.equal((await running).error?.reason, 'source_transfer_interrupted');
    assert.equal((await cancelled).phase, 'cancelled');
    assert.equal(f.calls.filter(call => call.method === 'target/begin').length, 1);
  }
});

test('the pre-launch scope fence shares normalized immutable identity rules with captured endpoints', () => {
  let value = { ownerId: 'owned-login', generation: 1, targetFingerprint: sha('target'),
    principal: { kind: 'verifiedAccount', principalId: 'owned-principal' } };
  const captured = captureMigrationSourceScope(() => value);
  assert.ok(Object.isFrozen(captured.captured)); assert.ok(Object.isFrozen(captured.captured.principal));
  captured.assertCurrent();
  value = { ...value, generation: 2 };
  assert.throws(() => captured.assertCurrent(), { reason: 'source_transfer_authority_changed' });
  assert.throws(() => captureMigrationSourceScope(() => { throw new Error('PRIVATE_VALUE'); }),
    error => error.reason === 'source_transfer_authority_unavailable' && !error.message.includes('PRIVATE_VALUE'));
});

test('target-only finish uses confirmed parts after the source is offline and reconciles a lost finish reply', async () => {
  const f = fixture(7, true), bridge = new MigrationSourceBridge();
  f.hooks.set('target/part/write', () => ({ error: { message: 'part committed; receipt lost' } }));
  await assert.rejects(bridge.run(f.options), { reason: 'source_transfer_outcome_unknown' });
  f.brokers.source.closed = true;
  const before = f.calls.length;
  const pending = await bridge.readTarget(f.options);
  assert.equal(pending.progress.partsComplete, true);
  assert.equal(pending.receipt, null);
  f.hooks.set('target/finish', () => ({ error: { message: 'finish committed; reply lost' } }));
  await assert.rejects(bridge.finishTarget(f.options), { reason: 'source_transfer_outcome_unknown' });
  const reopened = await new MigrationSourceBridge().finishTarget(f.options);
  assert.equal(reopened.phase, 'ready'); assert.equal(reopened.scope, 'target'); assert.equal(reopened.sourceObserved, false);
  assert.equal(reopened.sourceState, null); assert.equal(reopened.sourceSnapshotControl, null); assert.equal(reopened.sourceCapture, null);
  assert.equal(f.calls.filter(call => call.method === 'target/finish').length, 1);
  assert.ok(f.calls.slice(before).every(call => call.role === 'target' && call.method !== 'identity'));
  for (const hidden of ['accountId', 'principalId', 'dataBase64', 'sourceIdentity', 'peerRef']) assert.ok(!JSON.stringify(reopened).includes(hidden));
});

test('target-only cancel before begin persists its own watermark and resume must freeze both domains', async () => {
  const f = fixture(7, true), pending = deferred(), bridge = new MigrationSourceBridge();
  f.hooks.set('source/capture', async response => { await pending.promise; return response; });
  const running = bridge.run(f.options);
  while (!f.calls.some(call => call.method === 'source/capture')) await tick();
  const first = await bridge.cancelTarget({ ...f.options, commandId: randomUUID() });
  assert.equal(first.phase, 'cancelled'); assert.equal(first.targetState, null); assert.equal(first.progress, null);
  assert.equal(first.targetAdmissionControl.cancelled, true);
  pending.resolve(); await assert.rejects(running, { reason: 'source_transfer_interrupted' });
  f.brokers.source.closed = true;
  const before = f.calls.length;
  const second = await bridge.cancelTarget({ ...f.options, commandId: randomUUID() });
  await assert.rejects(bridge.resumeTarget({ ...f.options, expectedAdmissionControl: first.targetAdmissionControl,
    expectedOperationControl: null }), { reason: 'source_transfer_revision_conflict' });
  const resumed = await bridge.resumeTarget({ ...f.options, expectedAdmissionControl: second.targetAdmissionControl,
    expectedOperationControl: null });
  assert.equal(resumed.targetAdmissionControl.cancelled, false); assert.equal(resumed.targetState, null);
  assert.equal((await bridge.finishTarget(f.options)).phase, 'pending');
  assert.ok(f.calls.slice(before).every(call => call.role === 'target'));
  assert.ok(!f.calls.some(call => ['target/begin', 'target/part/write', 'target/finish'].includes(call.method)));
});

test('incomplete offline transfers cannot be finished and pending writers remain cancelling', async () => {
  const f = fixture(400000, true), bridge = new MigrationSourceBridge();
  f.hooks.set('target/part/write', () => ({ error: { message: 'owned part acknowledgement lost' } }));
  await assert.rejects(bridge.run(f.options), { reason: 'source_transfer_outcome_unknown' });
  f.brokers.source.closed = true;
  assert.equal((await bridge.finishTarget(f.options)).phase, 'incomplete');
  assert.ok(!f.calls.some(call => call.method === 'target/finish'));
  f.hooks.set('target/summary', response => { response.result.workerRunning = true; return response; });
  const cancelled = await bridge.cancelTarget({ ...f.options, commandId: randomUUID() });
  assert.equal(cancelled.phase, 'cancelling'); assert.equal(cancelled.targetWorkerRunning, true);
});

test('lost target cancel and resume receipts stop once and only explicit reads reconcile them', async () => {
  const f = fixture(7, true), bridge = new MigrationSourceBridge();
  f.hooks.set('target/part/write', () => ({ error: { message: 'part reply lost' } }));
  await assert.rejects(bridge.run(f.options), { reason: 'source_transfer_outcome_unknown' });
  f.brokers.source.closed = true;
  f.hooks.set('target/cancel', () => ({ error: { message: 'cancel committed; reply lost' } }));
  await assert.rejects(bridge.cancelTarget({ ...f.options, commandId: randomUUID() }), { reason: 'source_transfer_outcome_unknown' });
  let view = await bridge.readTarget(f.options);
  assert.equal(view.phase, 'cancelled'); assert.equal(f.calls.filter(call => call.method === 'target/cancel').length, 1);
  f.hooks.set('target/resume', () => ({ error: { message: 'resume committed; reply lost' } }));
  await assert.rejects(bridge.resumeTarget({ ...f.options, expectedAdmissionControl: view.targetAdmissionControl,
    expectedOperationControl: view.targetState }), { reason: 'source_transfer_outcome_unknown' });
  view = await bridge.readTarget(f.options);
  assert.equal(view.targetAdmissionControl.cancelled, false); assert.equal(view.targetState.cancelled, false);
  assert.equal(f.calls.filter(call => call.method === 'target/resume').length, 1);
});

test('equivalent control field order is accepted without relaxing either target cancellation watermark', async () => {
  const f = fixture(7, true), bridge = new MigrationSourceBridge();
  f.hooks.set('target/part/write', () => ({ error: { message: 'owned part acknowledgement lost' } }));
  await assert.rejects(bridge.run(f.options), { reason: 'source_transfer_outcome_unknown' });
  const cancelled = await bridge.cancelTarget({ ...f.options, commandId: randomUUID() });
  const reorder = value => ({ ready: value.ready, cancelled: value.cancelled,
    cancelWatermark: value.cancelWatermark, sequence: value.sequence });
  const resumed = await bridge.resumeTarget({ ...f.options, expectedAdmissionControl: reorder(cancelled.targetAdmissionControl),
    expectedOperationControl: reorder(cancelled.targetState) });
  assert.equal(resumed.targetState.cancelled, false); assert.equal(resumed.targetAdmissionControl.cancelled, false);
});

test('target recovery is capability-gated and late replies cannot cross a changed target generation or profile', async () => {
  const old = fixture(7);
  await assert.rejects(new MigrationSourceBridge().readTarget(old.options), { reason: 'source_transfer_authority_unavailable' });
  assert.equal(old.calls.length, 0);
  const f = fixture(7, true), bridge = new MigrationSourceBridge();
  await bridge.run(f.options);
  const delayed = deferred();
  f.hooks.set('target/summary', async response => { await delayed.promise; return response; });
  const reading = bridge.readTarget(f.options);
  while (!f.calls.some(call => call.method === 'peer/recover-target')) await tick();
  f.scopes.target.generation++;
  delayed.resolve(); await assert.rejects(reading, { reason: 'source_transfer_authority_changed' });
  f.scopes.target.generation++;
  const captured = captureMigrationSourceEndpoint({ broker: f.brokers.target, captureCurrent: () => f.scopes.target });
  f.hooks.delete('target/summary');
  f.hooks.set('peer/recover-target', response => { response.result.targetAuthority.accountId = sha('changed-profile'); return response; });
  await assert.rejects(bridge.readTarget({ requestId: f.requestId, target: captured }), { reason: 'source_transfer_request_changed' });
});

test('the full pair also requires the independent admission snapshot after a pre-begin target cancellation', async () => {
  const f = fixture(7, true), pending = deferred(), bridge = new MigrationSourceBridge();
  f.hooks.set('source/capture', async response => { await pending.promise; return response; });
  const running = bridge.run(f.options);
  while (!f.calls.some(call => call.method === 'source/capture')) await tick();
  const cancelled = await bridge.cancelTarget({ ...f.options, commandId: randomUUID() });
  pending.resolve(); await assert.rejects(running, { reason: 'source_transfer_interrupted' });
  const before = f.calls.filter(call => call.method === 'target/resume').length;
  assert.equal((await bridge.run({ ...f.options, resume: { target: {} } })).phase, 'cancelled');
  assert.equal(f.calls.filter(call => call.method === 'target/resume').length, before);
  assert.equal((await bridge.run({ ...f.options,
    resume: { target: { admissionControl: cancelled.targetAdmissionControl } } })).phase, 'ready');
  assert.equal(f.calls.filter(call => call.method === 'target/resume').length, before + 1);
});

function fixture(size = 400_000, recovery = false, contentOverride) {
  const requestId = randomUUID();
  const bytes = Buffer.alloc(size, 120);
  const authorities = { source: { instanceId: randomUUID(), accountId: sha('native-source-profile') },
    target: { instanceId: randomUUID(), accountId: sha('native-target-profile') } };
  const scopes = Object.fromEntries(['source', 'target'].map(role => [role, { ownerId: 'verified-web-session', generation: 1,
    targetFingerprint: sha(role), principal: { kind: 'verifiedAccount', principalId: `server-principal-${role}` } }]));
  const grant = { grantId: requestId, authority: authorities.target, scope: sha('destination-profile-scope') };
  const manifest = { version: 1, requestId, source: authorities.source, destination: grant,
    entries: [{ id: 'e0000-0000', bytes: bytes.length, sha256: sha(bytes), content: contentOverride ?? {
      kind: 'configuration_inventory', source: 'claude_code', source_revision: 'private-provenance-not-for-client', source_scope: 'user',
      sourceIdentity: sha('actual Native binding logical identity'),
    } }] };
  const digest = sha(JSON.stringify(manifest));
  const savedReceipt = { requestId, manifestSha256: digest, entries: 1, bytes: bytes.length };
  const calls = [];
  let sourceState = null, targetState = null, acceptedParts = 0, persistedSelections;
  let admissionControl = state({ sequence: 0 }), granted = false;
  const cancels = [];
  const hooks = new Map();
  const selectionDigest = sha('Native-owned selection digest; not a JS serializer contract');
  const part = () => ({ manifestSha256: digest, entryId: 'e0000-0000', acceptedParts,
    acceptedBytes: Math.min(acceptedParts * 131072, bytes.length) });
  const brokers = {};
  function make(role) {
    const broker = { closed: false,
      initializeResponse: { result: { capabilities: { experimental: { migrationSourceTransferTargetRecoveryV1: recovery,
        migrationSourceTransferAssetIdentityV1: true, migrationSourceTransferMemoryV1: true, migrationSourceTransferDefinitionsV1: true, migrationSourceTransferPluginsV1: true, migrationSourceTransferUploadedV1: true } } } },
      async sendMigrationSourceRequest(full, params, proof) {
        assert.ok(full.startsWith(PREFIX));
        const method = full.slice(PREFIX.length);
        calls.push({ role, method, params: structuredClone(params), proof: structuredClone(proof) });
        let result;
        switch (method) {
          case 'identity': result = { authority: authorities[role], chunkBytes: 131072, maxManifestBytes: 1048576 }; break;
          case 'peer/accept':
            assert.equal(params.role, role);
            assert.deepEqual(proof.source.authority, authorities.source);
            assert.deepEqual(proof.target.authority, authorities.target);
            result = { peerRef: `private-${role}-peer` }; break;
          case 'peer/recover-target':
            assert.equal(role, 'target'); assert.ok(granted);
            assert.deepEqual(params, { requestId }); assert.equal(proof, undefined);
            result = { peerRef: 'restricted-recovered-target', targetAuthority: authorities.target }; break;
          case 'source/state': result = { state: sourceState, selectionDigest: sourceState ? selectionDigest : null }; break;
          case 'source/intent': result = { intent: persistedSelections ? { selections: persistedSelections, selectionDigest } : null }; break;
          case 'target/state': result = { state: targetState }; break;
          case 'target/grant': granted = true; result = grant; break;
          case 'target/summary': result = { state: targetState, workerRunning: false,
            admissionControl, receipt: targetState?.ready ? savedReceipt : null,
            progress: targetState ? { manifestSha256: digest, entries: 1, totalBytes: bytes.length,
              acceptedBytes: part().acceptedBytes, partsComplete: part().acceptedBytes === bytes.length } : null }; break;
          case 'source/prepare':
            if (persistedSelections) assert.deepEqual(params.selections, persistedSelections, 'same request preserves original refs');
            else persistedSelections = structuredClone(params.selections);
            sourceState ??= state(); result = { state: sourceState, selectionDigest }; break;
          case 'source/capture': sourceState = { ...sourceState, ready: true }; result = { state: sourceState, selectionDigest }; break;
          case 'source/manifest': result = { manifest, manifestSha256: digest }; break;
          case 'target/begin': targetState = state(); result = { state: targetState }; break;
          case 'target/part/read': result = { receipt: part() }; break;
          case 'source/chunk': {
            const data = bytes.subarray(params.index * 131072, Math.min((params.index + 1) * 131072, bytes.length));
            result = { requestId, manifestSha256: digest, entryId: 'e0000-0000', index: params.index,
              sha256: sha(data), dataBase64: data.toString('base64') }; break;
          }
          case 'target/part/write':
            assert.equal(params.index, acceptedParts, 'confirmed parts are not replayed');
            assert.ok(Buffer.byteLength(params.dataBase64, 'base64') <= 131072);
            acceptedParts++; result = { receipt: part() }; break;
          case 'target/finish': targetState = { ...targetState, ready: true }; result = { receipt: savedReceipt }; break;
          case 'target/receipt': result = { receipt: targetState?.ready ? savedReceipt : null }; break;
          case 'source/cancel':
            sourceState = { ...sourceState, sequence: sourceState.sequence + 1, cancelWatermark: sourceState.cancelWatermark + 1,
              cancelled: true }; result = { state: sourceState, selectionDigest }; break;
          case 'target/cancel':
            if (recovery && !cancels.includes(params.commandId)) {
              cancels.push(params.commandId);
              admissionControl = { ...admissionControl, sequence: admissionControl.sequence + 1,
                cancelWatermark: admissionControl.cancelWatermark + 1, cancelled: true };
            }
            if (targetState) targetState = { ...targetState, sequence: targetState.sequence + 1, cancelWatermark: targetState.cancelWatermark + 1,
              cancelled: true }; result = { state: targetState }; break;
          case 'source/resume':
            assert.equal(params.expectedSequence, sourceState.sequence); assert.equal(params.expectedCancelWatermark, sourceState.cancelWatermark);
            assert.deepEqual(params.expectedSnapshotControl, sourceState);
            sourceState = { ...sourceState, sequence: sourceState.sequence + 1, cancelled: false }; result = { state: sourceState, selectionDigest }; break;
          case 'target/resume':
            if (recovery) {
              assert.deepEqual(params.expectedAdmissionControl, admissionControl);
              assert.deepEqual(params.expectedOperationControl, targetState);
              admissionControl = { ...admissionControl, sequence: admissionControl.sequence + 1, cancelled: false };
            } else {
              assert.equal(params.expectedSequence, targetState.sequence); assert.equal(params.expectedCancelWatermark, targetState.cancelWatermark);
            }
            if (targetState) targetState = { ...targetState, sequence: targetState.sequence + 1, cancelled: false };
            result = { state: targetState }; break;
          default: assert.fail(`Unexpected internal fixture method ${method}`);
        }
        if (['source/state', 'source/prepare', 'source/capture', 'source/cancel', 'source/resume'].includes(method)) {
          result.snapshotControl = sourceState ? structuredClone(sourceState) : null;
          result.capture = { status: sourceState?.ready ? 'ready' : 'idle', errorCode: null };
        }
        if (['target/state', 'target/begin', 'target/cancel', 'target/resume'].includes(method)) result.workerRunning = false;
        const response = { result: structuredClone(result) };
        return hooks.has(method) ? hooks.get(method)(response, params) : response;
      },
    };
    brokers[role] = broker;
    return captureMigrationSourceEndpoint({ broker, captureCurrent: () => scopes[role] });
  }
  const source = make('source'), target = make('target');
  return { requestId, source, target, brokers, scopes, calls, hooks, bytes, manifest, digest, authorities,
    options: { requestId, source, target, selections: selected },
    get sourceState() { return sourceState; }, get targetState() { return targetState; },
  };
}

test('private bridge forwards bounded chunks and returns only verified receipt and progress', async () => {
  const f = fixture();
  const progress = [];
  const result = await new MigrationSourceBridge().run({ ...f.options, onProgress: value => progress.push(value) });
  assert.equal(result.phase, 'ready'); assert.equal(result.receipt.bytes, 400_000);
  assert.deepEqual(progress.map(value => value.acceptedBytes), [131072, 262144, 393216, 400000]);
  assert.equal(f.calls.filter(call => call.method === 'target/part/write').length, 4);
  const visible = JSON.stringify({ result, progress });
  for (const hidden of ['private-provenance', 'dataBase64', 'accountId', 'principalId', 'private-source-peer']) assert.ok(!visible.includes(hidden));
  assert.deepEqual(f.calls.filter(call => call.method === 'peer/accept').map(call => call.params.role), ['source', 'target']);
});

test('lost part acknowledgement stops once and explicit same-ID recovery starts at the receipt', async () => {
  const f = fixture();
  let failed = false;
  f.hooks.set('target/part/write', response => {
    if (!failed) { failed = true; return { error: { message: 'PRIVATE_SOURCE_MUST_NOT_LEAK' } }; }
    return response;
  });
  const bridge = new MigrationSourceBridge();
  await assert.rejects(bridge.run(f.options), error => error.reason === 'source_transfer_outcome_unknown' && !error.message.includes('PRIVATE'));
  assert.equal(f.calls.filter(call => call.method === 'target/part/write').length, 1);
  assert.equal((await bridge.run(f.options)).phase, 'ready');
  assert.deepEqual(f.calls.filter(call => call.method === 'target/part/write').map(call => call.params.index), [0, 1, 2, 3]);
});

test('lost finish reply reconciles the durable receipt without another finish or source read', async () => {
  const f = fixture(7);
  f.hooks.set('target/finish', () => ({ error: { message: 'fixture reply lost after commit' } }));
  const bridge = new MigrationSourceBridge();
  await assert.rejects(bridge.run(f.options), { reason: 'source_transfer_outcome_unknown' });
  const before = f.calls.length;
  const recovered = await new MigrationSourceBridge().run(f.options);
  assert.equal(recovered.phase, 'ready');
  assert.equal(f.calls.filter(call => call.method === 'target/finish').length, 1);
  assert.ok(!f.calls.slice(before).some(call => ['source/prepare', 'source/manifest', 'source/chunk'].includes(call.method)));
});

test('both endpoint generations are fenced after delayed source reads', async () => {
  for (const role of ['source', 'target']) {
    const f = fixture(200000), pending = deferred();
    f.hooks.set('source/chunk', async response => { await pending.promise; return response; });
    const running = new MigrationSourceBridge().run(f.options);
    while (!f.calls.some(call => call.method === 'source/chunk')) await tick();
    f.scopes[role] = { ...f.scopes[role], generation: 2 };
    pending.resolve();
    await assert.rejects(running, { reason: 'source_transfer_authority_changed' });
    assert.ok(!f.calls.some(call => call.method === 'target/part/write'));
  }
});

test('cancel can run while capture is waiting and explicit resume must match the durable watermark', async () => {
  const f = fixture(7), pending = deferred();
  f.hooks.set('source/capture', async response => { await pending.promise; return response; });
  const bridge = new MigrationSourceBridge();
  const running = bridge.run(f.options);
  while (!f.calls.some(call => call.method === 'source/capture')) await tick();
  const cancelled = await bridge.cancel({ ...f.options, commandId: randomUUID() });
  assert.equal(cancelled.sourceState.cancelled, true);
  pending.resolve(); await assert.rejects(running, { reason: 'source_transfer_interrupted' });
  const stale = await bridge.run({ ...f.options, resume: { source: { sequence: 1, cancelWatermark: 0 } } });
  assert.equal(stale.phase, 'cancelled');
  assert.ok(!f.calls.some(call => call.method === 'source/resume'));
  assert.equal((await bridge.run({ ...f.options, resume: { source: { ...cancelled.sourceState, snapshotControl: cancelled.sourceSnapshotControl } } })).phase, 'ready');
});

test('fixed request intent cannot change selection or authenticated routing', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge();
  await bridge.run(f.options);
  await assert.rejects(bridge.run({ ...f.options, selections: [{ kind: 'assets', sourceId: 'other' }] }), { reason: 'source_transfer_request_changed' });
  const other = fixture(7);
  await assert.rejects(bridge.read({ ...other.options, requestId: f.requestId }), { reason: 'source_transfer_request_changed' });
  const before = f.calls.length;
  await assert.rejects(bridge.run({ ...f.options, source: { ...f.source, captured: { ownerId: 'forged' } } }), { reason: 'source_transfer_authority_changed' });
  assert.equal(f.calls.length, before);
});

test('only bounded opaque source selections are accepted, never paths or caller authorities', async () => {
  for (const invalid of [[], [...selected, ...selected], [{ kind: 'configuration', sourceId: 'one', path: '/personal/auth.json' }],
    [{ kind: 'history', catalogId: 'owned', sourceHandle: 'one', authority: 'forged' }]]) {
    const f = fixture();
    await assert.rejects(new MigrationSourceBridge().run({ ...f.options, selections: invalid }), { reason: 'source_transfer_invalid_request' });
    assert.equal(f.calls.length, 0);
  }
});

test('untrusted manifest source and malformed chunk data are rejected before a target write', async () => {
  for (const field of ['authority', 'source-identity', 'digest', 'base64', 'length', 'receipt']) {
    const f = fixture(7);
    if (field === 'authority') f.hooks.set('source/manifest', response => {
      response.result.manifest.source.accountId = sha('forged'); return response;
    });
    else if (field === 'source-identity') f.hooks.set('source/manifest', response => {
      response.result.manifest.entries[0].content.sourceIdentity = null; return response;
    });
    else if (field === 'receipt') f.hooks.set('target/part/read', response => {
      response.result.receipt.acceptedParts = 1; return response;
    });
    else f.hooks.set('source/chunk', response => {
      if (field === 'digest') response.result.manifestSha256 = sha('other');
      if (field === 'base64') response.result.dataBase64 = '***';
      if (field === 'length') response.result.dataBase64 = Buffer.alloc(131073).toString('base64');
      return response;
    });
    await assert.rejects(new MigrationSourceBridge().run(f.options), { reason: 'source_transfer_invalid_response' });
    assert.ok(!f.calls.some(call => call.method === 'target/part/write'));
  }
});

test('an aborted bridge never restarts the Native operation or forwards another chunk', async () => {
  const f = fixture(400000), controller = new AbortController();
  const pending = deferred();
  f.hooks.set('source/chunk', async response => { await pending.promise; return response; });
  const running = new MigrationSourceBridge().run({ ...f.options, signal: controller.signal });
  while (!f.calls.some(call => call.method === 'source/chunk')) await tick();
  controller.abort(); pending.resolve();
  await assert.rejects(running, { reason: 'source_transfer_interrupted' });
  assert.ok(!f.calls.some(call => call.method === 'target/part/write'));
});

test('a new Gateway instance recovers original Native selectors and confirmed parts without the original UI selection', async () => {
  const f = fixture(400000);
  f.hooks.set('target/part/write', () => ({ error: { message: 'owned lost acknowledgement' } }));
  await assert.rejects(new MigrationSourceBridge().run(f.options), { reason: 'source_transfer_outcome_unknown' });
  f.hooks.delete('target/part/write');
  const { selections: _originalUiSelection, ...reopened } = f.options;
  assert.equal((await new MigrationSourceBridge().run(reopened)).phase, 'ready');
  assert.equal(f.calls.filter(call => call.method === 'source/intent').length, 1);
  assert.deepEqual(f.calls.filter(call => call.method === 'source/prepare').map(call => call.params.selections), [selected, selected]);
  assert.deepEqual(f.calls.filter(call => call.method === 'target/part/write').map(call => call.params.index), [0, 1, 2, 3]);
});

test('cancel reaches the target independently of a delayed source cancel receipt', async () => {
  const f = fixture(400000), chunkPending = deferred(), cancelPending = deferred();
  f.hooks.set('source/chunk', async response => { await chunkPending.promise; return response; });
  f.hooks.set('source/cancel', async response => { await cancelPending.promise; return response; });
  const bridge = new MigrationSourceBridge(), running = bridge.run(f.options);
  while (!f.calls.some(call => call.method === 'source/chunk')) await tick();
  const cancelling = bridge.cancel({ ...f.options, commandId: randomUUID() });
  while (!f.calls.some(call => call.method === 'target/cancel')) await tick();
  assert.equal(f.targetState.cancelled, true);
  cancelPending.resolve();
  assert.equal((await cancelling).sourceState.cancelled, true);
  chunkPending.resolve();
  await assert.rejects(running, { reason: 'source_transfer_interrupted' });
  assert.ok(!f.calls.some(call => call.method === 'target/part/write'));
});

test('a changed Native selection digest cannot replace an existing same-request intent', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge();
  await bridge.run(f.options);
  f.hooks.set('source/state', response => { response.result.selectionDigest = sha('replacement selection'); return response; });
  await assert.rejects(bridge.read(f.options), { reason: 'source_transfer_request_changed' });
});

test('a fresh verified login can reopen the same Native accounts without adopting the old in-flight generation', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge();
  await bridge.run(f.options);
  for (const role of ['source', 'target']) f.scopes[role] = { ...f.scopes[role], ownerId: 'new-verified-session', generation: 2 };
  await assert.rejects(bridge.read(f.options), { reason: 'source_transfer_authority_changed' });
  const source = captureMigrationSourceEndpoint({ broker: f.brokers.source, captureCurrent: () => f.scopes.source });
  const target = captureMigrationSourceEndpoint({ broker: f.brokers.target, captureCurrent: () => f.scopes.target });
  assert.equal((await bridge.read({ requestId: f.requestId, source, target })).phase, 'ready');
});

test('a retained ready receipt cannot silently clear a later explicit cancellation', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge();
  await bridge.run(f.options);
  const cancelled = await bridge.cancel({ ...f.options, commandId: randomUUID() });
  const observed = await bridge.read(f.options);
  assert.equal(observed.phase, 'cancelled'); assert.equal(observed.receipt.bytes, 7);
  assert.equal((await bridge.run(f.options)).phase, 'cancelled');
  assert.ok(!f.calls.some(call => call.method === 'target/resume'));
  assert.equal((await bridge.run({ ...f.options, resume: { source: { ...cancelled.sourceState, snapshotControl: cancelled.sourceSnapshotControl }, target: cancelled.targetState } })).phase, 'ready');
});

test('a cancellation observed after finish keeps the receipt without projecting an active ready state', async () => {
  const f = fixture(7);
  f.hooks.set('target/state', response => {
    if (response.result.state?.ready) response.result.state = { ...response.result.state, cancelled: true, cancelWatermark: 1, sequence: 2 };
    return response;
  });
  const result = await new MigrationSourceBridge().run(f.options);
  assert.equal(result.phase, 'cancelled'); assert.equal(result.receipt.bytes, 7);
});

test('failed capture reports its terminal fact and frozen controls instead of polling forever', async () => {
  const f = fixture(7);
  f.hooks.set('source/capture', response => {
    response.result.state.ready = false; response.result.snapshotControl.ready = false;
    response.result.capture = { status: 'failed', errorCode: 'source_transfer_capture_failed' };
    return response;
  });
  const result = await new MigrationSourceBridge().run(f.options);
  assert.equal(result.phase, 'failed'); assert.equal(result.sourceCapture.errorCode, 'source_transfer_capture_failed');
  assert.ok(result.sourceState && result.sourceSnapshotControl);
  assert.ok(!f.calls.some(call => call.method === 'target/begin'));
});

test('cancel watermarks do not claim either still-running Native owner has already stopped', async () => {
  for (const role of ['source', 'target']) {
    const f = fixture(7), bridge = new MigrationSourceBridge();
    await bridge.run(f.options);
    f.hooks.set(`${role}/cancel`, response => {
      if (role === 'source') response.result.capture = { status: 'running', errorCode: null };
      else response.result.workerRunning = true;
      return response;
    });
    const requested = await bridge.cancel({ ...f.options, commandId: randomUUID() });
    assert.equal(requested.phase, 'cancelling');
    assert.equal((await bridge.read(f.options)).phase, 'cancelled');
  }
});

test('an independent snapshot cancellation is retained without automatically clearing its different watermark', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge();
  await bridge.run(f.options);
  f.hooks.set('source/state', response => {
    response.result.snapshotControl = { ...response.result.snapshotControl, sequence: 10, cancelWatermark: 3, cancelled: true };
    return response;
  });
  const observed = await bridge.read(f.options);
  assert.equal(observed.sourceState.cancelled, false);
  assert.equal(observed.sourceSnapshotControl.cancelWatermark, 3);
  assert.equal(observed.phase, 'cancelled');
  assert.equal((await bridge.run({ ...f.options, resume: { source: observed.sourceState } })).phase, 'cancelled');
  assert.ok(!f.calls.some(call => call.method === 'source/resume'));
});

test('a failed read cannot suppress the first explicit fixed-ID cancellation of an authenticated owner', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge();
  await bridge.run(f.options);
  f.hooks.set('source/state', () => ({ error: { message: 'owned publication observation unavailable' } }));
  assert.equal((await bridge.cancel({ ...f.options, commandId: randomUUID() })).phase, 'cancelled');
  assert.equal(f.calls.filter(call => call.method === 'source/cancel').length, 1);
});

test('equivalent selector property order preserves the same durable request intent', async () => {
  const f = fixture(7), bridge = new MigrationSourceBridge();
  await bridge.run({ ...f.options, selections: [{ sourceId: selected[0].sourceId, kind: 'configuration' }] });
  assert.equal((await bridge.run(f.options)).phase, 'ready');
});

test('work-asset origin identity is validated and negotiated without rewriting old manifests', async () => {
  const legacy = { kind: 'work_asset', source: 'claude-code', category: 'instructions', scope: { kind: 'global' },
    asset: 'CLAUDE.md', relative: 'CLAUDE.md', source_revision: sha('source bytes'), source_executable: false };
  for (const identified of [false, true]) {
    const content = identified ? { ...legacy, sourceIdentity: sha('actual binding logical origin') } : legacy;
    const f = fixture(7, false, content);
    assert.equal((await new MigrationSourceBridge().run({ ...f.options, selections: [{ kind: 'assets', sourceId: 'owned-asset' }] })).phase, 'ready');
    assert.deepEqual(f.calls.find(call => call.method === 'target/begin').params.manifest.entries[0].content, content);
  }
  const old = fixture(7, false, { ...legacy, sourceIdentity: sha('actual binding logical origin') });
  old.brokers.target.initializeResponse.result.capabilities.experimental.migrationSourceTransferAssetIdentityV1 = false;
  await assert.rejects(new MigrationSourceBridge().run(old.options), { reason: 'source_transfer_unsupported_native' });
  assert.ok(!old.calls.some(call => call.method === 'target/begin'));
  for (const content of [{ ...legacy, sourceIdentity: 'caller label' }, { ...legacy, sourceIdentity: null }, { ...legacy, extra: true }, { ...legacy, relative: '../secret' }]) {
    const f = fixture(7, false, content);
    await assert.rejects(new MigrationSourceBridge().run(f.options), { reason: 'source_transfer_invalid_response' });
    assert.ok(!f.calls.some(call => call.method === 'target/begin'));
  }
});

test('a short capture finishing between Native snapshot and worker observation is reconciled without another capture', async () => {
  const f = fixture(7);
  f.hooks.set('source/capture', response => {
    response.result.state.ready = false;
    response.result.snapshotControl.ready = false;
    assert.equal(response.result.capture.status, 'ready');
    return response;
  });
  const result = await new MigrationSourceBridge().run(f.options);
  assert.equal(result.phase, 'ready');
  assert.equal(result.receipt.bytes, 7);
  assert.equal(f.calls.filter(call => call.method === 'source/capture').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'source/state').length, 2);
});
test('a persistently contradictory capture observation fails without replaying a write', async () => {
  const f = fixture(7);
  for (const method of ['source/capture', 'source/state']) f.hooks.set(method, response => {
    if (response.result.state) response.result.state.ready = false;
    return response;
  });
  await assert.rejects(new MigrationSourceBridge().run(f.options), { reason: 'source_transfer_invalid_response' });
  assert.equal(f.calls.filter(call => call.method === 'source/capture').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'source/state').length, 2);
  assert.ok(!f.calls.some(call => call.method === 'target/begin'));
});


test('memory transfer preserves unverified provenance and rejects old target before beginning payload', async () => {
  const origin = { source: 'claude-code', layout: 'claude_auto_memory_v1', sourceGroup: 'opaque-not-a-target-path',
    sourceFile: 'feedback.md', sourceRevision: sha('source bytes'), sourceModifiedAtMs: null, factsVerified: false };
  const memory = { kind: 'work_asset', source: 'claude-code', category: 'memory', scope: { kind: 'global' },
    asset: 'feedback.md', relative: 'feedback.md', source_revision: origin.sourceRevision, source_executable: false,
    memoryProvenance: origin };
  const f = fixture(7, false, memory);
  assert.equal((await new MigrationSourceBridge().run(f.options)).phase, 'ready');
  assert.deepEqual(f.calls.find(call => call.method === 'target/begin').params.manifest.entries[0].content, memory);
  for (const legacyMetadata of [false, true]) {
    const content = { ...memory }; if (legacyMetadata) delete content.memoryProvenance;
    const old = fixture(7, false, content);
    delete old.brokers.target.initializeResponse.result.capabilities.experimental.migrationSourceTransferMemoryV1;
    await assert.rejects(new MigrationSourceBridge().run(old.options), { reason: 'source_transfer_memory_update_required' });
    assert.equal(old.calls.filter(call => ['target/begin', 'target/part/write', 'source/chunk'].includes(call.method)).length, 0);
  }
  for (const changed of [{ ...origin, factsVerified: true }, { ...origin, sourceFile: 'other.md' },
    { ...origin, migrationJobId: 'unrelated-source-job' }, { ...origin, privatePath: '/not-authorized' }]) {
    const invalid = fixture(7, false, { ...memory, memoryProvenance: changed });
    await assert.rejects(new MigrationSourceBridge().run(invalid.options), { reason: 'source_transfer_invalid_response' });
    assert.equal(invalid.calls.filter(call => call.method === 'target/begin').length, 0);
  }
});


test('uploaded provenance stays inert and requires the receiving Native capability before payload', async () => {
  const origin = { operationId: randomUUID(), manifestSha256: sha('uploaded manifest') };
  const contents = [
    { kind: 'configuration_inventory', source: 'codex', sourceIdentity: sha('configuration'), source_scope: 'user', uploadedSource: origin },
    { kind: 'work_asset', source: 'codex', category: 'instructions', scope: { kind: 'global' }, asset: 'AGENTS.md', relative: 'AGENTS.md',
      source_revision: sha('instruction'), source_executable: false, uploadedSource: origin },
    { kind: 'history', snapshot: {}, uploadedSource: origin },
  ];
  for (const content of contents) {
    const f = fixture(7, false, content);
    assert.equal((await new MigrationSourceBridge().run(f.options)).phase, 'ready');
    assert.deepEqual(f.calls.find(call => call.method === 'target/begin').params.manifest.entries[0].content.uploadedSource, origin);
    const old = fixture(7, false, content);
    delete old.brokers.target.initializeResponse.result.capabilities.experimental.migrationSourceTransferUploadedV1;
    await assert.rejects(new MigrationSourceBridge().run(old.options), { reason: 'source_transfer_uploaded_update_required' });
    assert.ok(!old.calls.some(call => ['target/begin', 'target/part/write', 'source/chunk'].includes(call.method)));
  }
  for (const uploadedSource of [{ ...origin, sourceAuthority: { accountId: 'forged' } }, { ...origin, operationId: '../peer' },
    { ...origin, manifestSha256: 'not-a-digest' }, null]) {
    const f = fixture(7, false, { ...contents[0], uploadedSource });
    await assert.rejects(new MigrationSourceBridge().run(f.options), { reason: 'source_transfer_invalid_response' });
    assert.ok(!f.calls.some(call => call.method === 'target/begin'));
  }
});


test('passive definitions require target support before begin or any payload chunk', async () => {
  for (const category of ['agent','hook']) {
    const content = { kind: 'work_asset', source: 'claude-code', category, scope: { kind: 'global' },
      asset: 'pending.md', relative: 'pending.md', source_revision: 'a'.repeat(64), source_executable: false };
    const old = fixture(4, false, content);
    delete old.brokers.target.initializeResponse.result.capabilities.experimental.migrationSourceTransferDefinitionsV1;
    await assert.rejects(new MigrationSourceBridge().run(old.options), { reason: 'source_transfer_definitions_update_required' });
    assert.ok(!old.calls.some(call => ['target/begin','target/part/write','source/chunk'].includes(call.method)));
    const current = fixture(4, false, content);
    const result = await new MigrationSourceBridge().run(current.options);
    assert.equal(result.phase, 'ready');
    assert.ok(!JSON.stringify(result).includes('work_asset'));
  }
});


test('plugin packages require target support before begin and bound selectors carry no paths', async () => {
  const content = { kind: 'plugin_package', format: 'kcoder-plugin-tar/1', origin: { source: 'claude-code', logicalIdentity: 'a'.repeat(64),
    name: 'sample', version: '1.0.0', scope: 'project', sourceEnabled: true, pending: ['plugin_project_mapping_required'],
    package: { sha256: 'b'.repeat(64), files: 2, bytes: 4 } } };
  const old = fixture(4, false, content);
  delete old.brokers.target.initializeResponse.result.capabilities.experimental.migrationSourceTransferPluginsV1;
  await assert.rejects(new MigrationSourceBridge().run({ ...old.options, selections: [{ kind: 'plugin', candidateId: 'plug-owned' }] }), { reason: 'source_transfer_plugins_update_required' });
  assert.ok(!old.calls.some(call => ['target/begin', 'target/part/write', 'source/chunk'].includes(call.method)));
  const f = fixture(4, false, content);
  const result = await new MigrationSourceBridge().run({ ...f.options, selections: [{ kind: 'plugin', candidateId: 'plug-owned' }] });
  assert.equal(result.phase, 'ready');
  assert.ok(!JSON.stringify(result).includes('plugin_package'));
  for (const origin of [{ ...content.origin, sourcePath: '/private/path' }, { ...content.origin, scope: 'global-authority' },
    { ...content.origin, pending: ['run-untrusted-hook'] }, { ...content.origin, package: { ...content.origin.package, files: 10001 } }]) {
    const bad = fixture(4, false, { ...content, origin });
    await assert.rejects(new MigrationSourceBridge().run(bad.options), { reason: 'source_transfer_invalid_response' });
    assert.ok(!bad.calls.some(call => call.method === 'target/begin'));
  }
});

test('user-supplied plugin provenance is negotiated at both ends before any target publication', async () => {
  const content = { kind: 'plugin_package', format: 'kcoder-plugin-tar/1',
    uploadedSource: { operationId: randomUUID(), manifestSha256: 'c'.repeat(64) },
    origin: { source: 'codex', logicalIdentity: 'a'.repeat(64), name: 'sample', version: '1.0.0', scope: 'user',
      sourceEnabled: false, pending: [], package: { sha256: 'b'.repeat(64), files: 2, bytes: 4 } } };
  for (const missing of ['source', 'target', null]) {
    const f = fixture(4, false, content);
    for (const role of ['source', 'target']) f.brokers[role].initializeResponse.result.capabilities.experimental.migrationSourceUploadedPluginsV1 = role !== missing;
    const running = new MigrationSourceBridge().run({ ...f.options, selections: [{ kind: 'plugin', candidateId: 'plug-owned' }] });
    if (missing) {
      await assert.rejects(running, { reason: 'source_transfer_uploaded_update_required' });
      assert.ok(!f.calls.some(call => ['target/begin', 'target/part/write', 'source/chunk'].includes(call.method)));
    } else {
      assert.equal((await running).phase, 'ready');
      assert.deepEqual(f.calls.find(call => call.method === 'target/begin').params.manifest.entries[0].content.uploadedSource, content.uploadedSource);
    }
  }
  const bad = fixture(4, false, { ...content, uploadedSource: { ...content.uploadedSource, sourcePath: '/not-authorized' } });
  for (const role of ['source', 'target']) bad.brokers[role].initializeResponse.result.capabilities.experimental.migrationSourceUploadedPluginsV1 = true;
  await assert.rejects(new MigrationSourceBridge().run(bad.options), { reason: 'source_transfer_invalid_response' });
  assert.ok(!bad.calls.some(call => call.method === 'target/begin'));
});


test('project inventory is metadata-only and requires both private endpoint capabilities before capture', async () => {
  const content = { kind: 'project_inventory', source: 'codex', format: 'kcoder-project-inventory/1',
    sourceIdentity: 'a'.repeat(64), source_revision: 'b'.repeat(64),
    metadata: { displayName: 'Original source label', labelOrigin: 'registry_name', originalProjectId: 'original', roots: 1,
      formatRevision: 'codex-project-registry/sqlite/1' } };
  const selections = [{ kind: 'projects', catalogId: 'owned-catalog', sourceHandle: 'owned-project' }];
  for (const missing of ['source', 'target']) {
    const f = fixture(4, false, content);
    for (const role of ['source', 'target']) f.brokers[role].initializeResponse.result.capabilities.experimental.migrationSourceTransferProjectsV1 = role !== missing;
    await assert.rejects(new MigrationSourceBridge().run({ ...f.options, selections }), { reason: 'source_transfer_projects_update_required' });
    assert.ok(!f.calls.some(call => ['source/prepare','source/capture','target/begin','source/chunk'].includes(call.method)));
  }
  const f = fixture(4, false, content);
  for (const role of ['source', 'target']) f.brokers[role].initializeResponse.result.capabilities.experimental.migrationSourceTransferProjectsV1 = true;
  assert.equal((await new MigrationSourceBridge().run({ ...f.options, selections })).phase, 'ready');
  for (const invalid of [{ ...content, directory: '/private' }, { ...content, metadata: { ...content.metadata, secret: 'PRIVATE' } },
    { ...content, metadata: { ...content.metadata, roots: 17 } }, { ...content, metadata: { ...content.metadata, formatRevision: 'unknown' } }]) {
    const bad = fixture(4, false, invalid);
    for (const role of ['source', 'target']) bad.brokers[role].initializeResponse.result.capabilities.experimental.migrationSourceTransferProjectsV1 = true;
    await assert.rejects(new MigrationSourceBridge().run({ ...bad.options, selections }), { reason: 'source_transfer_invalid_response' });
    assert.ok(!bad.calls.some(call => call.method === 'target/begin'));
  }
});
