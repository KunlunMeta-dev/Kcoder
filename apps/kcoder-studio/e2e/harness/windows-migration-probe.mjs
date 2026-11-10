import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = () => new Promise(accept => setTimeout(accept, 25));

/** Runs inside the package probe's private Windows Job; never uses personal state. */
export async function runWindowsMigrationProbe({ binary, root, environment, terminalOnly = false, localAttachmentOnly = false, archiveOnly = false, ownerRoot = root }) {
  assert.equal(process.platform, 'win32');
  const workspace = join(root, 'migration workspace 中文');
  const profile = join(root, 'migration-profile');
  const claude = join(root, 'source-claude');
  const codex = join(root, 'source-codex');
  for (const directory of [workspace, profile, claude, codex]) await mkdir(directory, { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), 'This is an isolated migration fixture. Keep historical operations inert.\n');
  let modelRequests = 0;
  const observedHttpRequests = [];
  const trap = createServer((request, response) => {
    const route = { method: request.method, path: new URL(request.url, 'http://fixture').pathname };
    observedHttpRequests.push(route);
    if (request.method === 'POST') modelRequests++;
    request.resume();
    if (route.method === 'GET' && ['/models', '/v1/models'].includes(route.path)) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture', object: 'model' }] }));
      return;
    }
    if (route.method === 'HEAD' && route.path === '/v1/chat/completions') {
      response.writeHead(204); response.end(); return;
    }
    response.writeHead(500); response.end('No model request is authorized by this test');
  });
  await new Promise(accept => trap.listen(0, '127.0.0.1', accept));
  const settings = {
    credential_store: 'file', active_provider: 'fixture', max_retries: 0, mcp_servers: [], hooks: {},
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: `http://127.0.0.1:${trap.address().port}/v1`, default_model: 'fixture',
      context_window_tokens: 1000000, max_output_tokens: 2048, output_headroom_tokens: 10000,
      discover_models: false, no_proxy: true } },
  };
  await writeFile(join(profile, 'settings.json'), JSON.stringify(settings));
  const sourceConfigurations = new Map([
    [join(claude, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://claude-fixture.invalid/v1', ANTHROPIC_MODEL: 'fixture' } })],
    [join(codex, 'config.toml'), "model = 'fixture'\nmodel_provider = 'owned'\n[model_providers.owned]\nbase_url = 'https://codex-fixture.invalid/v1'\nwire_api = 'responses'\n"],
  ]);
  for (const [file, contents] of sourceConfigurations) await writeFile(file, contents);
  const sources = new Map();
  const marker = join(workspace, 'NEVER_REPLAY_HISTORY');
  for (let index = 0; index < 12; index++) {
    const id = randomUUID(), directory = join(claude, 'projects', 'native-fixture');
    await mkdir(directory, { recursive: true });
    const records = [
      { type: 'user', uuid: 'request', sessionId: id, version: '2.1.301', message: { role: 'user', content: `Windows migration fixture ${index}` } },
      { type: 'assistant', uuid: 'call', parentUuid: 'request', sessionId: id, version: '2.1.301', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'old-call', name: 'PowerShell', input: { command: `Set-Content -LiteralPath '${marker}' -Value executed` } }] } },
      { type: 'user', uuid: 'result', parentUuid: 'call', sessionId: id, version: '2.1.301', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-call', content: 'Recorded source result; never replay.' }] } },
      { type: 'assistant', uuid: 'answer', parentUuid: 'result', sessionId: id, version: '2.1.301', message: { role: 'assistant', content: `Completed historical fixture ${index}.` } },
    ];
    if (localAttachmentOnly) records.push({ type: 'user', uuid: 'local-reference', parentUuid: 'answer',
      sessionId: id, version: '2.1.301', message: { role: 'user', content: [{ type: 'document',
        path: join(workspace, 'NEVER_GRANTED', 'historical-original.pdf'), title: 'historical-original.pdf', media_type: 'application/pdf' }] } });
    const file = join(directory, `${id}.jsonl`), bytes = Buffer.from(records.map(value => JSON.stringify(value)).join('\n') + '\n');
    await writeFile(file, bytes); sources.set(id, { file, sha256: digest(bytes) });
  }
  const codexId = randomUUID(), codexDirectory = join(codex, 'sessions', '2026', '10', '17');
  await mkdir(codexDirectory, { recursive: true });
  const codexFile = join(codexDirectory, `rollout-2026-10-17T10-00-00-${codexId}.jsonl`);
  const codexBytes = Buffer.from([
    { type: 'session_meta', payload: { id: codexId, cli_version: '0.163.0' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Native Windows Codex archive fixture' }] } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  await writeFile(codexFile, codexBytes); sources.set(codexId, { file: codexFile, sha256: digest(codexBytes) });
  const sourceAcls = new Map();
  for (const directory of [claude, codex]) {
    // Ordinary source directories can be shared for reading. Import must not
    // require exclusive temporary-storage permissions or repair the source ACL.
    execFileSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(OI)(CI)(RX)'], { stdio: 'pipe' });
    sourceAcls.set(directory, execFileSync('icacls.exe', [directory]));
  }
  let child, client, attempts = 0;
  let nativeDiagnostics = '';
  let negotiatedCapabilities = [];
  const methods = [];
  const requireCapability = name => assert.ok(negotiatedCapabilities.includes(name), `Native host upgrade required: ${name}`);
  const rpc = async (method, params = {}) => {
    methods.push(method);
    const frame = await client.request(method, params, 30000);
    if (frame.error && ['migration/history/branch/read', 'migration/history/branch/tools/read'].includes(method)) {
      await new Promise(accept => setTimeout(accept, 1000));
      const reread = await client.request(method, params, 30000);
      assert.fail(`${method}: ${frame.error.message}; delayed read: ${JSON.stringify(reread.error ?? {
        stage: reread.result?.progress?.stage ?? reread.result?.state?.run?.stage, workerRunning: reread.result?.workerRunning ?? reread.result?.state?.workerRunning,
        workerError: reread.result?.workerError, failureCode: reread.result?.progress?.failureCode,
      })}; native diagnostics: ${nativeDiagnostics.slice(-4096)}`);
    }
    assert.ok(!frame.error, `${method}: ${frame.error?.message}`);
    return frame.result;
  };
  const settle = async (method, params, ready) => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const value = await rpc(method, params);
      if (ready(value)) return value;
      assert.ok(Date.now() < deadline, `${method} did not settle: ${JSON.stringify(value)}`);
      if (value.workerRunning === false) assert.ok(!['failed', 'blocked', 'publish_unknown']
        .includes(value.job?.stage ?? value.progress?.stage ?? value.state?.run?.stage), JSON.stringify(value));
      await pause();
    }
  };
  const search = async (jobId, viewId = null) => {
    requireCapability('migrationHistorySearchV1');
    const result = await rpc('migration/history/search', { jobId, viewId, query: 'Recorded source result', caseSensitive: true, cursor: null, limit: 10 });
    assert.equal(result.items.length, 1);
    const hit = result.items[0];
    assert.equal(hit.matched, 'Recorded source result');
    assert.equal(typeof hit.bodyCursor, 'string');
    requireCapability(viewId ? 'migrationHistoryBranchesV1' : 'migrationHistoryReadV1');
    const params = { jobId, ...(viewId ? { viewId, position: hit.position } : { record: hit.position }),
      blockIndex: hit.block.index, cursor: hit.bodyCursor };
    const method = viewId ? 'migration/history/branch/text' : 'migration/history/text';
    const body = await rpc(method, params);
    assert.equal(body.text, 'Recorded source result; never replay.');
    const forged = await client.request(method, { ...params,
      cursor: (hit.bodyCursor[0] === 'A' ? 'B' : 'A') + hit.bodyCursor.slice(1) });
    assert.ok(forged.error, 'a tampered body position must be rejected');
    return { method, params };
  };
  const cliSearch = async (jobId, viewId = null) => {
    const args = ['--cwd', workspace, 'migrate', 'history', '--target-profile', profile, 'search',
      '--job-id', jobId, '--query', 'Recorded source result', '--limit', '10', '--read-hit', '1'];
    if (viewId) args.push('--view-id', viewId);
    const command = spawn(binary, args, { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...environment, KCODER_CONFIG_DIR: profile, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex } });
    let output = '', diagnostic = '', bytes = 0, streamFailure;
    const collect = stderr => data => { bytes += data.length;
      if (bytes > 2 * 1024 * 1024) { streamFailure = Error('Native CLI output exceeded limit'); command.kill(); return; }
      if (stderr) diagnostic = (diagnostic + data).slice(-2048); else output += data; };
    command.stdout.on('data', collect(false)); command.stderr.on('data', collect(true));
    command.once('error', error => { streamFailure = error; });
    let ended;
    try { ended = await waitForStdioChildClose(command, 60000, 'owned native history/search command'); }
    finally { if (command.exitCode === null) command.kill(); }
    assert.ifError(streamFailure);
    assert.equal(ended.code, 0, diagnostic);
    const result = JSON.parse(output);
    assert.equal(result.items.length, 1); assert.equal(result.items[0].matched, 'Recorded source result');
    assert.equal(result.body.text, 'Recorded source result; never replay.');
    assert.equal(result.cursorScope, 'connection');
    assert.equal(result.items[0].bodyCursor, undefined); assert.equal(result.nextCursor, undefined);
    return { matched: true, bodyRead: true, exportedPrivateCursor: false };
  };
  const stop = async () => {
    if (!child) return;
    child.stdin.end();
    try { await waitForStdioChildClose(child, 10000, 'owned native migration app-server'); }
    finally { if (child.exitCode === null) child.kill(); client.closeReader(); child = null; }
  };
  const terminalSmoke = async () => {
    requireCapability('terminalSessions');
    assert.deepEqual((await rpc('terminal/list')).sessions, []);
    const terminal = await rpc('terminal/start', { cwd: workspace, rows: 24, cols: 80 });
    const output = join(workspace, 'owned-terminal-receipt.txt');
    const diagnostic = { sessionId: terminal.session_id, enter: 'CR, as emitted by xterm.js', promptReady: false,
      writeAck: null, output: '', exit: null, receipt: null, failure: null, terminalResponses: [], screen: '' };
    const require = createRequire(import.meta.url);
    const { Terminal } = require('./xterm.cjs');
    const metadata = require('./xterm-package.json');
    diagnostic.emulator = { name: metadata.name, version: metadata.version,
      sha256: digest(await readFile(new URL('./xterm.cjs', import.meta.url))), renderer: 'none; protocol/buffer only' };
    const emulator = new Terminal({ cols: 80, rows: 24 });
    const contexts = new Map([[terminal.session_id, { emulator, diagnostic }]]);
    const responses = [];
    const responders = [];
    let responseFailure = null;
    const respond = (engine, id, trace) => responders.push(engine.onData(data => {
      if (trace.exit) return;
      if (trace.terminalResponses.length >= 32) { responseFailure = Error('terminal response budget'); return; }
      trace.terminalResponses.push(data);
      const response = rpc('terminal/write', { session_id: id, data });
      void response.catch(error => { responseFailure = error; }); responses.push(response);
    }));
    respond(emulator, terminal.session_id, diagnostic);
    const screen = (engine = emulator) => {
      const buffer = engine.buffer.active;
      let result = '';
      for (let row = 0; row <= buffer.cursorY; row++) {
        const line = buffer.getLine(buffer.baseY + row);
        result += (row && !line?.isWrapped ? '\n' : '') + (line?.translateToString(true) ?? '');
      }
      return result;
    };
    const capture = line => {
      let frame; try { frame = JSON.parse(line); } catch { return; }
      const context = contexts.get(frame.params?.session_id);
      if (!context) return;
      if (frame.method === 'terminal/output') {
        context.diagnostic.output = (context.diagnostic.output + frame.params.data).slice(-32768);
        context.emulator.write(frame.params.data);
      }
      if (frame.method === 'terminal/exit') context.diagnostic.exit = frame.params;
    };
    client.reader.on('line', capture);
    for (const frame of client.notificationHistory) capture(JSON.stringify(frame));
    const waitReady = async (engine, trace) => {
      const readyDeadline = Date.now() + 5000;
      while (!/(?:PS [^\r\n]*|[A-Za-z]:\\[^\r\n]*)>\s*$/.test(screen(engine))) {
        assert.ifError(responseFailure);
        assert.ok(Date.now() < readyDeadline, 'owned Windows terminal prompt did not become ready; see terminal diagnostic');
        await pause();
      }
      trace.promptReady = true;
    };
    try {
      await waitReady(emulator, diagnostic);
      const peer = await rpc('terminal/start', { cwd: workspace, rows: 24, cols: 80 });
      const peerTrace = { sessionId: peer.session_id, output: '', exit: null, terminalResponses: [], promptReady: false };
      const peerEmulator = new Terminal({ cols: 80, rows: 24 });
      diagnostic.peer = peerTrace;
      contexts.set(peer.session_id, { emulator: peerEmulator, diagnostic: peerTrace });
      respond(peerEmulator, peer.session_id, peerTrace);
      for (const frame of client.notificationHistory.filter(frame => frame.params?.session_id === peer.session_id)) capture(JSON.stringify(frame));
      await waitReady(peerEmulator, peerTrace);
      const exited = client.waitForNotification(frame => frame.method === 'terminal/exit'
        && frame.params?.session_id === terminal.session_id, 15000, 'owned Windows PTY exit');
      void exited.catch(() => {});
      diagnostic.writeAck = await rpc('terminal/write', { session_id: terminal.session_id,
        data: `[IO.File]::WriteAllText('${output.replaceAll("'", "''")}', 'OWNED_WINDOWS_TERMINAL_OK'); exit\r` });
      assert.equal(diagnostic.writeAck.written, true);
      assert.equal((await exited).params.exit_code, 0);
      await Promise.all(responses);
      diagnostic.receipt = await readFile(output, 'utf8');
      assert.equal(diagnostic.receipt, 'OWNED_WINDOWS_TERMINAL_OK');
      assert.deepEqual((await rpc('terminal/list')).sessions.map(value => value.session_id), [peer.session_id]);
      const peerOutput = join(workspace, 'owned-peer-receipt.txt');
      peerTrace.writeAck = await rpc('terminal/write', { session_id: peer.session_id,
        data: `[IO.File]::WriteAllText('${peerOutput.replaceAll("'", "''")}', 'OWNED_PEER_STILL_USABLE')\r` });
      assert.equal(peerTrace.writeAck.written, true);
      const peerDeadline = Date.now() + 5000;
      while (await readFile(peerOutput, 'utf8').catch(() => null) !== 'OWNED_PEER_STILL_USABLE') {
        assert.ok(Date.now() < peerDeadline, 'the active peer did not execute its own receipt after primary exit'); await pause();
      }
      peerTrace.receipt = 'OWNED_PEER_STILL_USABLE';
      const peerExited = client.waitForNotification(frame => frame.method === 'terminal/exit'
        && frame.params?.session_id === peer.session_id, 15000, 'explicitly closed peer exit');
      void peerExited.catch(() => {});
      peerTrace.closeAck = await rpc('terminal/close', { session_id: peer.session_id });
      assert.equal(peerTrace.closeAck.closed, true);
      assert.equal(typeof (await peerExited).params.exit_code, 'number');
      assert.deepEqual((await rpc('terminal/list')).sessions, []);
      const disconnect = await rpc('terminal/start', { cwd: workspace, rows: 24, cols: 80 });
      const disconnectTrace = { sessionId: disconnect.session_id, output: '', exit: null, terminalResponses: [], promptReady: false };
      const disconnectEmulator = new Terminal({ cols: 80, rows: 24 });
      diagnostic.disconnect = disconnectTrace;
      contexts.set(disconnect.session_id, { emulator: disconnectEmulator, diagnostic: disconnectTrace });
      respond(disconnectEmulator, disconnect.session_id, disconnectTrace);
      for (const frame of client.notificationHistory.filter(frame => frame.params?.session_id === disconnect.session_id)) capture(JSON.stringify(frame));
      await waitReady(disconnectEmulator, disconnectTrace);
      const identityFile = join(workspace, 'owned-disconnect-child.txt');
      disconnectTrace.writeAck = await rpc('terminal/write', { session_id: disconnect.session_id,
        data: `$ownedProcess=[Diagnostics.Process]::GetCurrentProcess(); [IO.File]::WriteAllText('${identityFile.replaceAll("'", "''")}', ($ownedProcess.Id.ToString()+'|'+$ownedProcess.StartTime.ToUniversalTime().Ticks.ToString()))\r` });
      const identityDeadline = Date.now() + 5000;
      let processIdentity;
      while (!(processIdentity = await readFile(identityFile, 'utf8').catch(() => null))) {
        assert.ok(Date.now() < identityDeadline, 'owned disconnect child identity was not written'); await pause();
      }
      assert.match(processIdentity, /^\d+\|\d+$/);
      const [pid, ticks] = processIdentity.split('|');
      const observeChild = () => execFileSync(join(environment.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';$owned=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if(!$owned -or $owned.HasExited){'absent'}elseif($owned.StartTime.ToUniversalTime().Ticks.ToString() -eq '${ticks}'){'owned-live'}else{'identity-reused'}`],
        { windowsHide: true, timeout: 10000, encoding: 'utf8', env: environment }).trim();
      assert.equal(observeChild(), 'owned-live');
      await stop();
      const goneDeadline = Date.now() + 5000;
      while ((disconnectTrace.childObservation = observeChild()) === 'owned-live') {
        assert.ok(Date.now() < goneDeadline, 'owned PowerShell survived its app-server connection'); await pause();
      }
      assert.ok(['absent', 'identity-reused'].includes(disconnectTrace.childObservation));
      return { nativePtyStarted: true, ownedCommandExecuted: true, exitCode: 0, registryReclaimed: true,
        peerStayedUsable: true, activePeerCloseAcknowledged: true, peerExitCode: peerTrace.exit.exit_code,
        disconnectChildStopped: true,
        emulator: diagnostic.emulator, terminalResponseCount: diagnostic.terminalResponses.length };
    } catch (error) {
      diagnostic.failure = String(error.message).slice(0, 1000);
      diagnostic.receipt = await readFile(output, 'utf8').catch(() => null);
      throw error;
    } finally {
      client.reader.off('line', capture);
      for (const responder of responders) responder.dispose();
      let cleanupError;
      for (const [id, context] of contexts) {
        context.diagnostic.screen = screen(context.emulator); context.emulator.dispose();
        try { if (child) await rpc('terminal/close', { session_id: id }); }
        catch (error) { (diagnostic.cleanupErrors ??= []).push(String(error.message)); if (!diagnostic.failure) cleanupError ??= error; }
      }
      await writeFile(join(root, 'terminal-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
      if (cleanupError) throw cleanupError;
    }
  };
  const start = async () => {
    assert.equal(child, null);
    child = spawn(binary, ['--cwd', workspace, 'app-server'], {
      cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...environment, KCODER_CONFIG_DIR: profile, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex,
        RUST_LOG: 'kcoder::migration=debug' },
    });
    nativeDiagnostics = '';
    child.stderr.on('data', data => { nativeDiagnostics = (nativeDiagnostics + data.toString()).slice(-16384); });
    client = new AppServerStdioClient(`native-migration-${++attempts}`, child);
    const initialized = await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'windows-owned-migration', version: '1' } });
    negotiatedCapabilities = Object.entries(initialized.capabilities.experimental)
      .filter(([, enabled]) => enabled === true).map(([name]) => name).sort();
    for (const capability of ['migrationHistoryJobsV1', 'migrationHistoryReadV1', 'migrationHistoryBranchesV1', 'migrationContinuationV1', 'migrationHistorySearchV1', 'migrationContinuationUndoV1'])
      assert.equal(initialized.capabilities.experimental[capability], true);
    if (localAttachmentOnly) requireCapability('migrationLocalAttachmentsV1');
    assert.deepEqual((await rpc('mcp/list')).servers, [], 'the owned fixture must not connect any external MCP');
  };
  child = null;
  try {
    await start();
    if (terminalOnly) {
      const terminal = await terminalSmoke();
      assert.equal(modelRequests, 0);
      assert.ok(!methods.includes('turn/start'));
      assert.ok(observedHttpRequests.every(route =>
        (route.method === 'GET' && ['/models', '/v1/models'].includes(route.path)) ||
        (route.method === 'HEAD' && route.path === '/v1/chat/completions')));
      return { passed: true, terminal, inferenceRequests: modelRequests, observedHttpRequests, guiAcceptance: 'not_run' };
    }
    const discovered = await rpc('migration/discover', { sources: ['claude-code', 'codex'], includeProject: false });
    const configurations = discovered.sources.filter(source => source.scope === 'user');
    assert.deepEqual(configurations.map(source => source.kind).sort(), ['claude-code', 'codex']);
    assert.deepEqual(discovered.problems, []);
    for (const [index, configuration] of configurations.entries()) {
      // Studio selects one product per batch; exercise each through its own plan.
      const batch = await rpc('migration/batch/scan', { sourceIds: [configuration.sourceId] });
      const items = await rpc('migration/items', { jobId: batch.job.jobId, pageIndex: 0 });
      assert.equal(items.providers.length, 1);
      const choices = items.providers.map(candidate => ({ kind: 'provider', itemId: candidate.itemId,
        targetName: `ImportedReadShared${index}`, endpoint: candidate.endpoint, model: candidate.model,
        contextWindowTokens: 1000000, outputHeadroomTokens: 10000, maxOutputTokens: 2048 }));
      const plan = await rpc('migration/batch/plan', { jobId: batch.job.jobId, expectedSequence: batch.job.sequence,
        choices, includeDefaultItems: false });
      await rpc('migration/batch/run', { jobId: batch.job.jobId, expectedSequence: plan.job.sequence,
        planId: plan.batch.planId, requestId: randomUUID(), mode: 'apply' });
      const saved = await settle('migration/batch/read', { jobId: batch.job.jobId }, value => !value.workerRunning && ['completed', 'completed_with_issues'].includes(value.state.job.status));
      // These fixtures intentionally contain no API keys. Missing authentication
      // can remain actionable after the connection definition is committed.
      assert.equal(saved.workerError, null);
      assert.equal(saved.state.batch.committedActions, 1);
      assert.equal(saved.state.batch.unresolvedActions, 0);
      const savedSettings = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'));
      assert.equal(savedSettings.active_provider, 'fixture');
      for (const choice of choices) assert.equal(savedSettings.providers[choice.targetName].default_model, choice.model);
      await rpc('migration/batch/run', { jobId: batch.job.jobId, expectedSequence: saved.state.job.sequence,
        planId: plan.batch.planId, requestId: randomUUID(), mode: 'rollback' });
      await settle('migration/batch/read', { jobId: batch.job.jobId }, value => !value.workerRunning && value.state.job.status === 'rolled_back');
    }
    const page = await rpc('migration/history/discover', { source: 'claude-code' });
    assert.equal(page.totalItems, 12); assert.equal(page.items.length, 10);
    const secondPage = await rpc('migration/history/sources', { catalogId: page.catalogId, cursor: page.nextCursor });
    assert.equal(secondPage.items.length, 2);
    const selected = page.items[0], jobId = randomUUID();
    const created = await rpc('migration/history/create', { catalogId: page.catalogId, sourceHandle: selected.sourceHandle, requestId: jobId });
    assert.equal(created.job.sequence, 0);
    await rpc('migration/history/run', { jobId, expectedSequence: 0 });
    const archived = await settle('migration/history/read', { jobId }, value => value.workerRunning === false && value.job.stage === 'normalized');
    assert.equal(archived.job.normalization.normalizedRecords, localAttachmentOnly ? 5 : 4);
    const transcript = await rpc('migration/history/transcript', { jobId });
    assert.equal(transcript.items.length, localAttachmentOnly ? 5 : 4);
    const rawSearch = await search(jobId);
    const codexPage = await rpc('migration/history/discover', { source: 'codex' });
    assert.equal(codexPage.totalItems, 1);
    const codexJobId = randomUUID();
    await rpc('migration/history/create', { catalogId: codexPage.catalogId,
      sourceHandle: codexPage.items[0].sourceHandle, requestId: codexJobId });
    await rpc('migration/history/run', { jobId: codexJobId, expectedSequence: 0 });
    const codexArchive = await settle('migration/history/read', { jobId: codexJobId }, value => value.workerRunning === false && value.job.stage === 'normalized');
    assert.equal(codexArchive.job.normalization.normalizedRecords, 2);
    assert.deepEqual((await rpc('thread/list')).threads, [], 'archiving must not create an ordinary conversation');
    if (archiveOnly) {
      for (const value of sources.values()) assert.equal(digest(await readFile(value.file)), value.sha256);
      for (const [file, contents] of sourceConfigurations) assert.equal(await readFile(file, 'utf8'), contents);
      for (const [directory, acl] of sourceAcls) assert.deepEqual(execFileSync('icacls.exe', [directory]), acl);
      assert.equal(await access(marker).then(() => true, () => false), false);
      assert.equal(modelRequests, 0);
      assert.ok(!methods.includes('turn/start'));
      return { passed: true, scope: 'configuration-and-history-archive',
        readSharedConfigurationSources: { discovered: 2, previewed: 2, saved: 2, rolledBack: 2,
          activeProviderPreserved: true, authenticationVerified: false },
        sourceFiles: sources.size, sourceBytesUnchanged: true, sourceAclsUnchanged: true,
        discoveryPages: [10, 2], archivedRecords: 4, codexArchivedRecords: 2,
        ordinaryThreadsCreated: 0, sourceCommandsExecuted: false, inferenceRequests: modelRequests,
        historicalContinuation: 'not_run_in_archive_scope', guiAcceptance: 'not_run' };
    }
    const prepared = await rpc('migration/history/branch/prepare', { jobId });
    const viewId = prepared.progress.viewId;
    await rpc('migration/history/branch/run', { jobId, viewId });
    await settle('migration/history/branch/read', { jobId, viewId }, value => value.progress?.stage === 'ready');
    await rpc('migration/history/branch/tools/run', { jobId, viewId });
    await settle('migration/history/branch/tools/read', { jobId, viewId }, value => value.state?.run?.stage === 'ready');
    if (localAttachmentOnly) {
      const { runWindowsLocalAttachmentCase } = await import('./windows-local-attachment-case.mjs');
      const localAttachment = await runWindowsLocalAttachmentCase({ root: ownerRoot, profile, workspace, jobId, viewId,
        rpc, raw: (method, params) => { methods.push(method); return client.request(method, params, 30000); }, settle,
        restart: async () => { await stop(); await start(); } });
      for (const value of sources.values()) assert.equal(digest(await readFile(value.file)), value.sha256, 'source bytes changed');
      assert.equal(await access(marker).then(() => true, () => false), false);
      assert.equal(modelRequests, 0);
      assert.ok(!methods.includes('turn/start'));
      assert.ok(observedHttpRequests.every(route =>
        (route.method === 'GET' && ['/models', '/v1/models'].includes(route.path)) ||
        (route.method === 'HEAD' && route.path === '/v1/chat/completions')));
      return { passed: true, localAttachment, sourceFiles: sources.size, sourceBytesUnchanged: true,
        sourceCommandsExecuted: false, inferenceRequests: modelRequests,
        metadataRequests: observedHttpRequests.filter(route => route.method === 'GET').length,
        connectivityRequests: observedHttpRequests.filter(route => route.method === 'HEAD').length,
        observedHttpRequests, nativeProcessesOpened: attempts, guiAcceptance: 'not_run' };
    }
    const branchSearch = await search(jobId, viewId);
    const wrongSelection = await client.request(branchSearch.method, { ...branchSearch.params, cursor: rawSearch.params.cursor });
    assert.ok(wrongSelection.error, 'a raw body cursor must not authorize a selected branch read');
    const requestId = randomUUID();
    const request = { requestId, sourceJobId: jobId, viewId,
      policy: { maxContextBytes: 4194304, maxEntries: 2048, maxAttachments: 256, maxAttachmentBytes: 536870912 },
      options: { model: null, settingsTemplate: null, studioWorkMode: 'kworker' } };
    await rpc('migration/history/continuation/create', request);
    const cancelled = await rpc('migration/history/continuation/cancel', { jobId: requestId });
    assert.equal(cancelled.job.stage, 'cancelled'); assert.equal(cancelled.job.threadId, null);
    const stale = await client.request('migration/history/continuation/resume', { jobId: requestId, expectedSequence: 0 });
    assert.ok(stale.error, 'a stale pre-cancel sequence must not resume');
    await rpc('migration/history/continuation/resume', { jobId: requestId, expectedSequence: cancelled.job.sequence });
    const imported = await settle('migration/history/continuation/read', { jobId: requestId }, value => value.workerRunning === false && value.job.stage === 'imported');
    const threadId = imported.job.threadId;
    assert.match(threadId, /^[A-Za-z0-9]{5}$/);
    const thread = await rpc('thread/read', { threadId });
    assert.equal(thread.thread.id, threadId);
    assert.equal(thread.thread.status, 'idle');
    assert.equal(thread.thread.studioWorkMode, 'kworker');
    assert.deepEqual(thread.messages, [], 'the inert context must not appear as a newly sent user request');
    assert.ok(!JSON.stringify(thread).includes('Historical evidence'));
    const origin = await rpc('migration/history/continuation/source', { threadId });
    assert.equal(origin.source.sourceJobId, jobId); assert.equal(origin.source.viewId, viewId);
    await stop();
    const cliRawSearch = await cliSearch(jobId);
    const cliBranchSearch = await cliSearch(jobId, viewId);
    await start();
    const oldCursor = await client.request(rawSearch.method, rawSearch.params);
    assert.ok(oldCursor.error, 'signed body positions must not cross app-server connections');
    await search(jobId);
    const reopened = await rpc('migration/history/continuation/read', { jobId: requestId });
    assert.deepEqual(reopened.job, imported.job);
    assert.deepEqual(await rpc('migration/history/continuation/source', { threadId }), origin);
    assert.equal((await rpc('migration/history/continuation/create', request)).job.threadId, threadId);
    assert.deepEqual((await rpc('thread/list')).threads.map(thread => thread.id), [threadId], 'CLI searches must not create extra conversations');
    assert.equal((await rpc('migration/history/transcript', { jobId })).items.length, 4);
    for (const value of sources.values()) assert.equal(digest(await readFile(value.file)), value.sha256, 'source bytes changed');
    for (const [file, contents] of sourceConfigurations) assert.equal(await readFile(file, 'utf8'), contents);
    for (const [directory, acl] of sourceAcls) assert.deepEqual(execFileSync('icacls.exe', [directory]), acl);
    assert.equal(await access(marker).then(() => true, () => false), false);
    assert.equal(modelRequests, 0, JSON.stringify(observedHttpRequests));
    assert.ok(observedHttpRequests.every(route =>
      (route.method === 'GET' && ['/models', '/v1/models'].includes(route.path)) ||
      (route.method === 'HEAD' && route.path === '/v1/chat/completions')),
      `Unexpected fixture request: ${JSON.stringify(observedHttpRequests)}`);
    assert.ok(!methods.includes('turn/start'));
    return { passed: true, sourceFiles: sources.size, sourceBytesUnchanged: true, sourceCommandsExecuted: false,
      readSharedConfigurationSources: { discovered: 2, previewed: 2, saved: 2, rolledBack: 2, sourceAclsUnchanged: true, activeProviderPreserved: true },
      discoveryPages: [10, 2], archivedRecords: 4, codexArchivedRecords: 2, cancelAndStaleResumeVerified: true,
      nativeIdleThreadCreated: true, stableThreadAfterRestart: true, originalTranscriptReadable: true,
      historySearch: { capabilityVerified: true, rawMatchAndBody: true, branchMatchAndBody: true,
        forgedBodyCursorRejected: true, crossSelectionCursorRejected: true, crossConnectionCursorRejected: true },
      cliHistorySearch: { raw: cliRawSearch, branch: cliBranchSearch, commandCount: 2 },
      unicodeAndSpacedWorkspace: true, nativeProcessesOpened: attempts, modelRequests,
      inferenceRequests: modelRequests,
      metadataRequests: observedHttpRequests.filter(route => route.method === 'GET').length,
      connectivityRequests: observedHttpRequests.filter(route => route.method === 'HEAD').length,
      observedHttpRequests,
      negotiatedCapabilities, guiAcceptance: 'not_run' };
  } finally {
    await stop(); trap.closeAllConnections(); await new Promise(accept => trap.close(accept));
  }
}
