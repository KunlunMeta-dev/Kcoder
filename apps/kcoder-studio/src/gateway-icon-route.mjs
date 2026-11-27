import { readResource } from './integrations/office/resource-verifier.mjs';

export function createGatewayIconRoute({ paths, location }) {
  let captured;
  const load = () => captured ??= (async () => {
    for (const path of paths) {
      try {
        const bytes = await readResource(path, 64 * 1024);
        if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return bytes;
      } catch { /* Try the shipped source icon when no packaged icon is present. */ }
    }
    return null;
  })();
  return async (request, response, pathname) => {
    if (!['/favicon.ico', '/favicon.png'].includes(pathname)) return false;
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); return true; }
    if (pathname === '/favicon.ico') { response.writeHead(307, { location: location(request, '/favicon.png'), 'cache-control': 'public, max-age=3600' }); response.end(); return true; }
    const bytes = await load();
    response.writeHead(bytes ? 200 : 404, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600',
      'cross-origin-resource-policy': 'same-origin', ...(bytes ? { 'content-length': bytes.length } : {}) });
    response.end(request.method === 'HEAD' ? undefined : bytes); return true;
  };
}
