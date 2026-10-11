import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const [binary, ownedRoot] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok(binary && ownedRoot);
const workspace = fs.mkdtempSync(path.join(ownedRoot, 'canva-session-'));
const child = spawn(binary, ['--cwd', workspace, '--tool-profile', 'full', 'app-server'], {
  cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.resume();
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let sequence = 0;
let threadId;
let stage = 'initialize';
const report = { installedRuntime: true, personalContentRead: false, modelRequestSent: false };
const exited = new Promise(resolve => child.once('exit', resolve));
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) entry.reject(new Error('RPC failed: ' + entry.method));
  else entry.resolve(message.result);
});
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout: ' + method)); }, 60000);
  pending.set(id, { resolve, reject, timer, method });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
try {
  await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'canva-authorized-verification', version: '1' } });
  stage = 'authorization-status';
  const servers = (await rpc('mcp/list')).servers.filter(server => /canva/i.test(server.name));
  report.canvaServers = servers.map(server => ({ name: server.name, authorization: server.authorization }));
  assert.ok(servers.some(server => server.authorization === 'authorized' || server.authorization === 'expired'));
  stage = 'new-session';
  const created = await rpc('thread/start');
  threadId = created.thread.id;
  const catalog = await rpc('tools/catalog', { threadId });
  report.canvaToolNames = catalog.tools.map(tool => tool.name).filter(name => /canva/i.test(name));
  report.catalogTruncated = catalog.truncated;
  assert.ok(report.canvaToolNames.length > 0);
  report.passed = true;
} catch {
  report.passed = false;
  report.failedStage = stage;
  process.exitCode = 1;
} finally {
  if (threadId) {
    try { await rpc('thread/delete', { threadId }); report.ownedThreadDeleted = true; }
    catch { report.ownedThreadDeleted = false; process.exitCode = 1; }
  }
  child.stdin.end();
  const timer = setTimeout(() => {
    if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }, 10000);
  await exited;
  clearTimeout(timer);
  lines.close();
  fs.rmSync(workspace, { recursive: true, force: true });
  report.ownedWorkspaceRemoved = !fs.existsSync(workspace);
  console.log(JSON.stringify(report));
}
