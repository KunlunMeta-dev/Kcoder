import { createHash, randomBytes } from 'node:crypto';
import { validAdminPasswordHash, verifyAdminPassword } from './admin-auth.mjs';
import { renderDashboard, activationHtml, activationJs, adminCss, adminJs } from './admin-assets.mjs';

const cookieName = '__Secure-kcoder_relay_admin';
const prefix = '/_relay/admin';
const htmlContentType = 'text/html; charset=utf-8';
const digest = text => createHash('sha256').update(text).digest('hex');
const accountStylesheet = '/_relay/account/style.css';
const publicAssets = {
  '/_relay/activate': [activationHtml, htmlContentType],
  '/_relay/login': [activationHtml, htmlContentType],
  [accountStylesheet]: [adminCss, 'text/css; charset=utf-8'],
  '/_relay/activation.js': [activationJs, 'text/javascript; charset=utf-8'],
};

async function body(request, form = false) {
  const expectedType = form ? 'application/x-www-form-urlencoded' : 'application/json';
  if (request.headers['content-type']?.split(';')[0] !== expectedType) throw Error('Invalid request');
  const timeout = setTimeout(() => request.destroy(), 5000);
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) throw Error('Invalid request'); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString('utf8');
    if (form) {
      const params = new URLSearchParams(text);
      if (params.size !== 2 || !params.has('username') || !params.has('password')) throw Error('Invalid request');
      return { username: params.get('username'), password: params.get('password') };
    }
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid request');
    return value;
  } finally { clearTimeout(timeout); }
}

