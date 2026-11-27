import { requestBody } from './gateway-http-body.js';
import { loginPage, loginTicketBridge, safeReturnTo } from './gateway-login-presentation.js';
import { sendGatewayLoginStorageError } from './gateway-request-errors.mjs';

export function createGatewayLoginRoutes({ authRequired, tokenMatches, tickets, matchesPersistentLink, failures, isAllowedOrigin,
  legacyLocalLink, cookies, cookiePath, prefixedLocation, createSession, renewSession, deleteSession, ttlMs, headers, onAuthenticated = () => {} }) {
  const page = (request, response, status, message = '', returnTo = null, extra = {}) => {
    response.writeHead(status, { ...headers, ...extra });
    response.end(request.method === 'HEAD' ? undefined : loginPage(message, returnTo, prefixedLocation(request, '/login')));
  };
  const sameOrigin = request => (!request.headers.origin || isAllowedOrigin(request.headers.origin, request.headers.host))
    && request.headers['sec-fetch-site'] !== 'cross-site';
  return async (request, response, url) => {
    if (!authRequired) return false;
    if (url.pathname === '/login/bridge.js') {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { allow: 'GET, HEAD' }); response.end(); }
      else { response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : loginTicketBridge); }
      return true;
    }
    if (url.pathname === '/logout' && request.method === 'POST') {
      if (!sameOrigin(request)) { page(request, response, 403, '请从当前工作台退出登录。'); return true; }
      const id = cookies.read(request); if (id) await deleteSession(id);
      response.writeHead(303, { location: prefixedLocation(request, '/login'), 'set-cookie': cookies.header(request, '', 0), 'cache-control': 'no-store' });
      response.end(); return true;
    }
    if (url.pathname !== '/login') return false;
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
      response.writeHead(405, { allow: 'GET, HEAD, POST', 'cache-control': 'no-store' }); response.end(); return true;
    }
    if (request.method === 'POST' && !sameOrigin(request)) { page(request, response, 403, '请从当前工作台提交登录。'); return true; }
    const link = request.method === 'GET' && url.searchParams.has('token');
    if (request.method !== 'POST' && !link) {
      page(request, response, 200, url.searchParams.has('linkError') ? '登录链接无效或已失效，请刷新访问链接或输入访问令牌。' : '', safeReturnTo(url.searchParams.get('returnTo')));
      return true;
    }
    const input = link ? url.searchParams : new URLSearchParams(await requestBody(request));
    const token = input.get('token') || '';
    const ticket = input.get('ticket') || (link ? token : '');
    const validTicket = tickets.consume(ticket);
    const validPersistentLink = !link && !validTicket && Boolean(await matchesPersistentLink?.(ticket));
    const validPassword = !input.has('ticket') && (!link || legacyLocalLink(request)) && tokenMatches(token);
    if (!validTicket && !validPersistentLink && !validPassword) {
      const retry = failures.retryAfter(request);
      if (retry) { page(request, response, 429, '尝试次数过多，请稍后重试。', null, { 'retry-after': String(retry) }); return true; }
      failures.record(request);
      if (link) { response.writeHead(303, { location: prefixedLocation(request, '/login?linkError=1'), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); response.end(); }
      else page(request, response, 401, '访问令牌或登录链接不正确。', safeReturnTo(input.get('returnTo')));
      return true;
    }
    let id = !link && !validTicket && input.get('renewSession') === '1' && request.headers.authorization === undefined ? cookies.read(request) : null;
    try { if (!id || !await renewSession(id)) ({ id } = await createSession({ browserAdmin: true })); }
    catch (error) {
      if (sendGatewayLoginStorageError(response, error)) return true;
      if (error.status !== 429) throw error;
      page(request, response, 429, '登录会话已满，请先撤销一个不再使用的设备后重试。', safeReturnTo(input.get('returnTo'))); return true;
    }
    onAuthenticated(request);
    response.writeHead(303, { location: safeReturnTo(input.get('returnTo')) || prefixedLocation(request, '/'),
      'set-cookie': cookies.header(request, id, Math.floor(ttlMs / 1000), cookiePath(request)),
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-kcoder-session-ttl-ms': String(ttlMs) });
    response.end(); return true;
  };
}
