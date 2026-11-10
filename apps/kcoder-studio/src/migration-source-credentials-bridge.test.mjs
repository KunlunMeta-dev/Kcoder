import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MigrationSourceCredentialsBridge } from './migration-source-credentials-bridge.js';
import { MigrationSourceBridge, captureMigrationSourceEndpoint } from './migration-source-bridge.js';

const state = overrides => ({ sequence: 1, cancelWatermark: 0, cancelled: false, ready: false, ...overrides });
function fixture() {
  const options = { requestId: randomUUID(), offerId: randomUUID(), manifestSha256: 'a'.repeat(64), entryId: 'e0000-0000',
    source: { owned: 'source' }, target: { owned: 'target' }, consent: { apiKeys: true, mcpPrivateFields: false },
    selections: [{ kind: 'provider', sourceName: 'provider', selector: { kind: 'claude_configuration' }, targetName: 'imported',
      endpoint: 'https://example.invalid/v1', apiFormat: 'anthropic' }] };
  const selected = [{ kind: 'provider', source_name: 'provider', selector: { kind: 'claude_configuration' },
    target_name: 'imported', endpoint: 'https://example.invalid/v1', api_format: 'anthropic' }];
  const offer = { context: { requestId: options.requestId, offerId: options.offerId, manifestSha256: options.manifestSha256,
    entryId: options.entryId, selections: selected }, suite: 'hpke-x25519-hkdf-sha256-aes256gcm-v1', publicKey: 'A'.repeat(43) + '=' };
  const envelope = { version: 1, offerId: options.offerId, offerSha256: 'b'.repeat(64), encapsulatedKey: 'ENCAPSULATED', ciphertext: 'CIPHERTEXT_ONLY' };
  let received = false, valid = true;
  const calls = [], hooks = new Map();
  const channel = { supportsBundles: true, assertCurrent() { if (!valid) throw new Error('owned-scope-revoked'); } };
  for (const side of ['source', 'target']) channel[side] = async (operation, params) => {
    calls.push({ side, operation, params: structuredClone(params) });
    if (operation === 'private/seal') {
      assert.deepEqual(params.offer, offer);
      assert.equal(Object.hasOwn(params, 'publicKey'), false);
    }
    if (operation === 'private/accept') { assert.deepEqual(params.envelope, envelope); received = true; }
    const value = { offer: structuredClone(offer), envelope: side === 'source' ? structuredClone(envelope) : null,
      control: state({ ready: side === 'source' || received }), writerRunning: false, received, keyReleased: false };
    return hooks.has(`${side}/${operation}`) ? hooks.get(`${side}/${operation}`)(value, params) : value;
  };
  const opened = [];
  const bridge = new MigrationSourceCredentialsBridge({ openChannel: async value => { opened.push(value); return channel; } });
  return { bridge, options, calls, hooks, offer, envelope, opened, channel, revoke() { valid = false; } };
}

test('the private bridge forwards the target key and original ciphertext without exposing either to public results', async () => {
  const f = fixture();
  const result = await f.bridge.run(f.options);
  assert.equal(result.phase, 'received'); assert.equal(result.received, true);
  assert.deepEqual(f.calls.map(call => `${call.side}/${call.operation}`), ['target/private/offer', 'source/private/seal', 'target/private/accept']);
  for (const word of ['publicKey', 'ciphertext', 'CIPHERTEXT_ONLY', 'encapsulatedKey', 'offerSha256', 'context', 'selections']) {
    assert.equal(JSON.stringify(result).includes(word), false);
  }
});

