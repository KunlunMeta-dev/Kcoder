const gatewayIdPattern = /^[a-f0-9]{64}$/;
const publicKeyPattern = /^[a-f0-9]{64}$/;
const noncePattern = /^[a-f0-9]{48}$/;
// Read retired metadata only to remove it; clients receive public endpoints exclusively.
const storedEndpointKinds = new Set(['public', 'lan']);
const gatewayMountPathPattern = /^\/g\/[A-Za-z0-9_-]{1,64}$/;
const maximumEndpoints = 8;
const maximumEndpointLength = 2048;
const maximumConnectionProofQueryLength = 4096;
const connectionProofNoncePattern = /^[a-f0-9]{48}$/;
const connectionProofCacheBusterPattern = /^[0-9]{1,16}$/;

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (/^127(?:\.\d{1,3}){3}$/.test(mapped)) return true;
    const firstWord = Number.parseInt(mapped.split(':', 1)[0], 16);
    if (Number.isFinite(firstWord) && (firstWord >>> 8) === 127) return true;
  }
  const octets = normalized.split('.');
  return octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255) && Number(octets[0]) === 127;
}

/** Return the canonical endpoint URL, or undefined when it is outside the wire contract. */
export function canonicalGatewayConnectionUrl(value) {
  if (typeof value !== 'string' || !value || value.length > maximumEndpointLength || value.trim() !== value) return undefined;
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port === '0') return undefined;
    if (parsed.pathname !== '/' && !gatewayMountPathPattern.test(parsed.pathname)) return undefined;
    const canonical = `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    return canonical.length <= maximumEndpointLength ? canonical : undefined;
  } catch {
    return undefined;
  }
}

/** Loopback endpoints cannot be advertised to a separate phone. */
export function isLoopbackGatewayConnectionUrl(value) {
  try {
    const parsed = new URL(value);
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function validEndpoint(value) {
  if (!plainObject(value) || Object.keys(value).length !== 2 || !storedEndpointKinds.has(value.kind)) return false;
  if (typeof value.url !== 'string' || canonicalGatewayConnectionUrl(value.url) !== value.url || isLoopbackGatewayConnectionUrl(value.url)) return false;
  return true;
}

/** Validate a versioned Gateway connection descriptor without platform crypto dependencies. */
export function parseGatewayConnectionRoutes(value) {
  if (!plainObject(value) || Object.keys(value).length !== 4 || value.version !== 1 ||
      typeof value.gatewayId !== 'string' || !gatewayIdPattern.test(value.gatewayId) ||
      typeof value.publicKey !== 'string' || !publicKeyPattern.test(value.publicKey) ||
      !Array.isArray(value.endpoints) || value.endpoints.length < 1 || value.endpoints.length > maximumEndpoints ||
      !value.endpoints.every(validEndpoint)) return undefined;
  if (new Set(value.endpoints.map(endpoint => endpoint.url)).size !== value.endpoints.length) return undefined;
  // Retire saved LAN candidates without changing the Gateway key or device binding.
  const endpoints = value.endpoints.filter(endpoint => endpoint.kind === 'public');
  if (endpoints.length === 0) return undefined;
  return {
    version: 1,
    gatewayId: value.gatewayId,
    publicKey: value.publicKey,
    endpoints: endpoints.map(({ url }) => ({ kind: 'public', url })),
  };
}

/** Stable Ed25519 signing payload shared by Gateway and clients. */
export function connectionProofMessage(gatewayId, nonce, endpoint) {
  if (typeof gatewayId !== 'string' || !gatewayIdPattern.test(gatewayId) ||
      typeof nonce !== 'string' || !noncePattern.test(nonce) ||
      canonicalGatewayConnectionUrl(endpoint) !== endpoint || isLoopbackGatewayConnectionUrl(endpoint)) {
    throw new TypeError('Invalid Gateway connection proof input');
  }
  return JSON.stringify(['kcoder.gateway.connection-proof.v1', gatewayId, nonce, endpoint]);
}

/** Parse the bounded anonymous proof query, allowing one inert fetch cachebuster. */
export function parseGatewayConnectionProofQuery(rawQuery) {
  if (typeof rawQuery !== 'string' || !rawQuery || rawQuery.length > maximumConnectionProofQueryLength) return undefined;
  const pairs = rawQuery.split('&');
  if (pairs.length < 2 || pairs.length > 3) return undefined;
  const names = new Set();
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator <= 0) return undefined;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!['nonce', 'endpoint', '_'].includes(name) || names.has(name)) return undefined;
    if (name === '_' && !connectionProofCacheBusterPattern.test(value)) return undefined;
    names.add(name);
  }
  if (!names.has('nonce') || !names.has('endpoint')) return undefined;
  const query = new URLSearchParams(rawQuery);
  const nonces = query.getAll('nonce');
  const endpoints = query.getAll('endpoint');
  if (nonces.length !== 1 || !connectionProofNoncePattern.test(nonces[0]) ||
      endpoints.length !== 1 || endpoints[0].length > maximumEndpointLength) return undefined;
  return { nonce: nonces[0], endpoint: endpoints[0] };
}