/** Root Relay management only. These grants never authorize a Gateway task. */
export function createRelayAdministration({ store, sharedHosts, passwordHash, username = 'admin', requireAccount, snapshot, revokeGateway, revokeAccount }) {
  if (passwordHash && (!store || !validAdminPasswordHash(passwordHash) || typeof username !== 'string' || !username || username.length > 100))
    throw Error('Configure a valid Relay administrator password hash and registration store');
  const sessions = new Map();
  const publicOrigin = `https://${sharedHosts.values().next().value}`;
  let attempts = 0; let resetAt = 0; let activeLogins = 0; let requests = 0;
  const reply = (response, status, value, contentType = 'application/json; charset=utf-8', headers = {}) => {
    response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store',
      'referrer-policy': contentType === htmlContentType ? 'same-origin' : 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...headers });
    response.end(contentType.startsWith('application/json') ? JSON.stringify(value) : value);
  };
  const replyDashboard = (response, status, { authenticated = false, loginError } = {}) => {
    // A native form POST needs its origin for the CSRF check.
    reply(response, status, renderDashboard({ authenticated, loginError }), htmlContentType,
      authenticated ? {} : { 'referrer-policy': 'same-origin' });
  };
  return {
    handle(request, response) {
      const path = request.url;
      if (Object.hasOwn(publicAssets, path)) {
        if (request.method === 'GET' && sharedHosts.has(request.headers.host) && (passwordHash || (store && path === accountStylesheet)))
          reply(response, 200, ...publicAssets[path]);
        else reply(response, 404, { error: 'Not found' });
        return true;
      }
      if (path !== prefix && !path?.startsWith(prefix + '/')) return false;
      const { host } = request.headers;
      const direct = request.socket.remoteAddress === '127.0.0.1' &&
        /^(?:localhost|127\.0\.0\.1):[0-9]{1,5}$/.test(host ?? '') &&
        !Object.keys(request.headers).some(key => key === 'forwarded' || key === 'via' || key.startsWith('x-forwarded-'));
      if (!direct || !passwordHash) { reply(response, 404, { error: 'Not found' }); return true; }
      const formLogin = request.method === 'POST' && path === `${prefix}/login`;
      const reject = (status, message) => formLogin
        ? replyDashboard(response, status, { loginError: message })
        : reply(response, status, { error: message });
      if (++requests > 16) { requests--; reject(429, '请求过多，请稍后再试。'); return true; }
      void (async () => {
        const now = Date.now();
        for (const [key, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(key);
        const cookies = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
        const key = cookies.length === 1 ? digest(cookies[0].slice(cookieName.length + 1)) : '';
        if (request.method === 'GET' && (path === prefix || path === `${prefix}/`)) {
          replyDashboard(response, 200, { authenticated: sessions.has(key) }); return;
        }
        const asset = request.method === 'GET' && ({
          [`${prefix}/assets/style.css`]: [adminCss, 'text/css; charset=utf-8'],
          [`${prefix}/assets/app.js`]: [adminJs, 'text/javascript; charset=utf-8'],
        })[path];
        if (asset) { reply(response, 200, asset[0], asset[1]); return; }
        if (request.method === 'POST' && request.headers.origin !== `http://${host}`) {
          reject(403, '请从中继管理页面执行此操作。'); return;
        }
        if (formLogin || (request.method === 'POST' && path === `${prefix}/api/login`)) {
          if (now >= resetAt) { attempts = 0; resetAt = now + 60000; }
          if (++attempts > 20 || activeLogins >= 4) { reject(429, '登录尝试过多，请稍后再试。'); return; }
          activeLogins++;
          try {
            const input = await body(request, formLogin);
            const valid = await verifyAdminPassword(input.password, passwordHash);
            if (!valid || input.username !== username) { reject(401, '账号或密码不正确。'); return; }
            if (sessions.size >= 64) { reject(429, '管理员会话过多，请先退出其他会话。'); return; }
            const token = randomBytes(32).toString('base64url');
            sessions.set(digest(token), now + 8 * 3600000);
            const headers = { 'set-cookie': `${cookieName}=${token}; Path=${prefix}; HttpOnly; Secure; SameSite=Strict; Max-Age=28800` };
            if (formLogin) reply(response, 303, '', htmlContentType, { ...headers, location: `${prefix}/` });
            else reply(response, 200, { authenticated: true }, undefined, headers);
          } finally { activeLogins--; }
          return;
        }
        if (!sessions.has(key)) { reply(response, 401, { error: '请先登录管理员账号。' }); return; }
        if (request.method === 'GET' && path === `${prefix}/api/state`) { reply(response, 200, snapshot()); return; }
        if (request.method !== 'POST') { reply(response, 404, { error: 'Not found' }); return; }
        const input = await body(request);
        if (path === `${prefix}/api/logout`) {
          sessions.delete(key);
          reply(response, 200, {}, undefined, { 'set-cookie': `${cookieName}=; Path=${prefix}; HttpOnly; Secure; SameSite=Strict; Max-Age=0` }); return;
        }
        if (path === `${prefix}/api/accounts`) {
          if (Object.keys(input).some(key => !['username', 'password', 'maxGateways'].includes(key))) throw Error('Invalid request');
          reply(response, 201, await store.createAccount(input)); return;
        }
        if (path === `${prefix}/api/invitations`) {
          if (Object.keys(input).some(key => !['label', 'ttlMs', 'maxGateways'].includes(key))) throw Error('Invalid request');
          const issued = await store.createActivationCode({ label: input.label, ttlMs: input.ttlMs, purpose: 'register' });
          reply(response, 201, { ...issued, loginLink: `${publicOrigin}/_relay/signup#code=${issued.code}` });
          return;
        }
        const loginCode = new RegExp(`^${prefix}/api/accounts/([a-f0-9]{32})/login-codes$`).exec(path);
        if (loginCode) {
          if (Object.keys(input).some(key => !['label', 'ttlMs'].includes(key))) throw Error('Invalid request');
          const issued = await store.createActivationCode({ ...input, accountId: loginCode[1], purpose: 'register' });
          reply(response, 201, { ...issued, loginLink: `${publicOrigin}/_relay/signup#code=${issued.code}` });
          return;
        }
        const claim = new RegExp(`^${prefix}/api/gateways/([a-f0-9]{32})/account$`).exec(path);
        if (claim) {
          if (Object.keys(input).length !== 1 || typeof input.accountId !== 'string') throw Error('Invalid request');
          await store.claimGateway(claim[1], input.accountId);
          reply(response, 200, {}); return;
        }
        if (!requireAccount && path === `${prefix}/api/codes`) {
          if (Object.keys(input).some(key => !['label', 'ttlMs'].includes(key))) throw Error('Invalid request');
          const issued = await store.createActivationCode(input);
          reply(response, 201, { ...issued, activationLink: `${publicOrigin}/_relay/activate#code=${issued.code}` }); return;
        }
        const action = new RegExp(`^${prefix}/api/(codes|gateways|accounts)/([a-f0-9]{32})/revoke$`).exec(path);
        if (action) {
          if (action[1] === 'codes') await store.revokeActivationCode(action[2]);
          else if (action[1] === 'accounts') await revokeAccount(action[2]);
          else await revokeGateway(action[2]);
          reply(response, 200, {}); return;
        }
        reply(response, 404, { error: 'Not found' });
      })().catch(error => {
        request.resume();
        reject(error.code === 'REGISTRATION_CAPACITY' ? 429 : error.code === 'REGISTRATION_STORE_PERSISTENCE' ? 503 : 400,
          '操作未完成，请刷新核对状态后再试。');
      }).finally(() => { requests--; });
      return true;
    },
    close() { sessions.clear(); },
  };
}
