// Only owned child processes, identities and loopback TLS peers.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { prepareClientIdentity, saveRegisteredClientIdentity } from '../../src/client-identity.mjs';

export const clientPath = fileURLToPath(new URL('../../src/client.mjs', import.meta.url));
export const gatewaySecret = 'owned-client-fix-internal-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const secret = 'owned-client-fix-control-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const registrationKey = 'owned-client-fix-register-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const assignment = { id: 'owned-client-fix', secret };
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function bounded(promise, ms = 4000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('owned client safety deadline')), ms);
  })]); } finally { clearTimeout(timer); }
}
export async function ownedRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-client-fixes-')), cleanup = [];
  t.after(async () => {
    const results = await Promise.allSettled(cleanup.map(close => close()));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    await rm(root, { recursive: true, force: true });
  });
  return { root, close: callback => cleanup.push(callback) };
}
export function environment(root, extra = {}) {
  return { PATH: process.env.PATH || '', HOME: root, TMPDIR: root, XDG_STATE_HOME: join(root, 'state'),
    KCODER_RELAY_ENV_FILE: join(root, 'absent.env'), ...extra };
}
export function capture(args, env, cwd, stopWhenOnline = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, stopped = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 8000);
    child.stdout.on('data', data => {
      stdout = (stdout + data).slice(-65536);
      if (stopWhenOnline && !stopped && stdout.includes('KCoder relay connected')) {
        stopped = true; child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-65536); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
  });
}
export async function tlsCliFixture(t) {
  const owned = await ownedRoot(t), key = join(owned.root, 'tls.key'), cert = join(owned.root, 'tls.crt');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=owned-client-fix', '-addext', 'subjectAltName=IP:127.0.0.1'],
  { env: { PATH: process.env.PATH || '', OPENSSL_CONF: '/dev/null', HOME: owned.root } });
  const sockets = new Set(), requests = [], peers = new WebSocketServer({ noServer: true });
  let status = () => 401;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('secureConnection', socket => socket.on('error', () => {}));
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    requests.push(request.url);
    if (status(requests.length) === 101) peers.handleUpgrade(request, socket, head, peer => peer.on('error', () => {}));
    else socket.end(`HTTP/1.1 ${status(requests.length)} Owned rejection\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  owned.close(async () => {
    for (const peer of peers.clients) peer.terminate(); for (const socket of sockets) socket.destroy();
    await bounded(Promise.all([new Promise(resolve => peers.close(resolve)), new Promise(resolve => server.close(resolve))]));
    assert.equal(sockets.size, 0); assert.equal(peers.clients.size, 0);
  });
  const url = `https://127.0.0.1:${server.address().port}`, identityFile = join(owned.root, 'identity.json');
  const pending = await prepareClientIdentity({ identityFile, relayUrl: url, gatewaySecret });
  await saveRegisteredClientIdentity({ identityFile, relayUrl: url, gatewaySecret, ...pending, ...assignment });
  const env = environment(owned.root, { NODE_EXTRA_CA_CERTS: cert, KCODER_RELAY_IDENTITY_FILE: identityFile,
    KCODER_RELAY_PUBLIC_URL: url, KCODER_RELAY_GATEWAY_SECRET: gatewaySecret });
  return { ...owned, env, requests, setStatus: next => { status = next; } };
}
