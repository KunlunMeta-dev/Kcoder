import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect, isIP } from 'node:net';
import { hostname } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireExecutable, runE2E, waitFor } from '../harness/run-context.mjs';

export const LAN_ROUTE_TLS_HOST = '10.31.6.5';

const CA_NICKNAME_PREFIX = 'kcoder-lan-route-e2e';
const MAX_CA_BYTES = 128 * 1024;

/** Generate a run-owned CA and an IP-SAN server certificate on the Gateway host. */
export async function createLanRouteTlsMaterial(context, { opensslPath = '/usr/bin/openssl' } = {}) {
  assertRunContext(context);
  const directory = context.pathInState('lan-route-tls');
  await createPrivateDirectory(context, directory, true);
  const paths = {
    caKey: resolve(directory, 'ca-key.pem'),
    caCert: resolve(directory, 'ca-cert.pem'),
    serverKey: resolve(directory, 'server-key.pem'),
    serverCsr: resolve(directory, 'server.csr'),
    serverCert: resolve(directory, 'server-cert.pem'),
    serverExtensions: resolve(directory, 'server-extensions.cnf'),
  };
  const openssl = await requireExecutable(opensslPath, 'OpenSSL');
  await writeFile(paths.serverExtensions,
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:10.31.6.5\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n',
    { flag: 'wx', mode: 0o600 });

  await runOwnedCommand(context, 'lan-route-ca-keygen', openssl, [
    'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', paths.caKey,
  ], directory);
  await runOwnedCommand(context, 'lan-route-ca-certgen', openssl, [
    'req', '-x509', '-new', '-key', paths.caKey, '-sha256', '-days', '2',
    '-subj', '/CN=KCoder LAN route test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', 'subjectKeyIdentifier=hash',
    '-out', paths.caCert,
  ], directory);
  await runOwnedCommand(context, 'lan-route-server-keygen', openssl, [
    'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', paths.serverKey,
  ], directory);
  await runOwnedCommand(context, 'lan-route-server-csr', openssl, [
    'req', '-new', '-key', paths.serverKey, '-sha256', '-subj', `/CN=${LAN_ROUTE_TLS_HOST}`,
    '-out', paths.serverCsr,
  ], directory);
  await runOwnedCommand(context, 'lan-route-server-certgen', openssl, [
    'x509', '-req', '-in', paths.serverCsr, '-CA', paths.caCert, '-CAkey', paths.caKey,
    '-CAcreateserial', '-days', '2', '-sha256', '-extfile', paths.serverExtensions,
    '-out', paths.serverCert,
  ], directory);
  await runOwnedCommand(context, 'lan-route-server-cert-verify', openssl, [
    'verify', '-CAfile', paths.caCert, '-verify_ip', LAN_ROUTE_TLS_HOST, paths.serverCert,
  ], directory);

  for (const path of Object.values(paths)) await chmod(path, 0o600);
  await verifyOwnedFile(context, paths.caKey, 0o600);
  await verifyOwnedFile(context, paths.serverKey, 0o600);
  await verifyOwnedFile(context, paths.caCert, 0o600);
  await verifyOwnedFile(context, paths.serverCert, 0o600);
  await verifyOwnedFile(context, paths.serverExtensions, 0o600);

  for (const path of [paths.caKey, paths.serverKey]) {
    for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
      if (line && !line.startsWith('-----')) context.registerSecret(line);
    }
  }
  const caCertificatePem = await readFile(paths.caCert, 'utf8');
  const caCertificateSha256 = createHash('sha256').update(caCertificatePem).digest('hex');
  const nickname = `${CA_NICKNAME_PREFIX}-${String(context.seed || 'run').slice(0, 12)}`;
  return Object.freeze({
    host: LAN_ROUTE_TLS_HOST,
    directory,
    caCertificatePath: paths.caCert,
    caCertificateSha256,
    nickname,
    serverKeyPath: paths.serverKey,
    serverCertificatePath: paths.serverCert,
  });
}

