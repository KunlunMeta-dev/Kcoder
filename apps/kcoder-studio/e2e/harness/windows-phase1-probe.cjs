// Model-independent Windows protocol checks; all state belongs to the caller's run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const [binary, ownedDirectory] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok(binary && ownedDirectory);
const root = fs.mkdtempSync(path.join(ownedDirectory, 'phase1-'));
let child, lines, fixture;
let diagnostics = '', requests = 0, authenticatedRequests = 0;
let result = { passed: false };
const invokedPath = path.join(root, 'invoked-tool.json');
const mcpPidsPath = path.join(root, 'mcp-pids.jsonl');
const mcp = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result;if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'read/page',description:'original',inputSchema:{type:'object'}},{name:'read_page',description:'rejected',inputSchema:{type:'object'}},{name:'other',description:'survives',inputSchema:{type:'object'}}]};else if(m.method==='tools/call'){require('node:fs').writeFileSync(${JSON.stringify(invokedPath)},JSON.stringify({name:m.params.name}));result={content:[{type:'text',text:'ORIGINAL_MCP_RESULT'}]}}else result={};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}))});`;
async function main() {
  fixture = http.createServer((req, res) => {
    let body = '';
    req.on('data', data => { body += data; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture', object: 'model' }] }));
      return;
    }
    requests++;
    if (req.headers.authorization || req.headers['x-api-key']) authenticatedRequests++;
    let payload;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400); res.end(); return; }
    const callTool = payload.messages?.some(message => JSON.stringify(message.content).includes('WINDOWS_COLLISION_CALL'))
      && !payload.messages.some(message => message.role === 'tool');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = { id: 'probe', object: 'chat.completion.chunk', created: 1, model: 'fixture' };
    const delta = callTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'collision-call', type: 'function',
      function: { name: 'mcp__docs_original__read_page', arguments: '{}' } }] } : { role: 'assistant', content: 'OK' };
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: callTool ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const config = path.join(root, 'config'), workspace = path.join(root, 'workspace');
  fs.mkdirSync(config); fs.mkdirSync(workspace);
  // Preserve the established writable user settings entry point.
  const settings = path.join(config, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ active_provider: 'fixture', history_enabled: false,
    permission_mode: 'bypass',
    providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: `http://127.0.0.1:${fixture.address().port}/v1`, default_model: 'fixture',
      context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192 } },
    mcp_servers: [{ name: 'docs / original', transport: 'stdio', command: process.execPath,
      args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(mcpPidsPath)},JSON.stringify(process.pid)+'\\n');${mcp}`] }] }));
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC'])
    if (process.env[key]) env[key] = process.env[key];
  child = spawn(binary, ['--cwd', workspace, '--tool-profile', 'full', 'app-server'], {
    cwd: workspace, env: { ...env, KCODER_CONFIG_DIR: config }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-64000); });
  lines = createInterface({ input: child.stdout });
  let sequence = 0;
  const events = [];
  const pending = new Map();
  lines.on('line', line => {
    const message = JSON.parse(line), entry = pending.get(message.id);
    if (!entry) { if (message.method) events.push(message); return; }
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(Error(`${entry.method}: ${message.error.message}`)) : entry.resolve(message.result);
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 30000);
    pending.set(id, { resolve, reject, timer, method });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'windows-phase1', version: '1' } });
  const before = fs.readFileSync(settings, 'utf8');
  const templates = await rpc('runtime.providers.templates');
  assert.equal(templates.supportsAuthenticationPolicy, true);
  assert.equal(templates.templates.find(item => item.id === 'local-openai').authentication.mode, 'none');
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
  assert.equal(requests, 0);
  const capabilities = { text: true, tools: false, vision: false, reasoning: false, structured_output: false };
  await rpc('runtime.providers.upsert', { id: 'local-openai', apiFormat: 'openai_chat_completions',
    endpoint: `http://127.0.0.1:${fixture.address().port}/v1`, model: 'fixture-edited',
    contextWindowTokens: 32000, maxOutputTokens: 4096, authentication: { mode: 'none' }, capabilities, makeDefault: false });
  const saved = (await rpc('runtime.providers.list')).profiles.find(item => item.id === 'local-openai');
  assert.equal(saved.model, 'fixture-edited');
  assert.equal(saved.authentication.mode, 'none');
  assert.equal(saved.apiKeyConfigured, false);
  assert.deepEqual(saved.capabilities, capabilities);
  assert.ok(requests > 0 && requests <= 3);
  assert.equal(authenticatedRequests, 0);
  const credentialsPath = path.join(config, 'credentials.json');
  assert.equal(fs.existsSync(credentialsPath) && Object.hasOwn(JSON.parse(fs.readFileSync(credentialsPath)), 'local-openai'), false);
  const catalog = await rpc('tools/catalog');
  assert.equal(catalog.scope, 'workspace');
  assert.equal(catalog.cachePolicy, 'no-store');
  const names = catalog.tools.map(tool => tool.name);
  assert.equal(names.filter(name => name === 'mcp__docs_original__read_page').length, 1);
  assert.ok(names.includes('mcp__docs_original__other'));
  assert.equal(catalog.tools.find(tool => tool.name === 'mcp__docs_original__read_page').description, '[MCP: docs / original::read/page] original');
  assert.ok(catalog.tools.every(tool => tool.displayName && tool.icon && tool.group));
  const thread = (await rpc('thread/start')).thread.id;
  const scoped = await rpc('tools/catalog', { threadId: thread });
  assert.equal(scoped.scope, 'thread');
  assert.equal(scoped.threadId, thread);
  assert.ok(scoped.tools.length > 0);
  await assert.rejects(rpc('tools/catalog', { threadId: 'not-owned' }));
  await rpc('turn/start', { threadId: thread, input: [{ type: 'text', text: 'WINDOWS_COLLISION_CALL' }] });
  const deadline = Date.now() + 30000;
  let completed;
  while (!(completed = events.find(event => event.method === 'turn/completed' && event.params.threadId === thread))) {
    assert.ok(Date.now() < deadline, 'MCP collision turn timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(completed.params.turn.status, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(invokedPath, 'utf8')).name, 'read/page');
  assert.ok((await rpc('runtime.providers.list')).profiles.length > 0);
  child.stdin.end();
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('app-server shutdown timed out')), 10000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0);
  const mcpPids = fs.readFileSync(mcpPidsPath, 'utf8').trim().split('\n').map(JSON.parse);
  const stillAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const cleanupDeadline = Date.now() + 5000;
  while (mcpPids.some(stillAlive) && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(mcpPids.some(stillAlive), false, 'Owned MCP process survived app-server shutdown');
  assert.match(diagnostics, /tool registration conflict/);
  for (const value of ['docs / original', 'read/page', 'read_page']) assert.ok(diagnostics.includes(value));
  return { passed: true, nativeWindows: true, templatesInert: true, authenticationNone: true,
    capabilitiesPersisted: true, workspaceTools: names.length, threadTools: scoped.tools.length,
    collisionRejectedServiceAlive: true, originalMcpToolExecuted: true, ownedMcpProcessesExited: mcpPids.length,
    httpRequests: requests, exitCode: code };
}
(async () => {
  try { result = await main(); }
  catch (error) { result = { passed: false, error: error.message }; }
  finally {
    lines?.close();
    if (child && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
    fs.rmSync(root, { recursive: true });
  }
  console.log(JSON.stringify({ result, cleaned: !fs.existsSync(root) }));
})();
