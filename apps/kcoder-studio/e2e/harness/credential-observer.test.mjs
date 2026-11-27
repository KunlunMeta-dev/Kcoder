import test from 'node:test';
import assert from 'node:assert/strict';
import { RunContext } from './run-context.mjs';
import { startApprovalModelFixture } from './approval-model.mjs';
import { startCredentialObserver } from './credential-observer.mjs';

test('observer records only authority labels and closes the owned listener', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'credential-observer-cleanup' });
  try {
    const fixture = await startApprovalModelFixture(context, { textOnly: true });
    const observer = await startCredentialObserver(context, fixture.baseUrl,
      { label: 'auth-fixture', oldKey: 'old-synthetic-key', newKey: 'new-synthetic-key' });
    for (const key of ['old-synthetic-key', 'new-synthetic-key']) {
      const response = await fetch(`${observer.endpoint}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fixture', messages: [] }),
      });
      assert.equal(response.status, 200); await response.text();
    }
    assert.deepEqual(observer.authentication, ['old', 'new']);
    assert.equal(fixture.requests.length, 2);
    await context.finish('passed', { redactedLabels: true });
    await assert.rejects(fetch(observer.endpoint));
  } finally { if (!context.finished) await context.finish('failed', null, new Error('observer verification failed')); }
});

test('observer rejects external destinations before allocating resources', async () => {
  await assert.rejects(startCredentialObserver({}, 'https://example.invalid', { label: 'invalid', oldKey: 'old', newKey: 'new' }), /owned loopback/);
});