test('public callers cannot inject a key, offer, envelope or authority even with valid consent', async () => {
  for (const key of ['offer', 'publicKey', 'envelope', 'ciphertext', 'authority', 'sourceAuthority', 'targetAuthority', 'peerRef']) {
    const f = fixture();
    await assert.rejects(f.bridge.run({ ...f.options, [key]: 'INJECTED' }), { reason: 'private_credentials_invalid_request' });
    assert.equal(f.opened.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.bridge.run({ ...f.options, selections: [{ ...f.options.selections[0], value: 'SYNTHETIC_SECRET' }] }),
    { reason: 'private_credentials_invalid_request' });
  await assert.rejects(f.bridge.run({ ...f.options, consent: { apiKeys: false, mcpPrivateFields: false } }),
    { reason: 'private_credentials_explicit_consent_required' });
  assert.equal(f.calls.length, 0);
});

test('a substituted source echo is rejected before target acceptance', async () => {
  const f = fixture();
  f.hooks.set('source/private/seal', value => ({ ...value, offer: { ...value.offer, publicKey: 'B'.repeat(43) + '=' } }));
  await assert.rejects(f.bridge.run(f.options), { reason: 'private_credentials_invalid_response' });
  assert.equal(f.calls.some(call => call.operation === 'private/accept'), false);
});

test('a lost acceptance reply is reconciled by target-only read without replay or contacting the source', async () => {
  const f = fixture();
  f.hooks.set('target/private/accept', () => { throw new Error('SECRET_BACKEND_MESSAGE'); });
  await assert.rejects(f.bridge.run(f.options), error => error.reason === 'private_credentials_outcome_unknown'
    && !String(error).includes('SECRET_BACKEND_MESSAGE'));
  const writes = f.calls.length;
  const result = await f.bridge.read(f.options);
  assert.equal(result.phase, 'received');
  assert.deepEqual(f.calls.slice(writes).map(call => `${call.side}/${call.operation}`), ['target/private/read']);
  assert.equal(Object.hasOwn(f.opened.at(-1), 'source'), false);
});

test('target cancellation remains cancelling until its actual writer stops and resume uses the private watermark', async () => {
  const f = fixture();
  f.hooks.set('target/private/cancel', () => ({ writerRunning: true,
    control: { sequence: 4, cancelWatermark: 2, cancelled: true } }));
  f.hooks.set('target/private/resume', () => ({ writerRunning: false,
    control: { sequence: 5, cancelWatermark: 2, cancelled: false } }));
  const cancelled = await f.bridge.control({ ...f.options, side: 'target', commandId: randomUUID() }, 'cancel');
  assert.equal(cancelled.control.cancelled, true); assert.equal(cancelled.workerRunning, true);
  assert.equal(Object.hasOwn(cancelled.control, 'ready'), false);
  assert.equal(Object.hasOwn(f.opened[0], 'source'), false);
  await f.bridge.control({ ...f.options, side: 'target', expectedControl: { sequence: 4, cancelWatermark: 2 } }, 'resume');
  assert.deepEqual(f.calls.at(-1).params, { offerId: f.options.offerId, expectedSequence: 4, cancelWatermark: 2 });
  assert.ok(f.calls.every(call => call.side === 'target'));
});

test('scope invalidation after a source reply prevents the next target effect', async () => {
  const f = fixture();
  f.hooks.set('source/private/seal', value => { f.revoke(); return value; });
  await assert.rejects(f.bridge.run(f.options), /owned-scope-revoked/);
  assert.equal(f.calls.some(call => call.operation === 'private/accept'), false);
});


test('the real endpoint/pair adapter gates both capabilities and uses target-only recovery after source closure', async () => {
  const f = fixture(), calls = [];
  const authorities = Object.fromEntries(['source', 'target'].map((side, index) => [side,
    { instanceId: randomUUID(), accountId: String(index + 1).repeat(64) }]));
  const brokers = {};
  const endpoints = Object.fromEntries(['source', 'target'].map((side, index) => {
    const broker = { closed: false, initializeResponse: { result: { capabilities: { experimental: {
      migrationSourceTransferPrivateCredentialsV1: true, migrationSourceTransferTargetRecoveryV1: true,
    } } } }, async sendMigrationSourceRequest(method, params, proof) {
      const operation = method.slice('migration/sourceTransfer/internal/'.length);
      calls.push({ side, operation, proof: structuredClone(proof) });
      if (operation === 'identity') return { result: { authority: authorities[side], chunkBytes: 128 * 1024, maxManifestBytes: 1024 * 1024 } };
      if (operation === 'peer/accept') {
        assert.deepEqual(proof.source.authority, authorities.source);
        assert.deepEqual(proof.target.authority, authorities.target);
        assert.equal(params.role, side);
        return { result: { peerRef: `owned-${side}` } };
      }
      if (operation === 'peer/recover-target') return { result: { peerRef: 'owned-target', targetAuthority: authorities.target } };
      const { requestId, peerRef, ...selected } = params;
      assert.equal(requestId, f.options.requestId); assert.equal(peerRef, `owned-${side}`);
      return { result: await (side === 'source' ? {
        assertCurrent() {}, source: async () => ({ offer: f.offer, envelope: f.envelope, control: state({ ready: true }),
          writerRunning: false, received: false, keyReleased: false }),
      }.source(operation, selected) : operation === 'target/private/offer' ? {
        offer: { ...f.offer, context: { ...f.offer.context, selections: selected.selections } }, envelope: null,
        control: state(), writerRunning: false, received: false, keyReleased: false,
      } : { offer: f.offer, envelope: null, control: state({ ready: true }), writerRunning: false, received: true, keyReleased: false }) };
    } };
    brokers[side] = broker;
    return [side, captureMigrationSourceEndpoint({ broker, captureCurrent: () => ({ ownerId: 'owned-login', generation: 1,
      targetFingerprint: String(index + 3).repeat(64), principal: { kind: 'localOs' } }) })];
  }));
  const bridge = new MigrationSourceCredentialsBridge({ transferBridge: new MigrationSourceBridge() });
  const options = { ...f.options, ...endpoints };
  assert.equal((await bridge.run(options)).phase, 'received');
  const beforeBundle = calls.length;
  await assert.rejects(bridge.prepare({ ...options, jobId: 'mig-owned', expectedSequence: 1, additionalOffers: [randomUUID()] }), { reason: 'private_credentials_update_required' });
  assert.equal(calls.length, beforeBundle, 'old target is rejected before any private recovery or write frame');
  brokers.source.closed = true;
  const before = calls.length;
  const read = await bridge.read(options);
  assert.equal(read.received, true); assert.equal(read.sourceObserved, false); assert.equal(read.sourceWorkerRunning, null);
  assert.ok(calls.slice(before).every(call => call.side === 'target' && call.operation !== 'identity'));
  const unsupported = captureMigrationSourceEndpoint({ broker: { sendMigrationSourceRequest() { throw new Error('must not send'); },
    initializeResponse: { result: { capabilities: { experimental: {} } } } }, captureCurrent: () => ({ ownerId: 'owned-login', generation: 1,
    targetFingerprint: '4'.repeat(64), principal: { kind: 'localOs' } }) });
  await assert.rejects(bridge.read({ ...options, target: unsupported }), { reason: 'private_credentials_update_required' });
});

test('only explicitly typed Native diagnostic codes cross the private relay boundary', async () => {
  const { MigrationSourceBridgeError } = await import('./migration-source-private.js');
  for (const code of ['private_credentials_keyring_unavailable', 'private_credentials_lowercase_secret', 'SECRET_BACKEND_PATH']) {
    const f = fixture();
    f.hooks.set('target/private/offer', () => { throw new MigrationSourceBridgeError(code); });
    await assert.rejects(f.bridge.run(f.options), { reason: code === 'private_credentials_keyring_unavailable'
      ? code : 'private_credentials_outcome_unknown' });
    assert.equal(f.calls.length, 1);
  }
});

test('saved-plan candidate reads forward the exact job and plan and reject another response before exposing targets', async () => {
  const f = fixture();
  const { readFileSync } = await import('node:fs');
  const examples = JSON.parse(readFileSync(new URL('../shared/generated/examples.migration-source-credentials.json', import.meta.url)));
  const candidate = structuredClone(examples.MigrationSourceCredentialCandidatesResult[0].value);
  Object.assign(candidate, { requestId: f.options.requestId, manifestSha256: f.options.manifestSha256, entryId: f.options.entryId });
  const jobId = 'mig-' + 'a'.repeat(32), expectedPlanId = 'batch-' + 'b'.repeat(32);
  candidate.plan = { jobId, planId: expectedPlanId, sequence: 7 };
  candidate.items[0].targets = [{ kind: 'mcp', batchItemId: 'owned-batch-item', targetName: 'renamed-notes', targetDefinitionSha256: 'c'.repeat(64) }];
  f.hooks.set('target/private/candidates', () => candidate);
  const result = await f.bridge.candidates({ ...f.options, pageIndex: 0, jobId, expectedPlanId }).catch(() => null);
  assert.deepEqual(f.calls.at(-1).params, { manifestSha256: f.options.manifestSha256, entryId: f.options.entryId, pageIndex: 0, jobId, expectedPlanId });
  assert.equal(result?.plan.jobId, jobId);
  candidate.plan.planId = 'batch-' + 'd'.repeat(32);
  await assert.rejects(f.bridge.candidates({ ...f.options, pageIndex: 0, jobId, expectedPlanId }), { reason: 'private_credentials_invalid_response' });
  const calls = f.calls.length;
  await assert.rejects(f.bridge.candidates({ ...f.options, pageIndex: 0, jobId }), { reason: 'private_credentials_invalid_request' });
  assert.equal(f.calls.length, calls);
});

function preparedJob(id) {
  return { job: { jobId: id, sourceId: 'source', status: 'ready', sequence: 3, totalItems: 0, committedItems: 0, requiresActionItems: 0 }, source: 'codex', plans: [], issues: [] };
}
test('bundle preparation requires its own target capability and returns the exact persisted complete set', async () => {
  const f = fixture(), additionalOffers = [randomUUID(), randomUUID()], jobId = 'mig-owned';
  const expected = [f.options.offerId, ...additionalOffers].sort();
  f.channel.supportsBundles = false;
  await assert.rejects(f.bridge.prepare({ ...f.options, jobId, expectedSequence: 1, additionalOffers }), { reason: 'private_credentials_update_required' });
  assert.equal(f.calls.length, 0);
  f.channel.supportsBundles = true;
  f.hooks.set('target/private/prepare', (_, params) => {
    assert.deepEqual(params.additionalOffers, additionalOffers.toSorted());
    return { job: preparedJob(jobId), offerIds: expected };
  });
  const result = await f.bridge.prepare({ ...f.options, jobId, expectedSequence: 1, additionalOffers });
  assert.deepEqual(result.offerIds, expected);
  assert.ok(f.calls.every(call => call.side === 'target'));
  for (const invalid of [[], null, [f.options.offerId], [additionalOffers[0], additionalOffers[0]], Array(16).fill(randomUUID())]) {
    const before = f.calls.length;
    await assert.rejects(f.bridge.prepare({ ...f.options, jobId, expectedSequence: 1, additionalOffers: invalid }), { reason: 'private_credentials_invalid_request' });
    assert.equal(f.calls.length, before);
  }
  for (const wrong of [[f.options.offerId], [...expected].reverse(), [...expected.slice(0, -1), randomUUID()]]) {
    f.hooks.set('target/private/prepare', () => ({ job: preparedJob(jobId), offerIds: wrong }));
    await assert.rejects(f.bridge.prepare({ ...f.options, jobId, expectedSequence: 1, additionalOffers }), { reason: 'private_credentials_invalid_response' });
  }
});
test('omitted bundle members preserve the old single reply and a lost bundle reply is never retried', async () => {
  const f = fixture(), jobId = 'mig-owned';
  f.hooks.set('target/private/prepare', () => ({ job: preparedJob(jobId) }));
  const result = await f.bridge.prepare({ ...f.options, jobId, expectedSequence: 1 });
  assert.equal(Object.hasOwn(result, 'offerIds'), false);
  assert.equal(Object.hasOwn(f.calls[0].params, 'additionalOffers'), false);
  f.hooks.set('target/private/prepare', () => { throw new Error('SYNTHETIC_LOST_ACK'); });
  const before = f.calls.length;
  await assert.rejects(f.bridge.prepare({ ...f.options, jobId, expectedSequence: 1, additionalOffers: [randomUUID()] }), { reason: 'private_credentials_outcome_unknown' });
  assert.equal(f.calls.length, before + 1);
});

test('source-only observation uses the original source endpoint without pairing, identity or any target request', async () => {
  const calls = [];
  const broker = { closed: false, initializeResponse: { result: { capabilities: { experimental: {
    migrationSourceTransferPrivateCredentialsV1: true, migrationSourceTransferPrivateCredentialSourceObservationV1: true,
  } } } }, async sendMigrationSourceRequest(method, params) {
    calls.push({ method, params });
    assert.equal(method, 'migration/sourceTransfer/internal/source/private/observe');
    assert.equal(Object.hasOwn(params, 'peerRef'), false);
    return { result: { control: state({ ready: true, cancelled: true }), writerRunning: true } };
  } };
  const source = captureMigrationSourceEndpoint({ broker, captureCurrent: () => ({ ownerId: 'owned', generation: 1,
    targetFingerprint: 'a'.repeat(64), principal: { kind: 'localOs' } }) });
  const transfer = new MigrationSourceBridge();
  transfer.privateCredentialsChannel = () => assert.fail('must not pair or recover the target');
  const bridge = new MigrationSourceCredentialsBridge({ transferBridge: transfer });
  const result = await bridge.sourceRead({ requestId: randomUUID(), offerId: randomUUID(), source });
  assert.equal(result.phase, 'cancelling'); assert.equal(result.sourceWorkerRunning, true);
  assert.equal(result.sourceObserved, true); assert.equal(result.targetObserved, false);
  assert.equal(result.targetWorkerRunning, null); assert.equal(result.targetControl, null);
  assert.equal(result.received, false); assert.equal(result.keyReleased, false);
  assert.equal(calls.length, 1);
  broker.initializeResponse.result.capabilities.experimental.migrationSourceTransferPrivateCredentialSourceObservationV1 = false;
  await assert.rejects(bridge.sourceRead({ requestId: randomUUID(), offerId: randomUUID(), source }), { reason: 'private_credentials_update_required' });
  assert.equal(calls.length, 1, 'unsupported source receives no Native frame');
});
