import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMobileDeviceAuth } from './mobile-device-auth.js';
import { createBrowserSessionPersistence, createGatewayAuthSessionRegistry, createBrowserSessionOperationQueue } from './browser-session-recovery.js';
import { reconcileServerAccess } from './server-config.js';

async function fixture(t, { maximumSessions = 4 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-browser-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = Date.now();
  const now = () => time;
  const registries = [];
  t.after(() => { for (const registry of registries) for (const session of registry.sessions.values()) clearTimeout(session.expiryTimer); });
  async function start({ identity = 'owned-test-identity', ids = ['local', 'ssh'] } = {}) {
    const store = createMobileDeviceAuth({ directory, identity, maximumDevices: maximumSessions, now });
    const persistence = await store.browserSessions();
    const registry = createGatewayAuthSessionRegistry({ authRequired: true, getServerIds: () => ids,
      maximumSessions, ttlMs: 60_000, persistence, sessionSockets: new Map(), invalidateOwner() {}, expireDevice() {}, now });
    registries.push(registry);
    return registry;
  }
  return { directory, start, advance(ms) { time += ms; } };
}

test('restores a browser Cookie and its original ACL after Gateway recreation without storing credentials', async t => {
  const f = await fixture(t);
  const first = await f.start();
  const { id, session } = await first.create({ browserAdmin: true });
  const second = await f.start({ ids: ['local', 'new-target'] });
  assert.deepEqual([...(await second.get(id)).allowedServerIds], ['local']);
  assert.equal((await second.get(id)).browserAdmin, true);
  assert.equal((await second.get(id)).expiresAt, session.expiresAt);
  const file = join(f.directory, 'mobile-device-auth', 'devices.json');
  const encoded = await readFile(file, 'utf8');
  assert.equal(encoded.includes(id), false);
  assert.equal(encoded.includes('owned-test-identity'), false);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('logout before lazy restoration remains revoked after another restart', async t => {
  const f = await fixture(t);
  const { id } = await (await f.start()).create({ browserAdmin: true });
  const restarted = await f.start();
  await restarted.delete(id);
  assert.equal(await (await f.start()).get(id), null);
});

test('a sibling Gateway cannot restore or retain a Cookie after another process logs it out', async t => {
  const f = await fixture(t);
  const first = await f.start();
  const { id } = await first.create({ browserAdmin: true });
  const sibling = await f.start();
  assert.ok(await sibling.get(id));
  await first.delete(id);
  assert.equal(await sibling.get(id), null);
});

test('expiration is preserved rather than extended by restart', async t => {
  const f = await fixture(t);
  const { id } = await (await f.start()).create({ browserAdmin: true });
  f.advance(60_001);
  assert.equal(await (await f.start()).get(id), null);
});

test('changing the configured Gateway token invalidates the persisted Cookie permanently', async t => {
  const f = await fixture(t);
  const first = await f.start();
  const { id } = await first.create({ browserAdmin: true });
  assert.equal(await (await f.start({ identity: 'new-owned-identity' })).get(id), null);
  assert.equal(await first.get(id), null, 'a live old process must not accept its stale browser session');
  assert.equal(await (await f.start()).get(id), null);
});

test('legacy Mobile sessions never gain persistent browser administration', async t => {
  const f = await fixture(t);
  const { id } = await (await f.start()).create();
  assert.equal(await (await f.start()).get(id), null);
});

test('explicit renewal keeps the same Cookie and persists its new expiry', async t => {
  const f = await fixture(t);
  const first = await f.start();
  const { id, session } = await first.create({ browserAdmin: true });
  const originalExpiry = session.expiresAt;
  f.advance(10_000);
  assert.equal(await first.renew(id), true);
  assert.equal((await (await f.start()).get(id)).expiresAt, originalExpiry + 10_000);
});

test('an old expiry callback cannot revoke a browser Cookie renewed by a sibling process', async t => {
  const f = await fixture(t);
  const { id, session } = await (await f.start()).create({ browserAdmin: true });
  const originalExpiry = session.expiresAt;
  const persistence = await createMobileDeviceAuth({ directory: f.directory, identity: 'owned-test-identity', maximumDevices: 4 }).browserSessions();
  await persistence.save(id, { ...session, expiresAt: originalExpiry + 10_000 });
  await persistence.remove(id, originalExpiry);
  assert.equal((await persistence.restore(id)).expiresAt, originalExpiry + 10_000);
  await persistence.remove(id);
  assert.equal(await persistence.restore(id), null);
});

test('persisted target access changes survive restart without restoring removed targets', async t => {
  const f = await fixture(t);
  const first = await f.start();
  const { id, session } = await first.create({ browserAdmin: true });
  session.allowedServerIds = new Set(['ssh']);
  await first.saveAccess();
  assert.deepEqual([...(await (await f.start()).get(id)).allowedServerIds], ['ssh']);
});

test('target reconciliation also updates a browser Cookie not yet restored since restart', async t => {
  const f = await fixture(t);
  const { id } = await (await f.start()).create({ browserAdmin: true });
  const restarted = await f.start({ ids: ['local', 'new-target'] });
  await restarted.saveAccess(['local', 'ssh'], ['local', 'new-target'], reconcileServerAccess);
  assert.deepEqual([...(await (await f.start({ ids: ['local', 'new-target'] })).get(id)).allowedServerIds], ['local', 'new-target']);
});

test('bounded concurrent browser logins evict old sessions durably', async t => {
  const f = await fixture(t, { maximumSessions: 2 });
  const first = await f.start();
  const [old, current, newest] = await Promise.all([first.create({ browserAdmin: true }), first.create({ browserAdmin: true }), first.create({ browserAdmin: true })]);
  const restarted = await f.start();
  assert.equal(await restarted.get(old.id), null);
  assert.ok(await restarted.get(current.id));
  assert.ok(await restarted.get(newest.id));
});

test('session pressure refuses login without evicting a protected device', async t => {
  const f = await fixture(t, { maximumSessions: 1 });
  const first = await f.start();
  const session = { deviceId: 'protected-device', expiresAt: Date.now() + 60_000 };
  first.sessions.set('protected-access', session);
  await assert.rejects(first.create({ browserAdmin: true }), error => error.status === 429);
  assert.equal(first.sessions.get('protected-access'), session);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function slowStore(t) {
  let time = 1_000, before = null, after = null, inspect = null, inspectCost = 0, serverIds = ['local'];
  const enqueue = createBrowserSessionOperationQueue();
  const data = { identityHash: 'a'.repeat(64), browserSessions: [] };
  const persistence = await createBrowserSessionPersistence({ maximumSessions: 4, now: () => time,
    transaction: (operation, kind) => enqueue(async () => {
      const pre = before; before = null;
      if (pre) { pre.entered.resolve(); await pre.release.promise; }
      const value = await operation(data);
      const post = after; after = null;
      if (post) { post.entered.resolve(); await post.release.promise; }
      return value;
    }, kind), inspect: operation => enqueue(async () => {
      const held = inspect; inspect = null;
      if (held) { held.entered.resolve(); await held.release.promise; }
      time += inspectCost;
      return operation(data);
    }, 'read'),
  });
  const invalidated = [];
  const registry = createGatewayAuthSessionRegistry({ authRequired: true, getServerIds: () => serverIds,
    maximumSessions: 4, ttlMs: 3_000, persistence, sessionSockets: new Map(),
    invalidateOwner: id => invalidated.push(id), expireDevice() {}, now: () => time });
  t.after(() => { for (const session of registry.sessions.values()) clearTimeout(session.expiryTimer); });
  return { registry, persistence, invalidated, advance: ms => { time += ms; }, now: () => time,
    holdInspect() { return inspect = { entered: deferred(), release: deferred() }; },
    setInspectCost(ms) { inspectCost = ms; },
    setServerIds(ids) { serverIds = ids; },
    holdBefore() { return before = { entered: deferred(), release: deferred() }; },
    holdAfter() { return after = { entered: deferred(), release: deferred() }; } };
}

test('slow private-store acquisition does not consume a newly created browser session TTL', async t => {
  const f = await slowStore(t), hold = f.holdBefore();
  const creating = f.registry.create({ browserAdmin: true });
  await hold.entered.promise; f.advance(2_500); hold.release.resolve();
  const { session } = await creating;
  assert.equal(session.expiresAt, f.now() + 3_000);
});

test('old expiry timer cannot detach an authorized renewal while its save is in flight', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await slowStore(t), { id, session } = await f.registry.create({ browserAdmin: true });
  f.advance(2_000);
  const hold = f.holdAfter(), renewing = f.registry.renew(id);
  await hold.entered.promise; f.advance(1_100); t.mock.timers.tick(3_000);
  const detachedDuringSave = f.invalidated.length;
  hold.release.resolve(); assert.equal(await renewing, true);
  assert.equal(detachedDuringSave, 0);
  assert.equal(f.registry.sessions.get(id), session);
  assert.ok(await f.registry.get(id));
});

test('renewal cannot recreate a Cookie removed from the authoritative private store', async t => {
  const f = await slowStore(t), { id } = await f.registry.create({ browserAdmin: true });
  await f.persistence.remove(id);
  assert.equal(await f.registry.renew(id), false);
  assert.equal(await f.persistence.restore(id), null);
});

test('persistence slower than the complete TTL fails closed instead of returning an expired login', async t => {
  const f = await slowStore(t), hold = f.holdAfter();
  const creating = f.registry.create({ browserAdmin: true });
  const rejected = assert.rejects(creating, error => error.status === 503);
  await hold.entered.promise; f.advance(3_001); hold.release.resolve();
  await rejected;
  assert.equal(f.registry.sessions.size, 0);
});


test('a renewed same Cookie still fails closed when its subsequent authoritative inspect finishes after expiry', async t => {
  const f = await slowStore(t), { id, session } = await f.registry.create({ browserAdmin: true });
  f.advance(1_000); assert.equal(await f.registry.renew(id), true);
  const expiry = session.expiresAt, hold = f.holdInspect(), reading = f.registry.get(id);
  await hold.entered.promise; f.advance(3_001); hold.release.resolve();
  assert.equal(await reading, null);
  assert.equal(session.expiresAt, expiry);
  assert.equal(await f.persistence.restore(id), null);
});

test('admitted renewal runs before unstarted slow browser inspections and keeps current-row expiry checks', async t => {
  const f = await slowStore(t), { id } = await f.registry.create({ browserAdmin: true });
  f.setInspectCost(1_100);
  const hold = f.holdInspect(), first = f.registry.get(id);
  await hold.entered.promise;
  const second = f.registry.get(id), third = f.registry.get(id), renewing = f.registry.renew(id);
  hold.release.resolve();
  const values = await Promise.all([first, second, third, renewing]);
  assert.equal(values[3], true);
  assert.ok(values.slice(0, 3).every(Boolean));
});

test('renewal scheduling passes only unstarted reads and preserves mutation barriers and failures', async () => {
  const enqueue = createBrowserSessionOperationQueue(), hold = deferred(), entered = deferred(), order = [];
  const first = enqueue(async () => { entered.resolve(); await hold.promise; order.push('active-read'); }, 'read');
  await entered.promise;
  const pending = [enqueue(() => order.push('queued-read'), 'read'),
    enqueue(() => order.push('renew'), 'renew'),
    enqueue(() => { order.push('revoke'); throw new Error('owned write failure'); }),
    enqueue(() => order.push('later-renew'), 'renew'), enqueue(() => order.push('later-read'), 'read')];
  const settled = Promise.allSettled(pending); hold.resolve(); await first;
  const results = await settled;
  assert.deepEqual(order, ['active-read', 'renew', 'queued-read', 'revoke', 'later-renew', 'later-read']);
  assert.equal(results[2].status, 'rejected');
  assert.ok(results.filter((_, index) => index !== 2).every(row => row.status === 'fulfilled'));
});


test('queued authoritative restore cannot overwrite a committed server ACL reconciliation with old memory', async t => {
  const f = await slowStore(t), { id, session } = await f.registry.create({ browserAdmin: true });
  const originalExpiry = session.expiresAt;
  f.setServerIds(['local','remote']);
  const held = f.holdInspect(), reading = f.registry.get(id);
  await held.entered.promise;
  // Reproduce the original caller's out-of-queue optimistic memory update.
  session.allowedServerIds = reconcileServerAccess(session, ['local'], ['local','remote']);
  const saving = f.registry.saveAccess(['local'], ['local','remote'], reconcileServerAccess);
  held.release.resolve(); await Promise.all([reading,saving]);
  const stored = await f.persistence.restore(id);
  assert.deepEqual([...stored.allowedServerIds], ['local','remote']);
  assert.deepEqual([...session.allowedServerIds], ['local','remote']);
  assert.equal(stored.expiresAt, originalExpiry);
});

test('server ACL reconciliation cannot upsert a concurrently revoked Cookie or extend its expiry', async t => {
  const f = await slowStore(t), { id } = await f.registry.create({ browserAdmin: true });
  await f.persistence.remove(id);
  f.setServerIds(['local','remote']);
  await f.registry.saveAccess(['local'], ['local','remote'], reconcileServerAccess);
  assert.equal(await f.persistence.restore(id), null);
  assert.equal(f.registry.sessions.has(id), false);
});

test('server ACL reconciliation derives restricted grants and expiry from the current durable row', async t => {
  const f = await slowStore(t); f.setServerIds(['local','other']);
  const { id, session } = await f.registry.create({ browserAdmin: true });
  session.allowedServerIds = new Set(['local']); await f.registry.saveAccess();
  const originalExpiry = session.expiresAt;
  // Stale memory cannot widen the existing private grant or its lifetime.
  session.allowedServerIds = new Set(['local','other']); session.expiresAt += 10_000;
  f.setServerIds(['local','remote']);
  await f.registry.saveAccess(['local','other'], ['local','remote'], reconcileServerAccess);
  const stored = await f.persistence.restore(id);
  assert.deepEqual([...stored.allowedServerIds], ['local']);
  assert.deepEqual([...session.allowedServerIds], ['local']);
  assert.equal(stored.expiresAt, originalExpiry); assert.equal(session.expiresAt, originalExpiry);
});


test('ACL reconciliation schedules expiry from the current durable renewal instead of losing the deadline', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f = await slowStore(t), { id } = await f.registry.create({browserAdmin:true});
  f.advance(2000); t.mock.timers.tick(2000);
  await f.persistence.renew(id,3000);
  await f.registry.saveAccess(['local'],['local'],reconcileServerAccess);
  f.advance(1100); t.mock.timers.tick(1100);
  for(let i=0;i<12;i++) await Promise.resolve();
  assert.equal(f.registry.sessions.has(id),true);
  f.advance(2000); t.mock.timers.tick(2000);
  for(let i=0;i<12;i++) await Promise.resolve();
  assert.equal(f.registry.sessions.has(id),false);
});


test('a queued read burst coalesces but later reads still observe durable logout', async t => {
  const f = await slowStore(t), { id } = await f.registry.create({ browserAdmin: true });
  const first = f.registry.get(id);
  const burst = Array.from({ length: 20 }, () => f.registry.get(id));
  assert.ok(burst.every(read => read === first), 'unstarted checks share one queued operation');
  assert.ok((await Promise.all(burst)).every(Boolean));
  await f.persistence.remove(id);
  assert.equal(await f.registry.get(id), null, 'no completed auth verdict is cached');
});

test('mutation admission fences queued read coalescing even when the mutation fails', async t => {
  const f = await slowStore(t), { id } = await f.registry.create({ browserAdmin: true });
  const first = f.registry.get(id);
  const removing = f.registry.delete(id);
  const after = f.registry.get(id);
  assert.notEqual(first, after);
  assert.ok(await first);
  await removing;
  assert.equal(await after, null);

  const next = await f.registry.create({ browserAdmin: true });
  const beforeFailure = f.registry.get(next.id);
  const failed = f.registry.saveAccess([], [], () => { throw new Error('controlled write failure'); });
  const afterFailure = f.registry.get(next.id);
  assert.notEqual(beforeFailure, afterFailure);
  await assert.rejects(failed, /controlled write failure/);
  assert.ok(await beforeFailure);
  assert.ok(await afterFailure);
});
