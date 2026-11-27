import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Cheap file metadata only: readiness never starts targets, models or resource hashing. */
export function createGatewayHealthRoutes({ webRoot, mobileRoot, mobileRequired = false, rendererMode, isStopping = () => false }) {
  const exists = async path => { try { return (await stat(path)).isFile(); } catch { return false; } };
  return async (request, response, pathname) => {
    if (!['/health', '/healthz', '/livez', '/readyz'].includes(pathname)) return false;
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }); response.end(); return true;
    }
    const live = pathname === '/livez' || pathname === '/healthz';
    const renderer = live ? 'not_checked' : rendererMode === 'vite' ? 'development' : await exists(join(webRoot, 'index.html')) ? 'ready' : 'unavailable';
    const mobile = !live && mobileRequired ? await exists(join(mobileRoot, 'index.html')) ? 'ready' : 'unavailable' : 'not_required';
    const ready = !isStopping() && renderer !== 'unavailable' && mobile !== 'unavailable';
    const payload = live ? { status: isStopping() ? 'stopping' : 'ok', service: 'kcoder-studio' }
      : { status: ready ? 'ready' : 'unavailable', service: 'kcoder-studio', renderer, mobile };
    const body = JSON.stringify(payload);
    response.writeHead((live ? !isStopping() : ready) ? 200 : 503,
      { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body),
        ...(!live && !ready ? { 'retry-after': '5' } : {}) });
    response.end(request.method === 'HEAD' ? undefined : body); return true;
  };
}
