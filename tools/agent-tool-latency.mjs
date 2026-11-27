// Measure installed CLI tool round trips with deterministic loopback providers.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createRunContext, verifyRunContextIntegrity } from './tui-lab/lib/run-context.mjs';
import { auditCases } from './kcoder-tool-audit-cases.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rounds = Number(process.env.AGENT_BENCH_ROUNDS || 5);
const consentIndex = process.argv.indexOf('--consent');
const externalConsent = consentIndex >= 0 && process.argv[consentIndex + 1] === 'external-provider' && process.env.KCODER_TEST_SEARCH_EXTERNAL === '1';
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('rounds must be 1..10');
const layout = await createRunContext({
  description: 'installed-agent-tool-latency', scenario: 'tool-latency',
  workspaceTemplate: path.join(repo, 'tests/fixtures/minimal'),
  out: path.join(repo, 'target/test/agent-tool-latency'),
}, 'agent-tools', { cwd: repo, now: new Date(), pid: process.pid, platform: process.platform });
const root = layout.dir;
const workspace = layout.workspace;
const cleanEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'SHELL']
  .filter(k => process.env[k]).map(k => [k, process.env[k]]));
cleanEnv.NO_PROXY = '127.0.0.1,localhost';
cleanEnv.KCODER_E2E_REAL_MODEL = '0';
cleanEnv.DISABLE_TELEMETRY = '1';
cleanEnv.DISABLE_ERROR_REPORTING = '1';
const binaries = Object.fromEntries(['claude', 'codex', 'kcoder'].map(name => {
  const executable = process.env[`AGENT_BENCH_${name.toUpperCase()}_BIN`] || name;
  const found = spawnSync('which', [executable], { encoding: 'utf8', env: cleanEnv });
  if (found.status !== 0) throw new Error(`${name} unavailable`);
  return [name, found.stdout.trim()];
}));
const versions = Object.fromEntries(Object.entries(binaries).map(([name, bin]) =>
  [name, spawnSync(bin, ['--version'], { encoding: 'utf8', env: cleanEnv, timeout: 10000 }).stdout.trim()]));
await mkdir(path.join(workspace, 'corpus'));
const marker = 'AGENT_BENCH_NEEDLE_3F27';
await writeFile(path.join(workspace, 'fixture.txt'), Array.from({ length: 200 }, (_, i) =>
  `line ${String(i + 1).padStart(4, '0')} ${i === 199 ? 'AGENT_BENCH_READ_END' : 'fixed benchmark content'}`).join('\n') + '\n');
for (let round = 0; round <= rounds; round++) await writeFile(path.join(workspace, `fixture-${round}.txt`), await readFile(path.join(workspace, 'fixture.txt')));
for (let i = 0; i < 256; i++) await writeFile(path.join(workspace, 'corpus', `file-${i}.txt`),
  Array.from({ length: 64 }, (_, n) => i === 127 && n === 31 ? marker : `record ${i} ${n} fixed corpus data`).join('\n') + '\n');
const scripts = { python: 'print("AGENT_BENCH_PYTHON_OK")\n', javascript: 'console.log("AGENT_BENCH_JS_OK");\n' };
await writeFile(path.join(workspace, 'fixture.py'), scripts.python);
await writeFile(path.join(workspace, 'fixture.js'), scripts.javascript);
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const categories = (process.env.AGENT_BENCH_CATEGORIES || 'shell_noop,shell_read,shell_search,native_read,native_search,native_write,python,javascript').split(',');
const states = new Map();
const processes = new Map();
const results = [];
const baseline = [];
let server;

function commandFor(category, agent, round) {
  return ({ shell_noop: 'printf AGENT_BENCH_SHELL_OK', shell_read: 'sed -n 1,200p fixture.txt',
    long_shell: 'printf AGENT_BENCH_STARTED; sleep 10; printf AGENT_BENCH_SHELL_OK',
    shell_search: `rg --no-heading --color never -n ${marker} corpus`,
    native_read: 'sed -n 1,200p fixture.txt', native_search: `rg --no-heading --color never -n ${marker} corpus`,
    native_write: `printf AGENT_BENCH_WRITE_OK > ${quote(`${agent}-${round}.txt`)}`,
    python: 'python3 fixture.py', javascript: 'bun run fixture.js',
    python_shell: 'python3 fixture.py', javascript_shell: 'bun run fixture.js' })[category];
}

