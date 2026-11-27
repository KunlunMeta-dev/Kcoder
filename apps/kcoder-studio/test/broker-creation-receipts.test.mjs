import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerFixture, fakeClient } from './workspace-app-server-broker.test-support.js';

for (const method of ['thread/start', 'thread/fork']) {
  for (const retirement of ['detach', 'timeout']) {
    test(`${retirement} preserves a receipt-backed ${method} after a late response`, t => {
      const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
      broker.initializeResponse = { result: { capabilities: { experimental: {
        threadCreationReceiptsV1: true, threadForkReceiptsV1: true,
      } } } };
      const owner = fakeClient(), observer = fakeClient();
      broker.attach(owner); broker.attach(observer);
      t.after(() => { broker.detach(owner); broker.detach(observer); });
      // The original source belongs to this client; a late fork has no new owner.
      broker.threadOwners.set('source', owner);
      broker.receive(owner, JSON.stringify({ id: 1, method, params: {
        threadId: 'source', lastTurnId: 'turn', clientRequestId: 'original-operation',
      } }));
      const forwarded = upstream.at(-1);
      assert.equal(forwarded.method, method);
      if (retirement === 'detach') broker.detach(owner);
      else broker.expireRequest(forwarded.id);
      const before = upstream.length;
      respond({ id: forwarded.id, result: { thread: { id: 'original-created' } } });
      assert.equal(upstream.length, before, 'must not delete an accepted durable creation');
      assert.equal(broker.threadOwners.has('original-created'), false);
      assert.equal(broker.pending.size, 0);
      assert.deepEqual(observer.messages, []);
    });
  }
}

for (const variant of ['legacy-capability', 'missing-request-id', 'ephemeral']) {
  for (const retirement of ['detach', 'timeout']) {
    test(`${retirement} keeps ${variant} fork cleanup compatible`, t => {
      const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
      broker.initializeResponse = { result: { capabilities: { experimental: {
        threadCreationReceiptsV1: true, threadForkReceiptsV1: variant !== 'legacy-capability',
      } } } };
      const owner = fakeClient(), observer = fakeClient();
      broker.attach(owner); broker.attach(observer);
      t.after(() => { broker.detach(owner); broker.detach(observer); });
      broker.threadOwners.set('source', owner);
      broker.receive(owner, JSON.stringify({ id: 1, method: 'thread/fork', params: {
        threadId: 'source', lastTurnId: 'turn',
        ...(variant !== 'missing-request-id' ? { clientRequestId: 'original-operation' } : {}),
        ...(variant === 'ephemeral' ? { ephemeral: true } : {}),
      } }));
      const forwarded = upstream.at(-1);
      assert.equal(forwarded.method, 'thread/fork');
      if (retirement === 'detach') broker.detach(owner);
      else broker.expireRequest(forwarded.id);
      respond({ id: forwarded.id, result: { thread: { id: 'legacy-created' },
        ...(variant === 'ephemeral' ? { ephemeral: true } : {}),
      } });
      const cleanup = upstream.at(-1);
      assert.equal(cleanup.method, variant === 'ephemeral' ? 'thread/dispose' : 'thread/delete');
      assert.equal(cleanup.params.threadId, 'legacy-created');
      respond({ id: cleanup.id, result: {} });
    });
  }
}
