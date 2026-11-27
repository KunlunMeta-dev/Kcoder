import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pressureRoot = process.env.KCODER_TEST_ENOSPC_ROOT;

async function ready(child) {
  return new Promise((accept, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('owned Gateway readiness timeout')), 30_000);
    const finish = (error, value) => {
      clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', onError);
      child.stdout.resume(); if (error) reject(error); else accept(value);
    };
    const onData = chunk => {
      output = (output + chunk).slice(-16_384);
      const match = output.match(/KCoder Studio: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) finish(null, match[1]);
    };
    const onExit = () => finish(new Error('owned Gateway exited before readiness'));
    const onError = () => finish(new Error('owned Gateway could not be spawned'));
    child.stdout.setEncoding('utf8'); child.stdout.on('data', onData); child.once('exit', onExit); child.once('error', onError);
  });
}

test('desktop login safely retries transient ENOSPC and reports persistent exhaustion', {
  skip: !pressureRoot && 'Requires an explicitly owned small tmpfs', timeout: 45_000,
}, async t => {
  if (process.platform !== 'linux') throw new Error('An isolated Linux tmpfs is required');
  const rootInfo = await lstat(pressureRoot), actual = await realpath(pressureRoot), fs = await statfs(actual);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid()
    || fs.type !== 0x01021994 || fs.bsize * fs.blocks > 16 * 1024 * 1024 || (await readdir(actual)).length)
    throw new Error('The pressure fixture must be an empty owned tmpfs no larger than 16 MiB');
  const root = await mkdtemp(join(actual, 'desktop-login-'));
  const data = join(root, 'data'), config = join(root, 'config'), web = join(root, 'web');
  await Promise.all([mkdir(data), mkdir(config), mkdir(web)]);
  await writeFile(join(web, 'index.html'), '<!doctype html><title>Owned fixture</title>');
  const token = randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [resolve(studioRoot, 'dev-server.mjs')], { cwd: studioRoot,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', KCODER_HOME: config, KCODER_CONFIG_DIR: config,
      KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0', KCODER_STUDIO_AUTH_TOKEN: token,
      KCODER_STUDIO_DATA_DIR: data, KCODER_STUDIO_SERVERS_STORE: join(root, 'servers.json'),
      KCODER_STUDIO_WORKSPACE: root, KCODER_STUDIO_WEB_ROOT: web, KCODER_STUDIO_RENDERER_MODE: 'static',
      KCODER_STUDIO_MOCK: '1', KCODER_STUDIO_P2P: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  let timer;
  t.after(async () => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit').catch(() => {}); child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000); deadline.unref();
      await stopped; clearTimeout(deadline);
    }
    await rm(root, { recursive: true, force: true });
  });
  const url = await ready(child);
  const login = () => fetch(`${url}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }), signal: AbortSignal.timeout(15_000) });
  const first = await login(); assert.equal(first.status, 303);
  const cookie = first.headers.get('set-cookie');
  const ledger = join(data, 'mobile-device-auth', 'devices.json'), filler = join(root, 'owned-filler');
  async function fill() {
    const handle = await open(filler, 'wx'); let exhausted = false;
    try { const block = Buffer.alloc(1024 * 1024); for (let i = 0; i < 20; i++) await handle.write(block); }
    catch (error) { if (error.code !== 'ENOSPC') throw error; exhausted = true; }
    finally { await handle.close(); }
    assert.equal(exhausted, true);
  }
  await fill();
  const released = new Promise((accept, reject) => { timer = setTimeout(() => { rm(filler).then(accept, reject); }, 500); });
  const transient = await login(); await released;
  assert.equal(transient.status, 303, 'confirmed pre-rename exhaustion should retry after space returns');
  assert.equal((await fetch(`${url}/api/servers`, { headers: { cookie } })).status, 200);
  const before = await readFile(ledger);
  await fill();
  const blocked = await login();
  assert.equal(blocked.status, 503);
  assert.equal(blocked.headers.get('x-kcoder-desktop-storage-failure'), 'space_exhausted');
  assert.deepEqual(await readFile(ledger), before);
  await rm(filler);
  assert.equal((await fetch(`${url}/api/servers`, { headers: { cookie } })).status, 200);
  assert.equal((await login()).status, 303);
});
