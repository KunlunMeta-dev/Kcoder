import assert from 'node:assert/strict';
import test from 'node:test';
import { startWorkflowModelFixture } from './workflow-model.mjs';

test('workflow fixture gates the second mutation and rejects execution tools during generation', async () => {
  const cleanup = [];
  const fixture = await startWorkflowModelFixture({ registerPort() {}, addCleanup(_label, action) { cleanup.push(action); } });
  const user = { role: 'user', content: 'Use WorkflowDraft to build draft "fixture-id". Read its current revision first.' };
  const post = (messages, names = ['WorkflowDraft']) => fetch(`${fixture.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, tools: names.map(name => ({ type: 'function', function: { name } })) }),
    signal: AbortSignal.timeout(5000),
  });
  try {
    const initial = await post([user]);
    assert.match(await initial.text(), /WorkflowDraft/);
    const first = await post([user, { role: 'tool', content: JSON.stringify({ revision: 1, nodes: [] }) }]);
    assert.match(await first.text(), /upsert_node/);
    let completed = false;
    const waiting = post([user, { role: 'tool', content: JSON.stringify({ revision: 2, nodes: [{ id: 'A' }] }) }]).then(async response => { completed = true; return response.text(); });
    await fixture.firstNode;
    assert.equal(completed, false);
    fixture.releaseSecondNode();
    const second = await waiting;
    assert.match(second, /dependsOn/);
    const invalid = await post([user], ['WorkflowDraft', 'bash']);
    assert.equal(invalid.status, 500);
    await invalid.text();
    assert.equal(fixture.observations.at(-1).message, 'Generation exposed execution tools');
  } finally { for (const action of cleanup.reverse()) await action(); }
});
