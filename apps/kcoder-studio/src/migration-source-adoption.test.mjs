import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { MigrationSourceBridge, captureMigrationSourceEndpoint } from './migration-source-bridge.js';
import { MigrationSourceTransferService } from './migration-source-transfer-service.js';
const sha = value => createHash('sha256').update(value).digest('hex');
const PREFIX = 'migration/sourceTransfer/internal/';
function fixture() {
  const requestId = randomUUID(), adoptionId = randomUUID(), calls = [];
  const scope = { ownerId: 'owned-login', generation: 1, targetFingerprint: sha('actual target scope'), principal: { kind: 'localOs' } };
  const receipt = { requestId, manifestSha256: sha('original manifest'), entries: 1, bytes: 31 };
  let state = { adoptionId, requestId, phase: 'scanning', workerState: 'running', control: { sequence: 0, cancelWatermark: 0 },
    cancelRequested: false, jobs: [{ source: 'claude-code', jobId: 'mig-' + 'a'.repeat(32), targetScope: 'user', previewReady: false }],
    totalSources: 1, completedSources: 0, blockedItems: 0, errorCode: null };
  const broker = { closed: false, initializeResponse: { result: { capabilities: { experimental: {
    migrationSourceTransferTargetRecoveryV1: true, migrationSourceTransferAdoptionV1: true,
  } } } }, async sendMigrationSourceRequest(method, params) {
    calls.push({ method: method.slice(PREFIX.length), params });
    if (method.endsWith('/peer/recover-target')) return { result: { peerRef: 'owned-target-grant', targetAuthority: { instanceId: randomUUID(), accountId: sha('profile') } } };
    if (method.endsWith('/target/received/read')) return { result: { receipt, items: [{ entryId: 'e0000-0000', source: 'claude-code', class: 'work_asset', category: 'instructions',
      projectScoped: false, files: 1, bytes: 31 }], totalSources: 1, nextPage: null } };
    return { result: { state: structuredClone(state) } };
  } };
  // The actual Native identity is stable across reconnects; a different random
  // identity on each recover would correctly be rejected as a different target.
  const targetIdentity = { instanceId: randomUUID(), accountId: sha('profile') };
  const original = broker.sendMigrationSourceRequest.bind(broker);
  broker.sendMigrationSourceRequest = async (method, params) => {
    const result = await original(method, params);
    if (method.endsWith('/peer/recover-target')) result.result.targetAuthority = targetIdentity;
    return result;
  };
  const target = captureMigrationSourceEndpoint({ broker, captureCurrent: () => scope });
  const options = { requestId, adoptionId, target, manifestSha256: receipt.manifestSha256, selections: [{ entryId: 'e0000-0000' }], pageIndex: 0 };
  return { calls, broker, scope, options, receipt, setState(value) { state = value; } };
}

test('received catalogs and adoption controls use only an existing recovered target and validate original identities', async () => {
  const f = fixture(), bridge = new MigrationSourceBridge();
  const page = await bridge.received(f.options);
  assert.equal(page.receipt.manifestSha256, f.receipt.manifestSha256);
  assert.equal((await bridge.adoptionPrepare(f.options)).state.workerState, 'running');
  await bridge.adoptionRead(f.options);
  await bridge.adoptionCancel({ ...f.options, commandId: randomUUID() });
  await bridge.adoptionResume({ ...f.options, expectedControl: { sequence: 0, cancelWatermark: 0 } });
  assert.ok(f.calls.every(call => call.method === 'peer/recover-target' || call.method.startsWith('target/')));
  assert.ok(!f.calls.some(call => ['identity', 'target/grant', 'target/begin', 'source/prepare'].includes(call.method)));
  f.setState({ wrong: 'not a typed adoption snapshot' });
  await assert.rejects(bridge.adoptionRead(f.options), { reason: 'source_transfer_invalid_response' });
});

test('plugin received rows require explicit new-client opt-in and do not break old Native reads', async () => {
  const f = fixture(), bridge = new MigrationSourceBridge();
  const original = f.broker.sendMigrationSourceRequest.bind(f.broker);
  f.broker.initializeResponse.result.capabilities.experimental.migrationSourceTransferPluginsV1 = true;
  f.broker.sendMigrationSourceRequest = async (method, params) => {
    const result = await original(method, params);
    if (method.endsWith('/target/received/read')) {
      if (!params.includePlugins) return { error: { message: 'source_transfer_plugins_update_required' } };
      result.result.items[0] = { ...result.result.items[0], class: 'plugin', category: 'plugin' };
    }
    return result;
  };
  await assert.rejects(bridge.received(f.options), { reason: 'source_transfer_plugins_update_required' });
  const page = await bridge.received({ ...f.options, includePlugins: true });
  assert.equal(page.items[0].class, 'plugin');
  const old = fixture();
  await new MigrationSourceBridge().received({ ...old.options, includePlugins: true });
  assert.ok(old.calls.filter(call => call.method === 'target/received/read').every(call => !Object.hasOwn(call.params, 'includePlugins')));
});