function buildCall(state, request, category, round) {
  const names = (request.tools || []).map(t => t.name || t.function?.name).filter(Boolean);
  state.toolNames ||= names;
  const entry = state.plan[state.index - 1];
  if (entry.rawName) return { id: `bench_${state.agent}_${state.index}`, name: entry.rawName,
    input: typeof entry.rawInput === 'function' ? entry.rawInput(state) : entry.rawInput,
    category, round, mode: entry.mode };
  const pick = (...candidates) => candidates.find(n => names.includes(n));
  let name, input;
  if (category === 'native_read' && (name = pick('Read', 'read'))) {
    input = { file_path: path.join(workspace, `fixture-${round}.txt`), offset: 1, limit: 200 };
  } else if (category === 'native_search' && (name = pick('Grep', 'grep'))) {
    input = { pattern: marker, path: path.join(workspace, 'corpus'), output_mode: 'content' };
  } else if (category === 'native_write' && (name = pick('Write', 'write'))) {
    input = { file_path: path.join(workspace, `${state.agent}-${round}.txt`), content: 'AGENT_BENCH_WRITE_OK' };
  } else if (['python', 'javascript'].includes(category) && (name = pick('REPL'))) {
    input = { language: category, code: scripts[category] + `${category === 'python' ? '#' : '//'} benchmark sample ${round}\n`, timeout: 10 };
  } else {
    name = pick('Bash', 'bash', 'exec_command', 'shell_command', 'shell');
    const command = commandFor(category, state.agent, round);
    const timeoutMs = category === 'long_shell' ? 30000 : 10000;
    if (name === 'exec_command') input = { cmd: command, workdir: workspace, yield_time_ms: 1000, max_output_tokens: 6000 };
    else if (name === 'shell_command') input = { command, workdir: workspace, timeout_ms: timeoutMs };
    else if (name === 'shell') input = { command: ['/bin/bash', '-lc', command], workdir: workspace, timeout_ms: timeoutMs };
    else input = { command, timeout: timeoutMs };
  }
  if (!name) throw new Error(`No callable tool for ${state.agent}; available: ${names.join(',')}`);
  return { id: `bench_${state.agent}_${state.index}`, name, input, category, round };
}

function toolResults(request, protocol) {
  if (protocol === 'responses') return (request.input || []).filter(i => i.type === 'function_call_output')
    .map(i => ({ id: i.call_id, text: typeof i.output === 'string' ? i.output : JSON.stringify(i.output) }));
  if (protocol === 'chat') return (request.messages || []).filter(i => i.role === 'tool')
    .map(i => ({ id: i.tool_call_id, text: typeof i.content === 'string' ? i.content : JSON.stringify(i.content) }));
  return (request.messages || []).flatMap(i => Array.isArray(i.content) ? i.content : [])
    .filter(i => i.type === 'tool_result').map(i => ({ id: i.tool_use_id, text: JSON.stringify(i.content), error: i.is_error }));
}

