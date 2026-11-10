import { randomBytes } from 'node:crypto';
import {
  canonicalGatewayConnectionUrl,
  isLoopbackGatewayConnectionUrl,
  parseGatewayConnectionProofQuery,
  parseGatewayConnectionRoutes,
} from '../shared/gatewayConnectionRoutes.js';

const connectionProofPath = '/api/mobile/connection-proof';

/** Check the configured public route without exposing a pairing credential. */
export function createPublicPairingReadiness({ signConnectionProof, fetchImpl = fetch }) {
  let current;
  return endpoint => {
    if (!endpoint) {
      current?.controller.abort();
      current = undefined;
      return undefined;
    }
    if (current?.endpoint === endpoint && (current.status !== 'failed' || current.retryAt > Date.now())) return current.status;
    current?.controller.abort();
    const controller = new AbortController();
    const probe = { endpoint, controller, status: 'preparing' };
    current = probe;
    const timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref?.();
    void (async () => {
      try {
        const nonce = randomBytes(24).toString('hex');
        const url = new URL(endpoint + connectionProofPath);
        url.searchParams.set('nonce', nonce);
        url.searchParams.set('endpoint', endpoint);
        const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
        // A normal proof is well under 1 KiB. Read only a bounded response.
        const reader = response.body?.getReader();
        if (!reader) throw Error('Public route proof unavailable');
        const chunks = [];
        let length = 0;
        try {
          if (!response.ok) throw Error('Public route proof unavailable');
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 1024) throw Error('Public route proof too large');
            chunks.push(value);
          }
        } finally { void reader.cancel().catch(() => {}); }
        const proof = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const expected = await signConnectionProof(nonce, endpoint);
        if (!expected || ['version', 'gatewayId', 'nonce', 'endpoint', 'signature'].some(key => proof?.[key] !== expected[key]))
          throw Error('Public route proof mismatch');
        probe.status = 'ready';
      } catch {
        probe.status = 'failed';
        probe.retryAt = Date.now() + 5_000;
      } finally { clearTimeout(timer); }
    })();
    return probe.status;
  };
}

/** Advertise only the configured public signaling and Relay endpoint. */
export function createMobileConnectionRoutes({ identity, publicAccessUrl, isAllowedAuthority }) {
  if (!identity || typeof identity.gatewayId !== 'string' || typeof identity.publicKey !== 'string') {
    throw new Error('Gateway connection identity is unavailable');
  }
  const url = publicAccessUrl ? canonicalGatewayConnectionUrl(String(publicAccessUrl)) : undefined;
  if (!url || isLoopbackGatewayConnectionUrl(url) ||
      (typeof isAllowedAuthority === 'function' && !isAllowedAuthority(new URL(url).host))) return undefined;
  return parseGatewayConnectionRoutes({
    version: 1, gatewayId: identity.gatewayId, publicKey: identity.publicKey,
    endpoints: [{ kind: 'public', url }],
  });
}

export function createMobileConnectionRoutesProvider(options) {
  let routes;
  return {
    setListeningPort() {
      routes = createMobileConnectionRoutes(options);
      return routes;
    },
    get() { return routes; },
    allows(endpoint) { return Boolean(routes?.endpoints.some(item => item.url === endpoint)); },
  };
}

export function attachMobileConnectionRoutes(payload, connectionRoutes) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Invalid Mobile response payload');
  return connectionRoutes ? { ...payload, connectionRoutes } : payload;
}

/** Read-only unauthenticated challenge endpoint; the caller runs Host and Origin/CORS admission first. */
export function createMobileConnectionProofHandler({ getConnectionRoutes, signConnectionProof, jsonResponse }) {
  if (typeof getConnectionRoutes !== 'function' || typeof signConnectionProof !== 'function' || typeof jsonResponse !== 'function') {
    throw new TypeError('Invalid mobile connection proof handler dependencies');
  }
  return async function handleMobileConnectionProof(request, response, requestUrl) {
    if (requestUrl.pathname !== connectionProofPath) return false;
    if (request.method !== 'GET') {
      jsonResponse(response, 405, { error: 'Method not allowed' }, { allow: 'GET' });
      return true;
    }
    const headers = request.headers ?? {};
    if (headers['transfer-encoding'] || headers.expect ||
        (headers['content-length'] !== undefined && headers['content-length'] !== '0')) {
      jsonResponse(response, 400, { error: 'Invalid connection proof request' });
      return true;
    }
    const rawQuery = requestUrl.search.startsWith('?') ? requestUrl.search.slice(1) : '';
    const query = parseGatewayConnectionProofQuery(rawQuery);
    if (!query) {
      jsonResponse(response, 400, { error: 'Invalid connection proof request' });
      return true;
    }
    const routes = await getConnectionRoutes();
    if (!routes?.endpoints?.some(endpoint => endpoint.url === query.endpoint)) {
      jsonResponse(response, 404, { error: 'Connection endpoint is not available' });
      return true;
    }
    try {
      const proof = await signConnectionProof(query.nonce, query.endpoint);
      if (proof?.version !== 1 || proof.gatewayId !== routes.gatewayId || proof.nonce !== query.nonce ||
          proof.endpoint !== query.endpoint || !/^[a-f0-9]{128}$/.test(proof.signature)) throw new Error('Invalid connection proof');
      jsonResponse(response, 200, proof);
    } catch {
      jsonResponse(response, 503, { error: 'Connection proof unavailable' });
    }
    return true;
  };
}
