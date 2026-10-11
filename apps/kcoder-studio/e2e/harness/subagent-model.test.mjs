import assert from 'node:assert/strict';
import test from 'node:test';
import { startSubagentModelFixture } from './subagent-model.mjs';

test('subagent protocol fixture gates real stream and tools and cleans its owned listener', async () => {
  const cleanup = [], ports = [];
  const fixture = await startSubagentModelFixture({ registerPort(_label, port) { ports.push(port); }, addCleanup(_label, action) { cleanup.push(action); } });
  const post = (message, tools = ['spawn_agent', 'bash', 'AskUserQuestion']) => fetch(`${fixture.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: message }], tools: tools.map(name => ({ type: 'function', function: { name } })) }), signal: AbortSignal.timeout(5000),
  });
  try {
    assert.equal(ports.length, 1); assert.ok(ports[0] > 0);
    const parent = await post('S03_START');
    assert.match(await parent.text(), /S03_WORKER_history0/);
    const live = await post('S03_WORKER_primary');
    let completed = false;
    const body = live.text().then(value => { completed = true; return value; });
    assert.equal(completed, false);
    fixture.release('primary-model');
    assert.match(await body, /S03_LIVE_VISIBLE/);
    const question = await post('S03_WORKER_primary S03_ADJUST_ONE S03_ADJUST_TWO');
    assert.match(await question.text(), /S03_ACTUAL_AGENT_QUESTION/);
    assert.deepEqual(fixture.observations.filter(value => value.tag === 'primary').map(value => [value.commandOne, value.commandTwo]), [[false, false], [true, true]]);
  } finally { for (const action of cleanup.reverse()) await action(); }
  await assert.rejects(post('S03_START'));
});
