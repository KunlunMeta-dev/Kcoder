import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';

/** Owned loopback transport fault only; the product's authorization and Native writes stay real. */
export async function migrationReplyLossProxy(context, gateway, operation) {
  assert.equal(new URL(gateway.baseUrl).hostname, '127.0.0.1');
  assert.ok(['run', 'adoption-prepare', 'directory-select', 'instructions-capture', 'private-prepare'].includes(operation));
  let dropped = 0, selectedRequests = 0;
  const peers = new Set();
  const requests = new Set();
  const own = socket => { peers.add(socket); socket.once('close', () => peers.delete(socket)); return socket; };
  const server = createServer(async (request, response) => {
    const controller = new AbortController(); requests.add(controller);
    response.once('close', () => controller.abort());
    try {
      const privateRequest = /^\/api\/migration\/source-transfer\/private\/(candidates|run|read|source-read|prepare-status|cancel|resume|prepare|release)$/.test(request.url);
      assert.ok(request.url === '/api/servers' || /^\/api\/migration\/source-(session|transfer)\/[a-z-]+$/.test(request.url) || privateRequest);
      const parts = []; let size = 0;
      for await (const part of request) { size += part.length; assert.ok(size <= (privateRequest ? 256 : 64) * 1024); parts.push(part); }
      const upstream = await fetch(`${gateway.baseUrl}${request.url}`, { method: request.method, redirect: 'manual', signal: controller.signal, headers: {
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(request.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      }, ...(request.method === 'POST' ? { body: Buffer.concat(parts) } : {}) });
      const bytes = Buffer.from(await upstream.arrayBuffer()); assert.ok(bytes.length <= 2 * 1024 * 1024);
      const selectedDirectory = operation === 'directory-select' && request.url === '/api/migration/source-session/query'
        && JSON.parse(Buffer.concat(parts).toString('utf8')).query?.kind === 'directory_select';
      const selectedInstructions = operation === 'instructions-capture' && request.url === '/api/migration/source-session/query'
        && JSON.parse(Buffer.concat(parts).toString('utf8')).query?.kind === 'instructions_capture';
      const selectedPrivate = operation === 'private-prepare' && request.url === '/api/migration/source-transfer/private/prepare';
      const selected = request.url === `/api/migration/source-transfer/${operation}` || selectedDirectory || selectedInstructions || selectedPrivate;
      if (selected) selectedRequests++;
      if (selected && upstream.status === 200 && dropped === 0) {
        dropped++; response.destroy(); return;
      }
      response.writeHead(upstream.status, { 'content-type': 'application/json', 'content-length': bytes.length }); response.end(bytes);
    } catch { response.destroy(); }
    finally { requests.delete(controller); }
  });
  server.on('upgrade', (request, socket, head) => {
    if (!request.url.startsWith('/rpc?')) { socket.destroy(); return; }
    own(socket);
    const upstream = own(connect(gateway.port, '127.0.0.1'));
    upstream.once('connect', () => {
      const lines = [`GET ${request.url} HTTP/1.1`, `Host: 127.0.0.1:${gateway.port}`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index].toLowerCase() !== 'host') lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`); if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
  });
  context.addCleanup(`close owned ${operation} reply-loss transport`, () => new Promise((resolveClose, reject) => {
    for (const controller of requests) controller.abort();
    for (const peer of peers) peer.destroy();
    server.close(error => error ? reject(error) : resolveClose()); server.closeAllConnections();
  }));
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  context.registerPort(`migration-${operation}-reply-loss`, server.address().port);
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, dropped: () => dropped, selectedRequests: () => selectedRequests };
}