test('old hosts and ambiguous selections are rejected before any adoption mutation', async () => {
  const f = fixture(), bridge = new MigrationSourceBridge();
  f.broker.initializeResponse.result.capabilities.experimental.migrationSourceTransferAdoptionV1 = false;
  await assert.rejects(bridge.adoptionPrepare(f.options), { reason: 'source_transfer_unsupported_native' });
  assert.equal(f.calls.length, 0);
  f.broker.initializeResponse.result.capabilities.experimental.migrationSourceTransferAdoptionV1 = true;
  for (const selections of [[null], [{ entryId: '../private' }], [{ entryId: 'e0000-0000', projectMapping: 'source_path' }],
    [{ entryId: 'e0000-0000' }, { entryId: 'e0000-0000' }]]) {
    await assert.rejects(bridge.adoptionPrepare({ ...f.options, selections }), { reason: 'source_transfer_invalid_request' });
  }
  assert.equal(f.calls.length, 0);
});

test('a late adoption read cannot cross the actual target generation and cannot be used to restart a missing session', async () => {
  const f = fixture();
  let leaseAlive = true;
  const owner = { async existingLease() {
    if (!leaseAlive) throw new Error('existing owned session unavailable');
    return { endpoint: f.options.target, assertCurrent() { f.options.target.assertCurrent(); } };
  } };
  const service = new MigrationSourceTransferService({ owner });
  const target = { sessionId: randomUUID(), purpose: 'target-recovery' };
  await service.adoptionRead({ ...f.options, target });
  const count = f.calls.length;
  leaseAlive = false;
  await assert.rejects(service.adoptionRead({ ...f.options, target }));
  assert.equal(f.calls.length, count);
  leaseAlive = true;
  f.scope.generation++;
  await assert.rejects(service.adoptionRead({ ...f.options, target }), { reason: 'source_transfer_authority_changed' });
  assert.equal(f.calls.length, count);
});


test('scoped instruction receipt opt-in and per-item mapping cannot fall back to an old Native or generic asset', async () => {
  const f = fixture(), bridge = new MigrationSourceBridge();
  assert.equal((await bridge.received({ ...f.options, includeInstructions: true })).items[0].class, 'work_asset');
  assert.ok(f.calls.filter(call => call.method === 'target/received/read').every(call => !Object.hasOwn(call.params, 'includeInstructions')));
  f.calls.length = 0;
  const mapping = { entryId: 'e0000-0000', items: [{ itemId: 'instruction-owned', targetRelativeScope: '' }] };
  await assert.rejects(bridge.adoptionPrepare({ ...f.options, instructionMappings: [mapping] }), { reason: 'source_transfer_scoped_instructions_update_required' });
  assert.equal(f.calls.length, 0);
  f.broker.initializeResponse.result.capabilities.experimental.migrationSourceTransferInstructionsV1 = true;
  const original = f.broker.sendMigrationSourceRequest.bind(f.broker);
  f.broker.sendMigrationSourceRequest = async (method, params) => {
    const result = await original(method, params);
    if (method.endsWith('/target/received/read')) {
      if (!params.includeInstructions) return { error: { message: 'source_transfer_scoped_instructions_update_required' } };
      result.result.items[0] = { ...result.result.items[0], class: 'instructions', projectScoped: true };
    }
    return result;
  };
  await assert.rejects(bridge.received(f.options), { reason: 'source_transfer_scoped_instructions_update_required' });
  assert.equal((await bridge.received({ ...f.options, includeInstructions: true })).items[0].class, 'instructions');
  await bridge.adoptionPrepare({ ...f.options, instructionMappings: [mapping] });
  assert.deepEqual(f.calls.find(call => call.method === 'target/adoption/prepare').params.instructionMappings, [mapping]);
  const count = f.calls.length;
  await assert.rejects(bridge.adoptionPrepare({ ...f.options, instructionMappings: [{ ...mapping, items: [{ itemId: 'owned', targetRelativeScope: '../outside' }] }] }), { reason: 'source_transfer_invalid_request' });
  assert.equal(f.calls.length, count);
});
