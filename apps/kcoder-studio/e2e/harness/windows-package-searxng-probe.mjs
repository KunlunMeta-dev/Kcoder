import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { spawnWindowsSupervised } from './owned-process.mjs';

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === '--forbidden-source-launch') {
  await writeFile(process.argv[3], 'Unexpected source command execution');
  process.exit(91);
}
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const root = resolve(input.directory), app = input.installedDirectory ? resolve(input.installedDirectory) : join(root, 'app');
const binary = join(app, 'resources/bin/kcoder.exe');
const profile = join(root, 'search-profile'), workspace = join(root, 'workspace');
const ambient = join(root, 'ambient-home'), temporary = join(root, 'temp');
const sha = data => createHash('sha256').update(data).digest('hex');
const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
Object.assign(environment, { TEMP: temporary, TMP: temporary, HOME: ambient, USERPROFILE: ambient,
  APPDATA: join(ambient, 'AppData/Roaming'), LOCALAPPDATA: join(ambient, 'AppData/Local'), KCODER_CONFIG_DIR: profile });

// This worker is itself in a private Job. Its app-server can retain normal stdio.
if (process.argv[3] === '--migration-task') {
  assert.equal(input.taskContinuation?.authorized,true);
  const {runWindowsMigrationTaskContinuation}=await import('./windows-migration-task-continuation.mjs');
  console.log(JSON.stringify(await runWindowsMigrationTaskContinuation({binary,root,environment,model:input.taskContinuation})));
  process.exit(0);
}
if (['--rpc', '--terminal-rpc'].includes(process.argv[3])) {
  if (input.focus === 'workflow-draft') {
    const { runWindowsWorkflowDraftProbe } = await import('./windows-workflow-draft-probe.mjs');
    console.log(JSON.stringify(await runWindowsWorkflowDraftProbe({ binary, root, environment, installation: app })));
    process.exit(0);
  }
  if(input.focus==='native-web-search'){
    const {runInstalledNativeWebSearch}=await import('./windows-native-web-search.mjs');
    console.log(JSON.stringify(await runInstalledNativeWebSearch({binary,directory:root,environment,expectedCommit:input.nativeCommit??input.commit,expectedCliSha256:input.cliSha256,nativeConsent:input.nativeConsent,externalConsent:input.externalConsent})));
    process.exit(0);
  }
  if (input.focus === 'task-board') {
    const { runWindowsTaskBoardStatusProbe } = await import('./windows-task-board-status-probe.mjs');
    console.log(JSON.stringify(await runWindowsTaskBoardStatusProbe({ binary, root, environment })));
    process.exit(0);
  }
  if (input.focus === 'migration') {
    const { runWindowsMigrationProbe } = await import('./windows-migration-probe.mjs');
    const terminalOnly = process.argv[3] === '--terminal-rpc';
    console.log(JSON.stringify(await runWindowsMigrationProbe({ binary, root: terminalOnly ? join(root, 'terminal-case') : root, environment, terminalOnly })));
    process.exit(0);
  }
  let requests = 0, discovered = false, searchResult, ordinaryThread;
  const fixture = createServer(async (request, response) => {
    try {
      let body = '', size = 0;
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 2 * 1024 * 1024); body += chunk; }
      const parsed = JSON.parse(body);
      const index = requests++;
      assert.ok(index < 3, 'bounded deterministic provider fixture');
      if (index === 1) {
        const revoked = await call('computerUse/revoke', { threadId: ordinaryThread });
        assert.equal(revoked.revoked, true);
        await new Promise(accept => setTimeout(accept, 4200));
      }
      if (index > 0) discovered ||= JSON.stringify(parsed.messages).includes('mcp__searxng__search');
      const last = parsed.messages.filter(message => message.role === 'tool').at(-1);
      if (index === 2) { try { searchResult = JSON.parse(last?.content ?? 'null'); } catch { searchResult = { error: String(last?.content).slice(0, 500) }; } }
      let delta, finish;
      if (index === 0 || (index === 1 && input.liveQuery)) {
        const name = index === 0 ? 'tool_search' : 'tool_execute';
        const arguments_ = index === 0 ? { query: 'searxng', limit: 5 } : { tool_name: 'mcp__searxng__search', arguments: { query: input.liveQuery, limit: 3 } };
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: `native-search-${index}`, type: 'function', function: { name, arguments: JSON.stringify(arguments_) } }] };
        finish = 'tool_calls';
      } else { delta = { role: 'assistant', content: 'Owned search diagnostic completed.' }; finish = 'stop'; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n');
    } catch { response.writeHead(400); response.end('Owned fixture rejected the request'); }
  });
  await new Promise(accept => fixture.listen(0, '127.0.0.1', accept));
  const settingsPath = join(profile, 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  settings.providers.nativeFixture.endpoint = `http://127.0.0.1:${fixture.address().port}/v1`;
  await writeFile(settingsPath, JSON.stringify(settings));
  const child = spawn(binary, ['app-server'], { cwd: workspace, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let next = 0, diagnostic = '', complete;
  const turnComplete = new Promise(accept => { complete = accept; });
  child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-8192); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const frame = JSON.parse(line); if (frame.method === 'turn/completed') complete(frame.params); const waiter = pending.get(frame.id); if (waiter) { pending.delete(frame.id); frame.error ? waiter.reject(Error(`Native RPC ${waiter.method}: ${frame.error.message}`)) : waiter.resolve(frame.result); } });
  const call = (method, params) => new Promise((accept, reject) => {
    const id = ++next;
    pending.set(id, { resolve: accept, reject, method });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const timer = setTimeout(() => { complete({ error: { message: 'Native turn deadline exceeded' } }); child.kill(); for (const waiter of pending.values()) waiter.reject(Error('Native app-server response timed out')); }, 120000);
  child.once('error', error => { for (const waiter of pending.values()) waiter.reject(error); });
  child.once('exit', () => { for (const waiter of pending.values()) waiter.reject(Error('Native app-server exited before response')); });
  try {
    const began = Date.now();
    await call('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-windows-package', version: '1' }, capabilities: { experimental: { studioWorkModesV1: true, inlineWidgetsV1: true, sessionLifetimeV1: true, computerUseRecoveryV1: true } } });
    const started = await call('thread/start', { studioWorkMode: 'kworker', cwd: workspace });
    ordinaryThread = started.thread.id;
    const lifetime = await call('thread/lifetime/read', { threadId: started.thread.id });
    assert.equal(lifetime.setting.mode, 'background');
    assert.equal(lifetime.attachedClients, 0);
    assert.equal(lifetime.pausedReason, null);
    const catalog = await call('tools/catalog', { threadId: started.thread.id });
    const result = await call('mcp/list', {});
    const registrationMs = Date.now() - began;
    await writeFile(join(root, 'app-server-search.json'), JSON.stringify({ registrationMs,
      servers: result.servers, hasSearchTool: JSON.stringify(catalog).includes('mcp__searxng__search'), phase: 'registered' }));
    await call('turn/start', { threadId: started.thread.id,
      clientPresentation: { version: 1, studioWorkMode: 'kworker', inlineWidgets: true },
      input: [{ type: 'text', text: 'Perform the explicitly requested read-only SearXNG diagnostic.' }] });
    const completed = await turnComplete;
    assert.ok(!completed.error, 'native diagnostic turn must reach successful completion');
    assert.equal(discovered, true, 'tool_search must return the registered SearXNG definition');
    assert.equal(requests, input.liveQuery ? 3 : 2);
    if (input.liveQuery) {
      assert.ok(Array.isArray(searchResult?.results), 'actual MCP search must return its JSON search contract: ' + JSON.stringify(searchResult).slice(0, 2000));
      assert.ok(searchResult.results.length > 0, 'No upstream results: ' + JSON.stringify(searchResult.unresponsive_engines ?? []));
    }
    console.log(JSON.stringify({ initializeMs: Date.now() - began, servers: result.servers,
      registrationMs, hasSearchTool: JSON.stringify(catalog).includes('mcp__searxng__search'),
      toolSearchReturnedDefinition: discovered, unattendedTurnCompleted: true, ordinaryDesktopRevocationIsolated: true, fixtureRequests: requests, realProviderRequests: 0,
      ...(input.liveQuery ? { liveSearch: { resultCount: searchResult.results.length, incomplete: !!searchResult.incomplete,
        unresponsiveEngines: searchResult.unresponsive_engines ?? [] } } : {}) }));
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    await new Promise(accept => { if (child.exitCode !== null) accept(); else { const deadline = setTimeout(() => child.kill(), 5000); child.once('exit', () => { clearTimeout(deadline); accept(); }); } });
    lines.close();
    fixture.closeAllConnections();
    await new Promise(accept => fixture.close(accept));
  }
  process.exit(0);
}