/** Start a strict-TLS LAN front that forwards the same HTTP and WebSocket routes to one owned loopback Gateway. */
export async function startLanRouteHttpsFront(context, {
  material,
  upstreamPort,
  listenPort = 0,
  label = 'lan-route-https-front',
} = {}) {
  assertRunContext(context);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(label)) throw new TypeError('Invalid HTTPS front label');
  if (listenPort !== 0 && (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535)) {
    throw new RangeError('listenPort must be 0 or a valid TCP port');
  }
  const cert = await validateTlsMaterial(context, material);
  let currentUpstreamPort = null;
  if (upstreamPort !== undefined) currentUpstreamPort = assertOwnedLoopbackPort(context, upstreamPort);

  const sockets = new Set();
  const upstreamRequests = new Set();
  let closePromise = null;
  const server = createHttpsServer({ key: cert.key, cert: cert.certificate, minVersion: 'TLSv1.2' }, (request, response) => {
    void handleHttp(request, response).catch(() => respondBadGateway(response));
  });
  const trackSocket = socket => {
    if (!sockets.has(socket)) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    }
    return socket;
  };
  server.on('connection', trackSocket);
  server.on('secureConnection', trackSocket);
  server.on('tlsClientError', () => {});
  server.on('clientError', (_error, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('upgrade', (request, clientSocket, head) => {
    void handleUpgrade(request, clientSocket, head).catch(() => rejectUpgrade(clientSocket, 502));
  });

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      for (const request of upstreamRequests) request.destroy();
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        const closed = new Promise((resolveClose, rejectClose) => {
          server.close(error => error ? rejectClose(error) : resolveClose());
        });
        server.closeAllConnections?.();
        await closed;
      }
    })();
    return closePromise;
  };
  context.addCleanup(`close ${label}`, close);
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(listenPort, LAN_ROUTE_TLS_HOST, resolveListen);
  });
  server.removeAllListeners('error');
  server.on('error', () => {});
  const address = server.address();
  if (!address || typeof address !== 'object' || address.address !== LAN_ROUTE_TLS_HOST) {
    await close();
    throw new Error('HTTPS front did not bind the expected Gateway LAN address');
  }
  context.registerPort(label, address.port);

  async function handleHttp(request, response) {
    if (!safeRequestTarget(request.url)) {
      response.writeHead(400, { 'cache-control': 'no-store', connection: 'close' });
      response.end();
      return;
    }
    if (!currentUpstreamPort) {
      response.writeHead(503, { 'cache-control': 'no-store', connection: 'close' });
      response.end();
      return;
    }
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: currentUpstreamPort,
      method: request.method,
      path: request.url,
      headers: request.rawHeaders,
      agent: false,
    }, upstreamResponse => {
      const statusCode = upstreamResponse.statusCode || 502;
      if (upstreamResponse.statusMessage) response.writeHead(statusCode, upstreamResponse.statusMessage, upstreamResponse.headers);
      else response.writeHead(statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    trackRequest(upstream);
    upstream.once('socket', trackSocket);
    upstream.once('error', () => respondBadGateway(response));
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
  }

  async function handleUpgrade(request, clientSocket, head) {
    trackSocket(clientSocket);
    if (!safeRequestTarget(request.url)) {
      rejectUpgrade(clientSocket, 400);
      return;
    }
    if (!currentUpstreamPort) {
      rejectUpgrade(clientSocket, 503);
      return;
    }
    const upstream = trackSocket(connect(currentUpstreamPort, '127.0.0.1'));
    let connected = false;
    upstream.once('connect', () => {
      connected = true;
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      clientSocket.once('error', () => upstream.destroy());
      upstream.once('error', () => clientSocket.destroy());
      clientSocket.once('close', () => upstream.destroy());
      upstream.once('close', () => clientSocket.destroy());
    });
    upstream.once('error', () => {
      if (connected) clientSocket.destroy();
      else rejectUpgrade(clientSocket, 502);
    });
  }

  function trackRequest(request) {
    upstreamRequests.add(request);
    request.once('close', () => upstreamRequests.delete(request));
  }

  return {
    host: LAN_ROUTE_TLS_HOST,
    port: address.port,
    origin: `https://${LAN_ROUTE_TLS_HOST}:${address.port}`,
    get upstreamPort() { return currentUpstreamPort; },
    setUpstream(port) {
      if (currentUpstreamPort !== null) throw new Error('HTTPS front upstream is already set');
      currentUpstreamPort = assertOwnedLoopbackPort(context, port);
    },
    close,
  };
}

