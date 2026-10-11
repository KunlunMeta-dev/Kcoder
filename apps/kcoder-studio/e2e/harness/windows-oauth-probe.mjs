import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { startOAuthMcpFixture } from './oauth-mcp.mjs';
import { createMcpOAuthCallbackReceiver } from './mcp-oauth-callback.mjs';

const [binary, ownedDirectory] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
const root = fs.mkdtempSync(path.join(ownedDirectory, 'oauth-'));
const secrets = new Set();
const cleanups = [];
const context = {
  registerSecret(value) { if (value) secrets.add(String(value)); },
  registerPort() {},
  addCleanup(_label, callback) { cleanups.push(callback); },
};
let child, lines;
const results = [];
let passed = true;
try {
  for (const manual of [false, true]) {
    const secret = randomBytes(24).toString('hex');
    context.registerSecret(secret);
    const fixture = await startOAuthMcpFixture(context, {
      resourceScopes: ['probe:read'],
      manualClient: manual ? { id: 'windows-client', secret, method: 'client_secret_basic' } : null,
    });
    const config = path.join(root, manual ? 'manual-config' : 'dynamic-config');
    const workspace = path.join(root, manual ? 'manual-workspace' : 'dynamic-workspace');
    fs.mkdirSync(config); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({
      providers: {}, mcp_servers: [{ name: 'windows-oauth', transport: 'http', url: fixture.root + '/mcp' }],
    }));
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC'])
      if (process.env[key]) env[key] = process.env[key];
    child = spawn(binary, ['--cwd', workspace, '--tool-profile', 'full', 'app-server'], {
      cwd: workspace, env: { ...env, KCODER_CONFIG_DIR: config }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    lines = createInterface({ input: child.stdout });
    const pending = new Map();
    let sequence = 0;
    lines.on('line', line => {
      const message = JSON.parse(line);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    });
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 30000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'windows-oauth-probe', version: '1' } });
    const receiver = await createMcpOAuthCallbackReceiver();
    cleanups.push(() => receiver.close());
    const login = await rpc('mcp/login', {
      server: { name: 'windows-oauth' }, redirectUri: receiver.redirectUri,
      ...(manual ? { clientId: 'windows-client', clientAuthentication: 'client_secret_basic', clientSecret: secret } : {}),
    });
    context.registerSecret(login.authorizationUrl);
    receiver.bindAuthorizationUrl(login.authorizationUrl);
    const browser = await fetch(login.authorizationUrl);
    assert.equal(browser.status, 200);
    await browser.text();
    const callback = await receiver.result;
    assert.equal(callback.status, 'received');
    await rpc('mcp/callback', { flowId: login.flowId, callbackUrl: callback.callbackUrl });
    assert.equal((await rpc('mcp/list')).servers[0].authorization, 'authorized');
    const before = await rpc('thread/start');
    assert.ok(JSON.stringify(await rpc('tools/catalog', { threadId: before.thread.id })).includes('oauth_probe'));
    await rpc('mcp/logout', { name: 'windows-oauth' });
    assert.equal((await rpc('mcp/list')).servers[0].authorization, 'notAuthorized');
    const after = await rpc('thread/start');
    assert.ok(!JSON.stringify(await rpc('tools/catalog', { threadId: after.thread.id })).includes('oauth_probe'));
    for (const thread of [before.thread, after.thread]) await rpc('thread/delete', { threadId: thread.id });
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Windows app-server did not stop')), 10000);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    child.stdin.end();
    assert.equal(await exited, 0);
    lines.close();
    results.push({ mode: manual ? 'manual-basic' : 'dynamic', authorized: true, newSessionTools: true, logoutReload: true, events: fixture.events });
  }
} catch (error) {
  let message = error.message;
  for (const secret of secrets) message = message.split(secret).join('[redacted]');
  results.push({ error: message });
  passed = false;
} finally {
  lines?.close();
  if (child && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  for (const cleanup of cleanups.reverse()) await cleanup();
  fs.rmSync(root, { recursive: true });
  console.log(JSON.stringify({ passed, nativeWindows: true, results, cleaned: !fs.existsSync(root) }));
}