assert.equal(process.platform, 'win32');
assert.equal(JSON.parse(await readFile(join(root, '.owner.json'), 'utf8')).owner, input.owner);
for (const directory of [profile, workspace, ambient, temporary]) await mkdir(directory, { recursive: true });
const creation = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}').CreationDate.ToUniversalTime().Ticks.ToString()`], { windowsHide: true, timeout: 10000, encoding: 'utf8' }).trim();
assert.match(creation, /^\d+$/);
await writeFile(join(root, 'probe-owner.json'), JSON.stringify({ owner: input.owner, pid: process.pid, creationTicks: creation }));
process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = join(app, 'resources/bin/kcoder-process-supervisor.exe');
const active = new Set();
let finished = false;
const authority = createInterface({ input: process.stdin });
const lostOwner = () => {
  if (!finished) { for (const child of active) child.stdin.destroy(); process.exit(2); }
};
authority.on('close', lostOwner);
const first = await new Promise((accept, reject) => { authority.once('line', line => { try { accept(JSON.parse(line)); } catch { reject(Error('Invalid probe authority')); } }); authority.once('close', () => { if (!finished) reject(Error('Probe owner disconnected')); }); });
assert.equal(first.owner, input.owner);

async function run(command, args, env = environment, timeoutMs = 60000) {
  const { child, identity } = spawnWindowsSupervised(command, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] }, join(root, 'process-status'));
  active.add(child);
  let stdout = '', stderr = '', bytes = 0;
  const completion = new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.stdin.destroy(); reject(Error('Owned native command timed out')); }, timeoutMs);
    const collect = field => data => { bytes += data.length; if (bytes > 2 * 1024 * 1024) { child.stdin.destroy(); reject(Error('Owned native output exceeded limit')); } else if (field === 'stdout') stdout += data; else stderr += data; };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); active.delete(child); accept({ code, stdout, stderr }); });
  });
  await identity.readyPromise;
  const result = await completion;
  if (result.code !== 0) throw Error(`Owned native command failed (${result.code}): ${result.stderr.slice(-2500)}`);
  return result;
}

