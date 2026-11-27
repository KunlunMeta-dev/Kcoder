function finishError(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

const loginStorageReasons = new Set(['network_storage', 'reparse_point',
  'unsafe_file', 'identity_unavailable', 'validation_failed', 'powershell_unavailable', 'execution_failed',
  'output_limit', 'timeout', 'invalid_identity', 'store_busy']);
const loginStorageIoReasons = new Map([['ENOSPC', 'space_exhausted'], ['EDQUOT', 'space_exhausted'],
  ['EACCES', 'access_denied'], ['EPERM', 'access_denied'], ['EROFS', 'read_only'],
  ['EMFILE', 'resource_limit'], ['ENFILE', 'resource_limit'], ['EIO', 'io_unavailable']]);

/** Expose only a bounded recovery reason after the desktop token has been verified. */
export function sendGatewayLoginStorageError(response, error) {
  const reason = error?.code === 'MOBILE_DEVICE_STORAGE_UNAVAILABLE' && loginStorageReasons.has(error.reason)
    ? error.reason : loginStorageIoReasons.get(error?.code);
  if (!reason) return false;
  if (response.destroyed || response.writableEnded) return true;
  if (response.headersSent) { response.destroy(); return true; }
  response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    'x-kcoder-desktop-storage-failure': reason, ...(reason === 'store_busy' ? { 'retry-after': '5' } : {}) });
  response.end('Desktop login storage unavailable');
  return true;
}

/** Unexpected failures never expose provider errors, URLs or credential-bearing headers. */
export function sendGatewayRequestError(response, { request, error, warn = console.warn } = {}) {
  const id = response.getHeader?.('x-request-id');
  const requestId = typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id) ? id : undefined;
  const tooLarge = error?.code === 'REQUEST_BODY_TOO_LARGE';
  const unavailable = error?.code === 'MOBILE_DEVICE_STORAGE_UNAVAILABLE';
  const status = tooLarge ? 413 : unavailable ? 503 : 500;
  const message = tooLarge ? 'Request body is too large' : unavailable ? 'Service unavailable' : 'Internal server error';
  try { warn(`GATEWAY_REQUEST_FAILED${requestId ? ` requestId=${requestId} status=${status}` : ''}`); } catch { /* Diagnostics cannot prevent response settlement. */ }
  if (!request) { finishError(response, status, message); return; }
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  const api = request.url?.split('?', 1)[0].startsWith('/api/');
  const html = !api && request.headers.accept?.includes('text/html');
  const body = html ? `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KCoder Studio 暂时无法完成请求</title><body><main><h1>${tooLarge ? '提交内容过大' : '暂时无法完成请求'}</h1><p>${tooLarge ? '请缩短提交内容后重试。' : '请先核对操作结果；如仍需处理，可向管理员提供下方请求编号。'}</p><p>请求编号：${requestId || 'unavailable'}</p><a href="./">返回</a></main></body></html>`
    : api ? JSON.stringify({ error: message, requestId }) : message;
  response.writeHead(status, { 'content-type': html ? 'text/html; charset=utf-8' : api ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    ...(unavailable && error.reason === 'store_busy' ? { 'retry-after': '5' } : {}),
    ...(html ? { 'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } : {}) });
  response.end(request.method === 'HEAD' ? undefined : body);
}

/** Only the selected static handler can classify a missing asset as a 404. */
export async function serveStudioStaticRequest(serve, request, response, pathname) {
  try { await serve(request, response, pathname); }
  catch (error) {
    if (error instanceof URIError || ['ENOENT', 'ENOTDIR'].includes(error?.code)
      || error?.message === 'path outside root') finishError(response, 404, 'Not found');
    else throw error;
  }
}
