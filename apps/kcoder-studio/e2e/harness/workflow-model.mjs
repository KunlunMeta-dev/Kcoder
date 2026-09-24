import { createServer } from 'node:http';

// Deterministic HTTP provider for graph/tool protocol coverage, not model quality.
export async function startWorkflowModelFixture(context) {
  const observations = [];
  let releaseSecond;
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  let reportFirst;
  const firstNode = new Promise(resolve => { reportFirst = resolve; });
  const active = new Set();
  let sequence = 0;
  const toolNames = body => (body.tools || []).map(tool => tool.function?.name || tool.name);
  const text = message => typeof message?.content === 'string' ? message.content
    : (message?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const result = message => { try { return JSON.parse(text(message)); } catch { return null; } };
  const node = (id, dependsOn = []) => ({ id, title: `Node ${id}`, prompt: `WF_NODE_${id}_WORK: return the requested result`,
    agentType: 'general', maxTurns: 4, dependsOn, position: { x: id === 'A' ? 40 : 380, y: 80 },
    allowedWritePaths: [], acceptanceCriteria: [], expectedArtifacts: [] });
  const server = createServer((request, response) => {
    const handler = (async () => {
      if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
      if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('Workflow fixture request too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (++sequence > 40) throw new Error('Workflow fixture request budget exceeded');
      const names = toolNames(body);
      const messages = body.messages || [];
      const users = messages.filter(message => message.role === 'user').map(text).join('\n');
      const last = [...messages].reverse().find(message => message.role === 'tool');
      const output = result(last);
      const reply = (content, name, input) => {
        const delta = name ? { tool_calls: [{ index: 0, id: `wf-fixture-${sequence}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } : { content };
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        for (const frame of [
          { id: `wf-${sequence}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
          { id: `wf-${sequence}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        ]) response.write(`data: ${JSON.stringify(frame)}\n\n`);
        response.end('data: [DONE]\n\n');
      };
      if (users.includes('Use WorkflowDraft to build draft') && !(names.length === 1 && names[0] === 'WorkflowDraft')) throw new Error('Generation exposed execution tools');
      if (names.length === 1 && names[0] === 'WorkflowDraft') {
        const id = users.match(/Use WorkflowDraft to build draft "([a-zA-Z0-9_-]+)"/)?.[1];
        if (!id) throw new Error('Workflow generation draft ID missing');
        observations.push({ kind: 'generation', names, id, nodeCount: output?.nodes?.length ?? null });
        if (!output?.nodes) return reply(null, 'WorkflowDraft', { action: 'read', id });
        if (!output.nodes.some(item => item.id === 'A')) return reply(null, 'WorkflowDraft', { action: 'upsert_node', id, expected_revision: output.revision, node: node('A') });
        if (!output.nodes.some(item => item.id === 'B')) {
          reportFirst();
          await Promise.race([secondGate, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Second node gate timed out')), 45000); timer.unref(); secondGate.then(() => clearTimeout(timer)); })]);
          return reply(null, 'WorkflowDraft', { action: 'upsert_node', id, expected_revision: output.revision, node: node('B', ['A']) });
        }
        return reply('WORKFLOW_GENERATION_DONE');
      }
      if (users.includes('WF_NODE_B_WORK')) {
        if (!users.includes('WF_NODE_A_RESULT')) throw new Error('Dependent node did not receive upstream output');
        observations.push({ kind: 'agent', node: 'B' }); return reply('WF_NODE_B_RESULT');
      }
      if (users.includes('WF_NODE_A_WORK')) {
        observations.push({ kind: 'agent', node: 'A' }); return reply('WF_NODE_A_RESULT');
      }
      const saved = users.match(/Run the saved workflow using Workflow with exactly (\{[^\n]+?\})\./)?.[1];
      if (saved) {
        const input = JSON.parse(saved);
        observations.push({ kind: 'saved-run', id: input.definition_id, version: input.version });
        if (!last) return reply(null, 'Workflow', input);
        if (output?.run_id && output?.status === 'running') return reply(null, 'TaskOutput', { task_id: output.run_id, block: true, timeout: 30000 });
        return reply('WORKFLOW_REUSE_DONE');
      }
      // Thin background completion may cause an additional aggregation request.
      observations.push({ kind: 'summary' });
      return reply('WORKFLOW_REUSE_DONE');
    })().catch(error => {
      observations.push({ kind: 'error', message: error.message });
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Workflow protocol fixture rejected the request' } }));
    });
    active.add(handler); void handler.finally(() => active.delete(handler));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  context.registerPort('workflow-model', port);
  context.addCleanup('close workflow HTTP fixture', async () => {
    releaseSecond(); const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections();
    await Promise.allSettled([...active]); await closed;
  });
  return { baseUrl: `http://127.0.0.1:${port}/v1`, firstNode, releaseSecondNode: () => releaseSecond(), observations };
}
