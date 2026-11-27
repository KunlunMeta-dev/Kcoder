import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BrokerMigrationViewLeases, MIGRATION_VIEW_PREFIX } from './broker-migration-view-leases.js';

function fixture() {
  const broker = new BrokerMigrationViewLeases();
  const owner = { initialized: true };
  const peer = { initialized: true };
  const params = { requestId: randomUUID(), jobId: randomUUID(), expectedArchiveId: `archive-${'a'.repeat(64)}`, viewId: null };
  const ticket = broker.claim(owner, { method: `${MIGRATION_VIEW_PREFIX}open`, params });
  const lease = { requestId: params.requestId, leaseId: randomUUID(), jobId: params.jobId, archiveId: params.expectedArchiveId, viewId: null, state: 'active' };
  return { broker, owner, peer, params, ticket, lease };
}

test('knowing a peer native lease and request IDs never grants logical-client renew/read/release', () => {
  const { broker, owner, peer, params, ticket, lease } = fixture();
  assert.equal(broker.response(ticket, { result: { lease } }, true), null);
  for (const name of ['renew', 'release', 'read', 'open']) {
    const request = name === 'open' ? params : { requestId: params.requestId, leaseId: lease.leaseId, expectedSequence: 1 };
    assert.throws(() => broker.claim(peer, { method: `${MIGRATION_VIEW_PREFIX}${name}`, params: request }), /another logical client/);
  }
  assert.ok(broker.claim(owner, { method: `${MIGRATION_VIEW_PREFIX}renew`, params: { requestId: params.requestId, leaseId: lease.leaseId, expectedSequence: 1 } }));
  assert.throws(() => broker.claim(owner, { method: `${MIGRATION_VIEW_PREFIX}release`, params: { requestId: params.requestId, leaseId: randomUUID() } }), /does not belong/);
});

test('a late open is cleaned by its original broker after detach and never bound to a new client', async () => {
  const { broker, owner, peer, params, ticket, lease } = fixture();
  let reply;
  const later = new Promise(resolve => { reply = resolve; });
  assert.deepEqual(broker.detach(owner), []);
  assert.throws(() => broker.claim(peer, { method: `${MIGRATION_VIEW_PREFIX}open`, params }), /another logical client/);
  const cleanup = later.then(response => broker.response(ticket, response, false));
  reply({ result: { lease } });
  assert.deepEqual(await cleanup, { method: `${MIGRATION_VIEW_PREFIX}release`, params: { requestId: params.requestId, leaseId: lease.leaseId } });
  assert.equal(broker.response(ticket, { result: { lease } }, false), null);
});

test('detach releases only its known holds and late renews cannot select a replacement lease', () => {
  const { broker, owner, peer, params, ticket, lease } = fixture();
  broker.response(ticket, { result: { lease } }, true);
  const peerParams = { ...params, requestId: randomUUID() };
  const peerTicket = broker.claim(peer, { method: `${MIGRATION_VIEW_PREFIX}open`, params: peerParams });
  const peerLease = { ...lease, requestId: peerParams.requestId, leaseId: randomUUID() };
  broker.response(peerTicket, { result: { lease: peerLease } }, true);
  assert.deepEqual(broker.detach(owner), [{ method: `${MIGRATION_VIEW_PREFIX}release`, params: { requestId: params.requestId, leaseId: lease.leaseId } }]);
  assert.ok(broker.claim(peer, { method: `${MIGRATION_VIEW_PREFIX}renew`, params: { requestId: peerParams.requestId, leaseId: peerLease.leaseId, expectedSequence: 1 } }));
  assert.throws(() => broker.response(ticket, { result: { lease: { ...lease, leaseId: peerLease.leaseId } } }, false), /does not match/);
});

test('unconfirmed opens require read-back and selection changes never reuse a request', () => {
  const { broker, owner, params, ticket } = fixture();
  assert.throws(() => broker.claim(owner, { method: `${MIGRATION_VIEW_PREFIX}release`, params: { requestId: params.requestId, leaseId: randomUUID() } }), /does not belong|Read back/);
  assert.throws(() => broker.claim(owner, { method: `${MIGRATION_VIEW_PREFIX}open`, params: { ...params, expectedArchiveId: 'different' } }), /already bound/);
  assert.equal(broker.response(ticket, { error: { message: 'transport unknown' } }, false), null);
  assert.ok(broker.claim(owner, { method: `${MIGRATION_VIEW_PREFIX}read`, params: { requestId: params.requestId } }));
});
