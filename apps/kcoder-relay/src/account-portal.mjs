import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { MIN_PASSWORD_LENGTH } from './admin-auth.mjs';
import { isolatedGatewayUrl } from './gateway-origin.mjs';

const accountPath = '/_relay/account';
const registerPath = '/_relay/signup';
const cookieName = '__Host-kcoder_account';
const studioLoginPath = accountPath + '/studio-login';
const webOpenPath = accountPath + '/open';
const revokeOthersPath = accountPath + '/revoke-other-sessions';
export const ACCOUNT_WEB_ENTRY_PATH = '/account-entry';
export const ACCOUNT_WEB_ENTRY_HEADER = 'x-kcoder-relay-account-entry';
const devicePrefix = 'kcacct1_';
const deviceLifetime = 120_000;
const paths = new Set([accountPath, accountPath + '/', accountPath + '/login', accountPath + '/logout',
  studioLoginPath, accountPath + '/connect', revokeOthersPath, webOpenPath, webOpenPath + '.js', registerPath, registerPath + '/form.js']);
const digest = value => createHash('sha256').update(value).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function form(action, label, fields = '') {
  return `<form method="post" action="${action}">${fields}<button type="submit">${label}</button></form>`;
}

function credentials(registration) {
  return `<label>账号<input name="username" autocomplete="username" autocapitalize="none" maxlength="64" required></label>
<label>密码<input type="password" name="password" autocomplete="${registration ? 'new-password' : 'current-password'}"${registration ? ` minlength="${MIN_PASSWORD_LENGTH}"` : ''} maxlength="256" required></label>`;
}

function document(title, content) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/_relay/account/style.css"><main><h1>${title}</h1>${content}</main></html>`;
}

async function fields(request, names) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') throw Error('Invalid request');
  const timeout = setTimeout(() => request.destroy(), 5000);
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 4096) throw Error('Invalid request'); chunks.push(chunk); }
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (params.size !== names.length || names.some(name => params.getAll(name).length !== 1)) throw Error('Invalid request');
    return Object.fromEntries(params);
  } finally { clearTimeout(timeout); }
}

function signupCode(input, origin) {
  const value = input.trim();
  let url;
  try { url = new URL(value); } catch { return value; }
  if (url.origin !== origin || url.pathname !== registerPath || url.username || url.password || url.search) return '';
  const fragment = new URLSearchParams(url.hash.slice(1));
  return fragment.size === 1 ? (fragment.get('code') ?? '') : '';
}

