import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireAgentMessageRouteLease, hasAgentMessageRouteLease } from './broker-agent-message-route-lease.js';

test('route borrowing expires once without renewal or a synthetic client', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1 });
  let changed = 0;
  const broker = { closed: false, idleShutdown: { closing: false },
    onIdleStateChange: () => changed++ };
  const lease = acquireAgentMessageRouteLease(broker);
  assert.equal(hasAgentMessageRouteLease(broker), true);
  lease.verify();
  t.mock.timers.tick(30_000);
  assert.equal(hasAgentMessageRouteLease(broker), false);
  assert.throws(() => lease.verify(), /DESTINATION_ROUTE_EXPIRED/);
  lease.release();
  assert.equal(changed, 1);
  assert.equal(Object.hasOwn(broker, 'clients'), false);
});

test('route borrows have a fixed capacity and a closed or closing process cannot be borrowed', () => {
  const broker = { closed: false, idleShutdown: { closing: false } };
  const leases = Array.from({ length: 32 }, () => acquireAgentMessageRouteLease(broker));
  try {
    assert.throws(() => acquireAgentMessageRouteLease(broker), /REQUEST_CAPACITY/);
    broker.idleShutdown.closing = true;
    assert.throws(() => leases[0].verify(), /DESTINATION_ROUTE_EXPIRED/);
    assert.throws(() => acquireAgentMessageRouteLease(broker), /ENDPOINT_UNAVAILABLE/);
    broker.idleShutdown.closing = false;
    broker.closed = true;
    assert.throws(() => leases[0].verify(), /DESTINATION_ROUTE_EXPIRED/);
    assert.throws(() => acquireAgentMessageRouteLease(broker), /ENDPOINT_UNAVAILABLE/);
  } finally { for (const lease of leases) lease.release(); }
  assert.equal(hasAgentMessageRouteLease(broker), false);
});
