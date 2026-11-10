import { request as httpRequest } from 'node:http';

const mount = '/mobile';
const maxHtmlBytes = 2 * 1024 * 1024;
const metroEndpoints = new Set(['/hot', '/message']);
const appPaths = new Set(['/', '/connect', '/welcome', '/host-details', '/new', '/open-project', '/pair-scan',
  '/server-editor', '/sessions', '/settings', '/settings-about', '/settings-appearance', '/settings-connections',
  '/settings-diagnostics', '/settings-section', '/settings-terminal']);

function send(response, status, headers = {}) {
  response.writeHead(status, { 'cache-control': 'no-store', ...headers });
  response.end();
}

export function createMobileWebDevProxy({ port, rendererMode, publicAccessUrl, allowedOrigin }) {
  if (port === undefined) return null;
  if (rendererMode !== 'vite' || !/^\d{4,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
    throw new Error('KCODER_STUDIO_MOBILE_DEV_PORT requires Vite mode and a valid loopback port');
  }
  const upstream = { hostname: '127.0.0.1', port: Number(port), agent: false };
  const base = `${publicAccessUrl?.pathname || ''}${mount}`;
  const matches = pathname => pathname === mount || pathname.startsWith(`${mount}/`);
  const isUpgrade = pathname => matches(pathname) && metroEndpoints.has(pathname.slice(mount.length));
  const isPublicHost = request => !publicAccessUrl || request.headers.host === publicAccessUrl.host;

  async function handle(request, response, url) {
    if (!['GET', 'HEAD'].includes(request.method)) { send(response, 405, { allow: 'GET, HEAD' }); return; }
    if (request.headers.origin && !allowedOrigin(request.headers.origin, request.headers.host)) {
      send(response, 403);
      return;
    }
    const path = url.pathname.slice(mount.length);
    if (!isPublicHost(request) || path === '') {
      const location = `${isPublicHost(request) ? '' : publicAccessUrl.origin}${base}${path || '/'}${url.search}`;
      send(response, 307, { location });
      return;
    }
    // Keep Metro's editor, debugger and control HTTP endpoints off the Gateway.
    const navigation = appPaths.has(path.replace(/\/$/, '') || '/') || /^\/h\/[^/]+(?:\/inbox|\/task\/[^/]+\/[^/]+)?\/?$/.test(path);
    const resource = /^\/(?:favicon\.ico$|assets\/|src\/entry(?:\.ts)?\.(?:bundle|map)$)/.test(path);
    if (!(navigation || resource) || /%2f|%5c|\\/i.test(path)) {
      send(response, 404);
      return;
    }
    await new Promise(resolve => {
      const proxy = httpRequest({ ...upstream, path: `${path}${url.search}`, method: request.method,
        headers: { accept: request.headers.accept || '*/*', 'accept-encoding': 'identity' } });
      const fail = () => {
        if (response.headersSent) response.destroy();
        else send(response, 502);
        resolve();
      };
      // The first preview navigation can compile both the server and web graphs.
      proxy.setTimeout(180_000, () => proxy.destroy());
      proxy.once('error', fail);
      response.once('close', () => { proxy.destroy(); resolve(); });
      proxy.once('response', async incoming => {
        try {
          const contentType = incoming.headers['content-type'] || 'application/octet-stream';
          const headers = { 'content-type': contentType, 'cache-control': 'no-store',
            'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
          if (incoming.statusCode >= 300 && incoming.statusCode < 400) {
            incoming.destroy();
            fail();
            return;
          }
          if (request.method === 'HEAD' || !contentType.startsWith('text/html')) {
            incoming.once('error', fail);
            response.writeHead(incoming.statusCode, headers);
            incoming.pipe(response);
            return;
          }
          const chunks = [];
          let size = 0;
          for await (const chunk of incoming) {
            size += chunk.length;
            if (size > maxHtmlBytes) throw new Error('Metro HTML exceeds preview limit');
            chunks.push(chunk);
          }
          // Expo's development serializer emits the entry script with an absolute root path.
          const html = Buffer.concat(chunks, size).toString('utf8')
            .replace(/(<script\b[^>]*\bsrc=["'])(\/src\/entry(?:\.ts)?\.bundle)\b/g, `$1${base}$2`);
          response.writeHead(incoming.statusCode, {
            ...headers, 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' ws: wss: http: https:; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
          });
          response.end(html);
        } catch {
          fail();
        }
      });
      proxy.end();
    });
  }

  function upgrade(request, socket, head, url) {
    if (!isPublicHost(request) || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const headers = { connection: 'Upgrade', upgrade: 'websocket' };
    for (const key of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) {
      if (request.headers[key] !== undefined) headers[key] = request.headers[key];
    }
    const proxy = httpRequest({ ...upstream, path: url.pathname.slice(mount.length), headers });
    socket.once('close', () => proxy.destroy());
    proxy.once('error', () => socket.destroy());
    proxy.once('response', incoming => { incoming.destroy(); socket.destroy(); });
    proxy.setTimeout(10_000, () => proxy.destroy());
    proxy.once('upgrade', (incoming, metroSocket, metroHead) => {
      if (socket.destroyed) { metroSocket.destroy(); return; }
      metroSocket.setTimeout(0);
      metroSocket.on('error', () => socket.destroy());
      metroSocket.once('close', () => socket.destroy());
      socket.once('close', () => metroSocket.destroy());
      const handshake = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket'];
      for (const key of ['sec-websocket-accept', 'sec-websocket-extensions', 'sec-websocket-protocol']) {
        if (incoming.headers[key] !== undefined) handshake.push(`${key}: ${incoming.headers[key]}`);
      }
      socket.write(handshake.concat('', '').join('\r\n'));
      if (metroHead.length) socket.write(metroHead);
      if (head.length) metroSocket.write(head);
      socket.pipe(metroSocket).pipe(socket);
    });
    proxy.end();
  }

  return { matches, isUpgrade, handle, upgrade };
}
