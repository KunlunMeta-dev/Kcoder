import test from 'node:test';
import assert from 'node:assert/strict';
import { projectThreadRunSummary } from '../src/broker-thread-summary.js';

test('legacy projection preserves array-shaped RPC results and notifications', () => {
  const values = Object.freeze([Object.freeze({ id: 'model-a' }), Object.freeze({ id: 'model-b' })]);
  for (const field of ['result', 'params']) {
    const message = Object.freeze({ jsonrpc: '2.0', [field]: values });
    const projected = projectThreadRunSummary(message, false);
    assert.ok(Array.isArray(projected[field]));
    assert.deepEqual(projected[field], values);
    assert.deepEqual(message[field], values);
  }
});

test('legacy thread summaries are projected without changing the source', () => {
  const thread = Object.freeze({ id: 'thread-a', status: 'running', runSummary: Object.freeze({ mainTurn: 'idle' }) });
  const message = Object.freeze({ result: Object.freeze({ threads: Object.freeze([thread]) }) });
  const projected = projectThreadRunSummary(message, false);
  assert.deepEqual(projected.result.threads, [{ id: 'thread-a', status: 'idle' }]);
  assert.equal(message.result.threads[0], thread);
  assert.equal(projectThreadRunSummary(message, true), message);
});
