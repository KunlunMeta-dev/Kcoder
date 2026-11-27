// Explicit read-only-source review probes. All network and identity state is owned.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as tlsServer } from 'node:https';
import { createServer as tcpServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { startClient, ensureRegisteredClientIdentity, checkRegisteredClientAccess } from '../../src/client.mjs';
import { prepareClientIdentity, saveRegisteredClientIdentity, DEFAULT_IDENTITY_FILE } from '../../src/client-identity.mjs';

const fixturePath = fileURLToPath(import.meta.url);
const clientPath = fileURLToPath(new URL('../../src/client.mjs', import.meta.url));
const gatewaySecret = 'owned-internal-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const secret = 'owned-control-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const registrationKey = 'owned-register-key-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms = 4000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('owned client probe deadline')), ms);
  })]); } finally { clearTimeout(timer); }
}
function capture(args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, stdout, stderr }); });
  });
}
function environment(root, extra = {}) {
  return { PATH: process.env.PATH || '', HOME: root, TMPDIR: root, XDG_STATE_HOME: join(root, 'state'),
    KCODER_RELAY_ENV_FILE: join(root, 'absent.env'), ...extra };
}
async function assignedIdentity(identityFile, url) {
  const options = { identityFile, relayUrl: url, gatewaySecret };
  const pending = await prepareClientIdentity(options);
  await saveRegisteredClientIdentity({ ...options, ...pending, id: 'owned-client-review', secret });
}

async function wireChild(mode) {
  const server = createServer(), peers = new WebSocketServer({ server });
  const tcp = tcpServer(socket => { localConnections++; socket.on('error', () => {}); locals.add(socket); socket.once('close', () => locals.delete(socket)); });
  const locals = new Set(); let localConnections = 0, client, control;
  const events = [];
  peers.on('connection', (peer, request) => {
    peer.on('error', () => {});
    if (request.url === '/_relay/control') {
      control = peer;
      if (mode === 'null') peer.send('null');
      else if (mode === 'object-id') peer.send('{"type":"open","id":{"toString":null,"valueOf":null}}');
      else if (mode === 'primitive') {
        peer.send('42'); peer.send('{"type":"future_message"}');
        setTimeout(() => peer.send(JSON.stringify({ type: 'open', id: 'a'.repeat(48) })), 30);
      }
    }
  });
  tcp.listen(0, '127.0.0.1'); server.listen(0, '127.0.0.1');
  await Promise.all([once(tcp, 'listening'), once(server, 'listening')]);
  try {
    client = startClient({ url: `http://127.0.0.1:${server.address().port}`, allowInsecure: true,
      gateway: `http://127.0.0.1:${tcp.address().port}`, gatewayId: 'owned-client-review', secret,
      onOnline: mode === 'observer' ? () => { throw new Error('PRIVATE_CALLBACK_CANARY'); } : () => {},
      onDiagnostic: value => events.push(value.event) });
    await wait(160);
    console.log(JSON.stringify({ mode, controlOpen: control?.readyState === 1, localConnections,
      invalidOpen: events.filter(value => value === 'open_rejected').length,
      acceptedOpen: events.filter(value => value === 'open_received').length }));
  } finally {
    client?.close(); for (const peer of peers.clients) peer.terminate();
    for (const socket of locals) socket.destroy();
    await bounded(Promise.all([new Promise(resolve => peers.close(resolve)),
      new Promise(resolve => server.close(resolve)), new Promise(resolve => tcp.close(resolve))]));
  }
}

