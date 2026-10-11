import assert from 'node:assert/strict';
import test from 'node:test';
import { pendingWorkIdleDelay, releaseIdleBrokers } from '../src/workspace-broker-release.js';

test('pending timer retry has a positive floor even when initial idle is zero', () => {
  assert.equal(pendingWorkIdleDelay(0), 1_000);
  assert.equal(pendingWorkIdleDelay(25), 1_000);
  assert.equal(pendingWorkIdleDelay(300_000), 300_000);
});

function fixture() {
  let clock = 0;
  const removed = [];
  const terminated = [];
  return { removed, terminated, options: {
    remove: broker => removed.push(broker),
    stop: async broker => { terminated.push(broker.child); return { status: 'stopped' }; },
    now: () => clock,
    wait: async ms => { clock += ms; },
  } };
}

test('explicit release removes only confirmed exited processes', async () => {
  const f = fixture();
  const stopped = { clientCount: 0 };
  const busy = { clientCount: 0 };
  f.options.stop = async broker => ({ status: broker === stopped ? 'stopped' : 'busy' });
  await assert.rejects(releaseIdleBrokers([stopped, busy], f.options), /not confirmed/);
  assert.deepEqual(f.removed, [stopped]);
});

test('release protects in-flight broker work after the last client disconnects', async () => {
  const f = fixture();
  const broker = { clientCount: 0, hasPendingWork: true, child: {} };
  await assert.rejects(releaseIdleBrokers([broker], f.options), /active/);
  assert.equal(f.terminated.length, 0);
});

test('release waits for pending work to settle before removing the group', async () => {
  const f = fixture();
  const broker = { clientCount: 0, hasPendingWork: true, child: {} };
  const advance = f.options.wait;
  f.options.wait = async ms => {
    assert.equal(f.removed.length, 0);
    await advance(ms);
    broker.hasPendingWork = false;
  };
  assert.deepEqual(await releaseIdleBrokers([broker], f.options), { released: true, releasedCount: 1 });
  assert.deepEqual(f.terminated, [broker.child]);
});

test('explicit workspace release protects automation without clients or terminals', async () => {
  const f = fixture();
  const idle = { clientCount: 0, hasLiveTerminals: false, hasProjectAutomations: false, child: {} };
  const scheduled = { ...idle, hasProjectAutomations: true, child: {} };
  await assert.rejects(releaseIdleBrokers([idle, scheduled], f.options), /active/);
  assert.equal(f.removed.length, 0);
  assert.equal(f.terminated.length, 0);
});

test('release rechecks automation started while waiting for a client to disconnect', async () => {
  const f = fixture();
  const broker = { clientCount: 1, hasProjectAutomations: false, child: {} };
  const advance = f.options.wait;
  f.options.wait = async ms => {
    await advance(ms);
    broker.clientCount = 0;
    broker.hasProjectAutomations = true;
  };
  await assert.rejects(releaseIdleBrokers([broker], f.options), /automationBrokers=1/);
  assert.equal(f.terminated.length, 0);
});

test('settled automation can release normally and a terminal still blocks the whole group', async () => {
  const f = fixture();
  const broker = { clientCount: 0, hasProjectAutomations: true, child: {} };
  const advance = f.options.wait;
  f.options.wait = async ms => { await advance(ms); broker.hasProjectAutomations = false; };
  assert.deepEqual(await releaseIdleBrokers([broker], f.options), { released: true, releasedCount: 1 });
  assert.deepEqual(f.terminated, [broker.child]);
  const blocked = fixture();
  await assert.rejects(releaseIdleBrokers([{ ...broker, hasLiveTerminals: true }], blocked.options), /terminalBrokers=1/);
  assert.equal(blocked.removed.length, 0);
});