const results = [];
async function check(name, body) {
  const start = Date.now();
  try { const details = await body(); results.push({ name, status: 'passed', durationMs: Date.now() - start, details }); }
  catch (error) { results.push({ name, status: 'failed', durationMs: Date.now() - start, error: String(error.message).slice(-3000) }); }
  await writeFile(join(root, 'probe-result.json'), JSON.stringify({ passed: results.every(x => x.status === 'passed'), results }, null, 2));
}

async function verifyBuildIdentity(manifest) {
  const output = (await run(binary, ['doctor'])).stdout;
  const commit = /^build commit: (.+)$/m.exec(output)?.[1]?.trim();
  const dirty = /^build dirty: (.+)$/m.exec(output)?.[1]?.trim();
  const version = /^version: (.+)$/m.exec(output)?.[1]?.trim();
  const executableSha256 = /^executable sha256: (.+)$/m.exec(output)?.[1]?.trim();
  assert.equal(commit, input.nativeCommit ?? input.commit); assert.equal(dirty, 'false');
  assert.equal(version, manifest.versions.cli); assert.equal(executableSha256, input.cliSha256);
  assert.equal(manifest.packagingSource.dirty, false);
  return { buildCommit: commit, packagingCommit: manifest.packagingSource.commit, buildDirty: false, studioVersion: manifest.versions.studio,
    cliVersion: version, cliSha256: executableSha256 };
}