/** Download and unpack libnss3-tools under this run without installing or changing system trust. */
export async function downloadOwnedCertutil(context) {
  const { binary } = await downloadOwnedCertutilDetails(context);
  return binary;
}

/** Download certutil and report the result of the tool's documented help/usage mode. */
export async function downloadOwnedCertutilDetails(context) {
  assertRunContext(context);
  const root = context.pathInState('owned-nss-tools');
  await createPrivateDirectory(context, root, true);
  const aptHome = context.pathInState('home');
  await createPrivateDirectory(context, aptHome, false);
  const downloadDirectory = resolve(root, 'download');
  const unpackDirectory = resolve(root, 'unpacked');
  await createPrivateDirectory(context, downloadDirectory, false);
  await createPrivateDirectory(context, unpackDirectory, false);
  const apt = await requireExecutable('/usr/bin/apt', 'apt package downloader');
  const dpkgDeb = await requireExecutable('/usr/bin/dpkg-deb', 'dpkg-deb');
  await runOwnedCommand(context, 'owned-nss-tools-download', apt, ['download', 'libnss3-tools'], downloadDirectory,
    context.isolatedEnvironment({ HOME: aptHome }));
  const packages = (await readdir(downloadDirectory)).filter(name => /^libnss3-tools_.+\.deb$/.test(name));
  if (packages.length !== 1) throw new Error('Owned libnss3-tools download did not yield exactly one package');
  await runOwnedCommand(context, 'owned-nss-tools-extract', dpkgDeb,
    ['-x', resolve(downloadDirectory, packages[0]), unpackDirectory], downloadDirectory);
  const candidate = resolve(unpackDirectory, 'usr/bin/certutil');
  const binary = await realpath(candidate);
  if (!isWithin(unpackDirectory, binary)) throw new Error('Unpacked certutil escaped the owned package directory');
  await access(binary, fsConstants.X_OK);
  await verifyOwnedFile(context, binary, undefined);
  const help = await runOwnedCommand(context, 'owned-nss-tools-verify', binary, ['-H'], unpackDirectory, undefined, {
    captureStdout: true,
    captureStderr: true,
    allowedExitCodes: [0, 1],
  });
  const helpText = `${help.stdout}\n${help.stderr}`;
  const usageSignatureMatched = hasCertutilUsageSignature(helpText);
  const loaderError = /error while loading shared libraries|cannot open shared object file|symbol lookup error|undefined symbol|ELF load command/i.test(helpText);
  if (loaderError || !usageSignatureMatched) {
    throw new Error('Unpacked certutil -H did not produce a valid usage signature or reported a loader error');
  }
  return Object.freeze({
    binary,
    helpExitCode: help.exitCode,
    usageSignatureMatched,
    usageSignature: 'NSS certutil -A/-L/-N command usage entries',
    loaderError,
  });
}

