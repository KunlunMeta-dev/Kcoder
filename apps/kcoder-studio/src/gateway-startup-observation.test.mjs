import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayStartupObservation } from './gateway-startup-observation.js';

test('startup observation preserves the exact opaque result and runs capture synchronously', async () => {
  const records = [], value = {}, branded = new WeakSet([value]);
  let time = 10, captured = false;
  const observer = createGatewayStartupObservation({ now: () => time, uptime: () => 400, emit: record => records.push(record) });
  const pending = observer.run('office_resources', () => { captured = true; time = 35; return value; });
  assert.equal(captured, true);
  assert.equal(branded.has(await pending), true);
  assert.deepEqual(records, [
    { event: 'gateway-startup', phase: 'module_imports', status: 'completed', elapsedMs: 400 },
    { event: 'gateway-startup', phase: 'office_resources', status: 'started', elapsedMs: 0 },
    { event: 'gateway-startup', phase: 'office_resources', status: 'completed', elapsedMs: 25 },
  ]);
});

test('original failure is propagated without logging its message, inputs or result', async () => {
  const records = [], failure = new Error('private-value-must-not-be-logged');
  const observer = createGatewayStartupObservation({ emit: record => records.push(record) });
  await assert.rejects(observer.run('account_credentials', () => { throw failure; }), error => error === failure);
  assert.equal(records.at(-1).status, 'failed');
  assert.equal(JSON.stringify(records).includes(failure.message), false);
  await assert.rejects(observer.run('private-unknown-label', () => assert.fail()), /Unknown/);
});

test('diagnostic output failures cannot replace the original operation or error', async () => {
  const observer = createGatewayStartupObservation({ emit() { throw Error('closed diagnostic sink'); } });
  const original = {};
  assert.equal(await observer.run('channel_resources', () => original), original);
  const failure = new Error('original');
  await assert.rejects(observer.run('component_image', () => { throw failure; }), error => error === failure);
});
