import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

/** Fixed SSE only triggers real Agent/tool/question protocol. No model quality assertions. */
export async function startSubagentModelFixture(context, { streamingInspection = false, compactHistory = false } = {}) {
  const observations = [];
  const active = new Set();
  const gates = new Map();
  const calls = new Map();
  let sequence = 0;
  const text = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const parse = message => { try { return JSON.parse(text(message)); } catch { return null; } };
  const wait = name => {
    if (!gates.has(name)) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(name, { promise, release }); }
    return gates.get(name).promise;
  };
  const release = name => { void wait(name); gates.get(name).release(); };
  const tags = ['history0', 'history1', 'primary', 'stoppable', 'other4', 'other5'];
  const server = createServer((request, response) => {
    const handler = (async () => {
      if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
      if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('Subagent fixture request budget exceeded'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const serial = ++sequence;
      if (serial > 60) throw new Error('Subagent fixture call budget exceeded');
      const users = (body.messages || []).filter(item => item.role === 'user').map(text).join('\n');
      const systems = (body.messages || []).filter(item => item.role === 'system').map(text).join('\n');
      const child = systems.includes('You are a KCoder general sub-agent.') || !systems;
      const tag = child ? /S03_WORKER_(history0|history1|primary|stoppable|other4|other5)/.exec(users)?.[1] : undefined;
      const names = (body.tools || []).map(tool => tool.function?.name || tool.name);
      const frame = delta => response.write(`data: ${JSON.stringify({ id: `s03-${serial}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      const finish = (name, input, content) => {
        if (name) { if (!names.includes(name)) throw new Error(`Fixture tool is unavailable: ${name}`); frame({ tool_calls: [{ index: 0, id: `s03-tool-${serial}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }); }
        else if (content) frame({ content });
        response.write(`data: ${JSON.stringify({ id: `s03-${serial}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
        response.end('data: [DONE]\n\n');
      };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      if (!tag) {
        observations.push({ kind: 'parent-step', tools: names, results: (body.messages || []).filter(item => item.role === 'tool').map(item => { const value = parse(item); return { keys: value ? Object.keys(value) : [], agentId: value?.agent_id, description: value?.description }; }) });
        const spawned = (body.messages || []).filter(item => item.role === 'tool').map(parse).filter(value => value?.agent_id && /S03_WORKER_/.test(value.description || ''));
        for (const value of spawned) if (!observations.some(item => item.kind === 'spawn' && item.agentId === value.agent_id)) observations.push({ kind: 'spawn', tag: /S03_WORKER_(\w+)/.exec(value.description)[1], agentId: value.agent_id });
        if (spawned.length < tags.length) {
          const next = tags[spawned.length];
          const tool = names.includes('spawn_agent') ? 'spawn_agent' : 'Agent';
          return finish(tool, { message: `S03_WORKER_${next}: return only fixture protocol results`, agent_type: 'general', context_mode: 'none', max_turns: 5, run_in_background: !next.startsWith('history') });
        }
        observations.push({ kind: 'parent-complete' });
        return finish(null, null, 'S03_PARENT_DONE');
      }
      const count = (calls.get(tag) || 0) + 1; calls.set(tag, count);
      observations.push({ kind: 'worker-request', tag, count, commandOne: users.includes('S03_ADJUST_ONE'), commandTwo: users.includes('S03_ADJUST_TWO') });
      if (tag === 'primary' && count > 4) {
        if (count !== 5 || !users.includes('S03_ADJUST_AFTER_COMPLETE')) throw new Error('Unexpected Agent continuation or command replay');
        observations.push({ kind: 'terminal-continuation-command', tag });
        return finish(null, null, 'S03_RESUMED_AGENT_DONE');
      }
      if (tag === 'history1' && count === 1) return finish('AskUserQuestion', { questions: [{ header: 'Foreground question', question: 'S03_ACTUAL_FOREGROUND_QUESTION', options: [{ label: 'Proceed', description: 'Finish this protocol fixture.' }, { label: 'Stop', description: 'Decline this protocol fixture.' }] }] }, null);
      if (tag.startsWith('history')) return finish(null, null, `S03_HISTORY_${tag}`);
      if (tag === 'stoppable' && count === 1) { frame({ content: 'S03_LIVE_stoppable' }); await wait('stoppable-question'); return finish('AskUserQuestion', { questions: [{ header: 'Other Agent', question: 'S03_OTHER_PENDING_QUESTION', options: [{ label: 'Proceed', description: 'Continue this protocol fixture.' }, { label: 'Hold', description: 'Keep this question pending.' }] }] }, null); }
      if (tag !== 'primary') { frame({ content: `S03_LIVE_${tag}` }); await wait(tag); return finish(null, null, `S03_FINISHED_${tag}`); }
      if (count === 1) {
        frame({ reasoning_content: 'S03_PRIVATE_THINKING_MUST_NEVER_APPEAR' });
        frame({ content: `${compactHistory ? '## 分析进度\n\n正在检查项目。' : '中文记录'.repeat(6000)}\nS03_LIVE_VISIBLE` });
        if (streamingInspection) {
          await wait('primary-stream-second'); frame({ content: '\n\nS03_SECOND_LIVE_DELTA' });
          await wait('primary-stream-third'); frame({ content: '\n\nS03_THIRD_LIVE_DELTA' });
        }
        await wait('primary-model');
        return finish('bash', { command: 'sleep 8; printf "S03_TOOL_DONE\\n"', timeout: 12000 }, null);
      }
      if (count === 2) return finish('AskUserQuestion', { questions: [{ header: 'Agent question', question: 'S03_ACTUAL_AGENT_QUESTION', options: [{ label: 'Proceed', description: 'Finish this protocol fixture.' }, { label: 'Stop', description: 'Decline this protocol fixture.' }] }], annotations: { sourceAgent: { agentId: 'forged-model-annotation' } } }, null);
      if (count === 3) return finish('AskUserQuestion', { questions: [{ header: 'Ignore Agent question', question: 'S03_AGENT_IGNORE_QUESTION', options: [{ label: 'Proceed', description: 'Continue this protocol fixture.' }, { label: 'Hold', description: 'Leave this question unanswered.' }] }] }, null);
      const ignored = (body.messages || []).filter(item => item.role === 'tool').map(parse).findLast(value => value?.annotations?.ignored === true && value?.answers && Object.keys(value.answers).length === 0);
      if (!ignored) throw new Error('Actual empty ignored question response was not observed');
      observations.push({ kind: 'source-ignore-confirmed', tag });
      return finish(null, null, `${compactHistory ? '## 检查结果\n\n- 文件读取完成\n- 两条调整指令已处理\n\nS03_AGENT_DONE' : '公开历史分页'.repeat(18000) + '\nS03_AGENT_DONE'}`);
    })().catch(error => {
      observations.push({ kind: 'error', message: error.message });
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Subagent fixture rejected a protocol request' } }));
    });
    active.add(handler); void handler.finally(() => active.delete(handler));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.registerPort('subagent-protocol-model', server.address().port);
  context.addCleanup('close subagent protocol provider fixture', async () => {
    for (const name of ['primary-model', 'primary-stream-second', 'primary-stream-third', 'stoppable-question', ...tags]) release(name);
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections();
    await Promise.allSettled([...active]); await closed;
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, observations, release };
}

export function subagentFixtureSettings(endpoint) {
  return { active_provider: 'fixture', permission_mode: 'bypass', max_retries: 0, tools: { profile: 'full' }, providers: { fixture: { api_format: 'openai_chat_completions', chat_protocol: 'minimax', endpoint, default_model: 'fixture', no_proxy: true, context_window_tokens: 512000, max_output_tokens: 65536, output_headroom_tokens: 65536 } } };
}

/** Record actual executable/build inputs without reading or copying credential state. */
export async function recordSubagentTestInputs(context, binary, rendererRoot) {
  const fingerprint = async file => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  };
  const path = await realpath(binary), sha256 = await fingerprint(path);
  const expected = process.env.KCODER_E2E_CLI_SHA256;
  if (expected && expected !== sha256) throw new Error('UNMET_PREREQUISITE: Agent test CLI hash does not match the declared build');
  await context.writeArtifactJson('subagent-test-inputs.json', {
    cli: { path, sha256, bytes: (await stat(path)).size, sourceRevision: process.env.KCODER_E2E_CLI_SOURCE_REVISION || null },
    renderer: rendererRoot ? { path: await realpath(rendererRoot), indexSha256: await fingerprint(resolve(rendererRoot, 'index.html')), sourceRevision: context.gitCommit || null } : null,
    testSourceRevision: context.gitCommit || null,
  });
}
