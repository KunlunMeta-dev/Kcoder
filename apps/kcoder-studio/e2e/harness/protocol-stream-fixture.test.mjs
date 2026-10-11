import assert from 'node:assert/strict';
import test from 'node:test';
import { protocolFrames, startProtocolStreamFixture } from './protocol-stream-fixture.mjs';
import { RunContext } from './run-context.mjs';

test('each declared protocol omits only its terminal sequence for EOF injection', () => {
  for (const [path, terminal] of [
    ['/v1/messages', 'message_stop'], ['/v1/chat/completions', '[DONE]'], ['/v1/responses', 'response.completed'],
  ]) {
    const completed = protocolFrames(path, 'fixture', false).join('');
    const truncated = protocolFrames(path, 'fixture', true).join('');
    assert.ok(completed.includes(terminal));
    assert.ok(!truncated.includes(terminal));
    assert.ok(truncated.includes('THINK_') && truncated.includes('TEXT_'));
  }
  assert.throws(() => protocolFrames('/unexpected', 'fixture', false));
});

test('owned HTTP fixture records no body or headers and closes its listener', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'protocol-fixture-cleanup' });
  try {
    const fixture = await startProtocolStreamFixture(context);
    const response = await fetch(`${fixture.baseUrl}/responses`, {
      method: 'POST', body: JSON.stringify({ model: 'fixture', input: 'FIXTURE_EOF' }),
    });
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes('response.completed'));
    assert.deepEqual(fixture.requests, [{ path: '/v1/responses', truncated: true }]);
    await context.finish('passed', { boundedFixture: true });
    await assert.rejects(fetch(`${fixture.baseUrl}/responses`));
  } finally {
    if (!context.finished) await context.finish('failed', null, new Error('fixture check failed'));
  }
});

test('text-only controls contain no upstream reasoning fields or blocks', () => {
  for (const path of ['/v1/messages', '/v1/chat/completions', '/v1/responses']) {
    const body = protocolFrames(path, 'fixture', false, false).join('');
    assert.doesNotMatch(body, /thinking|reasoning|THINK_/);
    assert.match(body, /TEXT_/);
    if (path === '/v1/messages') assert.doesNotMatch(body, /"index":1/);
  }
});