async function apiChild(mode, root) {
  const options = { url: 'https://owned-relay.example.test', gatewaySecret, registrationKey,
    identityFile: join(root, 'pending.json') };
  if (mode === 'default-file') {
    assert.ok(DEFAULT_IDENTITY_FILE.startsWith(root));
    const identityFile = join(root, 'selected.json');
    assert.equal(process.env.KCODER_RELAY_IDENTITY_FILE, identityFile);
    await assignedIdentity(identityFile, options.url);
    let sends = 0;
    const common = { url: options.url, gatewaySecret, fetchImpl: async () => { sends++; return new Response(null, { status: 204 }); } };
    const omitted = await checkRegisteredClientAccess(common), sendsAfterOmitted = sends;
    const explicit = await checkRegisteredClientAccess({ ...common, identityFile });
    return { omitted, explicit, sendsAfterOmitted, totalSends: sends };
  }
  const controller = new AbortController(); let reads = 0, sends = 0, sawFetch;
  const started = new Promise(resolve => { sawFetch = resolve; });
  let path, authorizationKind;
  const fetchImpl = async (url, init) => {
    sends++; sawFetch(); path = url.pathname; authorizationKind = init.headers.authorization.split(' ', 1)[0];
    if (mode === 'abort') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    if (mode === 'conflict') return new Response(null, { status: 401 });
    return { status: 201, headers: new Headers(), body: mode === 'reader-null' ? {
      getReader() { return { async read() { throw null; }, releaseLock() {} }; },
    } : {}, async text() { reads++; return ' '.repeat(65536); } };
  };
  const extras = mode === 'conflict' ? { accountSessionToken: 'a'.repeat(43), accountCredentials: { username: 'owned-user', password: 'owned-password-0123456789' } } : {};
  const originalAny = AbortSignal.any;
  if (mode === 'missing-any') AbortSignal.any = undefined;
  try {
    const pending = ensureRegisteredClientIdentity({ ...options, ...extras, fetchImpl,
      ...(['abort', 'missing-any'].includes(mode) ? { signal: controller.signal } : {}) });
    if (mode === 'abort') { await started; controller.abort(new DOMException('owned cancellation', 'AbortError')); }
    try { await pending; return { unexpectedSuccess: true }; }
    catch (error) { return { name: error.name, message: error.message, code: error.code ?? null,
      callerSignalAborted: controller.signal.aborted, sameReason: error === controller.signal.reason,
      sends, reads, path, authorizationKind }; }
  } finally { AbortSignal.any = originalAny; }
}

async function review() {
  const root = await mkdtemp(join(tmpdir(), 'relay-client-readonly-review-'));
  const observations = {};
  try {
    for (const mode of ['null', 'object-id', 'observer', 'primitive']) {
      const result = await capture([fixturePath, '--wire', mode], environment(root), root);
      assert.equal(result.timedOut, false);
      observations[mode] = { exitCode: result.code, signal: result.signal,
        typeError: result.stderr.includes('TypeError'), privateCallbackCanary: result.stderr.includes('PRIVATE_CALLBACK_CANARY'),
        observation: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null };
    }
    for (const mode of ['fallback', 'reader-null', 'abort', 'missing-any', 'conflict', 'default-file']) {
      const childRoot = await mkdtemp(join(root, 'api-'));
      const result = await capture([fixturePath, '--api', mode, childRoot], environment(childRoot,
        mode === 'default-file' ? { KCODER_RELAY_IDENTITY_FILE: join(childRoot, 'selected.json') } : {}), childRoot);
      assert.equal(result.timedOut, false); assert.equal(result.code, 0, 'owned API probe must complete');
      observations[mode] = JSON.parse(result.stdout.trim());
    }
    const key = join(root, 'tls.key'), cert = join(root, 'tls.crt');
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
      '-out', cert, '-days', '1', '-subj', '/CN=owned-client-review', '-addext', 'subjectAltName=IP:127.0.0.1']);
    const sockets = new Set(); let requests = 0;
    const server = tlsServer({ key: await readFile(key), cert: await readFile(cert) });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('upgrade', (_request, socket) => { requests++; socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const url = `https://127.0.0.1:${server.address().port}`, identityFile = join(root, 'cli.json');
      await assignedIdentity(identityFile, url);
      const env = environment(root, { NODE_EXTRA_CA_CERTS: cert, KCODER_RELAY_IDENTITY_FILE: identityFile,
        KCODER_RELAY_PUBLIC_URL: url, KCODER_RELAY_GATEWAY_SECRET: gatewaySecret });
      const denied = await capture([clientPath], env, root);
      assert.equal(denied.timedOut, false); assert.equal(requests, 1, 'real CLI TLS control request must reach the owned 401 peer');
      observations.cli401 = { exitCode: denied.code, attempts: requests, stdoutBytes: Buffer.byteLength(denied.stdout), stderrBytes: Buffer.byteLength(denied.stderr) };
      const invalid = await capture([clientPath], { ...env, KCODER_RELAY_LOCAL_GATEWAY: 'http://user:PRIVATE_CONFIG_CANARY@' }, root);
      observations.cliInvalidGateway = { exitCode: invalid.code, containsRawConfigCanary: invalid.stderr.includes('PRIVATE_CONFIG_CANARY'),
        containsStack: invalid.stderr.includes('at validateGateway'), extraRequests: requests - 1 };
    } finally { for (const socket of sockets) socket.destroy(); await bounded(new Promise(resolve => server.close(resolve))); assert.equal(sockets.size, 0); }
    console.log(JSON.stringify({ scope: 'observations, not production acceptance or fixes', observations, ownedChildrenSettled: true, realProviderRequests: 0 }, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[2] === '--wire') await wireChild(process.argv[3]);
else if (process.argv[2] === '--api') console.log(JSON.stringify(await apiChild(process.argv[3], process.argv[4])));
else await review();
