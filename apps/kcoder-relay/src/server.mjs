import { Agent, createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { bridge, bridgeRaw, heartbeat, RelayDuplex, RELAY_EOF_DRAIN_TIMEOUT_MS } from './transport.mjs';
import { bearerToken, createGatewayRegistry, normalizeGatewayAddition, requestAuthority, resolveGatewayRoute, tokenHash } from './server-routing.mjs';
import { loadEnv, relayServerConfig } from './config.mjs';
import { openRegistrationStore } from './registration-store.mjs';
import { GrantGetPool } from './http-get-pool.mjs';

const SESSION_PATH = '/api/mobile/session';
const REFRESH_PATH = '/api/mobile/session/refresh';
const MAX_SESSION_BODY = 64 * 1024;
const MAX_SESSIONS = 4096;
const REGISTRATION_PATH = '/_relay/register';
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
    secureStringEqual(gateway.pairingToken?.toString() ?? '', config.pairingToken) &&
    gateway.maxConnections === config.maxConnections &&
    gateway.maxBytesPerWindow === config.maxBytesPerWindow &&
    gateway.trafficWindowMs === config.trafficWindowMs;
}

function registrationResponse(config) {
  return {
    id: config.id,
    secret: config.secret,
    pairingToken: config.pairingToken,
    maxConnections: config.maxConnections,
    maxBytesPerWindow: config.maxBytesPerWindow,
    trafficWindowMs: config.trafficWindowMs,
  };
}

function hasDuplicateTopLevelJsonKeys(text) {
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? '')) index += 1; };
  const quotedEnd = start => {
    for (let cursor = start + 1; cursor < text.length; cursor += 1) {
      if (text[cursor] === '\\') { cursor += 1; continue; }
      if (text[cursor] === '"') return cursor + 1;
    }
    return text.length;
  };
  const valueEnd = start => {
    let depth = 0;
    let inString = false;
    for (let cursor = start; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (inString) {
        if (char === '\\') cursor += 1;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{' || char === '[') depth += 1;
      else if (char === '}' || char === ']') {
        if (depth === 0) return cursor;
        depth -= 1;
      } else if (char === ',' && depth === 0) return cursor;
    }
    return text.length;
  };

  whitespace();
  if (text[index] !== '{') return false;
  index += 1;
  const keys = new Set();
  while (index < text.length) {
    whitespace();
    if (text[index] === '}') return false;
    if (text[index] !== '"') return false;
    const start = index;
    index = quotedEnd(index);
    const key = JSON.parse(text.slice(start, index));
    if (keys.has(key)) return true;
    keys.add(key);
    whitespace();
    if (text[index] !== ':') return false;
    index += 1;
    whitespace();
    index = valueEnd(index);
    whitespace();
    if (text[index] === ',') { index += 1; continue; }
    return false;
  }
  return false;
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

function pathnameOf(target) {
  const index = target.indexOf('?');
  return index < 0 ? target : target.slice(0, index);
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
      const withoutDomain = String(cookie).replace(/;\s*domain\s*=\s*[^;]*/ig, '');
      if (/;\s*path\s*=/i.test(withoutDomain)) return withoutDomain.replace(/;\s*path\s*=\s*[^;]*/i, `; Path=${prefix}`);
      return `${withoutDomain}; Path=${prefix}`;
    }),
  };
}

