import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayResourceBudget } from '../src/gateway-resource-budget.js';
import { parseResourcePolicy } from '../src/resource-policy.js';

function broker(serverId, lastUsedAt) {
  return { serverId, lastUsedAt, closed: false, hasProtectedIdleResources: false,
    idleShutdown: { closing: false, exit: null, resourceSample: null },
    initializeResponse: { result: { capabilities: { experimental: { serverIdleShutdownV1: true, serverResourceSnapshotV1: true } } } },
    async stopWhenIdle() { this.closed = true; this.idleShutdown.exit = { code: 0 }; return { status: 'stopped' }; },
    async readResourceSnapshot() { this.idleShutdown.resourceSample = { receivedAt: 100, residentBytes: 100 }; },
  };
}

test('budget scheduler isolates target pools and shares the global attempt bound', async () => {
  const brokers = [broker('a', 1), broker('a', 2), broker('b', 1)];
  const policy = parseResourcePolicy('{"resources":{"idle_budget":{"max_processes":1}}}');
  const scheduler = new GatewayResourceBudget({ policy, getBrokers: () => brokers, now: () => 100 });
  const result = await scheduler.sweep();
  assert.equal(result.reduce((total, row) => total + row.stopped, 0), 1);
  assert.equal(brokers[2].closed, false);
  const many = Array.from({ length: 20 }, (_, index) => broker(`target-${index}`, index));
  const zero = new GatewayResourceBudget({ policy: { ...policy, maxProcesses: 0 }, getBrokers: () => many, now: () => 100 });
  assert.equal((await zero.sweep()).reduce((total, row) => total + row.attempted, 0), 8);
});

test('sampler is bounded and stop during a probe prevents subsequent eviction', async () => {
  const brokers = Array.from({ length: 8 }, (_, index) => broker('a', index));
  let finish;
  let reads = 0;
  for (const item of brokers) item.readResourceSnapshot = async () => { reads++; await new Promise(resolve => { finish = resolve; }); };
  const policy = parseResourcePolicy('{"resources":{"idle_budget":{"max_resident_bytes":0,"sample_limit":1}}}');
  const scheduler = new GatewayResourceBudget({ policy, getBrokers: () => brokers, now: () => 100 });
  const sweep = scheduler.sweep();
  assert.equal(scheduler.sweep(), sweep);
  assert.equal(reads, 1);
  scheduler.stop();
  finish();
  assert.deepEqual(await sweep, []);
  assert.ok(brokers.every(item => !item.closed));
});

test('disabled policy does not schedule or inspect brokers', t => {
  t.mock.method(globalThis, 'setTimeout', () => assert.fail('disabled timer'));
  const scheduler = new GatewayResourceBudget({ policy: parseResourcePolicy('{}'), getBrokers: () => assert.fail('disabled scan') });
  scheduler.start();
  scheduler.stop();
});

test('scheduled sweep failures are reported without exposing exception details', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const policy = parseResourcePolicy('{"resources":{"idle_budget":{"max_processes":1}}}');
  let errors = 0;
  const scheduler = new GatewayResourceBudget({ policy,
    getBrokers: () => { throw new Error('private failure details'); },
    onError: (...args) => { assert.deepEqual(args, []); errors++; },
  });
  scheduler.start();
  t.mock.timers.tick(policy.sweepIntervalMs);
  await new Promise(resolve => setImmediate(resolve));
  scheduler.stop();
  assert.equal(errors, 1);
});
