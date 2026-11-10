import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const RELAY_PAIRING_PATH = '/api/mobile/pairing/relay';

export function gatewayMobilePairingToken(env = process.env) {
  const value = env.KCODER_STUDIO_MOBILE_PAIRING_TOKEN || '';
  if (value && (!/^[A-Za-z0-9._~-]{32,512}$/.test(value) ||
      value === env.KCODER_STUDIO_AUTH_TOKEN || value === env.KCODER_STUDIO_RELAY_SECRET)) {
    throw new Error('Mobile pairing token must be a separate 32-512 character URL-safe credential');
  }
  return value;
}

export async function selectMobilePairingCredential(mode, fixedToken, getTemporary) {
  if (!['auto', 'fixed', 'temporary'].includes(mode)) throw new Error('Invalid mobile pairing token mode');
  if (mode !== 'temporary' && fixedToken) return { kind: 'fixed', token: fixedToken, expiresAt: null };
  if (mode === 'fixed') throw new Error('Fixed mobile pairing token is not configured');
  return { ...await getTemporary(), kind: 'temporary' };
}

export function gatewayRelaySecret(env = process.env) {
  const value = env.KCODER_STUDIO_RELAY_SECRET || '';
  if (value && (!/^[A-Za-z0-9._~-]{32,512}$/.test(value) || value === env.KCODER_STUDIO_AUTH_TOKEN)) {
    throw new Error('Gateway Relay secret must be independent from the optional fixed login token');
  }
  return value;
}

export function relaySecretMatches(secret, value) {
  return Boolean(secret && typeof value === 'string' && value.length <= 512 &&
    timingSafeEqual(createHash('sha256').update(secret).digest(), createHash('sha256').update(value).digest()));
}

export function accountPairingProofMatches(secret, token, proof, surface) {
  return Boolean(secret && /^kcacct1_[A-Za-z0-9_-]{43}$/.test(token) && typeof proof === 'string' &&
    /^[a-f0-9]{64}$/.test(proof) && timingSafeEqual(Buffer.from(proof, 'hex'), createHmac('sha256', secret)
      .update((surface === 'mobileWeb' ? 'kcoder-account-web-pairing-v1\0' : 'kcoder-account-pairing-v1\0') + token).digest()));
}

// The Relay consumes the owner's one-use grant before signing the forwarded POST.
// This handler never accepts a login token, URL credential or a client redirect.
export function createRelayAccountEntryHandler({
  secret, getSecret = () => secret, publicPrefix, requestBody, jsonResponse, browserCookie, allowsSurface = () => true,
}) {
  return async (request, response, url) => {
    if (url.pathname !== '/account-entry') return false;
    const secret = getSecret();
    const prefix = publicPrefix(request);
    const proof = request.headers['x-kcoder-relay-account-entry'];
    if (!secret || !/^\/g\/[A-Za-z0-9_-]{1,64}$/.test(prefix) || url.search ||
        request.method !== 'POST' || request.headers['content-type'] !== 'application/json' ||
        typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) {
      jsonResponse(response, 403, { error: 'Relay account entry required' });
      return true;
    }
    let entry;
    try {
      const body = await requestBody(request, 512);
      const signature = createHmac('sha256', secret)
        .update(JSON.stringify(['kcoder-account-entry-v1', request.headers.host, body])).digest();
      if (timingSafeEqual(Buffer.from(proof, 'hex'), signature)) entry = JSON.parse(body);
    } catch {}
    const age = Date.now() - entry?.issuedAt;
    const mobile = entry?.surface === 'mobile';
    if (secret !== getSecret() || prefix !== publicPrefix(request) || !Number.isFinite(age) || age < -30_000 || age > 30_000 || (mobile
      ? typeof entry.mobileToken !== 'string' || !/^kcacct1_[A-Za-z0-9_-]{43}$/.test(entry.mobileToken)
      : entry?.surface !== 'desktop' || entry.mobileToken !== null)) {
      jsonResponse(response, 403, { error: 'Invalid Relay account entry' });
      return true;
    }
    if (!allowsSurface(mobile ? 'mobileWeb' : 'desktopWeb')) {
      jsonResponse(response, 403, { error: 'Public access is disabled' });
      return true;
    }
    let cookie;
    try { cookie = await browserCookie(request, !mobile); }
    catch (error) {
      if (error.status !== 429) throw error;
      jsonResponse(response, 429, { error: 'Gateway session limit reached' });
      return true;
    }
    const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      ...(cookie ? { 'set-cookie': cookie } : {}) };
    if (!mobile) {
      response.writeHead(303, { ...headers, location: prefix + '/' }).end();
      return true;
    }
    // A tab-scoped one-use pairing proof is consumed before Expo starts routing.
    const pathname = prefix + '/mobile/connect';
    const query = new URLSearchParams({ gateway: `https://${request.headers.host}${prefix}`, gatewayId: prefix.slice(3) });
    const destination = pathname + '?' + query;
    const nonce = randomBytes(18).toString('base64');
    response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
    });
    response.end(`<!doctype html><meta charset="utf-8"><title>KCoder Mobile</title><p>请启用 JavaScript 后从 KCoder 账号页重试。</p><script nonce="${nonce}">try{sessionStorage.setItem("kcoder.account-pairing",${JSON.stringify(JSON.stringify({ pathname, token: entry.mobileToken }))});location.replace(${JSON.stringify(destination)});}catch{document.querySelector("p").textContent="无法保存连接信息，请从 KCoder 账号页重试。";}</script>`);
    return true;
  };
}

export const fixedMobilePairingTokenMatches = relaySecretMatches;

// Local operator tooling can select a mobile pairing token without a browser
// login. This authority never authenticates a mobile session or a browser admin.
export function createRelayPairingHandler({ secret, getSecret = () => secret, getPairing, jsonResponse }) {
  return async (request, response, url) => {
    if (url.pathname !== RELAY_PAIRING_PATH) return false;
    const peer = request.socket?.remoteAddress;
    let loopbackHost = false;
    try { loopbackHost = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${request.headers.host}`).hostname); } catch {}
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) || !loopbackHost ||
        !relaySecretMatches(getSecret(), request.headers['x-kcoder-relay-validation'])) {
      jsonResponse(response, 404, { error: 'Pairing unavailable' }); return true;
    }
    if (request.method !== 'GET' || url.search || request.url !== RELAY_PAIRING_PATH ||
        ['origin', 'cookie', 'authorization'].some(key => request.headers[key] !== undefined)) {
      jsonResponse(response, 403, { error: 'Internal pairing request required' }); return true;
    }
    const mode = request.headers['x-kcoder-pairing-token-mode'] ?? 'auto';
    if (!['auto', 'fixed', 'temporary'].includes(mode)) {
      jsonResponse(response, 400, { error: 'Invalid mobile pairing token mode' }); return true;
    }
    try { jsonResponse(response, 200, await getPairing(mode)); }
    catch { jsonResponse(response, 503, { error: 'Pairing unavailable' }); }
    return true;
  };
}
