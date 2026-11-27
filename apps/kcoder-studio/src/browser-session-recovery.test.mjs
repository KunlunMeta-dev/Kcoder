import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayDeviceAuth } from './gateway-device-auth.js';
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
    const store = createGatewayDeviceAuth({ directory, identity, maximumDevices: maximumSessions, now });
    const persistence = await store.browserSessions();
    const registry = createGatewayAuthSessionRegistry({ authRequired: true, getServerIds: () => ids,
      maximumSessions, ttlMs: 60_000, persistence, sessionSockets: new Map(), invalidateOwner() {}, expireDevice() {}, now });
    registries.push(registry);
    return registry;
  }
  return { directory, start, advance(ms) { time += ms; } };
}

test('restores a browser Cookie after Gateway recreation without storing credentials', async t => {
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
  const persistence = await createGatewayDeviceAuth({ directory: f.directory, identity: 'owned-test-identity', maximumDevices: 4 }).browserSessions();
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

test('unchanged browser expiry preserves its timer while every read still inspects current authority', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await slowStore(t), { id, session } = await f.registry.create({ browserAdmin: true });
  const timer = session.expiryTimer, restore = t.mock.method(f.persistence, 'restore');
  for (let index = 0; index < 20; index++) assert.equal(await f.registry.get(id), session);
  assert.equal(restore.mock.callCount(), 20);
  assert.equal(session.expiryTimer, timer);
  f.advance(3_001); t.mock.timers.tick(3_001);
  for (let index = 0; index < 12; index++) await Promise.resolve();
  assert.equal(f.registry.sessions.has(id), false);
  assert.deepEqual(f.invalidated, [id]);
});

test('warm authentication checks the requested credential without traversing peer sessions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await slowStore(t);
  const owners = [];
  for (let index = 0; index < 4; index++) owners.push(await f.registry.create({ browserAdmin: true }));
  const { id, session } = owners[0];
  const iterate = f.registry.sessions[Symbol.iterator].bind(f.registry.sessions);
  let visited = 0;
  t.mock.method(f.registry.sessions, Symbol.iterator, function* () {
    for (const entry of iterate()) { visited++; yield entry; }
  });
  const restore = t.mock.method(f.persistence, 'restore');
  for (let index = 0; index < 20; index++) assert.equal(await f.registry.get(id), session);
  assert.equal(visited, 0, 'warm reads must not walk unrelated sessions');
  assert.equal(restore.mock.callCount(), 20, 'each admitted read still checks the authoritative ledger');
  f.advance(3_001); t.mock.timers.tick(3_001);
  for (let index = 0; index < 30; index++) await Promise.resolve();
  assert.equal(f.registry.sessions.size, 0, 'each owner expires without relying on traffic for another Cookie');
  assert.deepEqual(new Set(f.invalidated), new Set(owners.map(owner => owner.id)));
});

test('reading an already expired nonpersistent credential still settles its own cleanup', async () => {
  const invalidated = [];
  const registry = createGatewayAuthSessionRegistry({ authRequired: true, getServerIds: () => ['local'],
    maximumSessions: 4, ttlMs: 3_000, sessionSockets: new Map(),
    invalidateOwner: id => invalidated.push(id), expireDevice() {}, now: () => 1_000 });
  registry.sessions.set('expired-owner', { expiresAt: 999, allowedServerIds: new Set(['local']) });
  assert.equal(await registry.get('expired-owner'), null);
  await registry.get('absent-owner');
  assert.equal(registry.sessions.has('expired-owner'), false);
  assert.deepEqual(invalidated, ['expired-owner']);
});

test('an early deadline after wall-clock rollback rearms without another authentication request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await slowStore(t), { id, session } = await f.registry.create({ browserAdmin: true });
  const timer = session.expiryTimer;
  f.advance(1_000); t.mock.timers.tick(3_000);
  for (let index = 0; index < 12; index++) await Promise.resolve();
  assert.equal(f.registry.sessions.has(id), true);
  assert.ok(session.expiryTimer);
  assert.notEqual(session.expiryTimer, timer);
  f.advance(2_001); t.mock.timers.tick(2_001);
  for (let index = 0; index < 12; index++) await Promise.resolve();
  assert.equal(f.registry.sessions.has(id), false);
  assert.deepEqual(f.invalidated, [id]);
});