function readCookie(request) {
  const matches = String(request.headers.cookie || '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(cookieName + '='));
  const value = matches.length === 1 ? matches[0].slice(cookieName.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

function sessionCookie(value, expiresAt = 0) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return `${cookieName}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function reply(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...headers });
  response.end(body);
}

export function createAccountPortal({ store, sharedHosts, gatewayAvailable, gatewayIngressStatus = () => 'ready',
  gatewaySurfaceAllowed = async () => true }) {
  const pairings = new Map();
  const attempts = new Map();
  let passwordChecks = 0;
  let requests = 0;
  const readAccount = token => token ? store.getAccountSession(token) : null;
  const owns = (account, id) => account && store.accountGateways(account.id).some(gateway => gateway.id === id);
  function issueGrant(gatewayId, accountToken, kind, origin) {
    const now = Date.now();
    for (const [key, grant] of pairings) if (grant.expiresAt <= now) pairings.delete(key);
    if (pairings.size >= 256) return null;
    const proof = (['pair', 'pair-web'].includes(kind) ? devicePrefix : 'kcweb1_') + randomBytes(32).toString('base64url');
    pairings.set(digest(proof), { gatewayId, accountToken, kind, origin, expiresAt: now + deviceLifetime });
    return proof;
  }
  function consumeGrant(token, gatewayId, kind, origin) {
    const key = digest(token);
    const grant = pairings.get(key);
    if (!grant || grant.gatewayId !== gatewayId || grant.kind !== kind || grant.origin !== origin) return null;
    pairings.delete(key);
    return grant.expiresAt > Date.now() && owns(readAccount(grant.accountToken), gatewayId) ? grant : null;
  }
  function admitPassword(request) {
    const now = Date.now();
    for (const [key, window] of attempts) if (window.until <= now) attempts.delete(key);
    const peer = request.socket.remoteAddress;
    const forwarded = request.headers['x-forwarded-for'];
    const key = peer === '127.0.0.1' && request.headers['x-forwarded-proto'] === 'https' &&
      request.headers['x-forwarded-host'] === request.headers.host && typeof forwarded === 'string' && isIP(forwarded)
      ? forwarded : peer;
    const current = attempts.get(key) ?? { count: 0, until: now + 60_000 };
    if (passwordChecks >= 2 || current.count >= 16 || (!attempts.has(key) && attempts.size >= 1024)) return false;
    current.count++;
    attempts.set(key, current);
    return true;
  }
  function renderLogin(response, status = 200, message = '') {
    reply(response, status, document('登录 KCoder', (message ? `<p role="alert">${message}</p>` : '') +
      form(accountPath + '/login', '登录', credentials(false)) + `<p><a href="${registerPath}">有邀请码？注册账号</a></p>`));
  }
  function renderRegistration(response, status = 200, message = '') {
    reply(response, status, document('注册 KCoder 账号或重置密码', (message ? `<p role="alert">${message}</p>` : '') +
      `<p>密码至少 ${MIN_PASSWORD_LENGTH} 个字符，不能与账号相同，也不能只使用同一个字符。</p>` +
      form(registerPath, '保存账号和密码', '<label>邀请码或邀请链接<input id="code" name="code" autocomplete="off" required></label>' + credentials(true)) +
      `<p><a href="${accountPath}/">返回登录</a></p><script src="${registerPath}/form.js" defer></script>`));
  }

  return {
    consumePairing(token, gatewayId) {
      if (!token.startsWith(devicePrefix)) return undefined;
      if (consumeGrant(token, gatewayId, 'pair-web')) return 'mobileWeb';
      return Boolean(consumeGrant(token, gatewayId, 'pair'));
    },
    consumeWebEntry(body, gatewayId, origin) {
      const params = new URLSearchParams(body);
      const surface = params.get('surface');
      const proof = params.get('proof');
      if (params.size !== 2 || !['desktop', 'mobile'].includes(surface) || !/^kcweb1_[A-Za-z0-9_-]{43}$/.test(proof)) return null;
      const grant = consumeGrant(proof, gatewayId, surface, origin);
      if (!grant) return null;
      return { surface, mobileToken: surface === 'mobile' ? issueGrant(gatewayId, grant.accountToken, 'pair-web') : null };
    },
    handle(request, response) {
      const path = request.url;
      if (!store || !paths.has(path)) return false;
      if (!sharedHosts.has(request.headers.host)) { reply(response, 404, 'Not found'); return true; }
      const studioLogin = path === studioLoginPath;
      const studioReply = (status, body) => reply(response, status, JSON.stringify(body), {
        'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*',
      });
      if (!studioLogin && request.method === 'POST' && request.headers.origin !== `https://${request.headers.host}`) {
        reply(response, 403, '请从 KCoder 账号页面执行此操作。'); return true;
      }
      if (requests >= 16) {
        if (studioLogin) studioReply(429, {});
        else reply(response, 429, '请求过多，请稍后再试。');
        return true;
      }
      requests++;
      const token = readCookie(request);
      const register = path === registerPath;
      void (async () => {
        if (studioLogin) {
          if (request.method !== 'POST') { studioReply(405, {}); return; }
          if (!admitPassword(request)) { studioReply(429, {}); return; }
          passwordChecks++;
          try {
            const input = await fields(request, ['username', 'password']);
            const { code } = await store.issueStudioLogin(input);
            studioReply(200, { code });
          } catch (error) {
            if (error.code === 'REGISTRATION_PASSWORD_RESET_REQUIRED') {
              studioReply(403, { error: error.code });
            } else {
              studioReply(error.code === 'REGISTRATION_UNAUTHORIZED' ? 401 :
                error.code === 'REGISTRATION_CAPACITY' ? 429 : error.code ? 503 : 400, {});
            }
          } finally { passwordChecks--; }
          return;
        }
        if (request.method === 'GET' && path === registerPath + '/form.js') {
          reply(response, 200, `const code = new URLSearchParams(location.hash.slice(1)).get('code');
if (code) document.getElementById('code').value = code;
if (location.hash) history.replaceState(null, '', location.pathname);`, { 'content-type': 'text/javascript; charset=utf-8' });
          return;
        }
        if (request.method === 'GET' && path === webOpenPath + '.js') {
          reply(response, 200, "document.querySelector('form').requestSubmit();", { 'content-type': 'text/javascript; charset=utf-8' });
          return;
        }
        if (request.method === 'GET' && register) { renderRegistration(response); return; }
        if (request.method === 'POST' && (register || path === accountPath + '/login')) {
          const render = register ? renderRegistration : renderLogin;
          if (!admitPassword(request)) { render(response, 429, '尝试过多，请稍后重试。'); return; }
          passwordChecks++;
          try {
            const { username, password, code } = await fields(request, register ? ['username', 'password', 'code'] : ['username', 'password']);
            const proof = randomBytes(32).toString('base64url');
            const account = register
              ? await store.redeemAccountInvitation(signupCode(code, `https://${request.headers.host}`), proof, { username, password })
              : await store.signInAccount({ username, password }, proof);
            if (token) await store.revokeAccountSession(token);
            reply(response, 303, '', { location: accountPath + '/', 'set-cookie': sessionCookie(proof, account.sessionExpiresAt) });
          } catch (error) {
            if (error.code === 'REGISTRATION_PASSWORD_RESET_REQUIRED') {
              render(response, 403, '当前密码不符合新要求。请联系管理员获取重置邀请。');
              return;
            }
            const status = error.code === 'REGISTRATION_CAPACITY' ? 429 :
              error.code === 'REGISTRATION_CONFLICT' ? 409 : error.code === 'REGISTRATION_UNAUTHORIZED' ? 401 : 400;
            render(response, status, register
              ? error.code === 'REGISTRATION_PASSWORD_POLICY' ? '密码不符合上方要求。' :
                status === 409 ? '该账号已存在。' : '注册未完成，请核对邀请码和账号。'
              : '账号或密码不正确，或暂时无法登录。');
          } finally { passwordChecks--; }
          return;
        }
        const account = readAccount(token);
        const origin = `https://${request.headers.host}`;
        if (request.method === 'GET' && (path === accountPath || path === accountPath + '/')) {
          if (!account) { renderLogin(response); return; }
          const gateways = store.accountGateways(account.id);
          const rows = gateways.map(({ id, label }) => {
            const name = escape(label || id);
            const gatewayField = `<input type="hidden" name="gatewayId" value="${id}">`;
            const open = (surface, label) => form(webOpenPath, label, gatewayField + `<input type="hidden" name="surface" value="${surface}">`);
            const ingress = gatewayAvailable(id) ? gatewayIngressStatus(id, origin) : 'offline';
            const links = ingress === 'ready' ? open('desktop', '打开桌面 Web') + open('mobile', '打开移动 Web') :
              ingress === 'offline' ? '<p>Gateway 离线</p>' :
                ingress === 'failed' ? '<p>公网入口暂不可用，请稍后刷新。</p>' : '<p>公网入口准备中，请稍后刷新。</p>';
            return `<section><h3>${name}</h3>${links}</section>`;
          }).join('');
          reply(response, 200, document('KCoder 账号', `<p>已登录 ${escape(account.username)}</p><h2>我的 Gateway</h2>` +
            (rows || '<p>还没有登记的 Gateway。</p>') +
            `<h2>账号会话</h2><p>当前会话到期时间（UTC） <time>${new Date(account.sessionExpiresAt).toISOString()}</time></p>` +
            '<p>撤销其他账号会话后，其他设备须重新登录账号。已登记的 Gateway 和已建立的 Gateway 会话仍各自管理。</p>' +
            form(revokeOthersPath, '撤销其他会话') + form(accountPath + '/logout', '退出登录')),
          { 'set-cookie': sessionCookie(token, account.sessionExpiresAt) });
          return;
        }
        if (!account || request.method !== 'POST') { reply(response, 401, '请先登录 KCoder。'); return; }
        if (path === accountPath + '/logout') {
          await store.revokeAccountSession(token);
          reply(response, 303, '', { location: accountPath + '/', 'set-cookie': sessionCookie('') });
        } else if (path === revokeOthersPath) {
          if (!await store.revokeOtherAccountSessions(token)) { reply(response, 401, '请先登录 KCoder。'); return; }
          reply(response, 303, '', { location: accountPath + '/' });
        } else if (path === webOpenPath || path === accountPath + '/connect') {
          const web = path === webOpenPath;
          const { gatewayId, surface } = await fields(request, web ? ['gatewayId', 'surface'] : ['gatewayId']);
          if (web && !['desktop', 'mobile'].includes(surface)) { reply(response, 400, '无效的 Web 入口'); return; }
          if (!owns(account, gatewayId) || !gatewayAvailable(gatewayId)) { reply(response, 404, 'Gateway 不可用'); return; }
          if (gatewayIngressStatus(gatewayId, origin) !== 'ready') {
            reply(response, 503, '公网入口尚未就绪，请稍后重试。', { 'retry-after': '5' }); return;
          }
          const gateway = isolatedGatewayUrl(origin, gatewayId);
          const entry = web ? (surface === 'desktop' ? 'desktopWeb' : 'mobileWeb') : 'mobileApp';
          if (!await gatewaySurfaceAllowed(gatewayId, gateway.host, entry)) {
            reply(response, 403, '此公网入口已关闭或暂不可用。'); return;
          }
          if (!owns(readAccount(token), gatewayId)) { reply(response, 401, '请先登录 KCoder。'); return; }
          const proof = issueGrant(gatewayId, token, web ? surface : 'pair', web ? origin : undefined);
          if (!proof) { reply(response, 429, '连接请求过多，请稍后重试。'); return; }
          if (web) {
            const action = new URL(ACCOUNT_WEB_ENTRY_PATH.slice(1), gateway);
            reply(response, 200, document('正在打开 KCoder', form(action.href, '继续打开',
              `<input type="hidden" name="proof" value="${proof}"><input type="hidden" name="surface" value="${surface}">`) +
              `<script src="${webOpenPath}.js" defer></script>`), {
              'referrer-policy': 'strict-origin',
              'content-security-policy': `default-src 'none'; style-src 'self'; script-src 'self'; form-action ${action.origin}; frame-ancestors 'none'; base-uri 'none'`,
            });
            return;
          }
          const params = new URLSearchParams({ gateway: gateway.href.replace(/\/$/, ''), gatewayId });
          params.set('token', proof);
          reply(response, 200, document('连接手机', `<p>请在两分钟内打开手机 App。</p>
<p><a href="kcoder-studio://connect?${escape(params.toString())}">打开手机 App</a></p>
<p><a href="${accountPath}/">返回账号</a></p>`));
        } else reply(response, 404, 'Not found');
      })().catch(() => {
        request.resume();
        if (!response.headersSent) reply(response, 503, '账号服务暂不可用，请稍后重试。');
      }).finally(() => { requests--; });
      return true;
    },
  };
}
