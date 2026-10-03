import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
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
  let target;
  const sockets = new Set();
  const callbackRequests = [];
  const track = socket => {
    if (!sockets.has(socket)) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    }
    return socket;
  };
  const server = createServer({ key, cert: await readFile(certPath) }, (request, response) => {
    if (!target) { response.writeHead(503); response.end(); return; }
    if (!request.url.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(400); response.end(); return;
    }
    if (request.url.startsWith('/oauth/mcp/callback')) {
      callbackRequests.push({ sessionHeaderPresent: Boolean(request.headers.cookie), host: request.headers.host });
    }
    const upstream = httpRequest(new URL(request.url, target), { method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('socket', track);
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('connection', track);
  server.on('upgrade', (request, socket, head) => {
    if (!target || !request.url.startsWith('/') || request.url.startsWith('//')) { socket.destroy(); return; }
    const destination = new URL(target);
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
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.registerPort('https-gateway-proxy', server.address().port);
  context.addCleanup('close owned HTTPS Gateway proxy', async () => {
    const closed = new Promise(resolve => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await closed;
  });
  return { origin: `https://127.0.0.1:${server.address().port}`, setTarget(value) { target = value; }, callbackRequests };
}