try {
  const manifest = JSON.parse(await readFile(join(app, 'resources/kcoder-release-manifest.json'), 'utf8'));
  assert.equal(manifest.packagingSource.commit, input.commit);
  assert.equal(sha(await readFile(binary)), input.cliSha256);
  if (input.focus === 'workflow-draft') {
    await check('native-workflow-draft-read-write-and-last-view-detach', async () =>
      JSON.parse((await run(process.execPath, [script, process.argv[2], '--rpc'], environment, 180000)).stdout));
  } else if(input.focus==='native-web-search') {
    await check('actual-native-web-search-without-search-configuration',async()=>JSON.parse((await run(process.execPath,[script,process.argv[2],'--rpc'],environment,180000)).stdout));
  } else
  if (input.focus === 'task-board') {
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ credential_store: 'file', active_provider: 'nativeFixture', model: 'fixture', mcp_servers: [], providers: { nativeFixture: { api_format: 'openai_chat_completions', endpoint: 'http://127.0.0.1:9/v1', default_model: 'fixture', authentication: { mode: 'none' }, discover_models: false, context_window_tokens: 128000, max_output_tokens: 256, output_headroom_tokens: 1024 } } }));
    await check('packaged-cli-native-build-identity', () => verifyBuildIdentity(manifest));
    await check('native-task-board-original-terminal-records', async () => {
      const result = JSON.parse((await run(process.execPath, [script, process.argv[2], '--rpc'], environment, 180000)).stdout);
      assert.equal(result.passed, true);
      return result;
    });
  } else if (input.focus === 'migration') {
    await writeFile(join(workspace, 'AGENTS.md'), 'This is an owned native package fixture. Do not inspect parent guides.\n');
    if (input.catalogLockTestsSha256) await check('native-catalog-lock-regressions', async () => {
      const tests = join(root, 'catalog-lock-tests.exe');
      assert.equal(sha(await readFile(tests)), input.catalogLockTestsSha256);
      const fullVfs = input.catalogLockTestMode === 'vfs';
      const output = (await run(tests, [...(fullVfs ? ['history_index::files::tests::private_catalog_windows_'] : []), '--test-threads=1'], environment)).stdout;
      assert.match(output, fullVfs ? /test result: ok\. 2 passed; 0 failed; 0 ignored/ : /test result: ok\. 4 passed; 0 failed; 1 ignored/);
      return { binarySha256: input.catalogLockTestsSha256, output: output.trim(),
        helperIgnoredInParent: !fullVfs, scope: fullVfs ? 'full native State VFS upgrades and legacy busy classification; separate test executable' : 'new Windows lock implementation; separate from the frozen product binary' };
    });
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ credential_store: 'file',
      active_provider: 'nativeFixture', mcp_servers: [], providers: { nativeFixture: {
        api_format: 'openai_chat_completions', endpoint: 'http://127.0.0.1:9/v1', default_model: 'fixture',
        authentication: { mode: 'none' }, discover_models: false,
        context_window_tokens: 128000, max_output_tokens: 4096, output_headroom_tokens: 4096,
      } } }));
    await check('packaged-cli-native-build-identity', () => verifyBuildIdentity(manifest));
    if(input.taskContinuation){
      await check(input.taskContinuation.noModel?'native-existing-source-archive-and-idle-continuation':'native-windows-real-model-import-and-continue',async()=>{
        const result=JSON.parse((await run(process.execPath,[script,process.argv[2],'--migration-task'],environment,210000)).stdout);
        assert.equal(result.passed,true);return result;
      });
    } else {
    await check('native-windows-terminal-pty', async () => {
      const result = JSON.parse((await run(process.execPath, [script, process.argv[2], '--terminal-rpc'], environment, 45000)).stdout);
      assert.equal(result.passed, true); return result;
    });
    await check('native-migration-archive-cancel-and-idle-continuation', async () => {
      const result = JSON.parse((await run(process.execPath, [script, process.argv[2], '--rpc'], environment, 150000)).stdout);
      assert.equal(result.passed, true); return result;
    });
    }
  } else {
  if (input.focus !== 'studio') {
  await check('packaged-cli-native-start', async () => ({ version: (await run(binary, ['--version'])).stdout.trim(), studioVersion: manifest.versions.studio }));
  const search = join(app, 'resources/searxng');
  const runtime = JSON.parse(await readFile(join(search, 'runtime-manifest.json'), 'utf8'));
  const python = join(search, runtime.python);
  await check('bundled-python-native-imports', async () => JSON.parse((await run(python, ['-I', '-B', join(search, 'launch.py'), '--check'])).stdout));
  await check('bundled-searxng-offline-real-search-and-cleanup', async () => {
    await run(python, ['-I', '-B', join(root, 'test-searxng.py'), '--runtime', search]);
    return { offlineFixtureSearch: true, noPublicSearchTraffic: true };
  });
  }
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ credential_store: 'file', permission_mode: 'bypass', max_retries: 0,
    active_provider: 'nativeFixture', model: 'fixture', providers: { nativeFixture: {
      api_format: 'openai_chat_completions', endpoint: 'http://127.0.0.1:9/v1', default_model: 'fixture',
      authentication: { mode: 'none' }, context_window_tokens: 128000, max_output_tokens: 4096, output_headroom_tokens: 4096,
    } }, mcp_servers: [{ name: 'searxng', transport: 'searxng' }] }));
  await check('packaged-cli-native-build-identity', () => verifyBuildIdentity(manifest));
  if (input.focus !== 'studio') {
  await check('packaged-cli-searxng-initialization-and-discovery', async () => {
    const result = await run(binary, ['mcp', 'test', 'searxng'], environment, 90000);
    assert.match(result.stdout, /Initialized 'searxng': [1-9]\d* tools discovered/);
    return { output: result.stdout.trim() };
  });
  }
  await check('studio-app-server-searxng-startup', async () => {
    const result = JSON.parse((await run(process.execPath, [script, process.argv[2], '--rpc'], environment, 150000)).stdout);
    await writeFile(join(root, 'app-server-search.json'), JSON.stringify(result));
    const server = result.servers.find(server => server.name === 'searxng');
    assert.equal(server?.lastConnectionAttempt, 'ready', 'new Studio backend must actually initialize the bundled MCP');
    assert.equal(result.hasSearchTool, true, 'the KWorker conversation catalog must contain the registered search tool');
    return result;
  });
  }
} finally {
  finished = true;
  authority.close();
  for (const child of active) child.stdin.destroy();
}
const result = { passed: results.every(x => x.status === 'passed'), platform: process.platform, packageCommit: input.commit,
  packageCliSha256: input.cliSha256, guiAcceptance: 'not_run', results };
await writeFile(join(root, 'probe-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exitCode = result.passed ? 0 : 1;
