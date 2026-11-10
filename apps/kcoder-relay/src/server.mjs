import { Agent, createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as tcpServer, isIP } from 'node:net';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { bridge, bridgeRaw, heartbeat, RelayDuplex, RELAY_EOF_DRAIN_TIMEOUT_MS } from './transport.mjs';
import { addGatewayState, bearerToken, createGatewayRegistry, crossGatewayOrigin, normalizeGatewayAddition, onDemandTlsAllowed, requestAuthority, resolveGatewayRoute, tokenHash } from './server-routing.mjs';
import { loadEnv, relayServerConfig } from './config.mjs';
import { openRegistrationStore } from './registration-store.mjs';
import { createRelayAdministration } from './admin.mjs';
import { createPublicIngress } from './public-ingress.mjs';
import { ACCOUNT_WEB_ENTRY_HEADER, ACCOUNT_WEB_ENTRY_PATH, createAccountPortal } from './account-portal.mjs';
import { canonicalRelayAuthority } from './gateway-origin.mjs';
import { GrantGetPool } from './http-get-pool.mjs';
import {
  canonicalGatewayConnectionUrl,
  isLoopbackGatewayConnectionUrl,
  parseGatewayConnectionProofQuery,
} from './connection-routes.mjs';

const SESSION_PATH = '/api/mobile/session';
const REFRESH_PATH = '/api/mobile/session/refresh';
const ACCESS_VALIDATION_PATH = '/api/mobile/session/relay-validation';
const CONNECTION_PROOF_PATH = '/api/mobile/connection-proof';
const P2P_CONFIG_PATH = '/api/mobile/p2p';
const P2P_OFFER_PATH = '/api/mobile/p2p/offer';
const MAX_SESSION_BODY = 64 * 1024;
const MAX_P2P_BODY = 64 * 1024;
const MAX_P2P_PEERS = 1024;
const MAX_P2P_PEER_REQUESTS_PER_WINDOW = 60;
const MAX_P2P_CONCURRENCY_PER_PEER = 4;
const MAX_P2P_CONCURRENCY_PER_GATEWAY = 16;
const P2P_RATE_WINDOW_MS = 60_000;
const P2P_NONCE = /^[a-f0-9]{48}$/;
const P2P_KEY_ID = /^[a-f0-9]{64}$/;
const P2P_PROOF = /^[a-f0-9]{64}$/;
const MAX_SESSIONS = 4096;
const MAX_ACCESS_VALIDATION_FLIGHTS = 128;
const MAX_ACCESS_VALIDATION_CONCURRENCY = 4;
const ACCESS_VALIDATION_TIMEOUT_MS = 5_000;
const MAX_ACCESS_VALIDATION_BODY = 4 * 1024;
const REGISTRATION_PATH = '/_relay/register';
const ACTIVATION_PATH = '/_relay/activate-device';
const ACCOUNT_REGISTRATION_PATH = '/_relay/account/register';
const ACCOUNT_ENROLLMENT_PATH = '/_relay/account/enroll';
const ACCOUNT_SESSION_PATH = '/_relay/account/session';

function accountCredentials(request) {
  const value = request.headers.authorization;
  const encoded = typeof value === 'string' && /^Basic ([A-Za-z0-9+/=]{4,2048})$/i.exec(value)?.[1];
  if (!encoded) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return null;
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
  const separator = decoded.indexOf(':');
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (separator < 1 || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username) || password.length < 12 || password.length > 256) return null;
  return { username, password };
}
const TLS_ASK_PATH = '/_relay/tls-ask';
// Studio Gateway's browser session cookie on an HTTPS public (isolated) origin.
const HOST_SESSION_COOKIE = '__Host-kcoder_studio_session';
const HOST_ACCOUNT_COOKIE = /^__Host-kcoder_studio_session_account_[0-9a-f]{24}=[A-Za-z0-9_-]{43}$/;
const STUDIO_ACCOUNT_PATHS = new Set(['/api/kcoder-account', '/api/relay/activation', '/api/relay/switch']);
const MAX_REGISTRATION_BODY = 64 * 1024;
const REGISTRATION_BODY_TIMEOUT_MS = 5_000;
const MAX_REGISTRATION_CONCURRENCY = 8;
const MAX_GATEWAYS = 256;
const REGISTRATION_CREDENTIAL = /^[A-Za-z0-9._~-]{32,512}$/;

function legacyReject(socket) {
  socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
}

async function startLegacyRelay({ secret, device, controlPort = 18452, proxyPort = 18451, maxConnections = 128, connectTimeout = 10000 }) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const pending = new Map();
  const active = new Set();
  let control = null;
  const finishPending = (id, entry, { rejectSocket = false, destroySocket = false, destroyUpgrade = false } = {}) => {
    if (pending.get(id) !== entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    const upgradeSocket = entry.upgradeSocket;
    entry.upgradeSocket = null;
    if (upgradeSocket && entry.onUpgradeClose) upgradeSocket.removeListener('close', entry.onUpgradeClose);
    if (destroyUpgrade && upgradeSocket && !upgradeSocket.destroyed) upgradeSocket.destroy();
    if (rejectSocket) legacyReject(entry.socket);
    else if (destroySocket) entry.socket.destroy();
    return true;
  };
  const proxy = tcpServer(socket => {
    socket.on('error', () => {});
    if (!control || control.readyState !== 1 || pending.size + active.size >= maxConnections) return legacyReject(socket);
    socket.pause();
    const id = randomBytes(24).toString('hex');
    const entry = { socket, timer: null, upgradeSocket: null, onUpgradeClose: null };
    entry.timer = setTimeout(() => finishPending(id, entry, { rejectSocket: true, destroyUpgrade: true }), connectTimeout);
    pending.set(id, entry);
    socket.once('close', () => finishPending(id, entry, { destroyUpgrade: true }));
    control.send(JSON.stringify({ type: 'open', id }));
  });
  const http = httpServer((request, response) => {
    if (request.url === '/_relay/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ online: control?.readyState === 1, connections: active.size, pending: pending.size }));
    } else { response.writeHead(404); response.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  http.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    const supplied = Buffer.from(request.headers.authorization || '');
    const url = new URL(request.url, 'http://localhost');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || request.headers['x-kcoder-device'] !== device) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    if (url.pathname === '/_relay/control') {
      if (control) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      wss.handleUpgrade(request, socket, head, ws => {
        control = ws;
        heartbeat(ws);
        ws.on('error', () => {});
        ws.once('close', () => {
          if (control !== ws) return;
          control = null;
          for (const [id, entry] of pending) finishPending(id, entry, { rejectSocket: true, destroyUpgrade: true });
          for (const close of [...active]) close();
        });
      });
    } else if (url.pathname === '/_relay/data' && pending.has(url.searchParams.get('id'))) {
      const id = url.searchParams.get('id');
      const entry = pending.get(id);
      if (entry.upgradeSocket) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      entry.upgradeSocket = socket;
      entry.onUpgradeClose = () => finishPending(id, entry, { rejectSocket: true });
      socket.once('close', entry.onUpgradeClose);
      wss.handleUpgrade(request, socket, head, ws => {
        if (!finishPending(id, entry)) { ws.terminate(); return; }
        heartbeat(ws);
        const close = bridge(entry.socket, ws, () => active.delete(close));
        active.add(close);
      });
    } else { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); }
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(controlPort, '127.0.0.1', resolve); });
  try { await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxyPort, '127.0.0.1', resolve); }); }
  catch (error) { http.close(); throw error; }
  return {
    controlPort: http.address().port, proxyPort: proxy.address().port,
    async close() {
      control?.terminate();
      for (const [id, entry] of pending) finishPending(id, entry, { destroySocket: true, destroyUpgrade: true });
      for (const close of [...active]) close();
      for (const ws of wss.clients) ws.terminate();
      http.closeAllConnections?.();
      await Promise.all([new Promise(resolve => http.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
      wss.close();
    },
  };
}

function secureStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function sendHttpError(response, status, message) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(`${message}\n`);
  response.shouldKeepAlive = false;
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(body);
}

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  response.shouldKeepAlive = false;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(body);
}

function registrationError(code) {
  return Object.assign(new Error(code), { code });
}

function gatewayMatchesConfig(gateway, config) {
  return gateway.id === config?.id &&
    secureStringEqual(gateway.secret.toString(), config.secret) &&
    secureStringEqual(gateway.gatewaySecret?.toString() ?? '', config.gatewaySecret) &&
    gateway.maxConnections === config.maxConnections &&
    gateway.maxBytesPerWindow === config.maxBytesPerWindow &&
    gateway.trafficWindowMs === config.trafficWindowMs;
}

function registrationResponse(config) {
  return {
    id: config.id,
    secret: config.secret,
    gatewaySecret: config.gatewaySecret,
    maxConnections: config.maxConnections,
    maxBytesPerWindow: config.maxBytesPerWindow,
    trafficWindowMs: config.trafficWindowMs,
  };
}

function hasDuplicateJsonObjectKeys(text) {
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? '')) index += 1; };
  let duplicate = false;
  const string = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index++] === '"') return JSON.parse(text.slice(start, index));
    }
    return JSON.parse(text.slice(start, index));
  };
  const value = () => {
    whitespace();
    if (text[index] === '"') { string(); return; }
    if (text[index] === '{') {
      index += 1;
      whitespace();
      if (text[index] === '}') { index += 1; return; }
      const keys = new Set();
      while (index < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) duplicate = true;
        keys.add(key);
        whitespace();
        index += 1;
        value();
        whitespace();
        if (text[index] === ',') { index += 1; continue; }
        index += 1;
        return;
      }
      return;
    }
    if (text[index] === '[') {
      index += 1;
      whitespace();
      if (text[index] === ']') { index += 1; return; }
      while (index < text.length) {
        value();
        whitespace();
        if (text[index] === ',') { index += 1; continue; }
        index += 1;
        return;
      }
      return;
    }
    while (index < text.length && !/[\s,\]}]/.test(text[index])) index += 1;
  };
  value();
  return duplicate;
}

function closeRequestAfterResponse(request, response) {
  request.pause();
  const close = () => { if (!request.destroyed) request.destroy(); };
  response.once('finish', close);
  response.once('close', close);
}

function sendUpgradeError(socket, status, reason) {
  if (socket.destroyed) return;
  const body = `${reason}\n`;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`);
}

function gatewayIdentity(request) {
  const explicit = request.headers['x-kcoder-gateway-id'];
  const legacy = request.headers['x-kcoder-device'];
  if (explicit && legacy && explicit !== legacy) return null;
  return explicit || legacy || null;
}

function gatewayAuthorized(request, gateway) {
  if (gatewayIdentity(request) !== gateway.id) return false;
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  return secureStringEqual(authorization.slice(7), gateway.secret.toString());
}

function routeErrorStatus(error) {
  if (error === 'invalid') return [400, 'Bad Request'];
  if (error === 'shared-path' || error === 'unknown-gateway') return [404, 'Not Found'];
  return [421, 'Misdirected Request'];
}

/**
 * The shared root never runs Gateway HTML/scripts, receives logins, or proxies
 * credentials. Bodyless, query-free page navigations move to the origin derived
 * from the path's own Gateway ID; everything else fails without a Location, so
 * no query (whatever its key names or encoding) is ever reflected elsewhere.
 */
function sendSharedOriginRedirect(request, response, route) {
  const navigable = (request.method === 'GET' || request.method === 'HEAD') && route.canonicalAuthority &&
    !request.url.includes('?') && !/^\/(?:api|rpc)(?:\/|$)/.test(route.target) &&
    request.headers.authorization === undefined && request.headers['transfer-encoding'] === undefined &&
    (request.headers['content-length'] === undefined || request.headers['content-length'] === '0');
  closeRequestAfterResponse(request, response);
  if (navigable) {
    response.writeHead(308, {
      // Composed, not URL-resolved: the validated path keeps its /g/<id> mount.
      location: `https://${route.canonicalAuthority}${request.url}`,
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-length': 0, connection: 'close',
    });
    response.end();
    return;
  }
  const body = Buffer.from(JSON.stringify({
    error: 'This Relay Gateway now uses its own isolated origin. Regenerate the pairing link or QR code; existing browser data on the shared origin is not migrated.',
    code: 'RELAY_ORIGIN_ISOLATION_REQUIRED',
  }));
  response.writeHead(426, {
    'content-type': 'application/json; charset=utf-8', 'content-length': body.length,
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer', connection: 'close',
  });
  response.end(body);
}

function pathnameOf(target) {
  const index = target.indexOf('?');
  return index < 0 ? target : target.slice(0, index);
}

function canonicalConnectionEndpoint(value) {
  return canonicalGatewayConnectionUrl(value) === value && !isLoopbackGatewayConnectionUrl(value);
}

