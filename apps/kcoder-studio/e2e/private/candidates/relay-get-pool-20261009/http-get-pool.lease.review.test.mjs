import assert from 'node:assert/strict';
import test from 'node:test';
// Private, model-independent lease contracts; no sockets or services are opened.
// Run only after Root authorizes the frozen static02 inputs.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const moduleUrl = new URL('../../../../../../target/private-phone-ux-implementation/relay-grant-get-pool-20261009/candidate-static02/source/apps/kcoder-relay/src/http-get-pool.mjs', import.meta.url);
const moduleBytes = await readFile(moduleUrl);
assert.equal(createHash('sha256').update(moduleBytes).digest('hex'), '1ac7a3e9806c0e57a86300497139d34be9c6143d68d1b18f57e49ba72742c923');
const { GrantGetPool } = await import(moduleUrl.href);


function pool(t, overrides = {}) {
  let current = true; let waiting = 0; let destroys = 0;
  const owner = new GrantGetPool({
    validate: () => current ? null : Object.assign(new Error('revoked'), { code: 'RELAY_UNAUTHORIZED' }),
    expiresAt: Date.now() + 60_000, queueTimeoutMs: 1000,
    createConnection: () => { throw new Error('No transport expected by lease-only contract'); },
    admitWaiter: () => { if (waiting >= 2) return false; waiting++; return true; },
    releaseWaiter: () => waiting--,
    ...overrides,
  });
  const destroy = owner.slots[0].agent.destroy.bind(owner.slots[0].agent);
  owner.slots[0].agent.destroy = () => { destroys++; destroy(); };
  t.after(() => { owner.retire(undefined, true); assert.equal(waiting, 0); });
  return { owner, invalidate: () => { current = false; }, waiting: () => waiting, destroys: () => destroys };
}

test('one grant serializes leases and bounds/cancels its shared waiter budget', async t => {
  const f = pool(t); const first = await f.owner.acquire(); first.markForwarded();
  const abort = new AbortController(); const second = f.owner.acquire(abort.signal); const secondRejected = assert.rejects(second);
  const third = f.owner.acquire();
  assert.equal(f.waiting(), 2);
  await assert.rejects(f.owner.acquire(), { code: 'RELAY_UNAVAILABLE' });
  abort.abort(); await secondRejected; assert.equal(f.waiting(), 1);
  first.release(true); const next = await third; assert.equal(f.waiting(), 0);
  next.markForwarded(); next.release(true); next.release(true);
  assert.equal(f.owner.active, false);
});

test('grant retirement cancels not-forwarded checkout and queued work', async t => {
  const f = pool(t); const lease = await f.owner.acquire();
  const queued = f.owner.acquire(); const rejected = assert.rejects(queued, { code: 'RELAY_UNAUTHORIZED' });
  f.invalidate(); f.owner.retire(Object.assign(new Error('refresh'), { code: 'RELAY_UNAUTHORIZED' }));
  assert.equal(f.destroys(), 1); assert.throws(() => lease.markForwarded(), { code: 'RELAY_UNAUTHORIZED' });
  await rejected; assert.equal(f.waiting(), 0); lease.release(false);
});

test('already-forwarded old grant settles once, hard revoke remains immediate', async t => {
  const f = pool(t); const lease = await f.owner.acquire(); lease.markForwarded();
  f.invalidate(); f.owner.retire(Object.assign(new Error('refresh'), { code: 'RELAY_UNAUTHORIZED' }));
  assert.equal(f.destroys(), 0); await assert.rejects(f.owner.acquire(), { code: 'RELAY_UNAUTHORIZED' });
  lease.release(true); assert.equal(f.destroys(), 1);
  const hard = pool(t); const inFlight = await hard.owner.acquire(); inFlight.markForwarded();
  hard.owner.retire(undefined, true); assert.equal(hard.destroys(), 1); inFlight.release(false);
});

test('queue expiry releases its exact budget without taking over the active lease', async t => {
  const f = pool(t, { queueTimeoutMs: 20 }); const lease = await f.owner.acquire(); lease.markForwarded();
  // Keep this lease-only test alive while the intentionally unref'ed queue timer fires.
  const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
  await assert.rejects(f.owner.acquire(), { code: 'RELAY_TIMEOUT' });
  assert.equal(f.waiting(), 0); assert.equal(f.owner.active, true); lease.release(true);
});

test('timeout and expiry inputs cannot silently become NaN/zero queue timers', () => {
  for (const queueTimeoutMs of [undefined, NaN, 0, -1, Infinity]) {
    assert.throws(() => new GrantGetPool({ queueTimeoutMs, expiresAt: Date.now() + 1000 }));
  }
  assert.throws(() => new GrantGetPool({ queueTimeoutMs: 100, expiresAt: NaN }));
});


test('two independent held GET leases can progress; only a third waits', async t => {
  const f = pool(t, { maxSockets: 2 });
  const a = await f.owner.acquire(); a.markForwarded();
  const b = await f.owner.acquire(); b.markForwarded();
  assert.notEqual(a.agent, b.agent);
  const queued = f.owner.acquire(); assert.equal(f.waiting(), 1);
  a.release(true); const c = await queued;
  assert.equal(c.agent, a.agent); assert.equal(f.waiting(), 0);
  b.release(true); c.markForwarded(); c.release(true);
});

test('idle eviction cannot close a sibling active HTTP parser', async t => {
  const f = pool(t, { maxSockets: 2 });
  const a = await f.owner.acquire(); a.markForwarded();
  const b = await f.owner.acquire(); b.markForwarded();
  let activeDestroyed = 0; const destroy = b.agent.destroy.bind(b.agent);
  b.agent.destroy = () => { activeDestroyed++; destroy(); };
  a.release(true); f.owner.evictIdle();
  assert.equal(activeDestroyed, 0); assert.equal(f.owner.active, true);
  b.release(true);
});