function sse(res, events) {
  let data = events.map(([type, body]) => `${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(body)}\n\n`).join('');
  if (events[0]?.[1]?.object === 'chat.completion.chunk') data += 'data: [DONE]\n\n';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function reply(res, state, call) {
  const usage = { input_tokens: 100, output_tokens: 20 };
  if (state.protocol === 'anthropic') {
    const block = call ? { type: 'tool_use', id: call.id, name: call.name, input: {} } : { type: 'text', text: '' };
    sse(res, [
      ['message_start', { type: 'message_start', message: { id: `msg_${state.index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, usage } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } : { type: 'text_delta', text: 'BENCH_DONE' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }],
      ['message_stop', { type: 'message_stop' }],
    ]);
  } else if (state.protocol === 'chat') {
    const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { content: 'BENCH_DONE' };
    sse(res, [[null, { id: `chat_${state.index}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }],
      [null, { id: `chat_${state.index}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }]]);
  } else {
    const item = call ? { id: `fc_${state.index}`, type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.input), status: 'completed' }
      : { id: `msg_${state.index}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'BENCH_DONE', annotations: [] }] };
    const response = { id: `resp_${state.index}`, object: 'response', model: 'gpt-5.4', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    const events = [['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: call ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } }]];
    if (call) events.push(['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments }]);
    else events.push(['response.content_part.added', { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
      ['response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'BENCH_DONE' }]);
    events.push(['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }], ['response.completed', { type: 'response.completed', response }]);
    sse(res, events);
  }
}

async function handle(req, res) {
  const received = performance.now();
  const agent = req.url.split('/')[1];
  const state = states.get(agent);
  if (!state || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new Error('request bound'); chunks.push(chunk); }
  const request = JSON.parse(Buffer.concat(chunks));
  if (!request.tools?.length) { reply(res, state, null); return; }
  if (!state.catalog) {
    state.catalog = request.tools;
    await writeFile(path.join(root, `${agent}-tools.json`), JSON.stringify(request.tools, null, 2));
    if (state.audit) {
      if (process.env.AGENT_BENCH_REPL === '1') {
        state.plan = [];
        for (const language of ['python', 'javascript', 'shell']) {
          const small = language === 'python' ? 'print("REPL_SMALL_OK")' : language === 'javascript' ? 'console.log("REPL_SMALL_OK")' : 'printf REPL_SMALL_OK';
          const large = language === 'python' ? 'print("x" * (4 * 1024 * 1024))' : language === 'javascript' ? 'process.stdout.write("x".repeat(4 * 1024 * 1024))' : 'head -c 4194304 /dev/zero | tr "\\000" x';
          const progress = language === 'python' ? 'import time\nprint("REPL_EARLY", flush=True)\ntime.sleep(0.5)\nprint("REPL_LATE")' : language === 'javascript' ? 'console.log("REPL_EARLY"); await new Promise(r => setTimeout(r, 500)); console.log("REPL_LATE");' : 'printf REPL_EARLY; sleep 0.5; printf REPL_LATE';
          const orphan = language === 'python' ? 'import subprocess,sys\nsubprocess.Popen([sys.executable,"-c","import time; time.sleep(1)"],stdin=subprocess.DEVNULL)\nprint("REPL_PARENT_EXIT")' : language === 'javascript' ? 'const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]}); c.unref(); console.log("REPL_PARENT_EXIT");' : 'sleep 1 & printf REPL_PARENT_EXIT';
          const selected = process.env.AGENT_BENCH_REPL_VARIANTS?.split(',');
          for (const [variant, code] of [['small',small],['output_4mib',large],['progress_500ms',progress],['orphan_pipe1000ms',orphan]]) {
            if (selected && !selected.includes(variant)) continue;
            for (let round = 0; round < 3; round++) state.plan.push({ rawName: 'REPL', rawInput: { language, code, timeout: 5 }, category: `REPL:${language}:${variant}`, round, mode: 'execution' });
          }
        }
        state.blocked = [];
      } else {
        const audit = auditCases({ workspace, root, catalog: request.tools, externalConsent });
        state.plan = audit.plan; state.blocked = audit.blocked;
      }
    }
  }
  if (state.pending && !toolResults(request, state.protocol).some(r => r.id === state.pending.id)) {
    state.childRequests = (state.childRequests || 0) + 1;
    reply(res, state, null); return;
  }
  if (state.pending) {
    const result = toolResults(request, state.protocol).find(r => r.id === state.pending.id);
    if (!result) throw new Error(`${agent} missing result ${state.pending.id}`);
    const call = state.pending;
    let valid = !result.error && !/unknown tool|permission denied|not allowed|execution failed|tool.*failed|invalid.*input/i.test(result.text);
    if (state.audit) {
      const text = result.text;
      let data; try { data = JSON.parse(text); if (typeof data === 'string') data = JSON.parse(data); } catch {}
      if (call.name === 'TaskCreate') state.ids.task = data?.task?.id;
      if (call.name === 'spawn_agent') state.ids.agent = data?.agent_id;
      if (call.mode === 'background_setup') state.ids.shell = data?.task_id;
    } else if (call.category === 'native_write') valid &&= (await readFile(path.join(workspace, `${agent}-${call.round}.txt`), 'utf8')) === 'AGENT_BENCH_WRITE_OK';
    else if (!state.audit) valid &&= result.text.includes(call.category.includes('read') ? 'AGENT_BENCH_READ_END' : call.category.includes('search') ? marker : call.category.startsWith('python') ? 'AGENT_BENCH_PYTHON_OK' : call.category.startsWith('javascript') ? 'AGENT_BENCH_JS_OK' : 'AGENT_BENCH_SHELL_OK');
    const row = { agent, category: call.category, round: call.round, tool: call.name, ms: received - state.dispatched, valid, output_bytes: Buffer.byteLength(result.text) };
    state.samples.push(row);
    if (state.audit) {
      row.output_preview = result.text.slice(0, 1600); row.mode = call.mode; row.input = call.input;
      if (state.samples.length % 10 === 0) console.log(`AUDIT ${state.samples.length}/${state.plan.length} ${call.name} ${row.ms.toFixed(1)}ms`);
    }
    if (!valid && !state.audit) { state.failure = `Invalid result ${call.id}: ${result.text.slice(0,500)}`; throw new Error(state.failure); }
    state.pending = null;
  } else if (state.firstRequest === undefined) state.firstRequest = received - state.started;
  const entry = state.plan[state.index++];
  const call = entry ? buildCall(state, request, entry.category, entry.round) : null;
  state.pending = call;
  reply(res, state, call);
  state.dispatched = performance.now();
}

async function runOwned(argv, env, logName, timeoutMs = 90000) {
  if (process.env.AGENT_BENCH_TRACE === '1') argv = ['strace', '-f', '-ttt', '-T', '-e', 'trace=openat,getdents64,kill,execve', '-o', path.join(root, `${logName}.strace`), ...argv];
  const child = spawn(argv[0], argv.slice(1), { cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.set(child.pid, child);
  let stdout = '', stderr = '', exceeded = false;
  let lineBuffer = '';
  const timeline = [];
  const timer = setTimeout(() => { exceeded = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
  child.stdout.on('data', b => {
    stdout += b; lineBuffer += b;
    const lines = lineBuffer.split('\n'); lineBuffer = lines.pop();
    for (const line of lines) try {
      const event = JSON.parse(line);
      if (timeline.length < 3000) timeline.push({ at_ms: performance.now(), type: event.type, id: event.id, name: event.name, is_error: event.is_error, contains_early: typeof event.text === 'string' && event.text.includes('REPL_EARLY') });
    } catch {}
    if (stdout.length > 8*1024*1024) child.kill('SIGKILL');
  });
  child.stderr.on('data', b => { stderr += b; if (stderr.length > 1024*1024) child.kill('SIGKILL'); });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  processes.delete(child.pid);
  await writeFile(path.join(root, `${logName}.stdout.jsonl`), stdout);
  await writeFile(path.join(root, `${logName}.stderr.log`), stderr);
  await writeFile(path.join(root, `${logName}.timeline.json`), JSON.stringify(timeline, null, 2));
  return { code, exceeded, tail: stderr.slice(-1600), done: stdout.includes('BENCH_DONE') };
}

try {
  server = http.createServer((req, res) => handle(req, res).catch(error => {
    const state = states.get(req.url.split('/')[1]); if (state) state.failure = String(error);
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: String(error) } }));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(root, 'meta.json'), JSON.stringify({ versions, binaries, rounds, workspace, externalConsent, fixture: { files: 256, lines_per_file: 64 }, policy: 'loopback deterministic provider; no real model or credentials', cpu: os.cpus()[0]?.model, load: os.loadavg() }, null, 2));
  for (const category of ['shell_noop','shell_read','shell_search','python','javascript']) for (let round = 0; round <= rounds; round++) {
    const before = performance.now();
    const output = spawnSync('/bin/bash', ['-lc', commandFor(category, 'baseline', round)], { cwd: workspace, env: cleanEnv, encoding: 'utf8', timeout: 10000 });
    baseline.push({ category, round, ms: performance.now() - before, valid: output.status === 0 });
  }
  for (const agent of (process.env.AGENT_BENCH_AGENTS || 'kcoder,claude,codex').split(',')) {
    const config = path.join(root, `${agent}-config`); await mkdir(config, { mode: 0o700 });
    const env = { ...cleanEnv, XDG_CACHE_HOME: path.join(config, 'cache'), TMPDIR: config };
    const plan = Array.from({ length: rounds + 1 }, (_, round) => categories.map(category => ({ round, category }))).flat();
    if (agent === 'kcoder' && !process.env.AGENT_BENCH_CATEGORIES) for (let round = 0; round <= rounds; round++) for (const category of ['python_shell', 'javascript_shell']) plan.push({ round, category });
    const state = { agent, audit: process.env.AGENT_BENCH_AUDIT === '1', ids: {}, protocol: agent === 'claude' ? 'anthropic' : agent === 'codex' ? 'responses' : 'chat', plan, index: 0, pending: null, samples: [], started: performance.now() };
    states.set(agent, state);
    let argv;
    const prompt = 'Execute the benchmark tools exactly as supplied; use only the isolated fixture workspace.';
    if (agent === 'kcoder') {
      env.KCODER_CONFIG_DIR = config;
      await writeFile(path.join(config, 'settings.json'), JSON.stringify({ active_provider: 'benchmark', permission_mode: 'yolo', max_retries: 0, providers: { benchmark: { api_format: 'openai_chat_completions', endpoint: `${base}/kcoder/v1`, default_model: 'benchmark', context_window_tokens: 1000000, output_headroom_tokens: 512, max_output_tokens: 4096, no_proxy: true } }, sandbox: { enabled: false } }));
      await writeFile(path.join(config, 'credentials.json'), JSON.stringify({ benchmark: { type: 'api', key: 'local-fixture-not-a-secret' } }));
      if (state.audit) {
        const settings = JSON.parse(await readFile(path.join(config, 'settings.json'), 'utf8'));
        settings.tool_timeout_ms = 30000;
        await writeFile(path.join(config, 'settings.json'), JSON.stringify(settings));
        await mkdir(path.join(config, 'skills/benchmark-latency'), { recursive: true });
        await writeFile(path.join(config, 'skills/benchmark-latency/SKILL.md'), '---\nname: benchmark-latency\ndescription: Synthetic benchmark only.\n---\nRead the isolated fixture only.\n');
        await writeFile(path.join(workspace, 'edit-fixture.txt'), 'BEFORE\n');
        await writeFile(path.join(workspace, '.gitignore'), '*\n!README.txt\n!.gitignore\n');
        for (const args of [['init','-q'], ['add','README.txt','.gitignore'], ['-c','user.name=Benchmark','-c','user.email=benchmark@example.invalid','-c','commit.gpgsign=false','commit','-qm','Isolated benchmark fixture']]) {
          const g = spawnSync('git', args, { cwd: workspace, env: cleanEnv, encoding: 'utf8', timeout: 10000 });
          if (g.status) throw new Error(`fixture git setup: ${g.stderr}`);
        }
      }
      argv = [binaries[agent], '--json', '--training-mode', '--tool-profile', 'full', '--permission-mode', 'yolo', '--cwd', workspace, '--max-retries', '0', '--max-duration-secs', '75', '--', prompt];
    } else if (agent === 'claude') {
      env.CLAUDE_CONFIG_DIR = config; env.ANTHROPIC_API_KEY = 'local-fixture-not-a-secret'; env.ANTHROPIC_BASE_URL = `${base}/claude`;
      argv = [binaries[agent], '-p', '--bare', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'dontAsk', '--allowedTools', 'Bash Read Grep Write', '--max-turns', '100', '--system-prompt', 'Execute tools only inside the supplied isolated benchmark workspace.', '--model', 'claude-sonnet-4-5', '--', prompt];
    } else {
      argv = [binaries[agent], 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json', '--sandbox', 'danger-full-access', '-C', workspace,
        '-c', 'model_provider="benchmark"', '-c', `model_providers.benchmark={name="benchmark",base_url="${base}/codex/v1",wire_api="responses",requires_openai_auth=false}`, '-c', 'model="gpt-5.4"', '-c', 'features.shell_snapshot=false', '-c', 'features.shell_snapshot_v2=false', '--', prompt];
    }
    console.log(`START ${agent} ${versions[agent]} ${state.audit ? 'catalog-driven audit' : `${plan.length} tool calls`}`);
    const outcome = await runOwned(argv, env, agent);
    const result = { agent, version: versions[agent], startup_to_request_ms: state.firstRequest, total_ms: performance.now()-state.started, ...outcome, samples: state.samples, toolNames: state.toolNames, blocked: state.blocked, child_requests: state.childRequests, failure: state.failure, completed_calls: state.samples.length, expected_calls: state.plan.length };
    results.push(result);
    await writeFile(path.join(root, 'results.json'), JSON.stringify({ baseline, results }, null, 2));
    console.log(JSON.stringify({ agent, code: outcome.code, completed: state.samples.length, expected: state.plan.length, startup_ms: state.firstRequest, failure: state.failure, tail: outcome.code ? outcome.tail : undefined }));
  }
  await verifyRunContextIntegrity(layout, { platform: process.platform });
} finally {
  for (const [pid] of processes) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ remaining_owned_processes: processes.size, server_closed: !server?.listening }));
}
console.log(`ARTIFACTS ${root}`);