function isConnectionProofRequest(request, target) {
  if (request.method !== 'GET' || pathnameOf(target) !== CONNECTION_PROOF_PATH ||
      request.headers['transfer-encoding'] || request.headers.expect ||
      (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) return false;
  const queryStart = target.indexOf('?');
  if (queryStart < 0) return false;
  const query = parseGatewayConnectionProofQuery(target.slice(queryStart + 1));
  return Boolean(query && canonicalConnectionEndpoint(query.endpoint));
}

function requestHeaderBytes(request, target) {
  let bytes = Buffer.byteLength(`${request.method} ${target} HTTP/${request.httpVersion}\r\n\r\n`);
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    bytes += Buffer.byteLength(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`);
  }
  return bytes;
}

function responseHeaderBytes(statusCode, statusMessage, headers) {
  let bytes = Buffer.byteLength(`HTTP/1.1 ${statusCode} ${statusMessage || ''}\r\n\r\n`);
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) bytes += Buffer.byteLength(`${name}: ${item}\r\n`);
    }
  }
  return bytes;
}

function consumeTraffic(gateway, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
  const now = Date.now();
  if (now - gateway.trafficWindowStarted >= gateway.trafficWindowMs) {
    gateway.trafficWindowStarted = now;
    gateway.trafficBytes = 0;
  }
  if (bytes > gateway.maxBytesPerWindow - gateway.trafficBytes) return false;
  gateway.trafficBytes += bytes;
  return true;
}

function hopHeaders(headers) {
  const removed = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const token of String(headers.connection || '').split(',')) {
    const name = token.trim().toLowerCase();
    if (name) removed.add(name);
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !removed.has(name.toLowerCase())));
}

function rewriteSetCookie(headers, gatewayId, shared) {
  if (!shared || headers['set-cookie'] === undefined) return headers;
  const prefix = `/g/${gatewayId}/`;
  const cookies = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']];
  return {
    ...headers,
    'set-cookie': cookies.map(cookie => {
      const scoped = String(cookie).replace(/;\s*(?:domain|path)\s*=\s*[^;]*/ig, '');
      return `${scoped}; Path=${/^__Host-[^=;]+=/.test(scoped) ? '/' : prefix}`;
    }),
  };
}

function responseHeaders(upstream, route) {
  const headers = rewriteSetCookie(hopHeaders(upstream.headers), route.gateway.id, route.shared);
  if (route.isolated) headers['origin-agent-cluster'] = '?1';
  if (route.shared && headers['service-worker-allowed'] !== undefined)
    headers['service-worker-allowed'] = `/g/${route.gateway.id}/`;
  return headers;
}

function readBoundedBody(request, limit, timeoutMs) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    request.once('error', () => {});
    request.pause();
    return Promise.resolve({ error: 'too-large' });
  }
  return new Promise(resolve => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result.error) request.pause();
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('aborted', onAborted);
      // Keep onError installed after settlement: IncomingMessage can emit
      // ECONNRESET after `aborted`, and that later error must be consumed.
      resolve(result);
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > limit) {
        finish({ error: 'too-large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish({ body: Buffer.concat(chunks, bytes) });
    const onAborted = () => finish({ error: 'aborted' });
    const onError = () => finish({ error: 'read-failed' });
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
    timer = setTimeout(() => finish({ error: 'timeout' }), timeoutMs);
    timer.unref?.();
  });
}

function accessCredentialFromSubprotocol(request) {
  const values = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
  const carriers = values.filter(value => value.startsWith('kcoder-session.'));
  if (carriers.length === 0) return { token: null, invalid: false };
  const match = carriers.length === 1 && carriers[0].match(/^kcoder-session\.([A-Za-z0-9._~-]{1,512})$/);
  return { token: match ? match[1] : null, invalid: !match };
}

function findSession(gateway, accessToken) {
  if (!accessToken) return null;
  const hash = tokenHash(accessToken);
  const session = gateway.sessions.get(hash);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    if (session.deviceId) { session.httpGetPool?.retire(Object.assign(new Error('Access grant expired'), { code: 'RELAY_UNAUTHORIZED' })); gateway.sessions.delete(hash); } else revokeSession(gateway, hash, session);
    return null;
  }
  return { hash, session };
}

function revokeDeviceFamily(gateway, deviceId) {
  const family = gateway.mobileDeviceFamilies?.get(deviceId);
  if (!family) return;
  gateway.mobileDeviceFamilies.delete(deviceId); clearTimeout(family.expiryTimer);
  for (const [hash, session] of gateway.sessions) if (session.deviceId === deviceId) { session.httpGetPool?.retire(Object.assign(new Error('Device revoked'), { code: 'RELAY_UNAUTHORIZED' }), true); gateway.sessions.delete(hash); }
  for (const close of [...family.active]) close(); family.active.clear();
}
function revokeSession(gateway, hash, session) {
  session.httpGetPool?.retire(Object.assign(new Error('Session revoked'), { code: 'RELAY_UNAUTHORIZED' }), true);
  if (session.deviceId) { revokeDeviceFamily(gateway, session.deviceId); return; }
  if (gateway.sessions.get(hash) === session) gateway.sessions.delete(hash);
  clearTimeout(session.expiryTimer);
  for (const close of [...session.active]) close();
  session.active.clear();
}

function pruneSessions(gateway) {
  for (const [hash, session] of gateway.sessions) {
    if (session.expiresAt <= Date.now()) { if (session.deviceId) { session.httpGetPool?.retire(Object.assign(new Error('Access grant expired'), { code: 'RELAY_UNAUTHORIZED' })); gateway.sessions.delete(hash); } else revokeSession(gateway, hash, session); }
  }
}

function browserSessionCredential(request) {
  const cookie = isolatedSessionCookie(request.headers.cookie);
  if (cookie === undefined) return null;
  try {
    const value = decodeURIComponent(cookie.slice(HOST_SESSION_COOKIE.length + 1));
    return /^[A-Za-z0-9-]{32,128}$/.test(value) ? value : null;
  } catch { return null; }
}

function httpAccessCredential(request) {
  // An explicit Authorization header must never fall back to ambient cookies.
  return request.headers.authorization !== undefined ? bearerToken(request) : browserSessionCredential(request);
}

function accessForApi(gateway, request) {
  const access = httpAccessCredential(request);
  return findSession(gateway, access);
}

function rpcAccessCredential(request) {
  const bearer = bearerToken(request);
  const credential = accessCredentialFromSubprotocol(request);
  if (credential.invalid) return { token: null, invalid: true };
  const protocol = credential.token;
  if (bearer && protocol && !secureStringEqual(bearer, protocol)) return { token: null, invalid: true };
  const cookie = request.headers.authorization === undefined && !protocol ? browserSessionCredential(request) : null;
  return { token: bearer || protocol || cookie, invalid: request.headers.authorization !== undefined && !bearer };
}

function accessForRpc(gateway, request) {
  const credential = rpcAccessCredential(request);
  if (credential.invalid) return null;
  return findSession(gateway, credential.token);
}

function rpcTokenFromTarget(target) {
  let url;
  try { url = new URL(target, 'http://relay.invalid'); } catch { return null; }
  const tokens = [...url.searchParams.getAll('token'), ...url.searchParams.getAll('rpcToken')];
  if (tokens.length !== 1 || !/^[A-Za-z0-9._~-]{1,512}$/.test(tokens[0])) return null;
  return tokens[0];
}

/**
 * Isolated routes show the target Gateway only its own host-only session
 * cookie. Browsers still attach parent-domain (pre-isolation) and unrelated
 * cookies to the subdomain; those are never forwarded. A repeated session
 * name is ambiguous, so every copy is dropped. The kept pair is byte-exact.
 */
function isolatedSessionCookie(header) {
  if (header === undefined) return undefined;
  const pairs = String(header).split(';').map(pair => pair.replace(/^[ \t]+|[ \t]+$/g, ''))
    .filter(pair => pair.startsWith(`${HOST_SESSION_COOKIE}=`));
  return pairs.length === 1 ? pairs[0] : undefined;
}

function makeRawUpgradeRequest(request, target, host, isolated = false) {
  const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding']);
  const connectionTokens = new Set(String(request.headers.connection || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  const lines = [`${request.method} ${target} HTTP/${request.httpVersion}`];
  let hasUpgrade = false;
  let cookieSent = false;
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = String(request.rawHeaders[index]);
    const lower = name.toLowerCase();
    if (lower === 'connection') continue;
    if (lower === 'host' && host) { lines.push(`Host: ${host}`); continue; }
    if (blocked.has(lower) || lower === 'x-kcoder-relay-validation' || lower === 'x-kcoder-relay-account-pairing' || lower === ACCOUNT_WEB_ENTRY_HEADER || (connectionTokens.has(lower) && lower !== 'upgrade')) continue;
    if (lower === 'cookie' && isolated) {
      // Node joins repeated Cookie lines in request.headers; emit one filtered line.
      const cookie = cookieSent ? undefined : isolatedSessionCookie(request.headers.cookie);
      cookieSent = true;
      if (cookie !== undefined) lines.push(`${name}: ${cookie}`);
      continue;
    }
    if (lower === 'upgrade') hasUpgrade = true;
    lines.push(`${name}: ${request.rawHeaders[index + 1]}`);
  }
  if (!hasUpgrade) return null;
  lines.push('Connection: Upgrade', '', '');
  return Buffer.from(lines.join('\r\n'));
}

function sessionResponse(upstream, route, gateway) {
  return new Promise(resolve => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const headers = responseHeaders(upstream, route);
    const headerBytes = responseHeaderBytes(upstream.statusCode, upstream.statusMessage, headers);
    if (!consumeTraffic(gateway, headerBytes)) {
      finish({ error: 'traffic' });
      upstream.destroy();
      return;
    }
    upstream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_SESSION_BODY || !consumeTraffic(gateway, chunk.length)) {
        finish({ error: bytes > MAX_SESSION_BODY ? 'too-large' : 'traffic' });
        upstream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    upstream.once('end', () => {
      finish({ statusCode: upstream.statusCode || 502, statusMessage: upstream.statusMessage, headers, body: Buffer.concat(chunks, bytes) });
    });
    upstream.once('aborted', () => finish({ error: 'upstream' }));
    upstream.once('error', () => finish({ error: 'upstream' }));
    upstream.once('close', () => finish({ error: 'upstream' }));
  });
}

function admitRefreshPeer(gateway, request) {
  gateway.refreshPeers ??= new Map();
  const now = Date.now(); const peer = request.socket.remoteAddress || 'unknown';
  for (const [address, value] of gateway.refreshPeers) if (value.resetAt <= now) gateway.refreshPeers.delete(address);
  let value = gateway.refreshPeers.get(peer);
  if (!value) {
    if (gateway.refreshPeers.size >= 1024) return false;
    value = { count: 0, resetAt: now + 60_000 }; gateway.refreshPeers.set(peer, value);
  }
  value.count++; return value.count <= 60;
}

function admitConnectionProofPeer(gateway, request) {
  gateway.connectionProofPeers ??= new Map();
  const now = Date.now(); const peer = request.socket.remoteAddress || 'unknown';
  for (const [address, value] of gateway.connectionProofPeers) {
    if (value.resetAt <= now) gateway.connectionProofPeers.delete(address);
  }
  let value = gateway.connectionProofPeers.get(peer);
  if (!value) {
    if (gateway.connectionProofPeers.size >= 1024) return false;
    value = { count: 0, resetAt: now + 60_000 };
    gateway.connectionProofPeers.set(peer, value);
  }
  value.count++;
  return value.count <= 60;
}

function admitAccessValidationPeer(gateway, request) {
  gateway.accessValidationPeers ??= new Map();
  const now = Date.now();
  const peer = request.socket.remoteAddress || 'unknown';
  for (const [address, value] of gateway.accessValidationPeers) {
    if (value.resetAt <= now) gateway.accessValidationPeers.delete(address);
  }
  let value = gateway.accessValidationPeers.get(peer);
  if (!value) {
    if (gateway.accessValidationPeers.size >= 1024) return false;
    value = { count: 0, resetAt: now + 60_000 };
    gateway.accessValidationPeers.set(peer, value);
  }
  value.count++;
  return value.count <= 60;
}

function acquireP2pRequest(gateway, request) {
  gateway.p2pPeers ??= new Map();
  const now = Date.now();
  const peer = request.socket.remoteAddress || 'unknown';
  for (const [address, value] of gateway.p2pPeers) {
    if (value.resetAt <= now && value.active === 0) gateway.p2pPeers.delete(address);
  }
  let value = gateway.p2pPeers.get(peer);
  let created = false;
  if (!value) {
    if (gateway.p2pPeers.size >= MAX_P2P_PEERS) return null;
    value = { count: 0, active: 0, resetAt: now + P2P_RATE_WINDOW_MS };
    gateway.p2pPeers.set(peer, value);
    created = true;
  } else if (value.resetAt <= now) {
    value.count = 0;
    value.resetAt = now + P2P_RATE_WINDOW_MS;
  }
  if (value.count >= MAX_P2P_PEER_REQUESTS_PER_WINDOW) {
    if (created) gateway.p2pPeers.delete(peer);
    return null;
  }

  value.count += 1;
  if (value.active >= MAX_P2P_CONCURRENCY_PER_PEER ||
      (gateway.p2pActive || 0) >= Math.min(gateway.maxConnections, MAX_P2P_CONCURRENCY_PER_GATEWAY)) return null;

  value.active += 1;
  gateway.p2pActive = (gateway.p2pActive || 0) + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    value.active = Math.max(0, value.active - 1);
    gateway.p2pActive = Math.max(0, (gateway.p2pActive || 0) - 1);
    if (value.active === 0 && value.resetAt <= Date.now() && gateway.p2pPeers.get(peer) === value) {
      gateway.p2pPeers.delete(peer);
    }
  };
}

function validP2pOfferBody(body) {
  let payload;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    payload = JSON.parse(text);
    if (hasDuplicateJsonObjectKeys(text)) return false;
  } catch {
    return false;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  const auth = payload.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return false;
  const authKeys = Object.keys(auth);
  return keys.length === 4 && keys.every(key => key === 'version' || key === 'nonce' || key === 'offer' || key === 'auth') &&
    payload.version === 1 && typeof payload.nonce === 'string' && P2P_NONCE.test(payload.nonce) &&
    typeof payload.offer === 'string' && Buffer.byteLength(payload.offer, 'utf8') > 0 &&
    Buffer.byteLength(payload.offer, 'utf8') <= MAX_P2P_BODY &&
    authKeys.length === 3 && authKeys.every(key => key === 'kind' || key === 'keyId' || key === 'proof') &&
    (auth.kind === 'pairing' || auth.kind === 'access') && typeof auth.keyId === 'string' && P2P_KEY_ID.test(auth.keyId) &&
    typeof auth.proof === 'string' && P2P_PROOF.test(auth.proof);
}

function registerSession(gateway, payload) {
  const accessToken = payload?.accessToken;
  const rpcToken = payload?.rpcToken;
  const expiresAt = payload?.expiresAt;
  if (typeof accessToken !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(accessToken) ||
      typeof rpcToken !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(rpcToken) ||
      typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || (expiresAt <= Date.now() && !(payload.capabilities?.mobileRefreshV1 === true && payload.refreshExpiresAt > Date.now()))) return false;
  const deviceId = payload.deviceId;
  if (payload.capabilities?.mobileRefreshV1 === true) {
    if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(deviceId) || !Number.isSafeInteger(payload.wsLeaseExpiresAt) || payload.wsLeaseExpiresAt < expiresAt || payload.wsLeaseExpiresAt > expiresAt + 24 * 60 * 60_000 || !Number.isSafeInteger(payload.refreshExpiresAt) || payload.refreshExpiresAt < payload.wsLeaseExpiresAt) return false;
    gateway.mobileDeviceFamilies ??= new Map();
    let family = gateway.mobileDeviceFamilies.get(deviceId);
    if (!family && gateway.mobileDeviceFamilies.size + gateway.sessions.size >= MAX_SESSIONS) return false;
    if (!family) { family = { active: new Set(), expiryTimer: null, expiresAt: payload.wsLeaseExpiresAt, refreshExpiresAt: payload.refreshExpiresAt }; gateway.mobileDeviceFamilies.set(deviceId, family); }
    clearTimeout(family.expiryTimer);
    // Replace access grants without closing channels owned by the same device.
    for (const [oldHash, oldSession] of gateway.sessions) if (oldSession.deviceId === deviceId) { oldSession.httpGetPool?.retire(Object.assign(new Error('Access grant replaced'), { code: 'RELAY_UNAUTHORIZED' })); gateway.sessions.delete(oldHash); }
    family.expiresAt = payload.wsLeaseExpiresAt;
    family.refreshExpiresAt = payload.refreshExpiresAt;
    gateway.sessions.set(tokenHash(accessToken), { deviceId, rpcHash: tokenHash(rpcToken), expiresAt, active: family.active, expiryTimer: null });
    const expire = () => { const remaining = family.expiresAt - Date.now(); if (remaining <= 0) revokeDeviceFamily(gateway, deviceId); else { family.expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_000_000)); family.expiryTimer.unref?.(); } }; expire();
    return true;
  }
  pruneSessions(gateway);
  const accessHash = tokenHash(accessToken);
  const existing = gateway.sessions.get(accessHash);
  if (!existing && gateway.sessions.size >= MAX_SESSIONS) return false;
  if (existing) revokeSession(gateway, accessHash, existing);
  const session = {
    rpcHash: tokenHash(rpcToken),
    expiresAt,
    active: new Set(),
    expiryTimer: null,
  };
  gateway.sessions.set(accessHash, session);
  const expire = () => {
    if (gateway.sessions.get(accessHash) !== session) return;
    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) {
      revokeSession(gateway, accessHash, session);
      return;
    }
    session.expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_000_000));
    session.expiryTimer.unref?.();
  };
  expire();
  return true;
}

function parseAccessValidationResponse(body, { requestId, accessToken }) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { return null; }
  const allowed = new Set([
    'version', 'kind', 'requestId', 'accessTokenHash', 'rpcTokenHash', 'expiresAt',
    'accessExpiresAt', 'wsLeaseExpiresAt', 'refreshExpiresAt', 'deviceId',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.has(key)) ||
      value.version !== 1 || value.kind !== 'access' || value.requestId !== requestId ||
      !secureStringEqual(value.accessTokenHash, tokenHash(accessToken)) ||
      typeof value.rpcTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.rpcTokenHash) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() ||
      !Number.isSafeInteger(value.accessExpiresAt) || value.accessExpiresAt !== value.expiresAt) return null;
  if (value.deviceId !== undefined && (typeof value.deviceId !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(value.deviceId))) return null;
  if (value.wsLeaseExpiresAt !== undefined && (!Number.isSafeInteger(value.wsLeaseExpiresAt) ||
      value.wsLeaseExpiresAt < value.expiresAt || value.wsLeaseExpiresAt > value.expiresAt + 24 * 60 * 60_000)) return null;
  if ((value.deviceId !== undefined) !== (value.wsLeaseExpiresAt !== undefined)) return null;
  if (value.refreshExpiresAt !== undefined && (!Number.isSafeInteger(value.refreshExpiresAt) ||
      value.refreshExpiresAt < (value.wsLeaseExpiresAt ?? value.expiresAt))) return null;
  if (value.deviceId !== undefined && value.refreshExpiresAt === undefined) return null;
  return {
    accessTokenHash: value.accessTokenHash,
    rpcTokenHash: value.rpcTokenHash,
    expiresAt: value.expiresAt,
    deviceId: value.deviceId,
    wsLeaseExpiresAt: value.wsLeaseExpiresAt,
    refreshExpiresAt: value.refreshExpiresAt,
  };
}

function registerValidatedAccess(gateway, metadata) {
  pruneSessions(gateway);
  const accessHash = metadata.accessTokenHash;
  const existing = gateway.sessions.get(accessHash);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.rpcHash === metadata.rpcTokenHash &&
      existing.expiresAt === metadata.expiresAt &&
      (existing.deviceId ?? null) === (metadata.deviceId ?? null);
  }
  if (metadata.deviceId) {
    gateway.mobileDeviceFamilies ??= new Map();
    let family = gateway.mobileDeviceFamilies.get(metadata.deviceId);
    if (!family && gateway.mobileDeviceFamilies.size + gateway.sessions.size >= MAX_SESSIONS) return false;
    if (!family) {
      family = { active: new Set(), expiryTimer: null, expiresAt: metadata.wsLeaseExpiresAt, refreshExpiresAt: metadata.refreshExpiresAt };
      gateway.mobileDeviceFamilies.set(metadata.deviceId, family);
    }
    clearTimeout(family.expiryTimer);
    for (const [oldHash, oldSession] of gateway.sessions) {
      if (oldSession.deviceId !== metadata.deviceId || oldHash === accessHash) continue;
      oldSession.httpGetPool?.retire(Object.assign(new Error('Access grant replaced'), { code: 'RELAY_UNAUTHORIZED' }));
      gateway.sessions.delete(oldHash);
    }
    family.expiresAt = metadata.wsLeaseExpiresAt;
    family.refreshExpiresAt = metadata.refreshExpiresAt;
    gateway.sessions.set(accessHash, {
      deviceId: metadata.deviceId,
      rpcHash: metadata.rpcTokenHash,
      expiresAt: metadata.expiresAt,
      active: family.active,
      expiryTimer: null,
    });
    const expire = () => {
      const remaining = family.expiresAt - Date.now();
      if (remaining <= 0) revokeDeviceFamily(gateway, metadata.deviceId);
      else {
        family.expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_000_000));
        family.expiryTimer.unref?.();
      }
    };
    expire();
    return true;
  }
  if (gateway.sessions.size >= MAX_SESSIONS) return false;
  const session = {
    rpcHash: metadata.rpcTokenHash,
    expiresAt: metadata.expiresAt,
    active: new Set(),
    expiryTimer: null,
  };
  gateway.sessions.set(accessHash, session);
  const expire = () => {
    if (gateway.sessions.get(accessHash) !== session) return;
    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) revokeSession(gateway, accessHash, session);
    else {
      session.expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_000_000));
      session.expiryTimer.unref?.();
    }
  };
  expire();
  return true;
}

function sameHash(value, hash) {
  return typeof value === 'string' && secureStringEqual(tokenHash(value), hash);
}

function gatewayOnline(gateway) {
  return gateway.control?.ws.readyState === 1;
}

function closeActive(gateway, close) {
  gateway.active.delete(close);
}

async function startMultiRelay({
  gateways = [],
  sharedHosts = [],
  publicTlsOrigin,
  registrationKey: configuredRegistrationKey,
  registrationStoreFile,
  adminPasswordHash,
  adminUsername = 'admin',
  requireAccount = Boolean(adminPasswordHash),
  controlPort = 18452,
  proxyPort = 18451,
  maxConnections = 128,
  maxBytesPerWindow = 256 * 1024 * 1024,
  trafficWindowMs = 60_000,
  connectTimeout = 10_000,
  pairingBodyTimeoutMs = 5_000,
}) {
  const tlsOrigin = publicTlsOrigin ? new URL(publicTlsOrigin) : null;
  if (typeof requireAccount !== 'boolean' || (requireAccount && !adminPasswordHash)) {
    throw new Error('Relay account enrollment requires an enabled administrator panel');
  }
  if (!Number.isSafeInteger(connectTimeout) || connectTimeout < 1) throw new Error('Invalid connectTimeout');
  if (!Number.isSafeInteger(pairingBodyTimeoutMs) || pairingBodyTimeoutMs < 1 || pairingBodyTimeoutMs > 10_000) {
    throw new Error('Invalid pairingBodyTimeoutMs (must be 1..10000 ms)');
  }
  const hasRegistrationStore = typeof registrationStoreFile === 'string' && registrationStoreFile.length > 0;
  const registrationKey = configuredRegistrationKey === '' ? undefined : configuredRegistrationKey;
  if (registrationKey !== undefined && !hasRegistrationStore) throw new Error('Registration key requires a registration store file');
  if (registrationKey !== undefined && (typeof registrationKey !== 'string' || !REGISTRATION_CREDENTIAL.test(registrationKey))) {
    throw new Error('Registration key must be a 32 to 512 character Bearer token');
  }
  if (registrationStoreFile !== undefined && !hasRegistrationStore) throw new Error('Invalid registration store file');
  if (gateways.length > MAX_GATEWAYS) throw new Error(`Relay supports at most ${MAX_GATEWAYS} Gateways`);

  const registrationStore = hasRegistrationStore
    ? await openRegistrationStore({ path: registrationStoreFile, maxGateways: MAX_GATEWAYS - gateways.length })
    : null;
  let registry;
  let administration;
  let persistedGatewayIds = [];
  try {
    let initialGateways = gateways;
    if (registrationStore) {
      const storedGateways = await registrationStore.list();
      if (!Array.isArray(storedGateways)) throw new Error('Registration store returned an invalid Gateway list');
      if (gateways.length + storedGateways.length > MAX_GATEWAYS) throw new Error('Relay Gateway capacity exceeded');
      persistedGatewayIds = storedGateways.map(gateway => gateway.id);
      initialGateways = [...gateways, ...storedGateways];
    }
    registry = createGatewayRegistry({
      gateways: initialGateways,
      sharedHosts,
      allowEmpty: Boolean(registrationStore),
      maxConnections,
      maxBytesPerWindow,
      trafficWindowMs,
    });
    if (registrationKey && [...registry.byId.values()].some(gateway =>
      secureStringEqual(gateway.secret.toString(), registrationKey) ||
      secureStringEqual(gateway.gatewaySecret?.toString() ?? '', registrationKey))) {
      throw new Error('Registration key must be independent from all Gateway credentials');
    }
    administration = createRelayAdministration({ store: registrationStore, sharedHosts: registry.sharedHosts,
      passwordHash: adminPasswordHash, username: adminUsername, requireAccount,
      snapshot: () => {
        const state = registrationStore.managementSnapshot();
        return { ...state, gateways: [
          ...state.gateways.map(gateway => ({ ...gateway, online: gatewayOnline(registry.byId.get(gateway.id) ?? {}) })),
          ...[...registry.byId.values()].filter(gateway => !dynamicGatewayIds.has(gateway.id))
            .map(gateway => ({ id: gateway.id, label: '', revokedAt: null, online: gatewayOnline(gateway), readOnly: true })),
        ] };
      },
      revokeGateway: async id => {
        await registrationStore.revokeGateway(id);
        removeGateway(id);
      },
      revokeAccount: async id => {
        for (const gatewayId of await registrationStore.revokeAccount(id)) removeGateway(gatewayId);
      },
    });
  } catch (error) {
    try { await registrationStore?.close(); } catch {}
    throw error;
  }
  const stateById = registry.byId;
  const publicIngress = createPublicIngress(tlsOrigin?.protocol === 'https:' && registry.sharedHosts.has(tlsOrigin.host)
    ? tlsOrigin.origin : undefined);
  const accountPortal = createAccountPortal({ store: registrationStore, sharedHosts: registry.sharedHosts,
    gatewayIngressStatus: publicIngress.status,
    gatewayAvailable: id => {
      const gateway = stateById.get(id);
      return Boolean(gateway?.gatewaySecret && gatewayOnline(gateway));
    },
    gatewaySurfaceAllowed: async (id, authority, surface) => {
      const gateway = stateById.get(id);
      if (!gateway || !gatewayOnline(gateway)) return false;
      const result = await requestGatewayAccessValidation(gateway, surface, authority, Date.now() + 3000, 'public-surface');
      return result.allowed === true;
    } });
  const dynamicGatewayIds = new Set(persistedGatewayIds);

  function removeGateway(id) {
    publicIngress.remove(id);
    const gateway = registry.byId.get(id);
    if (!gateway) return;
    registry.byId.delete(id);
    registry.byOriginLabel.delete(gateway.originLabel);
    dynamicGatewayIds.delete(id);
    for (const entry of [...gateway.pending.values()]) finishPending(entry, 'unavailable');
    for (const close of [...gateway.active]) close();
    gateway.control?.ws.terminate();
    for (const [hash, session] of [...gateway.sessions]) revokeSession(gateway, hash, session);
    for (const deviceId of [...(gateway.mobileDeviceFamilies?.keys() || [])]) revokeDeviceFamily(gateway, deviceId);
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });

  const finishPending = (entry, error, { destroyUpgrade = true, notifyFailure = true } = {}) => {
    const gateway = entry.gateway;
    if (gateway.pending.get(entry.id) !== entry) return false;
    gateway.pending.delete(entry.id);
    clearTimeout(entry.timer);
    if (entry.upgradeSocket && entry.onUpgradeClose) entry.upgradeSocket.removeListener('close', entry.onUpgradeClose);
    const upgradeSocket = entry.upgradeSocket;
    entry.upgradeSocket = null;
    if (destroyUpgrade && upgradeSocket && !upgradeSocket.destroyed) upgradeSocket.destroy();
    if (notifyFailure) entry.onFailure(error);
    return true;
  };

  const cancelPending = entry => finishPending(entry, null, { destroyUpgrade: true, notifyFailure: false });

  function makeConnectionRoom(gateway) {
    const full = () => gateway.pending.size + gateway.active.size + gateway.pairingReads >= gateway.maxConnections;
    if (!full()) return true;
    // Idle GET channels remain charged, but cannot permanently exclude refresh,
    // delete, pairing or RPC. Evict only unused parser connections, never active work.
    for (const session of gateway.sessions.values()) {
      session.httpGetPool?.evictIdle();
      if (!full()) return true;
    }
    return false;
  }

  function openPending(gateway, session, onAttach, onFailure) {
    if (!gatewayOnline(gateway)) {
      onFailure(Object.assign(new Error('Gateway is offline'), { code: 'RELAY_UNAVAILABLE' }));
      return null;
    }
    if (!makeConnectionRoom(gateway)) {
      onFailure(Object.assign(new Error('Gateway connection limit reached'), { code: 'RELAY_UNAVAILABLE' }));
      return null;
    }
    const control = gateway.control;
    const entry = {
      id: randomBytes(24).toString('hex'),
      gateway,
      session,
      generation: control.generation,
      control: control.ws,
      onAttach,
      onFailure,
      timer: null,
      upgradeSocket: null,
      onUpgradeClose: null,
    };
    gateway.pending.set(entry.id, entry);
    entry.timer = setTimeout(() => finishPending(entry, Object.assign(new Error('Gateway data connection timed out'), { code: 'RELAY_TIMEOUT' })), connectTimeout);
    entry.timer.unref?.();
    try {
      control.ws.send(JSON.stringify({ type: 'open', id: entry.id, gatewayId: gateway.id }), error => {
        if (error) finishPending(entry, Object.assign(new Error('Gateway control connection failed'), { code: 'RELAY_UNAVAILABLE' }));
      });
    } catch {
      finishPending(entry, Object.assign(new Error('Gateway control connection failed'), { code: 'RELAY_UNAVAILABLE' }));
    }
    return entry;
  }

  function activateEntry(entry, ws) {
    const gateway = entry.gateway;
    const current = gateway.pending.get(entry.id) === entry && gateway.control?.ws === entry.control &&
      gateway.control.generation === entry.generation && gatewayOnline(gateway);
    if (!current) { ws.terminate(); return; }
    gateway.pending.delete(entry.id);
    clearTimeout(entry.timer);
    if (entry.upgradeSocket && entry.onUpgradeClose) entry.upgradeSocket.removeListener('close', entry.onUpgradeClose);
    entry.upgradeSocket = null;

    const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 });
    let drainTimer = null;
    const close = () => {
      if (!gateway.active.has(close)) return;
      clearTimeout(drainTimer);
      drainTimer = null;
      closeActive(gateway, close);
      entry.session?.active.delete(close);
      stream.destroy();
      ws.terminate();
    };
    const finishDrain = () => {
      if (stream.readableEnded && stream.writableFinished && ws.readyState === ws.CLOSED)
        close();
    };
    const beginDrain = () => {
      if (!gateway.active.has(close)) return;
      if (drainTimer === null) {
        drainTimer = setTimeout(close, RELAY_EOF_DRAIN_TIMEOUT_MS);
        drainTimer.unref?.();
      }
      finishDrain();
    };
    gateway.active.add(close);
    entry.session?.active.add(close);
    heartbeat(ws);
    ws.on('error', close);
    ws.once('close', code => {
      // Keep received bytes until the HTTP parser/RelayDuplex consumes EOF.
      // Explicit close/revoke and stream errors never take this grace path.
      if (code === 1000 || code === 1001 || code === 1005) beginDrain();
      else close();
    });
    stream.on('error', close);
    stream.once('end', beginDrain);
    stream.once('finish', finishDrain);
    stream.once('close', close);
    try { entry.onAttach(stream, close); }
    catch { close(); }
  }

  function getGrantPool(gateway, session, hash, browser = false) {
    const control = gateway.control;
    const generation = control?.generation;
    const controlSocket = control?.ws;
    if (session.httpGetPool && !session.httpGetPool.retired && session.httpGetPool.control === control && session.httpGetPool.generation === generation) return session.httpGetPool;
    session.httpGetPool?.retire(Object.assign(new Error('Control generation changed'), { code: 'RELAY_UNAVAILABLE' }), true);
    const validate = () => {
      if (gateway.sessions.get(hash) !== session || session.expiresAt <= Date.now())
        return Object.assign(new Error('Access grant changed'), { code: 'RELAY_UNAUTHORIZED' });
      if (gateway.control !== control || gateway.control?.generation !== generation || gateway.control?.ws !== controlSocket || !gatewayOnline(gateway))
        return Object.assign(new Error('Control generation changed'), { code: 'RELAY_UNAVAILABLE' });
      return null;
    };
    const pool = new GrantGetPool({
      validate, expiresAt: session.expiresAt, queueTimeoutMs: connectTimeout,
      maxSockets: Math.min(browser ? 16 : 2, gateway.maxConnections),
      admitWaiter() {
        const count = gateway.httpGetWaiters || 0;
        if (count >= (browser ? Math.min(512, gateway.maxConnections * 4) : gateway.maxConnections)) return false;
        gateway.httpGetWaiters = count + 1; return true;
      },
      releaseWaiter() { gateway.httpGetWaiters = Math.max(0, (gateway.httpGetWaiters || 0) - 1); },
      createConnection(assertCurrent) {
        const tunnel = new RelayDuplex();
        let entry;
        tunnel.once('close', () => { if (entry) cancelPending(entry); });
        // Install ClientRequest handlers before a synchronous capacity/auth failure.
        queueMicrotask(() => {
          try {
            assertCurrent();
            if (tunnel.destroyed) return;
            entry = openPending(gateway, session, (stream, close) => tunnel.attach(stream, close), error => tunnel.fail(error));
          } catch (error) { tunnel.fail(error); }
        });
        return tunnel;
      },
    });
    pool.control = control;
    pool.generation = generation;
    session.httpGetPool = pool;
    return pool;
  }

  function requestGatewayAccessValidation(gateway, accessToken, authority, deadline, kind = 'access') {
    return new Promise(resolve => {
      const control = gateway.control;
      const generation = control?.generation;
      const controlSocket = control?.ws;
      if (!gatewayOnline(gateway) || !gateway.gatewaySecret || !control) {
        resolve({ error: 'unavailable' });
        return;
      }
      const requestId = randomBytes(24).toString('hex');
      const body = Buffer.from(JSON.stringify({ version: 1, kind, credential: accessToken, requestId }));
      if (body.length > MAX_ACCESS_VALIDATION_BODY || !consumeTraffic(gateway, body.length)) {
        resolve({ error: body.length > MAX_ACCESS_VALIDATION_BODY ? 'invalid' : 'traffic' });
        return;
      }

      const tunnel = new RelayDuplex();
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = () => tunnel;
      let entry;
      let upstreamRequest;
      let settled = false;
      let timer;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (upstreamRequest && !upstreamRequest.destroyed) upstreamRequest.destroy();
        if (!tunnel.destroyed) tunnel.destroy();
        agent.destroy();
        if (entry) cancelPending(entry);
        resolve(result);
      };
      tunnel.once('close', () => { if (entry) cancelPending(entry); });
      const remainingMs = Math.max(1, deadline - Date.now());
      timer = setTimeout(() => finish({ error: 'timeout' }), remainingMs);
      timer.unref?.();
      const validationHeader = gateway.gatewaySecret.toString();
      const headers = {
        host: authority,
        'content-type': 'application/json',
        'content-length': String(body.length),
        'x-kcoder-relay-validation': validationHeader,
        connection: 'close',
      };
      const requestBytes = Buffer.byteLength(`POST ${ACCESS_VALIDATION_PATH} HTTP/1.1\r\n`) +
        Object.entries(headers).reduce((sum, [name, value]) => sum + Buffer.byteLength(`${name}: ${value}\r\n`), 0) + 2;
      if (!consumeTraffic(gateway, requestBytes)) {
        finish({ error: 'traffic' });
        return;
      }
      upstreamRequest = httpRequest({
        host: 'kcoder-relay.invalid',
        port: 80,
        method: 'POST',
        path: ACCESS_VALIDATION_PATH,
        headers,
        agent,
      });
      upstreamRequest.on('error', error => {
        finish({ error: error?.code === 'RELAY_TIMEOUT' ? 'timeout' : error?.code === 'RELAY_TRAFFIC_LIMIT' ? 'traffic' : 'unavailable' });
      });
      upstreamRequest.on('response', upstream => {
        let bytes = 0;
        const chunks = [];
        const headerBytes = responseHeaderBytes(upstream.statusCode, upstream.statusMessage, upstream.headers);
        if (!consumeTraffic(gateway, headerBytes) || Number(upstream.headers['content-length']) > MAX_ACCESS_VALIDATION_BODY) {
          finish({ error: Number(upstream.headers['content-length']) > MAX_ACCESS_VALIDATION_BODY ? 'invalid' : 'traffic' });
          upstream.destroy();
          return;
        }
        upstream.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_ACCESS_VALIDATION_BODY || !consumeTraffic(gateway, chunk.length)) {
            const error = bytes > MAX_ACCESS_VALIDATION_BODY ? 'invalid' : 'traffic';
            finish({ error });
            upstream.destroy();
            return;
          }
          chunks.push(chunk);
        });
        upstream.once('end', () => {
          if (settled) return;
          if (gateway.control !== control || gateway.control?.generation !== generation || gateway.control?.ws !== controlSocket || !gatewayOnline(gateway)) {
            finish({ error: 'unavailable' });
            return;
          }
          if (kind === 'public-surface') {
            // Older Gateways reject the policy query as an unknown request kind.
            finish({ allowed: upstream.statusCode === 204 || upstream.statusCode === 400 });
            return;
          }
          if (upstream.statusCode !== 200) {
            finish({ error: upstream.statusCode === 401 || upstream.statusCode === 403 ? 'unauthorized' : 'unavailable' });
            return;
          }
          const metadata = parseAccessValidationResponse(Buffer.concat(chunks, bytes), { requestId, accessToken });
          finish(metadata ? { metadata, control, controlSocket, generation } : { error: 'unauthorized' });
        });
        upstream.once('aborted', () => finish({ error: 'unavailable' }));
        upstream.once('error', () => finish({ error: 'unavailable' }));
      });
      entry = openPending(gateway, null, (stream, close) => tunnel.attach(stream, close), error => {
        finish({ error: error?.code === 'RELAY_TIMEOUT' ? 'timeout' : error?.code === 'RELAY_TRAFFIC_LIMIT' ? 'traffic' : 'unavailable' });
      });
      if (!entry) return;
      tunnel.once('connect', () => {
        if (settled || Date.now() >= deadline) { finish({ error: 'timeout' }); return; }
        upstreamRequest.end(body);
      });
    });
  }

  function validateUnknownAccess(gateway, accessToken, authority, request) {
    const cached = findSession(gateway, accessToken);
    if (cached) return Promise.resolve(cached);
    if (!gateway.gatewaySecret || !/^[A-Za-z0-9._~-]{1,512}$/.test(accessToken || '')) {
      return Promise.resolve({ error: 'unauthorized' });
    }
    if (!admitAccessValidationPeer(gateway, request)) return Promise.resolve({ error: 'rate-limit' });
    gateway.accessValidationFlights ??= new Map();
    gateway.accessValidationQueue ??= [];
    const hash = tokenHash(accessToken);
    const existing = gateway.accessValidationFlights.get(hash);
    if (existing) return existing.promise;
    if (gateway.accessValidationFlights.size >= MAX_ACCESS_VALIDATION_FLIGHTS) return Promise.resolve({ error: 'busy' });

    let resolveFlight;
    const promise = new Promise(resolve => { resolveFlight = resolve; });
    const flight = {
      hash,
      accessToken,
      authority,
      deadline: Date.now() + ACCESS_VALIDATION_TIMEOUT_MS,
      promise,
      resolve: resolveFlight,
      timer: null,
      settled: false,
    };
    const finishFlight = (value) => {
      if (flight.settled) return;
      flight.settled = true;
      clearTimeout(flight.timer);
        if (!flight.started) {
          const queuedIndex = gateway.accessValidationQueue.indexOf(flight);
          if (queuedIndex >= 0) gateway.accessValidationQueue.splice(queuedIndex, 1);
        }
      if (gateway.accessValidationFlights.get(hash) === flight) gateway.accessValidationFlights.delete(hash);
      flight.resolve(value);
    };
    flight.finish = finishFlight;
    flight.timer = setTimeout(() => finishFlight({ error: 'timeout' }), ACCESS_VALIDATION_TIMEOUT_MS);
    flight.timer.unref?.();
    gateway.accessValidationFlights.set(hash, flight);
    gateway.accessValidationQueue.push(flight);

    const pump = () => {
      gateway.accessValidationActive ??= 0;
      while (gateway.accessValidationActive < MAX_ACCESS_VALIDATION_CONCURRENCY && gateway.accessValidationQueue.length > 0) {
        const next = gateway.accessValidationQueue.shift();
        if (next.settled) continue;
        next.started = true;
        gateway.accessValidationActive += 1;
        void requestGatewayAccessValidation(gateway, next.accessToken, next.authority, next.deadline)
          .then(result => {
            if (next.settled) return;
            if (result.error) { next.finish(result); return; }
            if (gateway.control !== result.control || gateway.control?.generation !== result.generation ||
                gateway.control?.ws !== result.controlSocket || !gatewayOnline(gateway)) {
              next.finish({ error: 'unavailable' });
              return;
            }
            if (!registerValidatedAccess(gateway, result.metadata)) {
              const current = findSession(gateway, next.accessToken);
              if (current && current.session.rpcHash === result.metadata.rpcTokenHash &&
                  current.session.expiresAt === result.metadata.expiresAt &&
                  (current.session.deviceId ?? null) === (result.metadata.deviceId ?? null)) next.finish(current);
              else next.finish({ error: current ? 'unauthorized' : 'busy' });
              return;
            }
            next.finish(findSession(gateway, next.accessToken) || { error: 'unauthorized' });
          })
          .catch(() => next.finish({ error: 'unavailable' }))
          .finally(() => {
            gateway.accessValidationActive = Math.max(0, gateway.accessValidationActive - 1);
            pump();
          });
      }
    };
    pump();
    return promise;
  }

  function validationFailureStatus(error) {
    if (error === 'timeout') return [504, 'Gateway Timeout'];
    if (error === 'busy' || error === 'rate-limit') return [429, 'Too Many Requests'];
    if (error === 'traffic') return [429, 'Too Many Requests'];
    if (error === 'unavailable') return [503, 'Service Unavailable'];
    return [401, 'Unauthorized'];
  }

  let registrationsInFlight = 0;
  let passwordChecksInFlight = 0;
  const passwordFailures = new Map();

  async function handleRegistration(request, response) {
    const accountSession = request.url === ACCOUNT_SESSION_PATH;
    const enrollment = request.url === ACCOUNT_ENROLLMENT_PATH;
    const account = enrollment || request.url === ACCOUNT_REGISTRATION_PATH;
    const activation = request.url === ACTIVATION_PATH;
    if (!registrationStore || (!account && !activation && !accountSession && !registrationKey)) {
      sendHttpError(response, 404, 'Not Found');
      return;
    }
    const suppliedKey = bearerToken(request);
    const credentials = request.url === ACCOUNT_REGISTRATION_PATH && accountCredentials(request);
    const tokenValid = suppliedKey && (account || activation || accountSession
      ? /^[A-Za-z0-9_-]{43}$/.test(suppliedKey) : secureStringEqual(suppliedKey, registrationKey));
    if (!credentials && !tokenValid) {
      closeRequestAfterResponse(request, response);
      sendHttpError(response, 401, 'Unauthorized');
      return;
    }
    if (accountSession && request.method === 'GET') {
      const current = registrationStore.getAccountSession(suppliedKey);
      if (current) sendJson(response, 200, { account: current });
      else sendHttpError(response, 401, 'Unauthorized');
      return;
    }
    if (registrationsInFlight >= MAX_REGISTRATION_CONCURRENCY) {
      closeRequestAfterResponse(request, response);
      sendHttpError(response, 429, 'Too Many Requests');
      return;
    }
    if (accountSession && request.method === 'DELETE') {
      closeRequestAfterResponse(request, response);
      registrationsInFlight += 1;
      try {
        await registrationStore.revokeAccountSession(suppliedKey);
        sendJson(response, 200, { account: null });
      } finally { registrationsInFlight -= 1; }
      return;
    }
    if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      closeRequestAfterResponse(request, response);
      sendHttpError(response, 415, 'Unsupported Media Type');
      return;
    }
    registrationsInFlight += 1;
    try {
      const result = await readBoundedBody(request, MAX_REGISTRATION_BODY, REGISTRATION_BODY_TIMEOUT_MS);
      if (result.error === 'timeout') {
        closeRequestAfterResponse(request, response);
        sendHttpError(response, 408, 'Request Timeout');
        return;
      }
      if (result.error === 'too-large') {
        closeRequestAfterResponse(request, response);
        sendHttpError(response, 413, 'Payload Too Large');
        return;
      }
      if (result.error) {
        sendHttpError(response, 400, 'Bad Request');
        return;
      }

      let payload;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(result.body);
        payload = JSON.parse(text);
        if (hasDuplicateJsonObjectKeys(text)) throw new Error('Duplicate registration field');
      } catch {
        sendHttpError(response, 400, 'Bad Request');
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        sendHttpError(response, 400, 'Bad Request');
        return;
      }
      const keys = Object.keys(payload);
      if (accountSession) {
        if (keys.length !== 1 || typeof payload.sessionToken !== 'string' ||
            !/^[A-Za-z0-9_-]{43}$/.test(payload.sessionToken) || secureStringEqual(payload.sessionToken, registrationKey ?? '')) {
          sendHttpError(response, 400, 'Bad Request');
          return;
        }
        try {
          const account = await registrationStore.redeemAccountInvitation(suppliedKey, payload.sessionToken);
          sendJson(response, 200, { account });
        } catch (error) {
          const status = { REGISTRATION_UNAUTHORIZED: 401, REGISTRATION_CONFLICT: 409, REGISTRATION_CAPACITY: 429 }[error?.code] ?? 503;
          sendHttpError(response, status, 'KCoder account login failed');
        }
        return;
      }
      if (keys.length !== 2 || !Object.hasOwn(payload, 'enrollmentToken') || !Object.hasOwn(payload, 'gatewaySecret') ||
          keys.some(key => key !== 'enrollmentToken' && key !== 'gatewaySecret') ||
          typeof payload.enrollmentToken !== 'string' || !REGISTRATION_CREDENTIAL.test(payload.enrollmentToken) ||
          typeof payload.gatewaySecret !== 'string' || !REGISTRATION_CREDENTIAL.test(payload.gatewaySecret) ||
          payload.enrollmentToken === payload.gatewaySecret ||
          secureStringEqual(payload.enrollmentToken, suppliedKey ?? '') || secureStringEqual(payload.gatewaySecret, suppliedKey ?? '') ||
          secureStringEqual(payload.enrollmentToken, registrationKey ?? '') ||
          secureStringEqual(payload.gatewaySecret, registrationKey ?? '')) {
        sendHttpError(response, 400, 'Bad Request');
        return;
      }
      if ([...stateById.values()].some(gateway =>
        secureStringEqual(payload.enrollmentToken, gateway.secret.toString()) ||
        secureStringEqual(payload.enrollmentToken, gateway.gatewaySecret?.toString() ?? ''))) {
        sendHttpError(response, 400, 'Bad Request');
        return;
      }

      let preparedGateway = null;
      let created;
      try {
        const input = {
          enrollmentToken: payload.enrollmentToken,
          gatewaySecret: payload.gatewaySecret,
        };
        const validation = {
          existingOnly: requireAccount && !account,
          validateGateway(config) {
            if (config?.gatewaySecret !== payload.gatewaySecret ||
                secureStringEqual(config?.secret, suppliedKey ?? '') ||
                secureStringEqual(config?.secret, registrationKey ?? '') || secureStringEqual(config?.gatewaySecret, registrationKey ?? '') ||
                secureStringEqual(config?.secret, payload.enrollmentToken)) {
              throw registrationError('REGISTRATION_CONFLICT');
            }
            const existing = typeof config?.id === 'string' ? stateById.get(config.id) : null;
            if (existing) {
              if (!dynamicGatewayIds.has(existing.id) || !gatewayMatchesConfig(existing, config)) {
                throw registrationError('REGISTRATION_CONFLICT');
              }
              preparedGateway = existing;
              return;
            }
            try {
              preparedGateway = normalizeGatewayAddition(registry, config, { maxConnections, maxBytesPerWindow, trafficWindowMs });
            } catch {
              throw registrationError('REGISTRATION_CONFLICT');
            }
          },
        };
        if (credentials) {
          const now = Date.now();
          for (const [key, value] of passwordFailures) {
            if (value.resetAt <= now) passwordFailures.delete(key);
          }
          const peer = request.socket.remoteAddress;
          const forwarded = request.headers['x-forwarded-for'];
          // The control port is loopback-only. The HTTPS Caddy ingress overwrites
          // client-supplied forwarding headers and sets a single source address.
          const publicPeer = peer === '127.0.0.1' && request.headers['x-forwarded-proto'] === 'https' &&
            request.headers['x-forwarded-host'] === request.headers.host && registry.sharedHosts.has(request.headers.host) &&
            typeof forwarded === 'string' && isIP(forwarded) ? forwarded : peer;
          const key = `${publicPeer ?? 'unknown'}/${credentials.username}`;
          const failures = passwordFailures.get(key);
          if (passwordChecksInFlight >= 2 || failures?.count >= 12) {
            sendHttpError(response, 429, 'Too Many Requests');
            return;
          }
          passwordChecksInFlight++;
          try {
            created = await registrationStore.registerAccount(credentials, input, validation);
            passwordFailures.delete(key);
          } catch (error) {
            if (error?.code === 'REGISTRATION_UNAUTHORIZED') {
              if (passwordFailures.size >= 1024 && !passwordFailures.has(key)) {
                passwordFailures.delete(passwordFailures.keys().next().value);
              }
              const current = passwordFailures.get(key);
              passwordFailures.set(key, { count: (current?.count ?? 0) + 1, resetAt: current?.resetAt ?? now + 60_000 });
            }
            throw error;
          } finally {
            passwordChecksInFlight--;
          }
        } else if (enrollment) {
          created = await registrationStore.registerAccountSession(suppliedKey, input, validation);
        } else if (account || activation) {
          created = await registrationStore.redeemActivationCode(suppliedKey, input, validation, { forAccount: account });
        } else created = await registrationStore.register(input, validation);
      } catch (error) {
        const code = error?.code;
        if (code === 'REGISTRATION_UNAUTHORIZED') sendHttpError(response, 401, 'Unauthorized');
        else if (code === 'REGISTRATION_PASSWORD_RESET_REQUIRED') sendHttpError(response, 403, 'KCoder account password reset required');
        else if (code === 'REGISTRATION_CAPACITY') {
          if (account) response.setHeader('x-kcoder-relay-error', 'RELAY_ACCOUNT_CAPACITY');
          sendHttpError(response, 429, 'Too Many Requests');
        }
        else if (code === 'REGISTRATION_CONFLICT') sendHttpError(response, 409, 'Conflict');
        else sendHttpError(response, 503, 'Service Unavailable');
        return;
      }

      if (!created || !preparedGateway || !gatewayMatchesConfig(preparedGateway, created) || created.gatewaySecret !== payload.gatewaySecret) {
        sendHttpError(response, 503, 'Service Unavailable');
        return;
      }
      if (!registrationStore.list().some(gateway => gateway.id === created.id)) {
        sendHttpError(response, 401, 'Unauthorized'); return;
      }
      const current = stateById.get(created.id);
      let status = 201;
      if (current) {
        if (!gatewayMatchesConfig(current, created)) {
          sendHttpError(response, 503, 'Service Unavailable');
          return;
        }
        status = 200;
      } else {
        // The callback already constructed and validated this state before the
        // store committed. Inserting the prepared state cannot re-validate or
        // fail after persistence.
        addGatewayState(registry, preparedGateway);
        dynamicGatewayIds.add(preparedGateway.id);
      }
      sendJson(response, status, registrationResponse(created));
      publicIngress.prepare(created.id);
    } finally {
      registrationsInFlight = Math.max(0, registrationsInFlight - 1);
    }
  }

  // Caddy on_demand_tls `ask` endpoint. Only the local Caddy process may ask:
  // public /_relay/* traffic carries the public Host and forwarding headers.
  function handleTlsAsk(request, response) {
    const local = `127.0.0.1:${controlHttp.address()?.port}`;
    let domains = [];
    let extra = true;
    try {
      const url = new URL(request.url, 'http://relay.invalid');
      domains = url.searchParams.getAll('domain');
      extra = [...url.searchParams.keys()].some(key => key !== 'domain');
    } catch {}
    const allowed = request.method === 'GET' && request.headers.host === local &&
      request.headers['x-forwarded-for'] === undefined && request.headers.forwarded === undefined &&
      request.headers.via === undefined && !extra && domains.length === 1 &&
      onDemandTlsAllowed(registry, domains[0]);
    response.writeHead(allowed ? 200 : 403, { 'cache-control': 'no-store', 'content-length': 0, connection: 'close' });
    response.end();
  }

  const controlHttp = httpServer((request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    if (administration.handle(request, response) || accountPortal.handle(request, response)) return;
    if (request.method === 'DELETE' && request.url === '/_relay/account/access') {
      const id = gatewayIdentity(request);
      const secret = bearerToken(request);
      if (!registrationStore || !id || !secret) { sendHttpError(response, 401, 'Unauthorized'); return; }
      void registrationStore.revokeGateway(id, secret).then(() => {
        removeGateway(id);
        response.writeHead(204, { 'cache-control': 'no-store' }).end();
      }, error => {
        const denied = error.code === 'REGISTRATION_UNAUTHORIZED';
        sendHttpError(response, denied ? 401 : 503, denied ? 'Unauthorized' : 'Service Unavailable');
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/_relay/account/access') {
      const gateway = stateById.get(gatewayIdentity(request));
      response.writeHead(gateway && gatewayAuthorized(request, gateway) ? 204 : 401,
        { 'cache-control': 'no-store', connection: 'close' });
      response.end();
      return;
    }
    if ((request.method === 'POST' && [REGISTRATION_PATH, ACTIVATION_PATH, ACCOUNT_REGISTRATION_PATH, ACCOUNT_ENROLLMENT_PATH].includes(request.url)) ||
        (request.url === ACCOUNT_SESSION_PATH && ['GET', 'POST', 'DELETE'].includes(request.method))) {
      void handleRegistration(request, response).catch(() => sendHttpError(response, 503, 'Service Unavailable'));
      return;
    }
    if (request.url === TLS_ASK_PATH || request.url.startsWith(`${TLS_ASK_PATH}?`)) {
      handleTlsAsk(request, response);
      return;
    }
    if (request.url === '/_relay/health') {
      const gateways = [...stateById.values()];
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
      response.end(JSON.stringify({
        online: gateways.some(gatewayOnline),
        connections: gateways.reduce((sum, gateway) => sum + gateway.active.size, 0),
        pending: gateways.reduce((sum, gateway) => sum + gateway.pending.size, 0),
      }));
    } else { response.writeHead(404, { connection: 'close' }); response.end(); }
  });

  controlHttp.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { sendUpgradeError(socket, 400, 'Bad Request'); return; }
    const id = gatewayIdentity(request);
    const gateway = id ? stateById.get(id) : null;
    if (!gateway || !gatewayAuthorized(request, gateway)) { sendUpgradeError(socket, 401, 'Unauthorized'); return; }

    if (url.pathname === '/_relay/control') {
      if (gateway.control) { sendUpgradeError(socket, 409, 'Conflict'); return; }
      const generation = gateway.generation + 1;
      wss.handleUpgrade(request, socket, head, ws => {
        const control = { ws, generation };
        gateway.generation = generation;
        gateway.control = control;
        if (dynamicGatewayIds.has(gateway.id)) publicIngress.prepare(gateway.id);
        heartbeat(ws);
        ws.on('error', () => {});
        ws.once('close', () => {
          if (gateway.control !== control) return;
          gateway.control = null;
          for (const session of gateway.sessions.values()) session.httpGetPool?.retire(Object.assign(new Error('Control closed'), { code: 'RELAY_UNAVAILABLE' }), true);
          for (const entry of [...gateway.pending.values()]) {
            if (entry.generation === generation) finishPending(entry, Object.assign(new Error('Gateway control connection closed'), { code: 'RELAY_UNAVAILABLE' }));
          }
          for (const close of [...gateway.active]) close();
        });
      });
      return;
    }

    if (url.pathname !== '/_relay/data') { sendUpgradeError(socket, 404, 'Not Found'); return; }
    const idValue = url.searchParams.getAll('id');
    const entry = idValue.length === 1 ? gateway.pending.get(idValue[0]) : null;
    if (!entry || entry.gateway !== gateway || entry.generation !== gateway.control?.generation || entry.control !== gateway.control?.ws || !gatewayOnline(gateway)) {
      sendUpgradeError(socket, 404, 'Not Found');
      return;
    }
    if (entry.upgradeSocket) { sendUpgradeError(socket, 409, 'Conflict'); return; }
    entry.upgradeSocket = socket;
    entry.onUpgradeClose = () => finishPending(entry, Object.assign(new Error('Gateway data connection closed'), { code: 'RELAY_UNAVAILABLE' }));
    socket.once('close', entry.onUpgradeClose);
    wss.handleUpgrade(request, socket, head, ws => activateEntry(entry, ws));
  });

  const publicHttp = httpServer((request, response) => {
    void handlePublicHttp(request, response);
  });

  async function handlePublicHttp(request, response) {
    let failureCleanup = () => {
      if (!response.destroyed) response.destroy();
    };
    request.on('aborted', () => failureCleanup());
    request.on('error', error => failureCleanup(error));
    response.on('error', error => failureCleanup(error));
    response.shouldKeepAlive = false;
    const authority = requestAuthority(request);
    const route = resolveGatewayRoute(registry, authority, request.url);
    if (route.error) {
      const [status, message] = routeErrorStatus(route.error);
      sendHttpError(response, status, message);
      return;
    }
    if (route.shared && !route.isolated) {
      sendSharedOriginRedirect(request, response, route);
      return;
    }
    const path = pathnameOf(route.target);
    const accountWebEntry = path === ACCOUNT_WEB_ENTRY_PATH;
    if (!accountWebEntry && crossGatewayOrigin(registry, route, request.headers.origin)) {
      closeRequestAfterResponse(request, response);
      sendHttpError(response, 403, 'Forbidden');
      return;
    }
    const gateway = route.gateway;
    if (!gatewayOnline(gateway)) { sendHttpError(response, 503, 'Service Unavailable'); return; }

    const isApi = path === '/api' || path.startsWith('/api/');
    const browser = request.headers.authorization === undefined && browserSessionCredential(request) !== null &&
      path !== '/login' && path !== '/logout';
    if (path === ACCESS_VALIDATION_PATH || path === '/api/mobile/pairing/relay') {
      closeRequestAfterResponse(request, response);
      sendHttpError(response, 404, 'Not Found');
      return;
    }
    const isConnectionProofPath = path === CONNECTION_PROOF_PATH;
    const isConnectionProofGet = isConnectionProofRequest(request, route.target);
    const isSessionPost = path === SESSION_PATH && request.method === 'POST';
    const isSessionDelete = path === SESSION_PATH && request.method === 'DELETE';
    const isRefreshPost = path === REFRESH_PATH && request.method === 'POST';
    const isDeviceDelete = /^\/api\/mobile\/devices\/[a-zA-Z0-9-]{16,128}$/.test(path) && request.method === 'DELETE';
    const isCorsPreflight = request.method === 'OPTIONS' && typeof request.headers.origin === 'string' &&
      typeof request.headers['access-control-request-method'] === 'string';
    const isP2pConfigPath = path === P2P_CONFIG_PATH;
    const isP2pOfferPath = path === P2P_OFFER_PATH;
    const isP2pEndpoint = isP2pConfigPath || isP2pOfferPath;
    const isP2pConfigGet = isP2pConfigPath && request.method === 'GET';
    const isP2pOfferPost = isP2pOfferPath && request.method === 'POST';
    const isP2pRequest = isP2pConfigGet || isP2pOfferPost;
    let session = null;
    let accessGrantHash = null;
    let bufferedBody = null;
    let accountPairingProof;
    let accountWebEntryProof;
    let bufferedBodyTrafficReserved = false;
    let sessionReservation = false;
    const releaseSessionReservation = () => {
      if (!sessionReservation) return;
      sessionReservation = false;
      gateway.pendingSessions = Math.max(0, gateway.pendingSessions - 1);
    };

    if (accountWebEntry) {
      const origin = request.headers.origin;
      if (!route.isolated || !gateway.gatewaySecret || route.target !== path || request.method !== 'POST' ||
          typeof origin !== 'string' || !origin.startsWith('https://') || !registry.sharedHosts.has(origin.slice(8)) ||
          request.headers['content-type']?.split(';', 1)[0] !== 'application/x-www-form-urlencoded') {
        closeRequestAfterResponse(request, response);
        sendHttpError(response, 403, 'Forbidden');
        return;
      }
      if (!makeConnectionRoom(gateway)) {
        closeRequestAfterResponse(request, response);
        sendHttpError(response, 429, 'Too Many Requests');
        return;
      }
      gateway.pairingReads++;
      let result;
      try { result = await readBoundedBody(request, 512, pairingBodyTimeoutMs); }
      finally { gateway.pairingReads--; }
      if (result.error) {
        closeRequestAfterResponse(request, response);
        sendHttpError(response, 400, 'Bad Request');
        return;
      }
      if (!consumeTraffic(gateway, requestHeaderBytes(request, route.target) + result.body.length)) {
        sendHttpError(response, 429, 'Too Many Requests');
        return;
      }
      const entry = accountPortal.consumeWebEntry(result.body.toString('utf8'), gateway.id, origin);
      if (!entry || (entry.surface === 'mobile' && !entry.mobileToken)) {
        sendHttpError(response, 401, 'Unauthorized');
        return;
      }
      bufferedBody = Buffer.from(JSON.stringify({ ...entry, issuedAt: Date.now() }));
      bufferedBodyTrafficReserved = true;
      accountWebEntryProof = createHmac('sha256', gateway.gatewaySecret)
        .update(JSON.stringify(['kcoder-account-entry-v1', route.authority, bufferedBody.toString('utf8')])).digest('hex');
    }

    if (isP2pEndpoint && !isCorsPreflight) {
      if (!isP2pRequest) {
        closeRequestAfterResponse(request, response);
        sendHttpError(response, 405, 'Method Not Allowed');
        return;
      }
      const releaseP2pRequest = acquireP2pRequest(gateway, request);
      if (!releaseP2pRequest) {
        closeRequestAfterResponse(request, response);
        sendHttpError(response, 429, 'Too Many Requests');
        return;
      }
      response.once('finish', releaseP2pRequest);
      response.once('close', releaseP2pRequest);
      if (route.target !== path) {
        closeRequestAfterResponse(request, response);
        sendHttpError(response, 400, 'Bad Request');
        return;
      }
      if (isP2pConfigGet && (request.headers['transfer-encoding'] || request.headers.expect ||
          Number(request.headers['content-length'] ?? 0) !== 0)) {
        closeRequestAfterResponse(request, response);
        sendHttpError(response, 400, 'Bad Request');
        return;
      }
      if (isP2pOfferPost) {
        if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          closeRequestAfterResponse(request, response);
          sendHttpError(response, 415, 'Unsupported Media Type');
          return;
        }
        if (!makeConnectionRoom(gateway)) {
          closeRequestAfterResponse(request, response);
          sendHttpError(response, 429, 'Too Many Requests');
          return;
        }
        gateway.pairingReads += 1;
        let result;
        try {
          result = await readBoundedBody(request, MAX_P2P_BODY, pairingBodyTimeoutMs);
        } finally {
          gateway.pairingReads = Math.max(0, gateway.pairingReads - 1);
        }
        if (result.error === 'timeout' || result.error === 'too-large') {
          closeRequestAfterResponse(request, response);
          if (result.error === 'timeout') sendHttpError(response, 408, 'Request Timeout');
          else sendHttpError(response, 413, 'Payload Too Large');
          return;
        }
        if (result.error || !validP2pOfferBody(result.body)) {
          sendHttpError(response, 400, 'Bad Request');
          return;
        }
        if (!consumeTraffic(gateway, requestHeaderBytes(request, route.target) + result.body.length)) {
          sendHttpError(response, 429, 'Too Many Requests');
          return;
        }
        bufferedBody = result.body;
        bufferedBodyTrafficReserved = true;
      }
    }

    if (isConnectionProofPath && request.method === 'GET' && !isConnectionProofGet) {
      sendHttpError(response, 400, 'Bad Request');
      return;
    }
    if (isConnectionProofGet && !admitConnectionProofPeer(gateway, request)) {
      sendHttpError(response, 429, 'Too Many Requests');
      return;
    }
    if (gateway.gatewaySecret && isRefreshPost && !admitRefreshPeer(gateway, request)) { sendHttpError(response, 429, "Too Many Requests"); return; }
    if (gateway.gatewaySecret && (isSessionPost || isRefreshPost)) {
      if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        closeRequestAfterResponse(request, response);
        sendHttpError(response, 415, 'Unsupported Media Type');
        return;
      }
      if (!makeConnectionRoom(gateway)) {
        closeRequestAfterResponse(request, response);
        sendHttpError(response, 429, 'Too Many Requests');
        return;
      }
      gateway.pairingReads += 1;
      let result;
      try {
        result = await readBoundedBody(request, MAX_SESSION_BODY, pairingBodyTimeoutMs);
      } finally {
        gateway.pairingReads = Math.max(0, gateway.pairingReads - 1);
      }
      if (result.error === 'timeout' || result.error === 'too-large') {
        closeRequestAfterResponse(request, response);
        if (result.error === 'timeout') sendHttpError(response, 408, 'Request Timeout');
        else sendHttpError(response, 413, 'Payload Too Large');
        return;
      }
      if (result.error) { sendHttpError(response, 400, 'Bad Request'); return; }
      let payload;
      try { payload = JSON.parse(result.body.toString('utf8')); } catch { sendHttpError(response, 400, 'Bad Request'); return; }
      if (!payload || (isSessionPost && (typeof payload.token !== 'string' || payload.token.length < 1 || payload.token.length > 4096)) || (isRefreshPost && (typeof payload.refreshToken !== 'string' || !/^[a-f0-9]{64}$/.test(payload.refreshToken) || typeof payload.rotationId !== 'string' || !/^[A-Za-z0-9-]{16,128}$/.test(payload.rotationId)))) {
        sendHttpError(response, 401, 'Unauthorized');
        return;
      }
      pruneSessions(gateway);
      if (isSessionPost && gateway.sessions.size + (gateway.mobileDeviceFamilies?.size || 0) + gateway.pendingSessions >= MAX_SESSIONS) { sendHttpError(response, 429, 'Too Many Requests'); return; }
      if (!consumeTraffic(gateway, requestHeaderBytes(request, route.target) + result.body.length)) {
        sendHttpError(response, 429, 'Too Many Requests');
        return;
      }
      if (isSessionPost) {
        const accountGrant = payload.durableDeviceAuthorization === true
          ? accountPortal.consumePairing(payload.token, gateway.id) : undefined;
        if (accountGrant === false) { sendHttpError(response, 401, 'Unauthorized'); return; }
        if (accountGrant) accountPairingProof = createHmac('sha256', gateway.gatewaySecret)
          .update((accountGrant === 'mobileWeb' ? 'kcoder-account-web-pairing-v1\0' : 'kcoder-account-pairing-v1\0') + payload.token).digest('hex');
      }
      bufferedBody = result.body;
      gateway.pendingSessions += 1;
      sessionReservation = true;
    } else if (gateway.gatewaySecret && (isApi || browser) && !accountWebEntry && !isCorsPreflight && !isConnectionProofGet && !isP2pRequest) {
      let authenticated = accessForApi(gateway, request);
      if (!authenticated) {
        const accessToken = httpAccessCredential(request);
        const validation = await validateUnknownAccess(gateway, accessToken, authority, request);
        if (validation.error && isApi) {
          closeRequestAfterResponse(request, response);
          const [status, message] = validationFailureStatus(validation.error);
          sendHttpError(response, status, message);
          return;
        }
        authenticated = validation.error ? null : validation;
      }
      // Navigation with an expired cookie still reaches Gateway's login redirect.
      session = authenticated?.session ?? null;
      accessGrantHash = authenticated?.hash ?? null;
    }

    const reqHeaderSize = requestHeaderBytes(request, route.target);
    if (!(gateway.gatewaySecret && (isSessionPost || isRefreshPost)) && !bufferedBodyTrafficReserved && !consumeTraffic(gateway, reqHeaderSize)) {
      sendHttpError(response, 429, 'Too Many Requests');
      return;
    }

    const headers = hopHeaders(request.headers);
    // Isolated routes forward the canonical authority (lowercase, no :443) that
    // the Gateway's configured public origin and Origin checks expect.
    headers.host = route.shared ? route.authority : request.headers.host;
    headers.connection = 'close';
    delete headers['x-kcoder-relay-validation'];
    delete headers['x-kcoder-relay-account-pairing'];
    delete headers[ACCOUNT_WEB_ENTRY_HEADER];
    if (accountPairingProof) headers['x-kcoder-relay-account-pairing'] = accountPairingProof;
    if (accountWebEntryProof) {
      headers[ACCOUNT_WEB_ENTRY_HEADER] = accountWebEntryProof;
      headers['content-type'] = 'application/json';
      delete headers.authorization;
    }
    if (route.isolated && headers.cookie !== undefined) {
      const cookie = isolatedSessionCookie(headers.cookie);
      if (cookie === undefined) delete headers.cookie;
      else {
        // The product account proof is carried only to its HTTP management endpoints.
        const accountCookies = request.headers.authorization === undefined && STUDIO_ACCOUNT_PATHS.has(path)
          ? headers.cookie.split(';').map(value => value.trim()).filter(value => HOST_ACCOUNT_COOKIE.test(value)) : [];
        headers.cookie = [cookie, ...accountCookies].join('; ');
      }
    }
    if (isP2pRequest) {
      delete headers.authorization;
      delete headers.cookie;
      delete headers['proxy-authorization'];
    }
    if (isConnectionProofGet) {
      delete headers.authorization;
      delete headers.cookie;
      delete headers['proxy-authorization'];
    }
    // Presentation proof only; never forwarded as an API/RPC credential.
    // The mount proof uses the private Gateway/Relay credential. Pairing users
    // receive only the rotating token generated by the Gateway.
    delete headers['x-kcoder-mobile-mount'];
    delete headers['x-kcoder-mobile-mount-proof'];
    if (route.shared && gateway.gatewaySecret &&
        (path === '/mobile-entry' || path === '/mobile' || path.startsWith('/mobile/'))) {
      const prefix = `/g/${gateway.id}`;
      headers['x-kcoder-mobile-mount'] = prefix;
      headers['x-kcoder-mobile-mount-proof'] = createHmac('sha256', gateway.gatewaySecret)
        .update(JSON.stringify(['kcoder-mobile-mount-v1', route.authority, prefix])).digest('hex');
    }
    if (bufferedBody) {
      delete headers['transfer-encoding'];
      headers['content-length'] = String(bufferedBody.length);
    }
    // Browser module graphs share bounded serial parsers instead of opening a
    // new tunnel for every Vite import. Gateway authenticates every request.
    const pooled = session && accessGrantHash && (isApi || browser) && request.method === 'GET' &&
      !request.headers['transfer-encoding'] && !request.headers.expect && !request.headers.upgrade &&
      (request.headers['content-length'] === undefined || request.headers['content-length'] === '0');
    let lease = null;
    const waiting = new AbortController();
    if (pooled) {
      failureCleanup = () => { waiting.abort(); lease?.release(false); if (!response.destroyed) response.destroy(); };
      response.once('close', () => { if (!response.writableFinished) waiting.abort(); });
      try { lease = await getGrantPool(gateway, session, accessGrantHash, browser).acquire(waiting.signal); }
      catch (error) {
        sendHttpError(response, error.code === 'RELAY_UNAUTHORIZED' ? 401 : error.code === 'RELAY_TIMEOUT' ? 504 : 503,
          error.code === 'RELAY_UNAUTHORIZED' ? 'Unauthorized' : error.code === 'RELAY_TIMEOUT' ? 'Gateway Timeout' : 'Service Unavailable');
        return;
      }
      if (waiting.signal.aborted || response.destroyed) { lease.release(false); return; }
      headers.connection = 'keep-alive';
    }
    let tunnel = pooled ? null : new RelayDuplex();
    let entry;
    const retryableMobileFetch = route.shared && path.startsWith('/mobile/') &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !request.headers['transfer-encoding'] && !request.headers.expect && !request.headers.upgrade &&
      (request.headers['content-length'] === undefined || request.headers['content-length'] === '0');
    const openControl = gateway.control;
    const openGeneration = openControl?.generation;
    let openAttempts = 0;
    let dataChannelAttached = false;
    if (tunnel) tunnel.once('close', () => { if (entry) cancelPending(entry); });
    const agent = lease?.agent || new Agent({ keepAlive: false });
    if (!pooled) agent.createConnection = () => tunnel;
    const upstreamRequest = httpRequest({
      host: 'kcoder-relay.invalid',
      port: 80,
      method: request.method,
      path: route.target,
      headers,
      agent,
    });
    failureCleanup = error => {
      releaseSessionReservation();
      if (!upstreamRequest.destroyed) upstreamRequest.destroy(error);
      if (tunnel && !tunnel.destroyed) tunnel.destroy(error);
      lease?.release(false);
      if (!response.destroyed) response.destroy(error);
    };
    upstreamRequest.on('error', error => {
      releaseSessionReservation();
      if (lease) lease.release(false); else agent.destroy();
      if (response.headersSent) response.destroy();
      else sendHttpError(response, error.code === 'RELAY_UNAUTHORIZED' ? 401 : error.code === 'RELAY_TIMEOUT' ? 504 : error.code === 'RELAY_TRAFFIC_LIMIT' ? 429 : 503,
        error.code === 'RELAY_UNAUTHORIZED' ? 'Unauthorized' : error.code === 'RELAY_TIMEOUT' ? 'Gateway Timeout' : error.code === 'RELAY_TRAFFIC_LIMIT' ? 'Too Many Requests' : 'Service Unavailable');
    });

    const isMobileSession = gateway.gatewaySecret && (isSessionPost || isRefreshPost);
    upstreamRequest.on('response', upstream => {
      void (async () => {
        if (isMobileSession) {
          const result = await sessionResponse(upstream, route, gateway);
          releaseSessionReservation();
          if (result.error) {
            tunnel?.destroy();
            if (result.error === 'traffic') sendHttpError(response, 429, 'Too Many Requests');
            else if (result.error === 'too-large') sendHttpError(response, 502, 'Bad Gateway');
            else sendHttpError(response, 502, 'Bad Gateway');
            return;
          }
          if (result.statusCode >= 200 && result.statusCode < 300) {
            let payload;
            try { payload = JSON.parse(result.body.toString('utf8')); } catch { payload = null; }
            if (!registerSession(gateway, payload)) {
              tunnel?.destroy();
              sendHttpError(response, 502, 'Bad Gateway');
              return;
            }
          }
          response.shouldKeepAlive = false;
          response.writeHead(result.statusCode, {
            ...result.headers,
            'content-length': result.body.length,
            connection: 'close',
          });
          response.end(result.body, () => tunnel?.destroy());
          return;
        }

        const filtered = responseHeaders(upstream, route);
        if (!consumeTraffic(gateway, responseHeaderBytes(upstream.statusCode, upstream.statusMessage, filtered))) {
          lease?.release(false);
          upstream.destroy();
          tunnel?.destroy();
          sendHttpError(response, 429, 'Too Many Requests');
          return;
        }
        response.shouldKeepAlive = false;
        response.writeHead(upstream.statusCode || 502, {
          ...filtered,
          connection: 'close',
        });
        let upstreamEnded = false;
        let responseFinished = false;
        const returnLease = () => { if (upstreamEnded && responseFinished) lease?.release(true); };
        let upstreamFailed = false;
        const failUpstreamResponse = error => {
          if (upstreamEnded || upstreamFailed) return;
          upstreamFailed = true;
          lease?.release(false);
          upstream.unpipe(meter);
          meter.destroy();
          if (!response.destroyed) response.destroy(error);
          if (!upstreamRequest.destroyed) upstreamRequest.destroy(error);
          tunnel?.destroy(error);
        };
        const meter = new Transform({
          transform(chunk, encoding, callback) {
            if (!consumeTraffic(gateway, chunk.length)) {
              callback(Object.assign(new Error('Gateway traffic limit reached'), { code: 'RELAY_TRAFFIC_LIMIT' }));
              return;
            }
            callback(null, chunk);
          },
        });
        meter.on('error', () => {
          lease?.release(false);
          if (!response.destroyed) response.destroy();
          tunnel?.destroy();
        });
        upstream.on('error', failUpstreamResponse);
        upstream.once('aborted', () => failUpstreamResponse(Object.assign(new Error('Gateway response was aborted'), { code: 'RELAY_UPSTREAM_ABORTED' })));
        upstream.once('end', () => { upstreamEnded = true; returnLease(); });
        upstream.once('close', () => {
          if (!upstreamEnded) failUpstreamResponse(Object.assign(new Error('Gateway response closed early'), { code: 'RELAY_UPSTREAM_ABORTED' }));
        });
        response.once('finish', () => {
          responseFinished = true;
          if (path === '/logout' && request.method === 'POST' && upstream.statusCode === 303) {
            const browserSession = findSession(gateway, browserSessionCredential(request));
            if (browserSession) revokeSession(gateway, browserSession.hash, browserSession.session);
          }
          if (isDeviceDelete && upstream.statusCode >= 200 && upstream.statusCode < 300) revokeDeviceFamily(gateway, path.slice(path.lastIndexOf('/') + 1));
          if (isSessionDelete && session && upstream.statusCode >= 200 && upstream.statusCode < 300) {
            const auth = bearerToken(request);
            const hash = auth ? tokenHash(auth) : '';
            revokeSession(gateway, hash, session);
          }
          if (lease) returnLease(); else tunnel?.destroy();
        });
        upstream.pipe(meter).pipe(response);
      })().catch(() => {
        releaseSessionReservation();
        lease?.release(false);
        tunnel?.destroy();
        sendHttpError(response, 502, 'Bad Gateway');
      });
    });

    response.once('close', () => {
      if (!response.writableFinished) {
        failureCleanup();
      }
    });

    const sendRequest = () => {
      if (request.aborted || response.destroyed) { upstreamRequest.destroy(); lease?.release(false); return; }
      // No await separates this exact grant/generation recheck from first bytes.
      try { lease?.markForwarded(); }
      catch (error) { upstreamRequest.destroy(error); return; }
      if (bufferedBody) upstreamRequest.end(bufferedBody);
      else {
        const meter = new Transform({
          transform(chunk, encoding, callback) {
            if (!consumeTraffic(gateway, chunk.length)) {
              callback(Object.assign(new Error('Gateway traffic limit reached'), { code: 'RELAY_TRAFFIC_LIMIT' }));
              return;
            }
            callback(null, chunk);
          },
        });
        meter.on('error', () => {
          upstreamRequest.destroy(Object.assign(new Error('Gateway traffic limit reached'), { code: 'RELAY_TRAFFIC_LIMIT' }));
        });
        request.pipe(meter).pipe(upstreamRequest);
      }
    };
    if (pooled) {
      upstreamRequest.once('socket', socket => {
        tunnel = socket;
        if (socket.connecting) socket.once('connect', sendRequest); else sendRequest();
      });
    } else {
      tunnel.once('connect', sendRequest);
      const openOwnerIsCurrent = () => !request.aborted && !response.destroyed && !upstreamRequest.destroyed &&
        !tunnel.destroyed && tunnel.connecting && gateway.control === openControl &&
        gateway.control?.generation === openGeneration && gatewayOnline(gateway);
      const openDataChannel = () => {
        if (!openOwnerIsCurrent()) {
          const abandoned = request.aborted || response.destroyed || upstreamRequest.destroyed || tunnel.destroyed;
          if (abandoned) {
            failureCleanup();
            agent.destroy();
            return;
          }
          tunnel.fail(Object.assign(new Error('Gateway control generation changed'), { code: 'RELAY_UNAVAILABLE' }));
          return;
        }
        openAttempts += 1;
        entry = openPending(gateway, session, (stream, close) => {
          dataChannelAttached = true;
          tunnel.attach(stream, close);
        }, error => {
          const retry = retryableMobileFetch && error?.code === 'RELAY_TIMEOUT' && openAttempts < 2 &&
            !dataChannelAttached && openOwnerIsCurrent();
          if (retry) {
            // The failed pending ID has already been removed. Keep the same
            // unattached RelayDuplex so ClientRequest sends its headers once,
            // only after a later data channel actually attaches. Recheck owner
            // state at entry as cancellation/control-close may race this turn.
            queueMicrotask(openDataChannel);
            return;
          }
          tunnel.fail(error);
        });
        if (!entry) { releaseSessionReservation(); upstreamRequest.destroy(); agent.destroy(); }
      };
      openDataChannel();
    }
  }

  publicHttp.on('upgrade', (request, socket, head) => {
    void handlePublicUpgrade(request, socket, head).catch(() => sendUpgradeError(socket, 502, 'Bad Gateway'));
  });

  async function handlePublicUpgrade(request, socket, head) {
    socket.on('error', () => {});
    const authority = requestAuthority(request);
    const route = resolveGatewayRoute(registry, authority, request.url);
    if (route.error) {
      const [status, message] = routeErrorStatus(route.error);
      sendUpgradeError(socket, status, message);
      return;
    }
    if (route.shared && !route.isolated) {
      // WebSocket credentials are never redirected; clients must use the Gateway origin.
      sendUpgradeError(socket, 426, 'Upgrade Required');
      return;
    }
    if (crossGatewayOrigin(registry, route, request.headers.origin)) {
      sendUpgradeError(socket, 403, 'Forbidden');
      return;
    }
    const gateway = route.gateway;
    if (!gatewayOnline(gateway)) { sendUpgradeError(socket, 503, 'Service Unavailable'); return; }

    const path = pathnameOf(route.target);
    if (path === ACCESS_VALIDATION_PATH || path === '/api/mobile/pairing/relay') { sendUpgradeError(socket, 404, 'Not Found'); return; }
    let session = null;
    if (gateway.gatewaySecret && path === '/rpc') {
      const rpcToken = rpcTokenFromTarget(route.target);
      const credential = rpcAccessCredential(request);
      if (!rpcToken || credential.invalid) {
        sendUpgradeError(socket, 401, 'Unauthorized');
        return;
      }
      let authenticated = accessForRpc(gateway, request);
      if (!authenticated && credential.token) {
        const validation = await validateUnknownAccess(gateway, credential.token, authority, request);
        if (validation.error) {
          const [status, message] = validationFailureStatus(validation.error);
          sendUpgradeError(socket, status, message);
          return;
        }
        authenticated = validation;
      }
      if (!authenticated || !rpcToken || !sameHash(rpcToken, authenticated.session.rpcHash)) {
        sendUpgradeError(socket, 401, 'Unauthorized');
        return;
      }
      session = authenticated.session;
    }
    const rawRequest = makeRawUpgradeRequest(request, route.target, route.shared ? route.authority : null, route.isolated === true);
    if (!rawRequest) { sendUpgradeError(socket, 400, 'Bad Request'); return; }
    const bytes = requestHeaderBytes(request, route.target) + head.length;
    if (!consumeTraffic(gateway, bytes)) { sendUpgradeError(socket, 429, 'Too Many Requests'); return; }
    socket.pause();
    let entry;
    socket.once('close', () => { if (entry) cancelPending(entry); });
    entry = openPending(gateway, session, (stream, close) => {
      const handshake = head.length ? Buffer.concat([rawRequest, head]) : rawRequest;
      stream.write(handshake, error => {
        if (error || socket.destroyed) { socket.destroy(); close(); return; }
        bridgeRaw(socket, stream, close, amount => consumeTraffic(gateway, amount));
        socket.resume();
      });
    }, error => {
      if (socket.destroyed) return;
      const status = error?.code === 'RELAY_TIMEOUT' ? 504 : error?.code === 'RELAY_TRAFFIC_LIMIT' ? 429 : 503;
      sendUpgradeError(socket, status, status === 504 ? 'Gateway Timeout' : status === 429 ? 'Too Many Requests' : 'Service Unavailable');
    });
    if (!entry) return;
  }

  const closeServer = server => new Promise(resolve => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  });
  try {
    await new Promise((resolve, reject) => { controlHttp.once('error', reject); controlHttp.listen(controlPort, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => { publicHttp.once('error', reject); publicHttp.listen(proxyPort, '127.0.0.1', resolve); });
  } catch (error) {
    controlHttp.closeAllConnections?.();
    publicHttp.closeAllConnections?.();
    for (const ws of wss.clients) ws.terminate();
    await Promise.all([closeServer(controlHttp), closeServer(publicHttp)]);
    wss.close();
    try { await registrationStore?.close(); } catch {}
    throw error;
  }

  return {
    controlPort: controlHttp.address().port,
    proxyPort: publicHttp.address().port,
    async close() {
      publicIngress.close();
      for (const gateway of stateById.values()) {
        gateway.control?.ws.terminate();
        gateway.control = null;
        for (const entry of [...gateway.pending.values()]) finishPending(entry, Object.assign(new Error('Relay is closing'), { code: 'RELAY_UNAVAILABLE' }));
        for (const close of [...gateway.active]) close();
        for (const [hash, session] of [...gateway.sessions]) revokeSession(gateway, hash, session);
        for (const deviceId of [...(gateway.mobileDeviceFamilies?.keys() || [])]) revokeDeviceFamily(gateway, deviceId);
      }
      for (const ws of wss.clients) ws.terminate();
      controlHttp.closeAllConnections?.();
      publicHttp.closeAllConnections?.();
      await Promise.all([closeServer(controlHttp), closeServer(publicHttp)]);
      wss.close();
      administration.close();
      await registrationStore?.close();
    },
  };
}

export async function startRelay(options) {
  if (Array.isArray(options?.gateways)) {
    if (options.legacy === true) {
      if (options.registrationStoreFile !== undefined || options.registrationKey !== undefined || options.requireAccount) {
        throw new Error('Registration storage is not supported in legacy relay mode');
      }
      if (options.gateways.length !== 1) throw new Error('Legacy relay mode accepts exactly one Gateway');
      const [gateway] = options.gateways;
      return startLegacyRelay({
        secret: gateway.secret,
        device: gateway.id,
        controlPort: options.controlPort,
        proxyPort: options.proxyPort,
        maxConnections: gateway.maxConnections,
      });
    }
    return startMultiRelay(options);
  }
  if (options?.registrationStoreFile !== undefined) {
    return startMultiRelay({ ...options, gateways: [], sharedHosts: options.sharedHosts ?? [] });
  }
  if (options?.registrationKey !== undefined && options.registrationKey !== '') {
    throw new Error('Registration key requires a registration store file');
  }
  if (options?.requireAccount) throw new Error('Relay account enrollment requires a registration store file');
  return startLegacyRelay(options ?? {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const relay = await startRelay({ ...relayServerConfig(), publicTlsOrigin: process.env.KCODER_RELAY_PUBLIC_URL });
  console.log(`KCoder relay listening on loopback ${relay.proxyPort}/${relay.controlPort}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await relay.close(); process.exit(0); });
}
