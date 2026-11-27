import test from 'node:test';
import assert from 'node:assert/strict';
import { IdleResourceBudget } from '../src/idle-resource-budget.js';

function broker(age, size = 100) {
  return { lastUsedAt: age, closed: false, hasProtectedIdleResources: false,
    initializeResponse: { result: { capabilities: { experimental: { serverIdleShutdownV1: true } } } },
    idleShutdown: { closing: false, resourceSample: { receivedAt: 100, residentBytes: size } },
    async stopWhenIdle() { this.closed = true; return { status: 'stopped' }; } };
}

test('unknown exit remains charged even when the shutdown controller seals the broker', async () => {
  const frozen = broker(0);
  frozen.stopWhenIdle = async () => {
    frozen.idleShutdown.closing = true;
    frozen.idleShutdown.resourceSample = null;
    return { status: 'unknown' };
  };
  const result = await new IdleResourceBudget({ maxProcesses: 0, maxResidentBytes: 0, now: () => 100 }).enforce([frozen]);
  assert.equal(result.stopped, 0);
  assert.equal(result.remainingIdleProcesses, 1);
  assert.equal(result.remainingIdleCandidates, 0);
  assert.equal(result.countSatisfied, false);
  assert.equal(result.memorySatisfied, null);
});

test('transport closure alone is not process exit evidence', async () => {
  const closed = broker(0);
  closed.closed = true;
  const budget = new IdleResourceBudget({ maxProcesses: 0, now: () => 100 });
  assert.equal((await budget.enforce([closed])).countSatisfied, false);
  closed.idleShutdown.exit = { code: 1, signal: null };
  assert.equal((await budget.enforce([closed])).countSatisfied, true);
});

test('count budget uses LRU and excludes protected work and duplicate references', async () => {
  const oldest = broker(1), newest = broker(3), middle = broker(2), busy = broker(0);
  busy.hasProtectedIdleResources = true;
  busy.stopWhenIdle = () => assert.fail('protected work');
  const result = await new IdleResourceBudget({ maxProcesses: 1, now: () => 100 }).enforce([newest, oldest, middle, oldest, busy]);
  assert.equal(result.stopped, 2);
  assert.equal(newest.closed, false);
  assert.equal(busy.closed, false);
  assert.equal(result.countSatisfied, true);
});

test('unknown or stale memory is not zero and does not authorize memory eviction', async () => {
  const unknown = broker(0, null), stale = broker(1), measured = broker(2, 200);
  stale.idleShutdown.resourceSample.receivedAt = 0;
  const result = await new IdleResourceBudget({ maxResidentBytes: 100, maxSampleAgeMs: 50, now: () => 100 }).enforce([unknown, stale, measured]);
  assert.equal(result.stopped, 1);
  assert.equal(measured.closed, true);
  assert.equal(unknown.closed, false);
  assert.equal(stale.closed, false);
  assert.equal(result.memorySatisfied, null);
});

test('rejections do not count as releases and protection is rechecked after await', async () => {
  const first = broker(0), second = broker(1);
  first.stopWhenIdle = async () => { second.hasProtectedIdleResources = true; return { status: 'busy' }; };
  second.stopWhenIdle = () => assert.fail('became protected');
  const result = await new IdleResourceBudget({ maxProcesses: 0, now: () => 100 }).enforce([first, second]);
  assert.equal(result.stopped, 0);
  assert.equal(result.attempted, 1);
  assert.equal(result.countSatisfied, false);
});

test('disabled budgets do nothing and one sweep has a bounded number of stop attempts', async () => {
  const brokers = Array.from({ length: 20 }, (_, index) => broker(index));
  assert.equal((await new IdleResourceBudget().enforce(brokers)).attempted, 0);
  const result = await new IdleResourceBudget({ maxProcesses: 0, now: () => 100 }).enforce(brokers);
  assert.equal(result.stopped, 8);
  assert.equal(result.countSatisfied, false);
  assert.throws(() => new IdleResourceBudget({ maxResidentBytes: -1 }));
});

test('concurrent sweeps coalesce and refusing oldest candidates cannot starve the next sweep', async () => {
  const brokers = Array.from({ length: 10 }, (_, index) => broker(index));
  for (const item of brokers.slice(0, 8)) item.stopWhenIdle = async () => ({ status: 'busy' });
  let clock = 100;
  const budget = new IdleResourceBudget({ maxProcesses: 0, now: () => clock });
  const first = budget.enforce(brokers);
  assert.equal(budget.enforce(brokers), first);
  assert.equal((await first).stopped, 0);
  clock += 2_000;
  assert.equal((await budget.enforce(brokers)).stopped, 2);
  assert.equal(brokers[8].closed, true);
  assert.equal(brokers[9].closed, true);
});
