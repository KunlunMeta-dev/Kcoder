import { createHash } from 'node:crypto';

export const MOBILE_ROUTE_AUTHORIZATION_PATH = '/api/mobile/session/relay-validation';
const maximumBodyBytes = 4096;
const maximumValidationMs = 5000;
const requestIdPattern = /^[a-f0-9]{48}$/;
const credentialPattern = /^[A-Za-z0-9-]{32,128}$/;
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');

function duplicateTopLevelKeys(raw) {
  const keys = new Set();
  let depth = 0;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === '{') { depth++; continue; }
    if (char === '}') { depth--; continue; }
    if (char !== '"') continue;
    const start = index++;
    while (index < raw.length && raw[index] !== '"') {
      if (raw[index] === '\\') index++;
      index++;
    }
    if (depth !== 1) continue;
    let next = index + 1;
    while (next < raw.length && /\s/.test(raw[next])) next++;
    if (raw[next] !== ':') continue;
    const key = JSON.parse(raw.slice(start, index + 1));
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

function exactAccessRequest(raw) {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw, 'utf8') > maximumBodyBytes || duplicateTopLevelKeys(raw)) return undefined;
  let payload;
  try { payload = JSON.parse(raw); } catch { return undefined; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 4 ||
      Object.keys(payload).some(key => !['version', 'kind', 'credential', 'requestId'].includes(key)) ||
      payload.version !== 1 || !['access', 'public-surface'].includes(payload.kind) ||
      typeof payload.credential !== 'string' || (payload.kind === 'access'
        ? !credentialPattern.test(payload.credential)
        : !['desktopWeb', 'mobileWeb', 'mobileApp'].includes(payload.credential)) ||
      typeof payload.requestId !== 'string' || !requestIdPattern.test(payload.requestId)) return undefined;
  return payload;
}

async function withinDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('route authorization timed out')), Math.max(0, deadline - Date.now())); }),
    ]);
  } finally { clearTimeout(timer); }
}

function validExpiry(value, now) { return Number.isSafeInteger(value) && value > now; }

