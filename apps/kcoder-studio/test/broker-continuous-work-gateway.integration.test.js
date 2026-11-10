import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import WebSocket from 'ws';

const studio = fileURLToPath(new URL('..', import.meta.url));
const peer = fileURLToPath(new URL('./fixtures/continuous-work-peer.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label) {
  for (let i = 0; i < 500; i++) { const value = await condition(); if (value) return value; await delay(20); }
  throw new Error(`Timed out waiting for ${label}`);
}
function rpc(socket) {
  const pending = new Map(); let next = 0;
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (pending.has(message.id)) { const done = pending.get(message.id); pending.delete(message.id); done(message); }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No Gateway response for ${method}`)); }, 10_000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}
const init = offer => ({ protocolVersion: '2026-07-27', clientInfo: { name: 'owned-gateway-test', version: '1' },
  capabilities: { experimental: offer ? { continuousWorkV1: true } : {} } });

test('actual authenticated Gateway keeps ordinary sessions and capability negotiation separate from optional integrations',
  { timeout: 40_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'kcoder-work-gateway-'));
    const config = join(root, 'config'), web = join(root, 'web');
    const store = join(root, 'servers.json'), trace = join(root, 'trace.jsonl');
    await Promise.all([mkdir(config, { mode: 0o700 }), mkdir(web, { mode: 0o700 })]);
    await writeFile(join(web, 'index.html'), '<!doctype html><title>Gateway test</title>');
    await writeFile(trace, '');
    const targets = [];
    for (const [target, advertiseWork] of [['legacy', false], ['controlled', true]]) {
      const workspace = join(root, target);
      await mkdir(workspace, { mode: 0o700 });
      await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module' }));
      await writeFile(join(workspace, 'controlled-peer.json'), JSON.stringify({ target, advertiseWork }));
      await copyFile(peer, join(workspace, 'app-server'));
      targets.push({ id: target, label: target, runtime: 'kcoder', transport: 'local', command: process.execPath, workspace });
    }
    await writeFile(store, JSON.stringify(targets));
    const token = 'owned-integration-test-token';
    // All configuration and fixture resources are owned by this test. Do not
    // propagate personal environment variables to the Gateway or its peer.
    const gateway = spawn(process.execPath, ['dev-server.mjs'], { cwd: studio, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      NODE_ENV: 'test', TMPDIR: root, TMP: root, TEMP: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
      KCODER_NATIVE_CONNECTIVITY_BINDING_V1: 'owned-fixture-without-native-component',
      KCODER_CONFIG_DIR: config, KCODER_STUDIO_SERVERS_STORE: store, KCODER_STUDIO_WORKSPACE: join(root, 'legacy'),
      KCODER_STUDIO_WEB_ROOT: web, KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0',
      KCODER_STUDIO_AUTH_TOKEN: token, KCODER_P1_TEST_TRACE: trace,
    } });
    let output = ''; gateway.stdout.on('data', chunk => { output += chunk.toString(); });
    gateway.stderr.resume();
    const sockets = [];
    const closed = once(gateway, 'close');
    t.after(async () => {
      for (const socket of sockets) socket.terminate();
      if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill('SIGTERM');
      const deadline = new Promise(resolve => { const timer = setTimeout(() => resolve(false), 8_000); timer.unref(); });
      const result = await Promise.race([closed.then(() => true), deadline]);
      assert.equal(result, true, `Owned Gateway did not exit; fixture retained at ${root}`);
      const lines = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      const started = new Set(lines.filter(item => item.event === 'spawn').map(item => item.pid));
      const finished = new Set(lines.filter(item => item.event === 'exit').map(item => item.pid));
      assert.ok([...started].every(pid => finished.has(pid)), `Owned peer did not exit; fixture retained at ${root}`);
      await rm(root, { recursive: true, force: true });
    });
    const base = await until(() => output.match(/KCoder Studio: (http:\/\/127\.0\.0\.1:\d+)/)?.[1], 'Gateway listener');
    const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    async function connect(server) {
      const url = new URL('/rpc', base); url.protocol = 'ws:';
      url.searchParams.set('token', 'cookie-auth'); url.searchParams.set('server', server);
      const socket = new WebSocket(url, { headers: { cookie, origin: base } }); sockets.push(socket);
      await once(socket, 'open'); return rpc(socket);
    }
    const legacy = await connect('legacy');
    const legacyInit = await legacy('initialize', init(true));
    assert.notEqual(legacyInit.result.capabilities.experimental.continuousWorkV1, true);
    assert.equal((await legacy('thread/start')).result.thread.id, 'owned-thread');
    assert.equal((await legacy('turn/start', { threadId: 'owned-thread', input: [{ type: 'text', text: 'hello' }] })).result.turn.id, 'owned-turn');
    assert.equal((await legacy('work/list')).error.code, -32601);
    const oldClient = await connect('controlled');
    assert.equal((await oldClient('initialize', init(false))).result.capabilities.experimental.continuousWorkV1, false);
    assert.equal((await oldClient('work/list')).error.code, -32601);
    const current = await connect('controlled');
    assert.equal((await current('initialize', init(true))).result.capabilities.experimental.continuousWorkV1, true);
    assert.equal((await current('work/list')).result.items[0].workId, 'work-1');
    const records = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    const spawned = records.filter(item => item.event === 'spawn');
    assert.deepEqual(new Set(spawned.map(item => item.target)), new Set(['legacy', 'controlled']));
    assert.ok(spawned.every(item => !item.nativeOffice && !item.nativeConnectivity));
    assert.deepEqual(records.filter(item => item.method === 'work/list').map(item => item.target), ['controlled']);
    const socketClosures = sockets.map(socket => once(socket, 'close'));
    const logout = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base } });
    assert.equal(logout.status, 303);
    await Promise.all(socketClosures);
  });
