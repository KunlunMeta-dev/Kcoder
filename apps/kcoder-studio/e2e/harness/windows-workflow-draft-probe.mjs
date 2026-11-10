import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';
import { runWindowsTaskViewHandoff } from './windows-task-view-handoff.mjs';

/** Runs under the package probe's owned Windows Job; never touches personal tasks. */
export async function runWindowsWorkflowDraftProbe({ binary, root, environment, installation }) {
  const workspace = join(root, 'workflow-workspace'), profile = join(root, 'workflow-profile');
  for (const directory of [workspace, profile]) await mkdir(directory, { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), 'Owned workflow protocol fixture. Do not read parent directories.\n');
  const observations = [], errors = [];
  let definition, requestCount = 0, detachedCase = false;
  let slowRequest;
  const provider = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture', object: 'model' }] }));
        return;
      }
      let body = '', bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 * 1024); body += chunk; }
      const value = JSON.parse(body);
      assert.ok(++requestCount <= 8, 'Bounded deterministic protocol requests');
      observations.push({ stage: requestCount, atMs: Date.now(), detachedCase });
      if (detachedCase) { slowRequest(response); return; }
      if (requestCount <= 3) await delay(20000);
      const actions = [
        [{ action: 'read' }, { action: 'collaboration_presets' }],
        [{ action: 'help', node_kind: 'code' }, { action: 'help', node_kind: 'agent' }],
        [{ action: 'help', node_kind: 'input' }, { action: 'help', node_kind: 'switch' }],
        [{ action: 'upsert_node', expected_revision: definition.revision,
          node: { id: 'owned-output', title: 'Owned unexecuted node', kind: 'agent',
            agentType: 'general', prompt: 'Owned node, never execute during authoring.',
            maxTurns: 1, dependsOn: [], position: { x: 0, y: 0 }, config: {} } }],
      ];
      let delta = { role: 'assistant', content: 'OWNED_DRAFT_AUTHORING_COMPLETE' }, finish = 'stop';
      if (requestCount <= actions.length) {
        const names = (value.tools ?? []).map(tool => tool.function?.name);
        assert.ok(names.includes('WorkflowDraft'), 'Actual authoring registry required');
        delta = { role: 'assistant', tool_calls: actions[requestCount - 1].map((args, index) => ({ index,
          id: `owned-draft-${requestCount}-${index}`, type: 'function',
          function: { name: 'WorkflowDraft', arguments: JSON.stringify({ ...args, id: definition.id }) } })) };
        finish = 'tool_calls';
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n' +
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n');
    } catch (error) { errors.push(`${request.method}: ${error.message}`); response.writeHead(400); response.end('Owned protocol fixture rejected request'); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ credential_store: 'file',
    permission_mode: 'bypass', max_retries: 0, session_memory: { enabled: false },
    active_provider: 'workflowFixture', model: 'fixture', mcp_servers: [],
    tools: { luna: { allowed: ['WorkflowDraft'] } },
    providers: { workflowFixture: { api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
      authentication: { mode: 'none' }, discover_models: false, default_model: 'fixture',
      context_window_tokens: 128000, max_output_tokens: 2048, output_headroom_tokens: 4096 } } }));
  const child = spawn(binary, ['--cwd', workspace, 'app-server'], { cwd: workspace,
    env: { ...environment, KCODER_CONFIG_DIR: profile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-4096); });
  const client = new AppServerStdioClient('owned-workflow-draft', child, { notificationHistoryLimit: 256 });
  const rpc = async (method, params) => {
    const reply = await client.request(method, params, 30000);
    assert.ok(!reply.error, `${method}: ${reply.error?.message}`); return reply.result;
  };
  const handle = { clientId: randomUUID(), generation: randomUUID() };
  let renewal;
  try {
    const init = await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-workflow-draft', version: '1' },
      capabilities: { experimental: { sessionLifetimeV1: true, workflowCanvasV1: true, workflowGraphV2: true, studioWorkModesV1: true } } });
    assert.equal(init.capabilities?.experimental?.sessionLifetimeV1, true);
    definition = await rpc('workflow/create', { title: 'Owned Windows authoring' });
    const { thread } = await rpc('thread/start', { cwd: workspace, sessionMode: 'workflow_draft', workflowDefinitionId: definition.id });
    await rpc('thread/attach', { threadId: thread.id, ...handle });
    renewal = setInterval(() => { void rpc('thread/attach', { threadId: thread.id, ...handle }).catch(error => errors.push(error.message)); }, 20000);
    const started = Date.now();
    const { turn } = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Run the owned authoring protocol without executing nodes.' }] });
    const completed = await client.waitForNotification(frame => frame.method === 'turn/completed' && frame.params.threadId === thread.id && frame.params.turn.id === turn.id, 90000);
    assert.equal(completed.params.turn.status, 'completed', JSON.stringify({ errors, diagnostic }));
    const draft = await rpc('workflow/read', { id: definition.id });
    const toolCompletions = client.notificationHistory.filter(frame => frame.method === 'item/completed' && frame.params?.item?.type === 'toolCall');
    assert.equal(toolCompletions.length, 7);
    assert.ok(toolCompletions.every(frame => frame.params.item.status === 'completed'),
      'All six original read/help actions and the write must succeed: ' + JSON.stringify(toolCompletions.map(frame => ({ id: frame.params.item.id, status: frame.params.item.status, output: frame.params.item.output }))));
    assert.equal(draft.nodes.length, 1, 'Actual WorkflowDraft must persist its node');
    assert.equal(draft.nodes[0].id, 'owned-output');
    const authoringMs = Date.now() - started;
    assert.ok(authoringMs >= 60000, 'The attached authoring turn must survive beyond the original 55-second boundary');
    detachedCase = true;
    clearInterval(renewal); renewal = undefined;
    const startHeldTurn = async text => {
      const waiting = new Promise(resolve => { slowRequest = resolve; });
      const { turn } = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text }] });
      let timer;
      const response = await Promise.race([waiting, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Owned slow model was not called')), 20000);
      })]).finally(() => clearTimeout(timer));
      return { turn, finish() {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'OWNED_HANDOFF_COMPLETE' }, finish_reason: null }] }) + '\n\n' +
          'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      } };
    };
    const handoff = await runWindowsTaskViewHandoff({ root, installation, init, rpc, client, thread, mainHandle: handle, startHeldTurn });
    assert.deepEqual(errors, []);
    return { passed: true, actualWindowsNative: true, sixOriginalQueriesSucceeded: true, actualNodePersisted: true,
      authoringMs, toolResults: toolCompletions.length, detachmentDoesNotStopExecution: true,
      ...handoff,
      observations, realModelRequests: 0, guiAcceptance: false,
      scope: 'Isolated deterministic Windows protocol and lifecycle; does not establish the historical stop initiator or real-model planning quality.' };
  } catch (error) {
    throw new Error(`${error.message}\nNative diagnostic: ${diagnostic.slice(-500)}`);
  } finally {
    clearInterval(renewal); provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    child.stdin.end();
    try { await waitForStdioChildClose(child, 10000); } finally { client.closeReader(); }
  }
}