/** Trust only the supplied public CA in the exact HOME used to start this run's Chromium. */
export async function initializeIsolatedChromiumTrust(context, {
  caCertificatePem,
  caCertificatePath,
  expectedCaSha256,
  certificateSha256,
  certutilPath,
  nickname = CA_NICKNAME_PREFIX,
  home: suppliedHome,
} = {}) {
  assertRunContext(context);
  if ((typeof caCertificatePem === 'string') === (typeof caCertificatePath === 'string')) {
    throw new TypeError('Supply exactly one PEM public CA value or RunContext-owned CA file path');
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(nickname)) throw new TypeError('Invalid NSS CA nickname');
  let certPath;
  let certificateBytes;
  if (typeof caCertificatePem === 'string') {
    if (Buffer.byteLength(caCertificatePem) > MAX_CA_BYTES ||
        !caCertificatePem.includes('-----BEGIN CERTIFICATE-----') ||
        !caCertificatePem.includes('-----END CERTIFICATE-----')) {
      throw new TypeError('A bounded PEM public CA certificate is required');
    }
    certPath = context.pathInState('chromium-public-ca.pem');
    await writeFile(certPath, caCertificatePem, { flag: 'wx', mode: 0o600 });
    await chmod(certPath, 0o600);
    await verifyOwnedFile(context, certPath, 0o600);
    certificateBytes = Buffer.from(caCertificatePem);
  } else {
    certPath = assertStatePath(context, caCertificatePath);
    await verifyOwnedFile(context, certPath, 0o600);
    certificateBytes = await readFile(certPath);
    if (certificateBytes.length > MAX_CA_BYTES ||
        !certificateBytes.toString('utf8').includes('-----BEGIN CERTIFICATE-----') ||
        !certificateBytes.toString('utf8').includes('-----END CERTIFICATE-----')) {
      throw new TypeError('The public CA certificate is not a bounded PEM file');
    }
  }
  const caCertificateSha256 = createHash('sha256').update(certificateBytes).digest('hex');
  const expectedHash = expectedCaSha256 ?? certificateSha256;
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    throw new TypeError('The staged public CA SHA-256 is required');
  }
  if (caCertificateSha256 !== expectedHash.toLowerCase()) {
    throw new Error('Transferred public CA certificate SHA-256 does not match the staged certificate');
  }
  const home = suppliedHome === undefined ? context.pathInState('chromium-home') : assertStatePath(context, suppliedHome);
  await createPrivateDirectory(context, home, false);
  const pkiDirectory = resolve(home, '.pki');
  const nssDirectory = resolve(pkiDirectory, 'nssdb');
  await createPrivateDirectory(context, pkiDirectory, false);
  await createPrivateDirectory(context, nssDirectory, false);
  const nssDbPath = nssDirectory;

  const certutil = await validateOwnedExecutable(context, certutilPath);
  for (const filename of ['cert9.db', 'key4.db', 'pkcs11.txt']) {
    try {
      await lstat(resolve(nssDbPath, filename));
      throw new Error('The isolated NSS database already contains state; refusing to overwrite it');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const env = context.isolatedEnvironment({ HOME: home, USERPROFILE: home });
  const database = `sql:${nssDbPath}`;
  await runOwnedCommand(context, 'chromium-nssdb-initialize', certutil,
    ['-N', '--empty-password', '-d', database], nssDirectory, env);
  await runOwnedCommand(context, 'chromium-nssdb-import-ca', certutil,
    ['-A', '-d', database, '-n', nickname, '-t', 'C,,', '-i', certPath], nssDirectory, env);
  const listing = await runOwnedCommand(context, 'chromium-nssdb-verify-ca', certutil,
    ['-L', '-d', database], nssDirectory, env, { captureStdout: true });
  if (!listing.stdout.includes(nickname) || !listing.stdout.includes('C,,')) {
    throw new Error('The isolated NSS database does not list the imported CA with SSL trust');
  }
  return Object.freeze({
    home,
    userProfile: home,
    nssDbPath,
    caCertificatePath: certPath,
    caCertificateSha256,
    nickname,
    chromiumEnv: Object.freeze({ HOME: home, USERPROFILE: home }),
  });
}

async function validateTlsMaterial(context, material) {
  if (!material || material.host !== LAN_ROUTE_TLS_HOST ||
      typeof material.serverKeyPath !== 'string' || typeof material.serverCertificatePath !== 'string') {
    throw new TypeError('TLS material for the expected LAN IP is required');
  }
  const keyPath = assertStatePath(context, material.serverKeyPath);
  const certPath = assertStatePath(context, material.serverCertificatePath);
  await verifyOwnedFile(context, keyPath, 0o600);
  await verifyOwnedFile(context, certPath, 0o600);
  const key = await readFile(keyPath);
  for (const line of key.toString().split(/\r?\n/)) {
    if (line && !line.startsWith('-----')) context.registerSecret(line);
  }
  return { key, certificate: await readFile(certPath) };
}

async function validateOwnedExecutable(context, candidate) {
  if (typeof candidate !== 'string') throw new TypeError('An owned certutil path is required');
  const path = assertStatePath(context, candidate);
  const actual = await realpath(path);
  if (!isWithin(context.stateDir, actual)) throw new Error('certutil must be unpacked inside this RunContext state');
  await access(actual, fsConstants.X_OK);
  await verifyOwnedFile(context, actual, undefined);
  return actual;
}

async function runOwnedCommand(context, label, command, args, cwd, env, {
  captureStdout = false,
  captureStderr = false,
  allowedExitCodes = [0],
} = {}) {
  const child = context.spawnOwned(label, command, args, { cwd, ...(env ? { env } : {}) });
  const stdoutChunks = [];
  const stderrChunks = [];
  if (captureStdout) child.stdout?.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)));
  if (captureStderr) child.stderr?.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));
  const finished = await waitFor(() => {
    const record = context.processes?.get(label);
    if (record?.spawnError) return { spawnError: true };
    if (child.exitCode !== null || child.signalCode !== null) return { exited: true };
    return null;
  }, 20_000, `owned command ${label}`, 25, context.abortSignal);
  if (finished.spawnError || !allowedExitCodes.includes(child.exitCode) || child.signalCode !== null) {
    throw new Error(`Owned command failed: ${label}`);
  }
  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    exitCode: child.exitCode,
  };
}

