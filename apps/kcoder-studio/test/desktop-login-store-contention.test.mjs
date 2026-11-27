import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { windowsPrivateDeviceStorage } from '../src/mobile-device-private-storage.js';

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function waitForGateway(child) {
  return new Promise((resolveReady, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('owned Gateway did not become ready')), 30_000);
    const finish = (error, value) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      child.stdout.resume();
      if (error) reject(error); else resolveReady(value);
    };
    const onData = chunk => {
      output = (output + chunk).slice(-16_384);
      const match = output.match(/KCoder Studio: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) finish(null, match[1]);
    };
    const onExit = () => finish(new Error('owned Gateway exited before readiness'));
    const onError = () => finish(new Error('owned Gateway could not be spawned'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

test('desktop login waits for temporary private-store contention and fails closed when it persists', { timeout: 75_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-desktop-login-contention-'));
  const data = join(root, 'data'), config = join(root, 'config'), web = join(root, 'web');
  await Promise.all([mkdir(data), mkdir(config), mkdir(web)]);
  await writeFile(join(web, 'index.html'), '<!doctype html><title>Owned fixture</title>');
  const token = randomBytes(32).toString('hex');
  const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR']
    .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
  const script = process.env.KCODER_STUDIO_STORAGE_TEST_GATEWAY_SCRIPT || resolve(studioRoot, 'dev-server.mjs');
  const child = spawn(process.execPath, [script], { cwd: studioRoot, windowsHide: true,
    env: { ...inherited, NODE_ENV: 'test', KCODER_HOME: config, KCODER_CONFIG_DIR: config,
      KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0', KCODER_STUDIO_AUTH_TOKEN: token,
      KCODER_STUDIO_DATA_DIR: data, KCODER_STUDIO_SERVERS_STORE: join(root, 'servers.json'),
      KCODER_STUDIO_WORKSPACE: root, KCODER_STUDIO_WEB_ROOT: web, KCODER_STUDIO_RENDERER_MODE: 'static',
      KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_P2P: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  let lock, release;
  t.after(async () => {
    clearTimeout(release);
    if (lock?.listening) await new Promise(done => lock.close(done));
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit').catch(() => {});
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      timer.unref();
      await exited;
      clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  });
  const url = await waitForGateway(child);
  const storage = join(data, 'mobile-device-auth');
  let identity;
  if (process.platform === 'win32') identity = await windowsPrivateDeviceStorage(storage, false);
  else { const info = await lstat(storage); identity = `local-file:${info.dev}:${info.ino}`; }
  const port = 49_152 + (parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 8), 16) % 16_384);
  lock = createServer();
  try {
    await new Promise((resolveListen, reject) => {
      lock.once('error', reject);
      lock.listen({ host: '127.0.0.1', port, exclusive: true }, resolveListen);
    });
  } catch (error) {
    if (['EADDRINUSE', 'EACCES'].includes(error.code)) { t.skip('fixture-derived lock port is unavailable'); return; }
    throw error;
  }
  release = setTimeout(() => lock.close(), 6_500);
  const response = await fetch(`${url}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }), signal: AbortSignal.timeout(25_000) });
  assert.equal(response.status, 303, 'a temporary store lock must not surface as HTTP 500');
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie || '', /^kcoder_studio_session=/);
  const servers = await fetch(`${url}/api/servers`, { headers: { cookie } });
  assert.equal(servers.status, 200);
  const before = await readFile(join(storage, 'devices.json'));
  lock = createServer();
  await new Promise((resolveListen, reject) => {
    lock.once('error', reject);
    lock.listen({ host: '127.0.0.1', port, exclusive: true }, resolveListen);
  });
  const denied = await fetch(`${url}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'incorrect' }) });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('x-kcoder-desktop-storage-failure'), null);
  const blocked = await fetch(`${url}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }), signal: AbortSignal.timeout(30_000) });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.headers.get('x-kcoder-desktop-storage-failure'), 'store_busy');
  assert.deepEqual(await readFile(join(storage, 'devices.json')), before);
  const renewal = await fetch(`${url}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ token, renewSession: '1' }), signal: AbortSignal.timeout(30_000) });
  assert.equal(renewal.status, 503);
  assert.equal(renewal.headers.get('x-kcoder-desktop-storage-failure'), 'store_busy');
  assert.deepEqual(await readFile(join(storage, 'devices.json')), before);
  await new Promise(done => lock.close(done));
  assert.equal((await fetch(`${url}/api/servers`, { headers: { cookie } })).status, 200);
});