test('cold Cookie restoration schedules once and sibling renewal replaces only the changed deadline', async t => {
  const f = await fixture(t), owner = await f.start();
  const { id } = await owner.create({ browserAdmin: true });
  const sibling = await f.start(), session = await sibling.get(id);
  const timer = session.expiryTimer;
  assert.ok(timer);
  assert.equal((await sibling.get(id)).expiryTimer, timer);
  f.advance(10_000); assert.equal(await owner.renew(id), true);
  assert.equal(await sibling.get(id), session);
  assert.notEqual(session.expiryTimer, timer);
  const renewedTimer = session.expiryTimer;
  assert.equal((await sibling.get(id)).expiryTimer, renewedTimer);
  await owner.delete(id);
  assert.equal(await sibling.get(id), null);
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


test('missing credentials are rejected without waiting behind an authoritative store read', async t => {
  const f = await slowStore(t), { id } = await f.registry.create({ browserAdmin: true });
  const hold = f.holdInspect(), reading = f.registry.get(id);
  await hold.entered.promise;
  let settled = false;
  const missing = Promise.all(Array.from({ length: 100 }, () => f.registry.get(null)))
    .then(values => { assert.ok(values.every(value => value === null)); settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'absence must not join the serialized authorization queue');
  } finally { hold.release.resolve(); await reading; await missing; }
});

test('explicitly disabled Gateway authentication keeps anonymous target access', async () => {
  const registry = createGatewayAuthSessionRegistry({ authRequired: false, getServerIds: () => ['local'] });
  assert.deepEqual([...(await registry.get(null)).allowedServerIds], ['local']);
});

test('disabled authorization observation does not sample its diagnostic clock', async t => {
  const diagnosticClock = t.mock.method(Date, 'now', () => 1000);
  const registry = createGatewayAuthSessionRegistry({ authRequired: false, getServerIds: () => ['local'], now: () => 1000 });
  for (let index = 0; index < 20; index++)
    assert.deepEqual([...(await registry.get(null)).allowedServerIds], ['local']);
  assert.ok((await Promise.all(Array.from({ length: 21 }, () => registry.get(null)))).every(Boolean));
  assert.equal(diagnosticClock.mock.callCount(), 0);
});

test('read coalescing observations reconcile equal call counts with different inspection cohorts', async () => {
  for (const serial of [false, true]) {
    const events = [];
    let inspections = 0;
    const session = { browserAdmin: true, expiresAt: 60000, allowedServerIds: new Set(['local']), expiryTimer: null };
    const registry = createGatewayAuthSessionRegistry({ authRequired: true, getServerIds: () => ['local'],
      maximumSessions: 4, now: () => 1000, observe: value => events.push(value),
      persistence: { restore: async () => { inspections++; return session; } } });
    try {
      if (serial) for (let index = 0; index < 21; index++) assert.ok(await registry.get('owned-cohort-id'));
      else assert.ok((await Promise.all(Array.from({ length: 21 }, () => registry.get('owned-cohort-id')))).every(Boolean));
      const count = stage => events.filter(value => value.stage === stage).length;
      assert.equal(count('read_queued') + count('read_coalesced'), 21);
      assert.equal(count('read_started'), serial ? 21 : 1);
      assert.equal(count('read_coalesced'), serial ? 0 : 20);
      assert.equal(inspections, count('read_started'));
      assert.equal(JSON.stringify(events).includes('owned-cohort-id'), false);
    } finally { clearTimeout(session.expiryTimer); }
  }
});

test('enabled authorization observation retains timings and outcome without credential content', async t => {
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock++);
  const observed = [];
  const registry = createGatewayAuthSessionRegistry({ authRequired: false, getServerIds: () => ['local'],
    now: () => 1000, observe: value => observed.push(value) });
  assert.ok(await registry.get('owned-observation-id'));
  assert.deepEqual(observed.map(value => value.stage), ['read_queued', 'read_started', 'read_completed']);
  assert.ok(observed.every(value => value.component === 'gateway_session' && Number.isSafeInteger(value.at)));
  assert.ok(observed[1].queueMs >= 0);
  assert.ok(observed[2].elapsedMs >= 0);
  assert.equal(observed[2].valid, true);
  assert.equal(observed[2].failed, false);
  assert.equal(JSON.stringify(observed).includes('owned-observation-id'), false);
});

test('throwing and rejected observation callbacks cannot change authorization results', async () => {
  for (const observe of [() => { throw new Error('Observation failed'); }, () => Promise.reject(new Error('Observation failed'))]) {
    const registry = createGatewayAuthSessionRegistry({ authRequired: false, getServerIds: () => ['local'], observe });
    assert.deepEqual([...(await registry.get(null)).allowedServerIds], ['local']);
  }
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

test('the same request count forms different authoritative read batches according to arrival timing', async t => {
  const f = await slowStore(t), { id } = await f.registry.create({ browserAdmin: true });
  const restores = t.mock.method(f.persistence, 'restore');
  const burst = await Promise.all(Array.from({ length: 21 }, () => f.registry.get(id)));
  assert.ok(burst.every(Boolean));
  assert.equal(restores.mock.callCount(), 1);

  const held = f.holdInspect(), first = f.registry.get(id);
  await held.entered.promise;
  const second = Array.from({ length: 20 }, () => f.registry.get(id));
  assert.ok(second.every(read => read === second[0] && read !== first));
  held.release.resolve();
  assert.ok((await Promise.all([first, ...second])).every(Boolean));
  assert.equal(restores.mock.callCount(), 3);

  for (let index = 0; index < 21; index++) assert.ok(await f.registry.get(id));
  assert.equal(restores.mock.callCount(), 24);
});

test('a read arriving after inspection starts observes a sibling logout instead of joining the older read', async t => {
  const f = await slowStore(t), { id } = await f.registry.create({ browserAdmin: true });
  const held = f.holdInspect(), first = f.registry.get(id);
  await held.entered.promise;
  const after = f.registry.get(id);
  assert.notEqual(after, first);
  const removed = f.persistence.remove(id);
  held.release.resolve();
  assert.ok(await first);
  await removed;
  assert.equal(await after, null);
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

test('restoration validates the whole ledger but checks expiry only for the current Cookie', async () => {
  const data = { identityHash: 'a'.repeat(64), browserSessions: [] };
  let time = 1000, clockReads = 0, inspections = 0, transactions = 0;
  const persistence = await createBrowserSessionPersistence({ maximumSessions: 64,
    now: () => { clockReads++; return time; },
    transaction: async operation => { transactions++; return operation(data); },
    inspect: async operation => { inspections++; return operation(data); },
  });
  const ids = Array.from({ length: 64 }, (_, index) => `owned-browser-${String(index).padStart(20, '0')}`);
  for (const id of ids) await persistence.save(id, { browserAdmin: true, expiresAt: 5000, allowedServerIds: new Set(['local']) });
  const snapshot = structuredClone(data), writes = transactions, id = ids.at(-1);
  clockReads = 0;
  const restored = await persistence.restore(id);
  assert.deepEqual([...restored.allowedServerIds], ['local']);
  assert.equal(clockReads, 1, 'a current Cookie must not sample expiration for the other 63 sessions');
  assert.equal(inspections, 1);
  assert.equal(transactions, writes);
  assert.deepEqual(data, snapshot, 'ordinary inspection must not prune or mutate the ledger');

  data.browserSessions.at(-1).allowedServerIds = ['ssh'];
  clockReads = 0;
  assert.deepEqual([...(await persistence.restore(id)).allowedServerIds], ['ssh']);
  assert.equal(inspections, 2, 'a later check must inspect current data instead of reusing the prior allow');
  assert.equal(clockReads, 1);
  time = 5000;
  assert.equal(await persistence.restore(id), null, 'the current row expires at its authoritative deadline');
  time = 1000;
  data.identityHash = 'b'.repeat(64);
  assert.equal(await persistence.restore(id), null, 'another installation identity cannot restore the current Cookie');
  data.identityHash = snapshot.identityHash;

  data.browserSessions[0].allowedServerIds = [''];
  await assert.rejects(persistence.restore(id), /Invalid browser session store/,
    'even an unrelated row must still pass complete schema validation');
  data.browserSessions[0] = { ...snapshot.browserSessions[0], idHash: data.browserSessions.at(-1).idHash };
  await assert.rejects(persistence.restore(id), /Invalid browser session store/,
    'an ambiguous duplicate cannot be accepted by selecting only the matching row');
});
