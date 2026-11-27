import { TextDecoder } from 'node:util';
import {
  canonicalGatewayConnectionUrl,
  isLoopbackGatewayConnectionUrl,
  parseGatewayConnectionRoutes,
} from './connection-routes.mjs';

const MAX_CONNECTION_ROUTES_BYTES = 32 * 1024;
const LOCAL_GATEWAY_REQUEST_TIMEOUT_MS = 5_000;
function validatedConnectionRoutes(value, gateway) {
  const routes = parseGatewayConnectionRoutes(value);
  if (!routes) throw new Error('Local Gateway returned invalid connection routes');
  const canonicalGateway = canonicalGatewayConnectionUrl(gateway);
  if (!canonicalGateway || !routes.endpoints.some(endpoint =>
    endpoint.kind === 'public' && endpoint.url === canonicalGateway)) {
    throw new Error('Local Gateway connection routes do not contain the paired public Gateway URL');
  }
  return routes;
}

function localGatewayForRouteDiscovery(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid KCODER_RELAY_LOCAL_GATEWAY for route discovery');
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error('Invalid KCODER_RELAY_LOCAL_GATEWAY for route discovery'); }
  if (parsed.protocol !== 'http:' || !isLoopbackGatewayConnectionUrl(value) ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.port === '0') {
    throw new Error('KCODER_RELAY_LOCAL_GATEWAY for route discovery must be a loopback HTTP URL without credentials, path, query, or fragment');
  }
  return parsed;
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CONNECTION_ROUTES_BYTES) {
    throw new Error('Local Gateway pairing response is too large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Local Gateway pairing response is empty');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONNECTION_ROUTES_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Local Gateway pairing response is too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)); }
  catch { throw new Error('Local Gateway pairing response is not valid UTF-8'); }
  try { return JSON.parse(text); }
  catch { throw new Error('Local Gateway pairing response is not valid JSON'); }
}

export async function fetchGatewayPairing({ localGateway, gatewaySecret, publicGateway, tokenMode = 'auto', fetchImpl = globalThis.fetch }) {
  const local = localGatewayForRouteDiscovery(localGateway);
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(gatewaySecret || '')) throw new Error('Configure a private Gateway Relay secret');
  if (!['auto', 'fixed', 'temporary'].includes(tokenMode)) throw new Error('Invalid mobile pairing token mode');
  let response;
  try {
    response = await fetchImpl(new URL('/api/mobile/pairing/relay', local), {
      method: 'GET', headers: { 'x-kcoder-relay-validation': gatewaySecret, 'x-kcoder-pairing-token-mode': tokenMode },
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(LOCAL_GATEWAY_REQUEST_TIMEOUT_MS),
    });
  } catch { throw new Error('Local Gateway pairing discovery failed'); }
  if (response.status !== 200) throw new Error(`Local Gateway pairing discovery failed (HTTP ${response.status})`);
  const pairing = await readBoundedJson(response);
  const validCredential = pairing?.kind === 'fixed'
    ? /^[A-Za-z0-9._~-]{32,512}$/.test(pairing.token || '') && pairing.expiresAt === null
    : pairing?.kind === 'temporary' && /^[a-f0-9]{64}$/.test(pairing.token || '') && Number.isSafeInteger(pairing.expiresAt) && pairing.expiresAt > Date.now();
  if (!validCredential || (tokenMode !== 'auto' && pairing.kind !== tokenMode) || pairing.token === gatewaySecret ||
      canonicalGatewayConnectionUrl(pairing.publicBaseUrl) !== canonicalGatewayConnectionUrl(publicGateway)) {
    throw new Error('Local Gateway returned invalid device pairing credentials');
  }
  return { kind: pairing.kind, token: pairing.token, expiresAt: pairing.expiresAt,
    connectionRoutes: validatedConnectionRoutes(pairing.connectionRoutes, publicGateway) };
}