/** Authenticates an internal Relay lookup and returns only hashes and expiry metadata. */
export function createMobileRouteAuthorizationHandler({
  authRequired,
  tokenMatches,
  authSessions,
  inspectAccessAuthorization,
  allowsSurface = () => true,
  rpcToken,
  readBody,
  jsonResponse,
  now = Date.now,
}) {
  if (typeof tokenMatches !== 'function' || !(authSessions instanceof Map) ||
      typeof inspectAccessAuthorization !== 'function' || typeof readBody !== 'function' ||
      typeof jsonResponse !== 'function') throw new TypeError('Invalid Mobile route authorization dependencies');

  return async function handleMobileRouteAuthorization(request, response, requestUrl) {
    if (requestUrl.pathname !== MOBILE_ROUTE_AUTHORIZATION_PATH) return false;
    if (request.url !== undefined && request.url !== MOBILE_ROUTE_AUTHORIZATION_PATH) {
      jsonResponse(response, 404, { error: 'Route authorization unavailable' });
      return true;
    }
    const relaySecret = request.headers['x-kcoder-relay-validation'];
    let authenticated = false;
    try { authenticated = authRequired === true && typeof relaySecret === 'string' && tokenMatches(relaySecret) === true; }
    catch { authenticated = false; }
    if (!authenticated) {
      jsonResponse(response, authRequired === true ? 401 : 404, { error: 'Route authorization unavailable' });
      return true;
    }
    if (request.method !== 'POST') {
      jsonResponse(response, 405, { error: 'Method not allowed' }, { allow: 'POST' });
      return true;
    }
    if (requestUrl.search || request.headers.origin !== undefined || request.headers.cookie !== undefined || request.headers.authorization !== undefined) {
      jsonResponse(response, 403, { error: 'Route authorization requires an internal request' });
      return true;
    }
    if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      jsonResponse(response, 415, { error: 'Route authorization requires application/json' });
      return true;
    }
    const deadline = Date.now() + maximumValidationMs;
    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBodyBytes)) {
      jsonResponse(response, 413, { error: 'Route authorization body is too large' });
      return true;
    }
    let payload;
    try {
      const raw = await withinDeadline(readBody(request, maximumBodyBytes), deadline);
      payload = exactAccessRequest(raw);
    } catch (error) {
      const timedOut = /timed out/i.test(String(error?.message));
      jsonResponse(response, timedOut ? 503 : /too large/i.test(String(error?.message)) ? 413 : 400, { error: 'Invalid route authorization request' });
      return true;
    }
    if (!payload) {
      jsonResponse(response, 400, { error: 'Invalid route authorization request' });
      return true;
    }
    if (payload.kind === 'public-surface') {
      if (allowsSurface(payload.credential)) response.writeHead(204, { 'cache-control': 'no-store' }).end();
      else jsonResponse(response, 403, { error: 'Public access is disabled' });
      return true;
    }

    const session = authSessions.get(payload.credential);
    if (session && !allowsSurface(session.deviceId ? session.surface || 'mobileApp' : 'desktopWeb')) {
      jsonResponse(response, 403, { error: 'Public access is disabled' });
      return true;
    }
    const sessionAccessExpiresAt = session?.accessExpiresAt ?? session?.expiresAt;
    const initialTime = now();
    if (!session || !validExpiry(sessionAccessExpiresAt, initialTime) || !validExpiry(session.expiresAt, initialTime)) {
      jsonResponse(response, 401, { error: 'Access authorization rejected' });
      return true;
    }
    let metadata;
    if (session.deviceId === undefined) {
      metadata = { accessTokenHash: hash(payload.credential), expiresAt: sessionAccessExpiresAt, accessExpiresAt: sessionAccessExpiresAt };
    } else {
      if (typeof session.deviceId !== 'string') {
        jsonResponse(response, 401, { error: 'Access authorization rejected' });
        return true;
      }
      try { metadata = await withinDeadline(inspectAccessAuthorization(payload.credential), deadline); }
      catch {
        jsonResponse(response, 503, { error: 'Route authorization unavailable' });
        return true;
      }
    }
    const validationTime = now();
    if (authSessions.get(payload.credential) !== session ||
        !validExpiry(session.accessExpiresAt ?? session.expiresAt, validationTime) ||
        !validExpiry(session.expiresAt, validationTime) ||
        (session.deviceId !== undefined && (!metadata || metadata.deviceId !== session.deviceId ||
          metadata.accessExpiresAt !== session.accessExpiresAt || metadata.wsLeaseExpiresAt !== session.expiresAt ||
          metadata.authorizationGeneration !== session.authorizationGeneration))) {
      jsonResponse(response, 401, { error: 'Access authorization rejected' });
      return true;
    }
    if (!metadata || metadata.accessTokenHash !== hash(payload.credential) ||
        !validExpiry(metadata.expiresAt, validationTime) || !validExpiry(metadata.accessExpiresAt, validationTime) ||
        metadata.expiresAt !== metadata.accessExpiresAt || typeof rpcToken !== 'string' || !rpcToken) {
      jsonResponse(response, 401, { error: 'Access authorization rejected' });
      return true;
    }
    const result = {
      version: 1,
      kind: 'access',
      requestId: payload.requestId,
      accessTokenHash: metadata.accessTokenHash,
      rpcTokenHash: hash(rpcToken),
      expiresAt: metadata.expiresAt,
      accessExpiresAt: metadata.accessExpiresAt,
    };
    for (const field of ['deviceId', 'wsLeaseExpiresAt', 'refreshExpiresAt']) {
      if (metadata[field] !== undefined) result[field] = metadata[field];
    }
    const hasDeviceMetadata = ['deviceId', 'wsLeaseExpiresAt', 'refreshExpiresAt'].some(field => result[field] !== undefined);
    if ((hasDeviceMetadata && !['deviceId', 'wsLeaseExpiresAt', 'refreshExpiresAt'].every(field => result[field] !== undefined)) ||
        (result.deviceId !== undefined && (typeof result.deviceId !== 'string' || !/^[A-Za-z0-9-]{16,128}$/.test(result.deviceId))) ||
        (result.wsLeaseExpiresAt !== undefined && !validExpiry(result.wsLeaseExpiresAt, validationTime)) ||
        (result.refreshExpiresAt !== undefined && !validExpiry(result.refreshExpiresAt, validationTime))) {
      jsonResponse(response, 503, { error: 'Route authorization unavailable' });
      return true;
    }
    jsonResponse(response, 200, result);
    return true;
  };
}
