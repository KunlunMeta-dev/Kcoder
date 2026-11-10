import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { escapeHtml } from './gateway-login-presentation.js';

export function studioRendererMode(env = process.env) {
  const mode = env.KCODER_STUDIO_RENDERER_MODE || 'static';
  if (!['static', 'vite'].includes(mode)) throw new Error('KCODER_STUDIO_RENDERER_MODE must be static or vite');
  return mode;
}

/** Vite has no public listener. Gateway owns authentication before either entry. */
export async function createStudioViteRenderer({ rendererRoot, cacheDir, publicAccessUrl, gatewayToken,
  desktopHost, contentSecurityPolicy, requestPublicPrefix }) {
  const base = `${publicAccessUrl?.pathname.replace(/\/+$/, '') || ''}/`;
  const upgradeServer = createHttpServer();
  const require = createRequire(resolve(rendererRoot, 'package.json'));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: compression } = await import('compression');
  const vite = await createServer({
    root: rendererRoot,
    ...(cacheDir ? { cacheDir } : {}),
    configFile: resolve(rendererRoot, 'vite.config.ts'),
    base,
    clearScreen: false,
    server: {
      middlewareMode: true,
      host: '127.0.0.1',
      // Gateway already validates Host and Origin. Keep Vite's own WS token check.
      allowedHosts: publicAccessUrl ? [publicAccessUrl.hostname] : [],
      ws: { server: upgradeServer, path: '__vite_hmr' },
      proxy: null,
      fs: { strict: true, allow: [rendererRoot, resolve(rendererRoot, '../shared')] },
    },
  });
  const sockets = new Set();
  const compressAssets = compression();
  const hmrPath = `${base}__vite_hmr`;
  const mountedUrl = value => value.startsWith(base) ? value : `${base.slice(0, -1)}${value}`;
  function isUpgrade(pathname) {
    return pathname === '/__vite_hmr' || pathname === hmrPath;
  }
  function upgrade(request, socket, head) {
    request.url = mountedUrl(request.url);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    upgradeServer.emit('upgrade', request, socket, head);
  }
  function personalizeHtml(html, request, response) {
    const prefix = requestPublicPrefix(request);
    const metadata = `<meta name="kcoder-rpc-token" content="${escapeHtml(gatewayToken)}">` +
      (desktopHost ? '<meta name="kcoder-desktop-host" content="1">' : '') +
      (prefix ? `<meta name="kcoder-app-base-path" content="${escapeHtml(prefix)}">` : '');
    html = html.replace('</head>', `${metadata}</head>`);
    // React Refresh injects inline modules. Authorize these exact bytes only.
    const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter(([, attributes, body]) => !/\bsrc\s*=/i.test(attributes) && body.trim())
      .map(([, , body]) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);
    response.removeHeader('content-length');
    response.removeHeader('etag');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-security-policy', contentSecurityPolicy.replace(/script-src([^;]*)/, `$& ${hashes.join(' ')}`));
    return html;
  }
  async function handle(request, response, pathname) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
      response.end();
      return;
    }
    const localPath = pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : pathname;
    if (localPath === '/__open-in-editor' || localPath.includes('widget-sandbox')) {
      response.writeHead(404, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    // Compiled assets carry Vite's in-memory ETag. The Gateway still authorizes
    // each conditional request; personalized navigation remains no-store.
    response.setHeader('cache-control', vite.config.experimental.bundledDev ? 'private, no-cache' : 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-kcoder-renderer', 'vite');
    const navigation = localPath === '/' || localPath === '/index.html' ||
      (request.headers.accept?.includes('text/html') && !localPath.startsWith('/@'));
    if (navigation && !vite.config.experimental.bundledDev) {
      const html = personalizeHtml(await vite.transformIndexHtml(mountedUrl(request.url),
        (await readFile(resolve(rendererRoot, 'index.html'), 'utf8')).replaceAll('%BASE_URL%', '/')), request, response);
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(request.method === 'HEAD' ? undefined : html);
      return;
    }
    const originalEnd = response.end;
    if (navigation) {
      // Bundled dev owns compiled and recovery HTML. Transforming the source
      // index would request modules that this mode no longer serves.
      response.end = function (body, encoding, callback) {
        response.end = originalEnd;
        if (response.headersSent || !String(response.getHeader('content-type')).includes('text/html'))
          return originalEnd.call(this, body, encoding, callback);
        const html = personalizeHtml(body == null ? '' : Buffer.isBuffer(body) ? body.toString('utf8') : String(body), request, response);
        return originalEnd.call(this, request.method === 'HEAD' ? undefined : html, encoding, callback);
      };
    }
    const previousUrl = request.url;
    request.url = mountedUrl(previousUrl);
    try {
      await new Promise((done, reject) => {
        const finish = () => { response.off('close', finish); response.off('finish', finish); done(); };
        response.once('close', finish);
        response.once('finish', finish);
        // Compress only code/assets, before Relay accounts for their wire bytes.
        // Credential-bearing navigation HTML and RPC never enter this middleware.
        const serve = error => {
          if (error) { reject(error); return; }
          vite.middlewares(request, response, error => {
            if (error) { reject(error); return; }
            if (!response.headersSent) response.writeHead(404);
            response.end();
          });
        };
        if (navigation) serve();
        else compressAssets(request, response, serve);
      });
    } finally { request.url = previousUrl; response.end = originalEnd; }
  }
  return { handle, isUpgrade, upgrade, async close() {
    for (const socket of sockets) socket.destroy();
    await vite.close();
    upgradeServer.close();
  } };
}
