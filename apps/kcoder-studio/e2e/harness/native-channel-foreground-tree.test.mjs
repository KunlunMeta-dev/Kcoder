import assert from 'node:assert/strict';
import test from 'node:test';
import { attachOriginalForegroundTree } from './native-channel-foreground-tree.mjs';

test('original tree readiness reobserves incomplete startup without changing the expected tree', async () => {
  let calls = 0, time = 0;
  const original = { rootAlive: true, keepers: [{ role: 'core', kernelPidfd: true }] };
  const value = await attachOriginalForegroundTree(async () => ++calls === 1
    ? { error: { message: 'incomplete', data: { incomplete: true } } } : { result: original },
  { timeoutMs: 1000, now: () => time, delay: async ms => { time += ms; } });
  assert.equal(calls, 2);
  assert.equal(value, original);
});

test('an original tree identity failure is terminal and cannot retry into a replacement', async () => {
  let calls = 0;
  await assert.rejects(attachOriginalForegroundTree(async () => {
    calls++;
    return { error: { message: 'identity invalid', data: { incomplete: false } } };
  }, { timeoutMs: 1000 }), /identity invalid/);
  assert.equal(calls, 1);
});

test('incomplete original tree has a bounded startup deadline', async () => {
  let time = 0, calls = 0;
  await assert.rejects(attachOriginalForegroundTree(async () => {
    calls++;
    return { error: { message: 'still incomplete', data: { incomplete: true } } };
  }, { timeoutMs: 200, now: () => time, delay: async ms => { time += ms; } }), /still incomplete/);
  assert.equal(time, 200);
  assert.equal(calls, 3);
});
