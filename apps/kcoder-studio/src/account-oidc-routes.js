import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const same = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const callbackPath = '/api/account/oidc/callback';
const errorMessage = '组织 SSO 登录失败，请重试或联系管理员检查固定 issuer 和回调配置';

// All original owner/target/generation facts are captured from the Gateway.
// Callback code/state are forwarded only to that same privileged process.
export function createOrganizationOidcRoutes({
  getTarget, targetSignature, loginContexts, loginOwner, captureOwner, ownerActive,
  isAllowedRedirectOrigin, listeningPort, createBroker, finishBroker, stopBroker,
  closeSockets, invalidateHealth, requireSameOriginMutation, requestBody, jsonResponse,
  publicCallbackPath = () => callbackPath,
  stopOwner,
  callbackOwner = async () => null,
  deliverLogout,
}) {
  const pending = new Map();
  const active = new Map();
  const cancelled = new Map();
  let logoutActive = 0;
  const ownerKey = (owner, target) => JSON.stringify([owner, target]);
  const keyOf = (owner, target, clientId) => JSON.stringify([owner, target, clientId]);
  const scopeCurrent = slot => {
    try { return ownerActive(slot.ownerProof) && Boolean(getTarget(slot.targetId)) && targetSignature(getTarget(slot.targetId)) === slot.signature; }
    catch { return false; }
  };
  const ownsContext = slot => {
    const credential = loginContexts.credential(slot.owner, slot.targetId);
    return Boolean(slot.handle && credential?.authentication === 'oidcResume' && credential.resumeAuthority?.handle === slot.handle);
  };
  const fail = (slot, reason = errorMessage) => {
    if (slot.status === 'failed') return;
    slot.status = 'failed'; slot.error = reason;
    if (active.get(ownerKey(slot.owner, slot.targetId)) === slot) active.delete(ownerKey(slot.owner, slot.targetId));
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => pending.delete(slot.key), 30000); slot.timer.unref?.();
    if (ownsContext(slot)) {
      loginContexts.invalidate(slot.owner, slot.targetId);
      closeSockets(slot.owner, slot.targetId);
      invalidateHealth(slot.targetId);
      if (stopOwner) void stopOwner(slot.owner, slot.targetId).catch(() => {});
    }
    if (slot.broker) void stopBroker(slot.broker).catch(() => {});
    slot.rejectVerified?.(new Error(errorMessage));
  };
  const visible = slot => {
    if (!scopeCurrent(slot) || (slot.status === 'authenticated' && !ownsContext(slot)) ||
        (slot.status !== 'authenticated' && loginContexts.generation(slot.owner, slot.targetId) !== slot.generation && !ownsContext(slot))) {
      fail(slot); return { status: 'failed', error: errorMessage };
    }
    return { status: slot.status, ...(slot.status === 'authenticated' ? { identity: slot.principal } : {}),
      ...(slot.status === 'failed' ? { error: slot.error } : {}) };
  };
  const page = (response, success, locale) => {
    const text = locale === 'en' ? (success ? 'Sign-in completed. Return to Studio.' : 'Sign-in failed. Return to Studio and retry.')
      : (success ? '登录已完成，请返回 Studio。' : '登录未完成，请返回 Studio 重试。');
    response.writeHead(success ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
    response.end(`<!doctype html><html><head><title>KCoder Studio</title></head><body><p>${text}</p></body></html>`);
  };
  const nativeCallback = (slot, request) => {
    const uri = new URL(slot.redirectUri);
    const local = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
    return slot.ownerProof.localStart === true && uri.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(uri.hostname) &&
      Number(uri.port) === listeningPort() && local(request.socket?.remoteAddress) && local(request.socket?.localAddress);
  };

  return {
    expireOwner(owner) {
      for (const slot of [...pending.values(), ...active.values()]) if (slot.owner === owner) {
        fail(slot);
        if (stopOwner) void stopOwner(slot.owner, slot.targetId).catch(() => {});
      }
    },
    async handleCallback(request, response, url) {
      const logoutTarget = url.pathname.match(/^\/api\/servers\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/account\/oidc\/logout$/);
      if (logoutTarget && request.method === 'POST') {
        const target = getTarget(logoutTarget[1]);
        if (!target?.security || !deliverLogout) { jsonResponse(response, 404, { processed: false }); return true; }
        if (logoutActive >= 4) { jsonResponse(response, 429, { processed: false }); return true; }
        logoutActive++;
        try {
          if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new Error();
          const form = new URLSearchParams(await requestBody(request, 8192));
          if ([...form.keys()].some(key => key !== 'logout_token') || form.getAll('logout_token').length !== 1 || !form.get('logout_token')) throw new Error();
          jsonResponse(response, 200, await deliverLogout(target, form.get('logout_token')));
        } catch { jsonResponse(response, 400, { processed: false }); }
        finally { logoutActive--; }
        return true;
      }
      if (url.pathname !== callbackPath || !['GET', 'POST'].includes(request.method)) return false;
      if (request.method === 'POST') {
        let receipt;
        try {
          const body = JSON.parse(await requestBody(request, 1024));
          if (!body || Object.keys(body).join(',') !== 'receipt' || typeof body.receipt !== 'string') throw new Error();
          receipt = body.receipt;
        } catch { jsonResponse(response, 400, { completed: false }); return true; }
        const slot = [...pending.values()].find(value => same(value.callbackReceipt, receipt));
        const owner = await callbackOwner(request);
        if (!slot || !requireSameOriginMutation(request) || !scopeCurrent(slot) ||
            (owner !== slot.owner && !(owner === null && nativeCallback(slot, request)))) {
          jsonResponse(response, 403, { completed: false }); return true;
        }
        if (slot.status === 'authenticated' && ownsContext(slot)) {
          jsonResponse(response, 200, { completed: true }); return true;
        }
        if (slot.status === 'exchanging' && slot.completion) {
          await slot.completion; jsonResponse(response, visible(slot).status === 'authenticated' ? 200 : 400, { completed: visible(slot).status === 'authenticated' }); return true;
        }
        if (slot.status !== 'pending' || loginContexts.generation(slot.owner, slot.targetId) !== slot.generation) {
          jsonResponse(response, 400, { completed: false }); return true;
        }
        slot.status = 'exchanging';
        slot.completion = new Promise(resolve => { slot.completeCallback = resolve; });
        try {
          slot.broker.child.submitOidcCallback({ requestId: slot.requestId, authorizationResponse: slot.redirectUri + slot.callbackQuery });
          slot.callbackQuery = undefined;
          await slot.verified;
          if (!scopeCurrent(slot)) throw new Error(errorMessage);
          await finishBroker(getTarget(slot.targetId), slot.owner);
          if (!ownsContext(slot) || !scopeCurrent(slot)) throw new Error(errorMessage);
          slot.status = 'authenticated'; active.set(ownerKey(slot.owner, slot.targetId), slot);
          clearTimeout(slot.timer); slot.timer = setTimeout(() => pending.delete(slot.key), 180000); slot.timer.unref?.();
          jsonResponse(response, 200, { completed: true });
        } catch { fail(slot); jsonResponse(response, 400, { completed: false }); }
        finally { slot.completeCallback?.(); }
        return true;
      }
      const states = url.searchParams.getAll('state');
      const candidates = states.length === 1 ? [...pending.values()].filter(slot => same(slot.state, states[0])) : [];
      const slot = candidates.length === 1 ? candidates[0] : null;
      const fingerprint = createHash('sha256').update(url.search).digest('hex');
      if (slot?.status === 'authenticated' && slot.callbackFingerprint === fingerprint && ownsContext(slot) && scopeCurrent(slot)) {
        page(response, true, slot.locale); return true;
      }
      if (!slot || slot.status !== 'pending' || !scopeCurrent(slot) || loginContexts.generation(slot.owner, slot.targetId) !== slot.generation) {
        page(response, false, slot?.locale); return true;
      }
      if (slot.callbackFingerprint && slot.callbackFingerprint !== fingerprint) { page(response, false, slot.locale); return true; }
      slot.callbackFingerprint = fingerprint;
      slot.callbackQuery = url.search;
      slot.callbackReceipt ??= randomBytes(32).toString('base64url');
      // A same-origin POST restores Strict cookies after a cross-site IdP GET.
      // Public HTTPS requires the original owner. Only an actual loopback
      // native client may finish without a browser cookie in an external agent.
      const nonce = randomBytes(24).toString('base64url');
      const complete = slot.locale === 'en' ? 'Sign-in completed. Return to Studio.' : '登录已完成，请返回 Studio。';
      const failed = slot.locale === 'en' ? 'Sign-in failed. Return to Studio and retry.' : '登录未完成，请返回 Studio 重试。';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'` });
      response.end(`<!doctype html><html><head><title>KCoder Studio</title></head><body><p>Studio</p><script nonce="${nonce}">fetch(${JSON.stringify(new URL(slot.redirectUri).pathname)},{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({receipt:${JSON.stringify(slot.callbackReceipt)}})}).then(r=>r.json()).then(r=>{document.querySelector('p').textContent=r.completed?${JSON.stringify(complete)}:${JSON.stringify(failed)}}).catch(()=>{document.querySelector('p').textContent=${JSON.stringify(failed)}})</script></body></html>`);
      return true;
    },

    async handle(request, response, url, authSession) {
      const match = url.pathname.match(/^\/api\/servers\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/account\/oidc$/);
      if (!match) return false;
      const target = getTarget(match[1]);
      const owner = loginOwner(request, authSession);
      if (!owner || !target?.security || !authSession.allowedServerIds.has(target.id)) {
        jsonResponse(response, 404, { error: errorMessage }); return true;
      }
      if (request.method === 'GET' || request.method === 'DELETE') {
        if (request.method === 'DELETE' && !requireSameOriginMutation(request)) {
          jsonResponse(response, 403, { error: errorMessage }); return true;
        }
        const clientId = url.searchParams.get('clientRequestId');
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(clientId ?? '')) {
          jsonResponse(response, 400, { error: errorMessage }); return true;
        }
        const key = keyOf(owner, target.id, clientId);
        const slot = pending.get(key);
        if (request.method === 'DELETE' && !slot) {
          if (cancelled.size >= 256) { jsonResponse(response, 429, { error: errorMessage }); return true; }
          cancelled.set(key, Date.now() + 225000);
          const timer = setTimeout(() => cancelled.delete(key), 225000); timer.unref?.();
          jsonResponse(response, 200, { status: 'failed' }); return true;
        }
        if (!slot || slot.owner !== owner || slot.targetId !== target.id) {
          jsonResponse(response, 404, { error: errorMessage }); return true;
        }
        if (request.method === 'DELETE') fail(slot);
        jsonResponse(response, 200, visible(slot)); return true;
      }
      if (request.method !== 'POST' || !requireSameOriginMutation(request)) {
        jsonResponse(response, 403, { error: errorMessage }); return true;
      }
      let input;
      try {
        input = JSON.parse(await requestBody(request, 1024));
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['username', 'locale', 'clientRequestId'].includes(key)) ||
            typeof input.username !== 'string' || !/^[a-z][a-z0-9_.-]{1,31}$/.test(input.username) ||
            !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.clientRequestId ?? '') ||
            (input.locale !== undefined && !['en', 'zh-CN'].includes(input.locale))) throw new Error(errorMessage);
      } catch {
        jsonResponse(response, 400, { error: errorMessage }); return true;
      }
      if (pending.size >= 256 || (loginContexts.oidcSessionCount?.() ?? 0) >= 32 || [...pending.values()].filter(slot => !['failed', 'authenticated'].includes(slot.status)).length >= 32) {
        jsonResponse(response, 429, { error: errorMessage }); return true;
      }
      try {
        const result = await loginContexts.mutate(owner, target.id, async () => {
          const key = keyOf(owner, target.id, input.clientRequestId);
          if ((cancelled.get(key) ?? 0) > Date.now()) throw new Error(errorMessage);
          const previous = pending.get(key);
          if (previous) {
            if (previous.username !== input.username || !scopeCurrent(previous) || previous.status !== 'pending') throw new Error(errorMessage);
            return previous.challenge;
          }
          if (loginContexts.identity(owner, target.id)) throw new Error('请先退出此连接的现有账号');
          for (const slot of pending.values()) if (ownerKey(slot.owner, slot.targetId) === ownerKey(owner, target.id) && !['failed', 'authenticated'].includes(slot.status)) fail(slot);
          loginContexts.invalidate(owner, target.id);
          const slot = { key, owner, ownerProof: captureOwner(request, authSession, target.id), targetId: target.id,
            signature: targetSignature(target), generation: loginContexts.generation(owner, target.id),
            locale: input.locale ?? 'zh-CN', status: 'starting', username: input.username, callbackPath: publicCallbackPath(request) };
          pending.set(key, slot);
          slot.verified = new Promise((resolve, reject) => { slot.resolveVerified = resolve; slot.rejectVerified = reject; });
          slot.verified.catch(() => {});
          const challenge = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { fail(slot); reject(new Error(errorMessage)); }, 15000);
            slot.broker = createBroker(target, { loginOwner: owner, authentication: { username: input.username, authentication: 'oidc', callbackPort: listeningPort() },
              onAuthorizationRequired: value => {
                try {
                  const redirect = new URL(value.redirectUri), authorization = new URL(value.authorizationUrl);
                  if (redirect.pathname !== slot.callbackPath || redirect.search || redirect.hash || !isAllowedRedirectOrigin(redirect.origin, slot.ownerProof) || authorization.protocol !== 'https:' ||
                      authorization.searchParams.getAll('state').length !== 1 || !authorization.searchParams.get('state') || !scopeCurrent(slot) || loginContexts.generation(owner, target.id) !== slot.generation) throw new Error(errorMessage);
                  slot.requestId = value.requestId; slot.state = authorization.searchParams.get('state');
                  slot.redirectUri = value.redirectUri; slot.status = 'pending';
                  slot.timer = setTimeout(() => fail(slot), 225000); slot.timer.unref?.();
                  clearTimeout(timer);
                  slot.challenge = { clientRequestId: input.clientRequestId, authorizationUrl: value.authorizationUrl, expiresIn: value.expiresIn };
                  resolve(slot.challenge);
                } catch { clearTimeout(timer); fail(slot); reject(new Error(errorMessage)); return false; }
              },
              onAccountAuthenticated: (principal, authority) => {
                if (!scopeCurrent(slot) || slot.status !== 'exchanging' || loginContexts.generation(owner, target.id) !== slot.generation || principal.username !== slot.username) return false;
                slot.handle = authority?.handle; slot.principal = principal;
                slot.resolveVerified(principal);
                return true;
              },
            });
            slot.broker.child.once('error', () => { clearTimeout(timer); fail(slot); reject(new Error(errorMessage)); });
            slot.broker.child.once('close', () => {
              clearTimeout(timer);
              if (active.get(ownerKey(slot.owner, slot.targetId)) === slot) active.delete(ownerKey(slot.owner, slot.targetId));
              fail(slot); reject(new Error(errorMessage));
            });
          });
          return await challenge;
        });
        jsonResponse(response, 200, result);
      } catch {
        jsonResponse(response, 400, { error: errorMessage });
      }
      return true;
    },
  };
}