async function createPrivateDirectory(context, path, mustNotExist) {
  assertStatePath(context, path);
  await mkdir(path, { mode: 0o700, recursive: !mustNotExist });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('RunContext TLS/trust directory is not private and owned');
  }
}

async function verifyOwnedFile(context, path, expectedMode) {
  assertStatePath(context, path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (expectedMode !== undefined && (info.mode & 0o777) !== expectedMode) ||
      (expectedMode !== undefined && (info.mode & 0o077) !== 0)) {
    throw new Error('RunContext TLS/trust file has unsafe ownership, type, link count, or permissions');
  }
}

function assertRunContext(context) {
  if (!context || typeof context.stateDir !== 'string' || typeof context.pathInState !== 'function' ||
      typeof context.registerPort !== 'function' || typeof context.addCleanup !== 'function' ||
      typeof context.spawnOwned !== 'function' || typeof context.isolatedEnvironment !== 'function') {
    throw new TypeError('A RunContext-owned state, port, process, and cleanup interface is required');
  }
}

function assertStatePath(context, path) {
  const normalized = resolve(path);
  if (!isWithin(context.stateDir, normalized) || normalized === resolve(context.stateDir)) {
    throw new Error('TLS and trust files must be inside this RunContext state directory');
  }
  return normalized;
}

function assertOwnedLoopbackPort(context, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535 ||
      !context.ports?.some(record => record.port === port)) {
    throw new Error('HTTPS front upstream must be a registered owned Gateway port');
  }
  return port;
}

function isWithin(root, path) {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith(sep);
}

function safeRequestTarget(value) {
  return typeof value === 'string' && value.length <= 16_384 && value.startsWith('/') && !value.startsWith('//') &&
    !/[\0\r\n\\#]/.test(value);
}

function hasCertutilUsageSignature(value) {
  return /(?:^|\n)\s*-A\s+Add a certificate to the database\s+\(create if needed\)/m.test(value) &&
    /(?:^|\n)\s*-L\s+List all certs,/m.test(value) &&
    /(?:^|\n)\s*-N\s+Create a new certificate database/m.test(value);
}

function respondBadGateway(response) {
  if (response.destroyed) return;
  if (!response.headersSent) response.writeHead(502, { 'cache-control': 'no-store', connection: 'close' });
  response.end();
}

function rejectUpgrade(socket, status) {
  if (socket.destroyed) return;
  const text = status === 503 ? 'Service Unavailable' : status === 400 ? 'Bad Request' : 'Bad Gateway';
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
}

assert.equal(isIP(LAN_ROUTE_TLS_HOST), 4, 'The route TLS SAN must be an IPv4 address');

const certutilSelfcheckFlag = 'KCODER_E2E_PRIVATE_LAN_TLS_CERTUTIL_SELFCHECK';
if (process.env[certutilSelfcheckFlag] === '1' &&
    resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  await runE2E(import.meta.url, {
    testId: 'mobile-route-lan-tls-owned-certutil-selfcheck',
    tier: 'manual-live',
    retainSuccessLogs: false,
    modelPolicy: 'owned package download and certutil -H exit/usage/library-load prerequisite check only; no Gateway or browser process',
  }, async context => {
    const result = await downloadOwnedCertutilDetails(context);
    const report = {
      status: 'passed',
      host: hostname(),
      command: 'certutil -H',
      exitCode: result.helpExitCode,
      usageSignatureMatched: result.usageSignatureMatched,
      usageSignature: result.usageSignature,
      loaderError: result.loaderError,
      packagePath: 'RunContext-owned package download and extraction',
    };
    await context.writeArtifactJson('owned-certutil-selfcheck.json', report);
    return report;
  });
}
