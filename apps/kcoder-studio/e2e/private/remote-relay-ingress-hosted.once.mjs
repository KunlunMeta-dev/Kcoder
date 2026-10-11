import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { constants as fsConstants, closeSync, createReadStream, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONFIG_ARG = process.argv[2];
assert.ok(typeof CONFIG_ARG === 'string' && CONFIG_ARG.length > 0 && process.argv.length === 3,
  'usage: node remote-relay-ingress.once.mjs <private-config-path>');
const configPath = resolve(CONFIG_ARG);
const config = await readPrivateConfig(configPath);
const runRoot = config.runRoot;
const gatewayId = config.gatewayId;
const serverId = config.serverId;
const workspacePath = config.workspacePath;
const ingressPort = config.ingressPort;
assert.equal(ingressPort, 32552, 'the reviewed test443 sidecar targets the owned loopback ingress port');
assert.match(gatewayId, /^[a-f0-9]{32}$/);
assert.match(serverId, /^[A-Za-z0-9_-]{1,64}$/);
assert.ok(typeof workspacePath === 'string' && workspacePath.length > 0 && workspacePath.length <= 4096 && !workspacePath.includes('\0'));
assert.match(config.sharedHost, /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/);
for (const path of [config.relayRoot, config.registrationStoreFile, config.readyFile]) {
  assert.ok(path === runRoot || path.startsWith(`${runRoot}${sep}`), 'all remote runtime paths must stay inside this run root');
}
await assertOwnedPrivateFile(config.registrationStoreFile, 0o600);
await assertAbsent(config.readyFile);
writeProcessReceipt(config, configPath);

const relayEntry = pathToFileURL(resolve(config.relayRoot, 'src/server.mjs')).href;
const { startRelay } = await import(relayEntry);
let relay;
let ingress;
let stopping;
try {
  relay = await startRelay({
    gateways: [],
    sharedHosts: [config.sharedHost],
    registrationStoreFile: config.registrationStoreFile,
    controlPort: 0,
    proxyPort: 0,
  });
  ingress = await startIngress({ gatewayId, serverId, workspacePath, controlPort: relay.controlPort, proxyPort: relay.proxyPort, port: ingressPort });
  const ready = {
    version: 1,
    runId: config.runId,
    pid: process.pid,
    nodeVersion: process.version,
    nodeExecutable: await realpath(process.execPath),
    nodeExecutableSha256: await sha256File(process.execPath),
    cwd: process.cwd(),
    runRoot,
    ingressPort,
    controlPort: relay.controlPort,
    proxyPort: relay.proxyPort,
  };
  await writeFile(config.readyFile, `${JSON.stringify(ready)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ready: true, pid: ready.pid, ingressPort, controlPort: relay.controlPort, proxyPort: relay.proxyPort })}\n`);
} catch (error) {
  await shutdown().catch(() => {});
  process.stderr.write(`${JSON.stringify(safeFailure(error))}\n`);
  process.exitCode = 1;
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void shutdown().then(() => { process.exitCode = 0; }, error => {
      process.stderr.write(`${JSON.stringify(safeFailure(error))}\n`);
      process.exitCode = 1;
    });
  });
}

async function readPrivateConfig(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600,
    'private config must be an owned regular 0600 file');
  const value = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['gatewayId', 'ingressPort', 'readyFile', 'registrationStoreFile', 'relayRoot', 'runId', 'runRoot', 'serverId', 'sharedHost', 'workspacePath'].sort());
  assert.match(value.runId, /^[a-f0-9]{24}$/);
  const rootInfo = await lstat(value.runRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && rootInfo.uid === process.getuid() && (rootInfo.mode & 0o777) === 0o700,
    'run root must be an owned non-symlink 0700 directory');
  const rootReal = await realpath(value.runRoot);
  assert.equal(resolve(value.runRoot), rootReal, 'run root path must be canonical');
  assert.ok(resolve(path).startsWith(`${rootReal}${sep}`), 'private config must be inside the run root');
  return value;
}

async function assertOwnedPrivateFile(path, mode) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o777) === mode,
    'private Relay store must be an owned regular 0600 file');
}

