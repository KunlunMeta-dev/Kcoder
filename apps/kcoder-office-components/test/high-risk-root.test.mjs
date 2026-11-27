import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { generateOffice } from '../src/index.mjs';
import { sample } from './fixtures.mjs';

test('cleanup uncertainty retains the original generation failure privately', async t => {
  const original = Worker.prototype.terminate;
  const lostReceipt = new Error('owned termination receipt was lost');
  t.mock.method(Worker.prototype, 'terminate', async function () {
    await original.call(this);
    throw lostReceipt;
  });
  await assert.rejects(generateOffice(sample('docx'), { timeoutMs: 1 }), error => {
    assert.equal(error.code, 'OFFICE_CLEANUP_UNCONFIRMED');
    assert.equal(error.recovery, 'reconcile_original');
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.errors[0].code, 'OFFICE_TIMEOUT');
    assert.equal(error.cause.errors[1], lostReceipt);
    assert.equal(JSON.stringify(error).includes(lostReceipt.message), false);
    return true;
  });
});