function responseHeaders(upstream, route) {
  return rewriteSetCookie(hopHeaders(upstream.headers), route.gateway.id, route.shared);
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

function accessForApi(gateway, request) {
  const access = bearerToken(request);
  return findSession(gateway, access);
}

function accessForRpc(gateway, request) {
  const bearer = bearerToken(request);
  const credential = accessCredentialFromSubprotocol(request);
  if (credential.invalid) return null;
  const protocol = credential.token;
  if (bearer && protocol && !secureStringEqual(bearer, protocol)) return null;
  return findSession(gateway, bearer || protocol);
}

function rpcTokenFromTarget(target) {
  let url;
  try { url = new URL(target, 'http://relay.invalid'); } catch { return null; }
  const tokens = [...url.searchParams.getAll('token'), ...url.searchParams.getAll('rpcToken')];
  if (tokens.length !== 1 || !/^[A-Za-z0-9._~-]{1,512}$/.test(tokens[0])) return null;
  return tokens[0];
}

function makeRawUpgradeRequest(request, target) {
  const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding']);
  const connectionTokens = new Set(String(request.headers.connection || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  const lines = [`${request.method} ${target} HTTP/${request.httpVersion}`];
  let hasUpgrade = false;
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    const name = String(request.rawHeaders[index]);
    const lower = name.toLowerCase();
    if (lower === 'connection') continue;
    if (blocked.has(lower) || (connectionTokens.has(lower) && lower !== 'upgrade')) continue;
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
    if (!family) { family = { active: new Set(), expiryTimer: null, expiresAt: payload.wsLeaseExpiresAt }; gateway.mobileDeviceFamilies.set(deviceId, family); }
    clearTimeout(family.expiryTimer);
    // Replace access grants without closing channels owned by the same device.
    for (const [oldHash, oldSession] of gateway.sessions) if (oldSession.deviceId === deviceId) { oldSession.httpGetPool?.retire(Object.assign(new Error('Access grant replaced'), { code: 'RELAY_UNAUTHORIZED' })); gateway.sessions.delete(oldHash); }
    family.expiresAt = payload.wsLeaseExpiresAt;
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
  registrationKey: configuredRegistrationKey,
  registrationStoreFile,
  controlPort = 18452,
  proxyPort = 18451,
  maxConnections = 128,
  maxBytesPerWindow = 256 * 1024 * 1024,
  trafficWindowMs = 60_000,
  connectTimeout = 10_000,
  pairingBodyTimeoutMs = 5_000,
}) {
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
      secureStringEqual(gateway.pairingToken?.toString() ?? '', registrationKey))) {
      throw new Error('Registration key must be independent from all Gateway credentials');
    }
  } catch (error) {
    try { await registrationStore?.close(); } catch {}
    throw error;
  }
  const stateById = registry.byId;
  const dynamicGatewayIds = new Set(persistedGatewayIds);
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

  function getGrantPool(gateway, session, hash) {
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
      validate, expiresAt: session.expiresAt, queueTimeoutMs: connectTimeout, maxSockets: Math.min(2, gateway.maxConnections),
      admitWaiter() {
        const count = gateway.httpGetWaiters || 0;
        if (count >= gateway.maxConnections) return false;
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

  let registrationsInFlight = 0;

  async function handleRegistration(request, response) {
    if (!registrationStore || !registrationKey) {
      sendHttpError(response, 404, 'Not Found');
      return;
    }
    const suppliedKey = bearerToken(request);
    if (!suppliedKey || !secureStringEqual(suppliedKey, registrationKey)) {
      closeRequestAfterResponse(request, response);
      sendHttpError(response, 401, 'Unauthorized');
      return;
    }
    if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      closeRequestAfterResponse(request, response);
      sendHttpError(response, 415, 'Unsupported Media Type');
      return;
    }
    if (registrationsInFlight >= MAX_REGISTRATION_CONCURRENCY) {
      closeRequestAfterResponse(request, response);
      sendHttpError(response, 429, 'Too Many Requests');
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
        if (hasDuplicateTopLevelJsonKeys(text)) throw new Error('Duplicate registration field');
      } catch {
        sendHttpError(response, 400, 'Bad Request');
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        sendHttpError(response, 400, 'Bad Request');
        return;
      }
      const keys = Object.keys(payload);
      if (keys.length !== 2 || !Object.hasOwn(payload, 'enrollmentToken') || !Object.hasOwn(payload, 'pairingToken') ||
          keys.some(key => key !== 'enrollmentToken' && key !== 'pairingToken') ||
          typeof payload.enrollmentToken !== 'string' || !REGISTRATION_CREDENTIAL.test(payload.enrollmentToken) ||
          typeof payload.pairingToken !== 'string' || !REGISTRATION_CREDENTIAL.test(payload.pairingToken) ||
          payload.enrollmentToken === payload.pairingToken ||
          secureStringEqual(payload.enrollmentToken, registrationKey) ||
          secureStringEqual(payload.pairingToken, registrationKey)) {
        sendHttpError(response, 400, 'Bad Request');
        return;
      }
      if ([...stateById.values()].some(gateway =>
        secureStringEqual(payload.enrollmentToken, gateway.secret.toString()) ||
        secureStringEqual(payload.enrollmentToken, gateway.pairingToken?.toString() ?? ''))) {
        sendHttpError(response, 400, 'Bad Request');
        return;
      }

      let preparedGateway = null;
      let created;
      try {
        created = await registrationStore.register({
          enrollmentToken: payload.enrollmentToken,
          pairingToken: payload.pairingToken,
        }, {
          validateGateway(config) {
            if (config?.pairingToken !== payload.pairingToken ||
                secureStringEqual(config?.secret, registrationKey) || secureStringEqual(config?.pairingToken, registrationKey) ||
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
        });
      } catch (error) {
        const code = error?.code;
        if (code === 'REGISTRATION_UNAUTHORIZED') sendHttpError(response, 401, 'Unauthorized');
        else if (code === 'REGISTRATION_CAPACITY') sendHttpError(response, 429, 'Too Many Requests');
        else if (code === 'REGISTRATION_CONFLICT') sendHttpError(response, 409, 'Conflict');
        else sendHttpError(response, 503, 'Service Unavailable');
        return;
      }

      if (!created || !preparedGateway || !gatewayMatchesConfig(preparedGateway, created) || created.pairingToken !== payload.pairingToken) {
        sendHttpError(response, 503, 'Service Unavailable');
        return;
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
        stateById.set(preparedGateway.id, preparedGateway);
        dynamicGatewayIds.add(preparedGateway.id);
      }
      sendJson(response, status, registrationResponse(created));
    } finally {
      registrationsInFlight = Math.max(0, registrationsInFlight - 1);
    }
  }

  const controlHttp = httpServer((request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    if (request.method === 'POST' && request.url === REGISTRATION_PATH) {
      void handleRegistration(request, response).catch(() => sendHttpError(response, 503, 'Service Unavailable'));
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
    const gateway = route.gateway;
    if (!gatewayOnline(gateway)) { sendHttpError(response, 503, 'Service Unavailable'); return; }

    const path = pathnameOf(route.target);
    const isApi = path === '/api' || path.startsWith('/api/');
    const isSessionPost = path === SESSION_PATH && request.method === 'POST';
    const isSessionDelete = path === SESSION_PATH && request.method === 'DELETE';
    const isRefreshPost = path === REFRESH_PATH && request.method === 'POST';
    const isDeviceDelete = /^\/api\/mobile\/devices\/[a-zA-Z0-9-]{16,128}$/.test(path) && request.method === 'DELETE';
    const isCorsPreflight = request.method === 'OPTIONS' && typeof request.headers.origin === 'string' &&
      typeof request.headers['access-control-request-method'] === 'string';
    let session = null;
    let accessGrantHash = null;
    let bufferedBody = null;
    let sessionReservation = false;
    const releaseSessionReservation = () => {
      if (!sessionReservation) return;
      sessionReservation = false;
      gateway.pendingSessions = Math.max(0, gateway.pendingSessions - 1);
    };

    if (gateway.pairingToken && isRefreshPost && !admitRefreshPeer(gateway, request)) { sendHttpError(response, 429, "Too Many Requests"); return; }
    if (gateway.pairingToken && (isSessionPost || isRefreshPost)) {
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
      bufferedBody = result.body;
      gateway.pendingSessions += 1;
      sessionReservation = true;
    } else if (gateway.pairingToken && isApi && !isCorsPreflight) {
      const authenticated = accessForApi(gateway, request);
      if (!authenticated) { sendHttpError(response, 401, 'Unauthorized'); return; }
      session = authenticated.session;
      accessGrantHash = authenticated.hash;
    }

    const reqHeaderSize = requestHeaderBytes(request, route.target);
    if (!(gateway.pairingToken && (isSessionPost || isRefreshPost)) && !consumeTraffic(gateway, reqHeaderSize)) {
      sendHttpError(response, 429, 'Too Many Requests');
      return;
    }

    const headers = hopHeaders(request.headers);
    headers.host = request.headers.host;
    headers.connection = 'close';
    // Presentation proof only; never forwarded as an API/RPC credential.
    // Pairing users know this key. It attests a mount at pairing authority,
    // not possession of the Relay's private registration/control secret.
    delete headers['x-kcoder-mobile-mount'];
    delete headers['x-kcoder-mobile-mount-proof'];
    if (route.shared && gateway.pairingToken &&
        (path === '/mobile-entry' || path === '/mobile' || path.startsWith('/mobile/'))) {
      const prefix = `/g/${gateway.id}`;
      const canonicalHost = new URL(`http://${authority}`).host;
      headers['x-kcoder-mobile-mount'] = prefix;
      headers['x-kcoder-mobile-mount-proof'] = createHmac('sha256', gateway.pairingToken)
        .update(JSON.stringify(['kcoder-mobile-mount-v1', canonicalHost, prefix])).digest('hex');
    }
    if (bufferedBody) {
      delete headers['transfer-encoding'];
      headers['content-length'] = String(bufferedBody.length);
    }
    // Only authenticated bodyless API GETs participate. Mutations/upgrades and
    // compatibility Gateways retain their existing one-attempt tunnel path.
    const pooled = session && accessGrantHash && isApi && request.method === 'GET' &&
      !request.headers['transfer-encoding'] && !request.headers.expect && !request.headers.upgrade &&
      (request.headers['content-length'] === undefined || request.headers['content-length'] === '0');
    let lease = null;
    const waiting = new AbortController();
    if (pooled) {
      failureCleanup = () => { waiting.abort(); lease?.release(false); if (!response.destroyed) response.destroy(); };
      response.once('close', () => { if (!response.writableFinished) waiting.abort(); });
      try { lease = await getGrantPool(gateway, session, accessGrantHash).acquire(waiting.signal); }
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

    const isMobileSession = gateway.pairingToken && (isSessionPost || isRefreshPost);
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
      entry = openPending(gateway, session, (stream, close) => tunnel.attach(stream, close), error => tunnel.fail(error));
      if (!entry) { releaseSessionReservation(); upstreamRequest.destroy(); agent.destroy(); return; }
      tunnel.once('connect', sendRequest);
    }
  }

  publicHttp.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    const authority = requestAuthority(request);
    const route = resolveGatewayRoute(registry, authority, request.url);
    if (route.error) {
      const [status, message] = routeErrorStatus(route.error);
      sendUpgradeError(socket, status, message);
      return;
    }
    const gateway = route.gateway;
    if (!gatewayOnline(gateway)) { sendUpgradeError(socket, 503, 'Service Unavailable'); return; }

    const path = pathnameOf(route.target);
    let session = null;
    if (gateway.pairingToken && path === '/rpc') {
      const authenticated = accessForRpc(gateway, request);
      const rpcToken = rpcTokenFromTarget(route.target);
      if (!authenticated || !rpcToken || !sameHash(rpcToken, authenticated.session.rpcHash)) {
        sendUpgradeError(socket, 401, 'Unauthorized');
        return;
      }
      session = authenticated.session;
    }
    const rawRequest = makeRawUpgradeRequest(request, route.target);
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
  });

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
      await registrationStore?.close();
    },
  };
}

export async function startRelay(options) {
  if (Array.isArray(options?.gateways)) {
    if (options.legacy === true) {
      if (options.registrationStoreFile !== undefined || options.registrationKey !== undefined) {
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
  return startLegacyRelay(options ?? {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const relay = await startRelay(relayServerConfig());
  console.log(`KCoder relay listening on loopback ${relay.proxyPort}/${relay.controlPort}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await relay.close(); process.exit(0); });
}