async function assertAbsent(path) {
  try { await lstat(path); throw new Error('ready receipt already exists'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function writeProcessReceipt(config, configPath) {
  const rootInfo = lstatSync(config.runRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && rootInfo.uid === process.getuid()
    && (rootInfo.mode & 0o777) === 0o700, 'receipt root must remain the owned private directory');
  const ownerPath = resolve(config.runRoot, '.owner.json');
  const ownerInfo = lstatSync(ownerPath);
  assert.ok(ownerInfo.isFile() && !ownerInfo.isSymbolicLink() && ownerInfo.uid === process.getuid()
    && ownerInfo.nlink === 1 && (ownerInfo.mode & 0o777) === 0o600, 'receipt owner marker must be private and regular');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  assert.deepEqual(owner, { version: 1, runId: config.runId, uid: rootInfo.uid, dev: rootInfo.dev, ino: rootInfo.ino });
  assert.equal(process.geteuid(), owner.uid, 'Relay must run as the owner recorded for this run root');

  const procStat = readFileSync('/proc/self/stat', 'utf8');
  const statFields = procStat.slice(procStat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const exe = realpathSync('/proc/self/exe');
  const exeInfo = statSync('/proc/self/exe');
  const cwd = realpathSync('/proc/self/cwd');
  const argv = readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean);
  const entryPath = fileURLToPath(import.meta.url);
  assert.equal(exe, realpathSync(process.execPath));
  assert.equal(cwd, config.runRoot);
  assert.deepEqual(argv, [process.execPath, entryPath, configPath]);
  assert.deepEqual(process.argv, argv);
  const identity = {
    version: 1,
    runId: config.runId,
    rootDev: rootInfo.dev,
    rootIno: rootInfo.ino,
    pid: process.pid,
    starttime: Number(statFields[19]),
    exe,
    exeDev: exeInfo.dev,
    exeIno: exeInfo.ino,
    cwd,
    argv,
    euid: process.geteuid(),
    pgid: Number(statFields[2]),
  };
  assert.ok(Number.isSafeInteger(identity.starttime) && identity.starttime > 0);
  assert.ok(Number.isSafeInteger(identity.pgid) && identity.pgid > 0);
  const bytes = Buffer.from(`${JSON.stringify(identity)}\n`);
  const recordPath = resolve(config.runRoot, '.process.json');
  const fd = openSync(recordPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  let directoryFd;
  try {
    fchmodSync(fd, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      assert.ok(written > 0, 'process identity receipt write must make progress');
      offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    directoryFd = openSync(config.runRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    fsyncSync(directoryFd);
  } finally { if (directoryFd !== undefined) closeSync(directoryFd); }
}

async function startIngress({ gatewayId, serverId, workspacePath, controlPort, proxyPort, port }) {
  assert.ok(Number.isInteger(controlPort) && controlPort > 0 && Number.isInteger(proxyPort) && proxyPort > 0 && controlPort !== proxyPort);
  const sockets = new Set();
  const track = socket => {
    if (!sockets.has(socket)) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    }
    return socket;
  };
  const server = createServer((request, response) => {
    const targetPort = selectPort(request.url, request.method, false, gatewayId, serverId, workspacePath, controlPort, proxyPort);
    if (!targetPort) { response.writeHead(validRequestTarget(request.url) ? 404 : 400); response.end(); return; }
    const upstream = httpRequest(new URL(request.url, `http://127.0.0.1:${targetPort}`), {
      method: request.method,
      headers: request.headers,
      agent: false,
    }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('socket', track);
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('aborted', () => upstream.destroy());
    response.once('close', () => { if (!response.writableFinished) upstream.destroy(); });
    request.pipe(upstream);
  });
  server.on('connection', track);
  server.on('upgrade', (request, socket, head) => {
    const targetPort = selectPort(request.url, request.method, true, gatewayId, serverId, workspacePath, controlPort, proxyPort);
    if (!targetPort) { socket.destroy(); return; }
    const upstream = track(connect(targetPort, '127.0.0.1', () => {
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(request.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    }));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return {
    async close() {
      const closed = new Promise(resolveClose => server.listening ? server.close(resolveClose) : resolveClose());
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await closed;
    },
  };
}

function selectPort(rawUrl, method, upgrade, gatewayId, serverId, workspacePath, controlPort, proxyPort) {
  if (!validRequestTarget(rawUrl)) return null;
  const url = new URL(rawUrl, 'http://fixture.invalid');
  if (url.hash || url.pathname !== rawUrl.split('?', 1)[0]) return null;
  const one = name => url.searchParams.getAll(name).length === 1;
  const noQuery = !url.search;
  if (url.pathname === '/_relay/register' && !upgrade && method === 'POST' && noQuery) return controlPort;
  if (url.pathname === '/_relay/control' && upgrade && method === 'GET' && noQuery) return controlPort;
  if (url.pathname === '/_relay/data' && upgrade && method === 'GET' && one('id')
    && [...url.searchParams.keys()].every(key => key === 'id') && /^[a-f0-9]{48}$/.test(url.searchParams.get('id'))) return controlPort;
  const prefix = `/g/${gatewayId}`;
  if (!upgrade && ['GET', 'HEAD'].includes(method) && noQuery
    && (url.pathname === `${prefix}/mobile-entry` || url.pathname === `${prefix}/mobile`
      || url.pathname.startsWith(`${prefix}/mobile/`))) return proxyPort;
  if (url.pathname === `${prefix}/api/mobile/session` && !upgrade && ['POST', 'DELETE'].includes(method) && noQuery) return proxyPort;
  if (url.pathname === `${prefix}/api/servers` && !upgrade && method === 'GET' && noQuery) return proxyPort;
  if (url.pathname === `${prefix}/api/servers/status` && !upgrade && method === 'GET' && noQuery) return proxyPort;
  const workspaceCount = url.searchParams.getAll('workspace').length;
  const workspaceMatches = workspaceCount === 1 && url.searchParams.get('workspace') === workspacePath;
  if (url.pathname === `${prefix}/rpc` && upgrade && method === 'GET'
    && one('token') && one('server') && one('channel') && one('workspace') && workspaceMatches
    && [...url.searchParams.keys()].every(key => ['token', 'server', 'channel', 'workspace'].includes(key))
    && /^[A-Za-z0-9._~-]{1,512}$/.test(url.searchParams.get('token'))
    && url.searchParams.get('server') === serverId
    && url.searchParams.get('channel') === 'runtime' && workspaceMatches) return proxyPort;
  return null;
}

function validRequestTarget(value) {
  return typeof value === 'string' && value.length <= 8192 && value.startsWith('/') && !value.startsWith('//') && !/[\r\n\\]/.test(value);
}

async function shutdown() {
  if (stopping) return stopping;
  stopping = (async () => {
    const failures = [];
    try { if (ingress) await ingress.close(); } catch (error) { failures.push(error); }
    try { if (relay) await relay.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'remote Relay shutdown failed');
  })();
  return stopping;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function safeFailure(error) {
  const name = ['Error', 'TypeError', 'RangeError', 'AssertionError'].includes(error?.name) ? error.name : 'Error';
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;
  return { ready: false, errorName: name, ...(code ? { errorCode: code } : {}) };
}
