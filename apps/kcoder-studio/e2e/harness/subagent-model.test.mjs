import assert from 'node:assert/strict';
import test from 'node:test';
import { startSubagentModelFixture } from './subagent-model.mjs';

test('progress inspection releases fresh model deltas separately before and after selection', async () => {
  const cleanup = [];
  const fixture = await startSubagentModelFixture({ registerPort() {}, addCleanup(_label, action) { cleanup.push(action); } },
    { progressInspection: true, compactHistory: true });
  try {
    const response = await fetch(`${fixture.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'S03_WORKER_primary' }], tools: [{ function: { name: 'bash' } }] }),
    });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '';
    const until = async marker => {
      while (!text.includes(marker)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, `stream ended before ${marker}`);
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    await until('S03_LIVE_VISIBLE');
    assert.ok(!text.includes('S03_UNSELECTED_PROGRESS'));
    fixture.release('primary-stream-unselected');
    await until('S03_UNSELECTED_PROGRESS');
    assert.ok(!text.includes('S03_SELECTED_PROGRESS'));
    fixture.release('primary-stream-selected');
    await until('S03_SELECTED_PROGRESS');
    fixture.release('primary-model');
    await until('[DONE]');
  } finally { for (const action of cleanup.reverse()) await action(); }
});

test('subagent protocol fixture gates real stream and tools and cleans its owned listener', async () => {
  const cleanup = [], ports = [];
  const fixture = await startSubagentModelFixture({ registerPort(_label, port) { ports.push(port); }, addCleanup(_label, action) { cleanup.push(action); } });
  const post = (message, results = []) => fetch(`${fixture.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: message }, ...results.map(value => ({ role: 'tool', content: JSON.stringify(value) }))], tools: ['spawn_agent', 'bash', 'AskUserQuestion', 'AskUserQuestionAsync'].map(name => ({ type: 'function', function: { name } })) }), signal: AbortSignal.timeout(5000),
  });
  try {
    assert.equal(ports.length, 1); assert.ok(ports[0] > 0);
    const parent = await post('S03_START');
    assert.match(await parent.text(), /S03_WORKER_history0/);
    assert.match(await (await post('S03_START', [{ agent_id: 'history-child', description: 'S03_WORKER_history1', result: 'S03_ESCALATE_FOREGROUND' }])).text(), /S03_ACTUAL_FOREGROUND_QUESTION/);
    const live = await post('S03_WORKER_primary');
    let completed = false;
    const body = live.text().then(value => { completed = true; return value; });
    assert.equal(completed, false);
    fixture.release('primary-model');
    assert.match(await body, /S03_LIVE_VISIBLE/);
    fixture.release('primary-guidance');
    const question = await post('S03_WORKER_primary S03_ADJUST_ONE S03_ADJUST_TWO');
    assert.match(await question.text(), /S03_ACTUAL_AGENT_QUESTION/);
    const guidance = { accepted: false, status: 'parent_agent_required', message: 'Report the blocker to the parent agent.' };
    assert.match(await (await post('S03_WORKER_primary S03_ADJUST_ONE S03_ADJUST_TWO', [guidance])).text(), /AskUserQuestionAsync/);
    assert.match(await (await post('S03_WORKER_primary S03_ADJUST_ONE S03_ADJUST_TWO', [guidance])).text(), /S03_AGENT_DONE/);
    assert.deepEqual(fixture.observations.filter(value => value.kind === 'child-question-guidance').map(value => value.tool), ['AskUserQuestion', 'AskUserQuestionAsync']);
    assert.deepEqual(fixture.observations.filter(value => value.tag === 'primary' && value.kind === 'worker-request').map(value => [value.commandOne, value.commandTwo]), [[false, false], [true, true], [true, true], [true, true]]);
  } finally { for (const action of cleanup.reverse()) await action(); }
  await assert.rejects(post('S03_START'));
});

test('child question fixture rejects human answers and invented acceptance receipts', async () => {
  for (const result of [
    { accepted: true, questionId: 'invented' },
    { accepted: false, status: 'parent_agent_required', message: 'Ask the parent agent.', answers: {} },
    { accepted: false, status: 'parent_agent_required', message: 'Ask the parent agent.', questionId: 'invented' },
  ]) {
    const cleanup = [];
    const fixture = await startSubagentModelFixture({ registerPort() {}, addCleanup(_label, action) { cleanup.push(action); } });
    const post = results => fetch(`${fixture.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'S03_WORKER_history1' }, ...results], tools: [{ function: { name: 'AskUserQuestion' } }] }),
    });
    try {
      await (await post([])).text();
      await (await post([{ role: 'tool', content: JSON.stringify(result) }])).text();
      assert.ok(fixture.observations.some(value => value.kind === 'error' && value.message.includes('non-interactive parent guidance')));
    } finally { for (const action of cleanup.reverse()) await action(); }
  }
});
