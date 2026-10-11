import { createServer } from 'node:https';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { waitFor } from './run-context.mjs';

export async function startHttpsGatewayProxy(context) {
  const keyPath = context.pathInState('proxy-key.pem');
  const certPath = context.pathInState('proxy-cert.pem');
  const openssl = context.spawnOwned('proxy-certificate', '/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', keyPath, '-out', certPath,
  ]);
  await waitFor(() => openssl.exitCode !== null ? { code: openssl.exitCode } : null, 15000, 'owned TLS certificate');
  if (openssl.exitCode !== 0) throw new Error('Cannot generate owned TLS certificate');
  const key = await readFile(keyPath);
  // Redact every private key payload line without buffering whole PEM-sized startup logs.
  for (const line of key.toString().split(/\r?\n/)) {
    if (line && !line.startsWith('-----')) context.registerSecret(line);
  }
  const cert = await readFile(certPath);
  let target;
  const callbackRequests = [];
  const proxy = await startForwardingProxy(context, {
    label: 'https-gateway-proxy',
    makeServer: handler => createServer({ key, cert }, handler),
    select(request, upgrade) {
      if (!target) return { status: 503 };
      if (!request.url.startsWith('/') || request.url.startsWith('//')) return { status: 400 };
      if (!upgrade && request.url.startsWith('/oauth/mcp/callback')) {
        callbackRequests.push({ sessionHeaderPresent: Boolean(request.headers.cookie), host: request.headers.host });
      }
      return { target };
    },
  });
  return { origin: `https://127.0.0.1:${proxy.port}`, setTarget(value) { target = value; }, callbackRequests };
}

/** Test-only HTTP front: public TLS and authentication remain upstream/downstream. */
export async function startRelayIngressProxy(context, { controlPort, proxyPort, gatewayId }) {
  for (const port of [controlPort, proxyPort]) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Owned loopback port required');
    if (!context.ports.some(row => row.port === port)) throw new Error('Ingress targets must be registered in this RunContext');
  }
  if (controlPort === proxyPort || typeof gatewayId !== 'string' || !/^[a-f0-9]{32}$/.test(gatewayId)) throw new Error('Invalid Relay ingress fixture');
  return startForwardingProxy(context, {
    label: 'relay-ingress-proxy', makeServer: handler => createHttpServer(handler), httpAgent: false,
    select(request, upgrade) {
      if (!validRequestTarget(request.url)) return { status: 400 };
      const url = new URL(request.url, 'http://fixture.invalid');
      if (url.hash || url.pathname !== request.url.split('?', 1)[0]) return { status: 400 };
      const one = name => url.searchParams.getAll(name).length === 1;
      const noQuery = !url.search;
      let port;
      if (url.pathname === '/_relay/register' && !upgrade && request.method === 'POST' && noQuery) port = controlPort;
      if (url.pathname === '/_relay/control' && upgrade && request.method === 'GET' && noQuery) port = controlPort;
      if (url.pathname === '/_relay/data' && upgrade && request.method === 'GET' && one('id')
        && [...url.searchParams.keys()].every(key => key === 'id') && /^[a-f0-9]{48}$/.test(url.searchParams.get('id'))) port = controlPort;
      const prefix = `/g/${gatewayId}`;
      if (url.pathname === `${prefix}/api/mobile/session` && !upgrade && ['POST', 'DELETE'].includes(request.method) && noQuery) port = proxyPort;
      if (url.pathname === `${prefix}/api/servers` && !upgrade && request.method === 'GET' && noQuery) port = proxyPort;
      if (url.pathname === `${prefix}/rpc` && upgrade && request.method === 'GET'
        && one('token') && one('server') && one('workspace')
        && [...url.searchParams.keys()].every(key => ['token', 'server', 'workspace'].includes(key))
        && /^[A-Za-z0-9._~-]{1,512}$/.test(url.searchParams.get('token'))
        && /^[A-Za-z0-9_-]{1,64}$/.test(url.searchParams.get('server'))
        && url.searchParams.get('workspace').length <= 4096 && !url.searchParams.get('workspace').includes('\0')) port = proxyPort;
      return port ? { target: `http://127.0.0.1:${port}` } : { status: 404 };
    },
  });
}

function validRequestTarget(value) {
  return typeof value === 'string' && value.length <= 8192 && value.startsWith('/') && !value.startsWith('//') && !/[\r\n\\]/.test(value);
}

async function startForwardingProxy(context, { label, makeServer, select, httpAgent }) {
  const sockets = new Set();
  const track = socket => {
    if (!sockets.has(socket)) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    }
    return socket;
  };
  const server = makeServer((request, response) => {
    const selected = select(request, false);
    if (!selected.target) { response.writeHead(selected.status || 404); response.end(); return; }
    const upstream = httpRequest(new URL(request.url, selected.target), { method: request.method, headers: request.headers,
      ...(httpAgent === false ? { agent: false } : {}) }, incoming => {
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
    const selected = select(request, true);
    if (!selected.target) { socket.destroy(); return; }
    const destination = new URL(selected.target);
    const upstream = track(connect(Number(destination.port), destination.hostname, () => {
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(request.headers).map(([key, value]) => key + ': ' + value).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    }));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  context.addCleanup(`close owned ${label}`, async () => {
    const closed = new Promise(resolve => server.listening ? server.close(resolve) : resolve());
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await closed;
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.registerPort(label, server.address().port);
  return { port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` };
}
