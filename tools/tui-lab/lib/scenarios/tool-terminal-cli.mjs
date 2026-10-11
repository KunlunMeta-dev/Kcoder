// Real CLI entry points with a loopback model transport; tools and persistence are KCoder's.
// Run: node tools/tui-lab/lib/scenarios/tool-terminal-cli.mjs --software-webgl --command /absolute/path/to/kcoder
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { parseArgs, browserLaunchOptions } from '../runner-options.mjs';
import { createRunContext } from '../run-context.mjs';
import { defaultWorkspaceTemplate, repoRoot, runContextRuntime } from '../runtime-paths.mjs';
import { startSession } from '../session.mjs';
import { pressTerminalEscape, submitTerminalLine } from '../terminal-interaction.mjs';
import { captureStep } from '../browser-evidence.mjs';
import { settleLifecycleStep } from '../browser-lifecycle.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = parseArgs(['tool-terminal-cli', ...process.argv.slice(2)], { defaultWorkspaceTemplate });
options.timeoutMs = Math.min(options.timeoutMs, 30000);
const binary = path.resolve(options.commandOverride || path.join(repoRoot, 'target/optimization-bin-06ab/kcoder'));
const sigintSlice = options.scenario === 'headless-sigint';
const privateRoot = await mkdtemp('/tmp/kcoder-s01-cli-');
const runtime = { ...runContextRuntime(), configRoot: privateRoot, configTrustRoot: privateRoot };
const artifacts = await createRunContext({ ...options, description: options.description || 's01-tool-terminal-cli' }, 's01', runtime);
const json = (name, value) => writeFile(path.join(artifacts.dir, name), JSON.stringify(value, null, 2) + '\n');
const requests = [], trace = [], processes = [], handles = [], cleanup = [];
let session, browser, page, failure;
let currentMode = 'headless';
const prompts = { success: 'S01_SUCCESS_TOOL', interrupt: 'S01_INTERRUPT_TOOL', followup: 'S01_FOLLOWUP' };
const goalObjective = 'S01 preserve this explicit goal and its progress after user interruption';
if (sigintSlice) prompts.interrupt += ` Explicitly create a persistent goal: ${goalObjective}; then run the bounded shell fixture.`;
const toolId = (mode, kind) => `s01-${mode}-${kind}`;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    let input = '';
    for await (const chunk of request) { input += chunk; assert.ok(input.length < 2 * 1024 * 1024); }
    const body = JSON.parse(input);
    const user = body.messages.filter(message => message.role === 'user').at(-1);
    const prompt = typeof user.content === 'string' ? user.content : user.content.map(block => block.text || '').join('');
    const kind = Object.keys(prompts).find(key => prompt.includes(prompts[key]));
    assert.ok(kind, `unexpected synthetic input ${prompt}`);
    const id = toolId(currentMode, kind);
    const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === id);
    requests.push({ mode: currentMode, kind, body });
    await json('model-requests.json', requests);
    let delta, finish;
    const createdGoal = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 's01-headless-goal');
    if (sigintSlice && kind === 'interrupt' && !createdGoal) {
      assert.ok(body.tools.some(tool => tool.function.name === 'create_goal'));
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 's01-headless-goal', type: 'function', function: { name: 'create_goal', arguments: JSON.stringify({ objective: goalObjective }) } }] };
      finish = 'tool_calls';
    } else if (kind !== 'followup' && !result) {
      assert.ok(body.tools.some(tool => tool.function.name === 'bash'), 'real registry must advertise bash');
      const command = kind === 'success'
        ? "printf 'S01_ACTUAL_TOOL_SUCCESS\\n'"
        : "printf '%s\\n' \"$$\" > .s01-tool.pid; printf 'S01_ACTUAL_TOOL_BEGIN\\n'; sleep 4; printf 'S01_UNEXPECTED_TOOL_END\\n'";
      delta = { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: `S01 ${kind} real tool`, timeout: 6000, run_in_background: false }) } }] };
      finish = 'tool_calls';
    } else {
      delta = { role: 'assistant', content: `S01_${currentMode.toUpperCase()}_${kind.toUpperCase()}_FINAL` };
      finish = 'stop';
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (value, reason) => ({ id: 's01-fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: value, finish_reason: reason }] });
    response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, finish))}\n\ndata: [DONE]\n\n`);
  } catch (error) { response.writeHead(400).end(String(error)); }
});

async function until(check, description) {
  const deadline = Date.now() + options.timeoutMs;
  do { if (await check()) return; await delay(50); } while (Date.now() < deadline);
  throw new Error(`timed out: ${description}`);
}
async function alive(pid) {
  try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'; }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error; }
}
async function toolHandle(workspace, mode) {
  const file = path.join(workspace, '.s01-tool.pid');
  await until(async () => { try { return Number(await readFile(file, 'utf8')) > 0; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, `${mode} real tool PID`);
  const pid = Number(await readFile(file, 'utf8'));
  const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
  const record = { mode, pid, children, beginObservedAt: new Date().toISOString(), shellAliveAtBegin: await alive(pid) };
  assert.equal(record.shellAliveAtBegin, true);
  handles.push(record);
  await json('owned-handles.json', handles);
  return record;
}
async function histories(root) {
  const found = [];
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.name.endsWith('.jsonl')) found.push({ file: path.relative(root, file), text: await readFile(file, 'utf8') });
    }
  }
  await scan(root);
  return found;
}
async function goalStates(root) {
  const found = [];
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.name === 'state.json' || entry.name.endsWith('.state.json')) {
        const state = JSON.parse(await readFile(file, 'utf8'));
        if (state.goal?.objective === goalObjective) found.push({ file: path.relative(root, file), goal: state.goal });
      }
    }
  }
  await scan(path.join(root, 'kcoder/projects'));
  assert.ok(found.length > 0, 'the real create_goal tool must have persisted this owned fixture goal');
  return found;
}
function headless(configHome, workspace, prompt, resume = false) {
  const env = { ...process.env, KCODER_CONFIG_DIR: path.join(configHome, 'kcoder'), XDG_CONFIG_HOME: configHome, RUST_LOG: 'warn' };
  for (const key of ['KCODER_HISTORY_DIR', 'KCODER_PROFILE', 'KCODER_PROVIDER', 'KCODER_MODEL', 'KCODER_SUMMARY_PROVIDER', 'KCODER_SUMMARY_MODEL']) delete env[key];
  const args = ['--cwd', workspace, '--training-mode', '--json', ...(resume ? ['--resume', 'latest'] : []), prompt];
  const child = spawn(binary, args, { env, cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { pid: child.pid, args, child, stdout: '', stderr: '', events: [], exit: null };
  let pending = '';
  child.stdout.on('data', chunk => {
    const text = chunk.toString(); record.stdout += text; pending += text;
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines.filter(Boolean)) record.events.push(JSON.parse(line));
  });
  child.stderr.on('data', chunk => { record.stderr += chunk.toString(); });
  record.exited = new Promise(resolve => child.on('exit', (code, signal) => { record.exit = { code, signal }; resolve(record.exit); }));
  processes.push(record);
  return record;
}
async function saveProcess(record, name) {
  await writeFile(path.join(artifacts.dir, `${name}.jsonl`), record.stdout);
  await writeFile(path.join(artifacts.dir, `${name}.stderr.txt`), record.stderr);
  await json(`${name}.meta.json`, { pid: record.pid, args: record.args, exit: record.exit });
}

try {
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const expectedSha = process.env.KCODER_S01_EXPECTED_SHA256 || '11995f0f26977a22a311a3d3bb38bdd9167136507cff1989d0de162951e0a1fb';
  assert.equal(sha256, expectedSha);
  await json('meta.start.json', { binary, sha256, source: process.env.KCODER_S01_SOURCE_COMMIT || '06ab1814a', buildPreparation: sigintSlice ? 'headless-sigint-product-fix' : 'prep13', realCli: true, provider: 'loopback-only', skill: 'kcoder-tui-lab unavailable; tools/tui-lab AGENTS fallback', tuiOnly: options.scenario === 'tui-only', scopes: sigintSlice ? ['headless single-PID SIGINT', 'CLI-owned tool cleanup', 'durable interrupted terminal', 'resume normal followup'] : ['headless success', 'headless running-tool SIGINT and resume', 'TUI running-tool Escape and next turn'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings = { active_provider: 'fixture', credential_store: 'file', permission_mode: 'yolo', max_retries: 0,
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: `http://127.0.0.1:${server.address().port}/v1`,
      default_model: 'fixture-model', context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024,
      capabilities: { text: true, tools: true }, no_proxy: true } } };
  const headlessHome = path.join(artifacts.configHome, 'headless');
  for (const home of [artifacts.configHome, headlessHome]) {
    await mkdir(path.join(home, 'kcoder'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(home, 'kcoder/settings.json'), JSON.stringify(settings));
    await writeFile(path.join(home, 'kcoder/credentials.json'), JSON.stringify({ fixture: { type: 'api', key: 'synthetic-owned-fixture' } }), { mode: 0o600 });
  }
  const headlessWorkspace = path.join(artifacts.dir, 'headless-workspace');
  await cp(defaultWorkspaceTemplate, headlessWorkspace, { recursive: true });
  if (options.scenario !== 'tui-only') {
  if (!sigintSlice) {
  const success = headless(headlessHome, headlessWorkspace, prompts.success);
  await until(() => success.exit !== null, 'headless success exit');
  await saveProcess(success, 'headless-success');
  assert.equal(success.exit.code, 0);
  assert.ok(success.events.some(event => event.type === 'tool_use_started' && event.id === toolId('headless', 'success')));
  assert.ok(success.events.some(event => event.type === 'tool_result' && event.id === toolId('headless', 'success') && event.is_error === false && event.text.includes('S01_ACTUAL_TOOL_SUCCESS')));
  }
  const interrupted = headless(headlessHome, headlessWorkspace, prompts.interrupt);
  const headlessHandle = await toolHandle(headlessWorkspace, 'headless');
  assert.ok(interrupted.events.some(event => event.type === 'tool_use_started' && event.id === toolId('headless', 'interrupt')));
  // History is batched every 500 ms. Observe the actual persistence boundary;
  // a process killed before it cannot recover a tool identity still only in memory.
  if (!sigintSlice) await until(async () => (await histories(path.join(headlessHome, 'kcoder/projects'))).some(history => history.text.includes(`\"id\":\"${toolId('headless', 'interrupt')}\"`)), 'pending tool identity naturally persisted');
  const signalAt = new Date().toISOString();
  const requestsAtSignal = requests.filter(request => request.kind === 'interrupt').length;
  const goalsBeforeSignal = sigintSlice ? await goalStates(headlessHome) : [];
  if (sigintSlice) assert.ok(goalsBeforeSignal.every(state => state.goal.status === 'active'));
  process.kill(sigintSlice ? interrupted.pid : -interrupted.pid, 'SIGINT');
  await json('headless-signal.json', { at: signalAt, pid: interrupted.pid, target: sigintSlice ? 'CLI PID only; tool process group receives no fixture signal' : 'CLI process group' });
  await until(() => interrupted.exit !== null, 'headless SIGINT exit');
  await saveProcess(interrupted, 'headless-interrupted');
  const stoppedHistory = await histories(headlessHome);
  await json('headless-before-resume-history.json', stoppedHistory);
  if (sigintSlice) {
    assert.equal(interrupted.exit.signal, null, 'first SIGINT must drain the CLI instead of killing it');
    assert.notEqual(interrupted.exit.code, 0, 'interrupted CLI must exit nonzero');
    const terminal = interrupted.events.at(-1);
    assert.equal(terminal.type, 'result');
    assert.equal(terminal.run_status, 'cancelled');
    assert.equal(terminal.termination_reason, 'user_cancelled');
    assert.deepEqual(terminal.interrupt_cleanup, { status: 'completed', history_flushed: true });
    assert.ok(interrupted.events.some(event => event.type === 'tool_result' && event.id === toolId('headless', 'interrupt') && event.is_error === true && /interrupted|cancelled/i.test(event.text)));
    const entries = stoppedHistory.filter(history => history.file.includes('projects/') && !history.file.endsWith('.exit.jsonl')).flatMap(history => history.text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
    assert.ok(entries.flatMap(entry => entry.content || []).some(block => block.type === 'tool_result' && block.tool_use_id === toolId('headless', 'interrupt') && block.is_error === true));
    assert.equal(await alive(headlessHandle.pid), false, 'CLI must stop its owned shell before exit');
    assert.ok(!(await Promise.all(headlessHandle.children.map(alive))).some(Boolean), 'CLI must stop its owned tool descendants before exit');
    assert.equal(requests.filter(request => request.kind === 'interrupt').length, requestsAtSignal, 'interruption must not request an automatic model continuation');
    const goalsAfterSignal = await goalStates(headlessHome);
    assert.ok(goalsAfterSignal.every(state => state.goal.status === 'paused'));
    assert.ok(goalsAfterSignal.every(state => state.goal.goal_id === goalsBeforeSignal[0].goal.goal_id && state.goal.objective === goalsBeforeSignal[0].goal.objective));
    await json('goal-pause-evidence.json', { beforeSignal: goalsBeforeSignal, afterSignal: goalsAfterSignal });
  }
  // The headless process exit is abrupt, unlike the TUI Engine cancellation below.
  for (const pid of [headlessHandle.pid, ...headlessHandle.children]) if (await alive(pid)) { process.kill(pid, 'SIGTERM'); headlessHandle.ownerCleanupRequired = true; }
  await until(async () => !(await alive(headlessHandle.pid)) && !(await Promise.all(headlessHandle.children.map(alive))).some(Boolean), 'headless interrupted tool cleanup');
  const resumed = headless(headlessHome, headlessWorkspace, prompts.followup, true);
  await until(() => resumed.exit !== null, 'headless resume exit');
  await saveProcess(resumed, 'headless-resumed');
  if (!sigintSlice) assert.equal(resumed.exit.code, 0);
  assert.ok(resumed.events.some(event => event.type === 'assistant_text_delta' && event.text.includes('S01_HEADLESS_FOLLOWUP_FINAL')));
  assert.ok(!resumed.events.some(event => event.type === 'tool_result' || event.type === 'tool_use_started'), 'followup must not replay old tool lifecycle events');
  const resumedRequest = requests.findLast(request => request.mode === 'headless' && request.kind === 'followup');
  assert.ok(resumedRequest.body.messages.some(message => message.role === 'tool' && message.tool_call_id === toolId('headless', 'interrupt') && (sigintSlice ? /interrupted by the user/i.test(JSON.stringify(message.content)) : JSON.stringify(message.content).includes('interrupted before KCoder recorded a result'))));
  await json('headless-after-resume-history.json', await histories(headlessHome));
  if (sigintSlice) {
    const goalsAfterResume = await goalStates(headlessHome);
    assert.ok(goalsAfterResume.every(state => state.goal.status === 'paused'));
    assert.equal(requests.filter(request => request.kind === 'followup').length, 1, 'ordinary resumed question must not automatically resume the paused goal');
    const terminal = resumed.events.at(-1);
    assert.equal(terminal.type, 'result');
    assert.equal(terminal.run_status, 'completed');
    assert.equal(terminal.task_status, 'partial', 'preserve existing unfinished-paused-goal outcome semantics');
    await json('goal-after-resume.json', goalsAfterResume);
  }
  }
  if (!sigintSlice) {
  currentMode = 'tui';
  session = await startSession({ ...options, commandOverride: `${binary} --training-mode --cwd {workspace}`, runDir: artifacts.dir,
    workspaceDir: artifacts.workspace, configHome: artifacts.configHome, requestsDir: artifacts.requestsDir, tuiLabMode: 'paste' });
  browser = await chromium.launch(browserLaunchOptions(options));
  page = await browser.newPage({ viewport: { width: 1400, height: 1050 } });
  await page.goto(session.url);
  await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
  const waitText = text => page.waitForFunction(text => window.tuiLab.visibleText().includes(text), text, { timeout: options.timeoutMs });
  const capture = async name => { await writeFile(path.join(artifacts.dir, `${name}.txt`), await page.evaluate(() => window.tuiLab.visibleText())); await captureStep(page, trace, name, path.join(artifacts.dir, `${name}.png`)); };
  await waitText('Ask KCoder');
  await submitTerminalLine(page, prompts.success);
  await waitText('S01_TUI_SUCCESS_FINAL');
  await capture('tui-success');
  await submitTerminalLine(page, prompts.interrupt);
  const tuiHandle = await toolHandle(artifacts.workspace, 'tui');
  await page.waitForFunction(() => /bash running|Running bash/.test(window.tuiLab.visibleText()), null, { timeout: 2000 });
  await capture('tui-tool-running');
  // Use the existing Kitty-aware Unix/ConPTY adapter; a bare Escape byte is
  // ambiguous while crossterm's keyboard disambiguation mode is enabled.
  trace.push({ name: 'interrupt-input-before', at: new Date().toISOString(), shellAlive: await alive(tuiHandle.pid) });
  await pressTerminalEscape(page, process.platform);
  // submitTerminalLine focuses by clicking the terminal body, which can leave
  // KCoder's transcript selection active. First Escape clears that selection;
  // the second is the actual turn interruption (app_keyboard.rs).
  await delay(50);
  await pressTerminalEscape(page, process.platform);
  trace.push({ name: 'interrupt-input-after', at: new Date().toISOString(), shellAlive: await alive(tuiHandle.pid) });
  await json('interrupt-timing.json', trace);
  await page.waitForFunction(() => window.tuiLab.visibleText().includes('Cancelled.'), null, { timeout: 1500 });
  await until(async () => !(await alive(tuiHandle.pid)) && !(await Promise.all(tuiHandle.children.map(alive))).some(Boolean), 'TUI Engine cancellation stops tool');
  await delay(250);
  await capture('tui-tool-cancelled');
  await submitTerminalLine(page, prompts.followup);
  await waitText('S01_TUI_FOLLOWUP_FINAL');
  await delay(250);
  await capture('tui-followup');
  const finalText = await readFile(path.join(artifacts.dir, 'tui-followup.txt'), 'utf8');
  assert.ok(!/esc interrupt|Writing response|Preparing bash|Running bash/.test(finalText), 'completed next turn must return to idle footer');
  const tuiRequest = requests.findLast(request => request.mode === 'tui' && request.kind === 'followup');
  const cancelledResult = tuiRequest.body.messages.find(message => message.role === 'tool' && message.tool_call_id === toolId('tui', 'interrupt'));
  assert.ok(cancelledResult && /abort|cancel|interrupt/i.test(JSON.stringify(cancelledResult.content)), 'next real request must contain the interrupted tool result');
  await json('tui-history.json', await histories(artifacts.configDir));
  }
  await json('assertions.json', { ok: true, headless: options.scenario === 'tui-only' ? { skipped: true } : { toolSuccess: !sigintSlice, actualToolBegin: true, processInterrupted: true, interruptionRepairedOnResume: true, followupDidNotReplayToolEvents: true, gracefulSigintOwnedCleanupAndDurableTerminal: sigintSlice, actualGoalPausedAndOrdinaryResumeDidNotRestart: sigintSlice }, tui: sigintSlice ? { skipped: true, preservedEvidenceRun: '2026-10-04/06-18-24-511-s01-tool-terminal-cli-3523806' } : { toolSuccess: true, actualToolBegin: true, escapeCancelStoppedOwnedTool: true, nextTurnIncludedCancelledResult: true, followupCompleted: true, footerIdle: true }, visualTrace: trace });
} catch (error) {
  failure = error;
  await json('failure.json', { error: String(error), stack: error.stack });
  if (page) await page.screenshot({ path: path.join(artifacts.dir, 'failure.png') }).catch(() => {});
} finally {
  await json('visual-trace.json', trace);
  if (session) await writeFile(artifacts.ptyLog, session.getPtyLog());
  if (browser) cleanup.push(await settleLifecycleStep('browser', () => browser.close()));
  if (session) {
    cleanup.push(await settleLifecycleStep('PTY-session', () => session.stop()));
    cleanup.push(await settleLifecycleStep('PTY-exit', () => session.exitPromise));
  }
  for (const record of processes) {
    if (!record.exit) { try { process.kill(-record.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    cleanup.push(await settleLifecycleStep(`headless-${record.pid}-exit`, () => record.exited));
  }
  for (const handle of handles) {
    for (const pid of [handle.pid, ...handle.children]) {
      if (await alive(pid)) { process.kill(pid, 'SIGTERM'); handle.finalOwnerCleanupRequired = true; }
    }
    handle.aliveAfterCleanup = await alive(handle.pid);
    handle.childrenAliveAfterCleanup = await Promise.all(handle.children.map(alive));
  }
  cleanup.push(await settleLifecycleStep('loopback-provider', () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
  cleanup.push(await settleLifecycleStep('private-config-removal', () => rm(privateRoot, { recursive: true, force: true })));
  await json('owned-handles.json', handles);
  await json('cleanup.json', { steps: cleanup, handles, ptyPid: session?.ptyProcess.pid, ptyDiagnostics: session?.getDiagnostics(), privateRootRemoved: true });
  console.log(artifacts.dir);
  if (failure) throw failure;
  assert.ok(cleanup.every(step => step.status === 'completed'));
  assert.ok(handles.every(handle => !handle.aliveAfterCleanup && !handle.childrenAliveAfterCleanup.some(Boolean)));
}
