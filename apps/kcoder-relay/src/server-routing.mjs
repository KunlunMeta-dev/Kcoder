import { gatewayOriginLabel, isGatewayOriginLabel, isolatedGatewayAuthority } from './gateway-origin.mjs';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const GATEWAY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_MAX_CONNECTIONS = 128;
const DEFAULT_MAX_BYTES_PER_WINDOW = 256 * 1024 * 1024;
const DEFAULT_TRAFFIC_WINDOW_MS = 60_000;
const MAX_GATEWAYS = 256;

function validLimit(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`Invalid gateway ${name}`);
  return result;
}

export function normalizeAuthority(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || /[\s\/?#@,]/.test(value)) return null;
  let hostname, port = '';
  if (value.startsWith('[')) {
    const match = value.match(/^\[([0-9A-Fa-f:.]+)\](?::([0-9]{1,5}))?$/);
    if (!match || isIP(match[1]) !== 6) return null;
    hostname = `[${match[1].toLowerCase()}]`;
    port = match[2] === undefined ? '' : `:${match[2]}`;
  } else {
    const match = value.match(/^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/);
    if (!match || match[1].startsWith('.') || match[1].endsWith('.') || match[1].includes('..')) return null;
    hostname = match[1].toLowerCase();
    port = match[2] === undefined ? '' : `:${match[2]}`;
  }
  if (port && (Number(port.slice(1)) > 65535 || Number(port.slice(1)) < 1 || String(Number(port.slice(1))) !== port.slice(1))) return null;
  // Public Relay authorities are HTTPS; an explicit default port names the same origin.
  if (port === ':443') port = '';
  return `${hostname}${port}`;
}

export function createGatewayRegistry({
  gateways,
  secret,
  device,
  sharedHosts = [],
  allowEmpty = false,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  maxBytesPerWindow = DEFAULT_MAX_BYTES_PER_WINDOW,
  trafficWindowMs = DEFAULT_TRAFFIC_WINDOW_MS,
}) {
  const legacy = !Array.isArray(gateways);
  if (legacy && (typeof secret !== 'string' || !secret || typeof device !== 'string' || !GATEWAY_ID.test(device))) {
    throw new Error('Relay requires a secret and valid device ID');
  }
  if (!legacy && (gateways.length > MAX_GATEWAYS || (gateways.length === 0 && !allowEmpty) || !Array.isArray(sharedHosts))) {
    throw new Error(`Relay requires 1 to ${MAX_GATEWAYS} Gateways and a shared host list`);
  }

  const source = legacy ? [{ id: device, secret, hosts: null }] : gateways;
  const byId = new Map();
  const byOriginLabel = new Map();
  const ids = new Set();
  const secrets = new Set();
  const gatewaySecrets = new Set();

  for (const config of source) {
    if (!config || typeof config !== 'object' || typeof config.id !== 'string' || !GATEWAY_ID.test(config.id)) {
      throw new Error('Invalid Gateway ID');
    }
    const normalizedId = config.id.toLowerCase();
    if (ids.has(normalizedId)) throw new Error('Duplicate Gateway ID');
    ids.add(normalizedId);
    if (typeof config.secret !== 'string' || config.secret.length < 32 || /[\u0000-\u001f\u007f]/.test(config.secret)) throw new Error(`Gateway ${config.id} requires a secret of at least 32 characters`);
    if (secrets.has(config.secret)) throw new Error('Each Gateway must have an independent control secret');
    if (gatewaySecrets.has(config.secret)) throw new Error('Pairing tokens must be independent from all control secrets');
    secrets.add(config.secret);

    let gatewaySecret = config.gatewaySecret;
    if (!legacy && (typeof gatewaySecret !== 'string' || gatewaySecret.length < 32 || /[\u0000-\u001f\u007f]/.test(gatewaySecret) || gatewaySecret === config.secret)) {
      throw new Error(`Gateway ${config.id} requires an independent gatewaySecret of at least 32 characters`);
    }
    if (gatewaySecret !== undefined && (typeof gatewaySecret !== 'string' || gatewaySecret.length < 32 || /[\u0000-\u001f\u007f]/.test(gatewaySecret) || gatewaySecret === config.secret)) {
      throw new Error(`Gateway ${config.id} has an invalid gatewaySecret`);
    }
    if (gatewaySecret !== undefined && (gatewaySecrets.has(gatewaySecret) || secrets.has(gatewaySecret))) {
      throw new Error('Each Gateway must have an independent gatewaySecret');
    }
    if (gatewaySecret !== undefined) gatewaySecrets.add(gatewaySecret);

    const state = {
      id: config.id,
      originLabel: gatewayOriginLabel(config.id),
      secret: Buffer.from(config.secret),
      gatewaySecret: gatewaySecret === undefined ? null : Buffer.from(gatewaySecret),
      maxConnections: validLimit(config.maxConnections, maxConnections, 'maxConnections'),
      maxBytesPerWindow: validLimit(config.maxBytesPerWindow, maxBytesPerWindow, 'maxBytesPerWindow'),
      trafficWindowMs: validLimit(config.trafficWindowMs, trafficWindowMs, 'trafficWindowMs'),
      control: null,
      generation: 0,
      pending: new Map(),
      active: new Set(),
      sessions: new Map(),
      pendingSessions: 0,
      pairingReads: 0,
      trafficBytes: 0,
      trafficWindowStarted: Date.now(),
    };
    if (byOriginLabel.has(state.originLabel)) throw new Error('Gateway origin label collision');
    byId.set(state.id, state);
    byOriginLabel.set(state.originLabel, state);
  }

  for (const gatewaySecret of gatewaySecrets) {
    if (secrets.has(gatewaySecret)) throw new Error('Pairing tokens must be independent from all control secrets');
  }

  const bySharedHost = new Set();
  if (!legacy) {
    for (const host of sharedHosts) {
      const authority = normalizeAuthority(host);
      if (!authority) throw new Error('Invalid shared host');
      if (bySharedHost.has(authority)) throw new Error(`Duplicate shared host ${authority}`);
      bySharedHost.add(authority);
    }
    if (bySharedHost.size === 0) throw new Error('Relay requires at least one shared host');
    for (const host of bySharedHost) {
      if (isGatewayOriginLabel(host.split('.', 1)[0])) throw new Error('A shared host cannot be a Gateway origin');
    }
  }

  return { legacy, byId, byOriginLabel, sharedHosts: bySharedHost };
}

/** Insert an already validated Gateway into both live indexes. */
export function addGatewayState(registry, state) {
  if (registry.byId.has(state.id) || registry.byOriginLabel.has(state.originLabel)) {
    throw new Error('Duplicate Gateway identity');
  }
  registry.byId.set(state.id, state);
  registry.byOriginLabel.set(state.originLabel, state);
}

/**
 * Validate one new persisted Gateway against a running multi-Gateway registry
 * without changing the registry. Registration stores use this before commit
 * so a collision with a static Gateway cannot poison the durable store.
 */
export function normalizeGatewayAddition(registry, config, {
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  maxBytesPerWindow = DEFAULT_MAX_BYTES_PER_WINDOW,
  trafficWindowMs = DEFAULT_TRAFFIC_WINDOW_MS,
} = {}) {
  if (!registry || registry.legacy || !(registry.byId instanceof Map)) {
    throw new Error('Dynamic Gateway registration requires a multi-Gateway registry');
  }
  if (registry.byId.size >= MAX_GATEWAYS) throw new Error('Relay Gateway capacity reached');

  const single = createGatewayRegistry({
    gateways: [config],
    sharedHosts: [...registry.sharedHosts],
    maxConnections,
    maxBytesPerWindow,
    trafficWindowMs,
  });
  const candidate = single.byId.values().next().value;
  const candidateId = candidate.id.toLowerCase();
  if (registry.byOriginLabel?.has(candidate.originLabel)) throw new Error('Gateway origin label collision');
  for (const current of registry.byId.values()) {
    if (current.id.toLowerCase() === candidateId) throw new Error('Duplicate Gateway ID');
    const currentSecret = current.secret.toString();
    const currentGatewaySecret = current.gatewaySecret?.toString() ?? null;
    const nextSecret = candidate.secret.toString();
    const nextGatewaySecret = candidate.gatewaySecret?.toString() ?? null;
    if (nextSecret === currentSecret || nextSecret === currentGatewaySecret ||
        nextGatewaySecret === currentSecret || nextGatewaySecret === currentGatewaySecret) {
      throw new Error('Gateway credentials must be independent across tenants');
    }
  }
  return candidate;
}

export function requestAuthority(request) {
  const raw = request.rawHeaders ?? [];
  const values = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (String(raw[index]).toLowerCase() === 'host') values.push(raw[index + 1]);
  }
  if (values.length !== 1) return null;
  return normalizeAuthority(values[0]);
}

function splitTarget(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.includes('#')) return null;
  const separator = target.indexOf('?');
  return separator < 0
    ? { pathname: target, search: '' }
    : { pathname: target.slice(0, separator), search: target.slice(separator) };
}

// Dot segments and backslashes are rejected before routing: a URL parser on
// either side could otherwise resolve /g/a/../b into another Gateway's mount.
function unsafeRoutePath(pathname) {
  return pathname.includes('\\') || pathname.split('/').some(segment => /^(?:\.|%2e){1,2}$/i.test(segment));
}

function isolatedHost(registry, host) {
  const separator = host.indexOf('.');
  if (separator <= 0) return null;
  const label = host.slice(0, separator);
  const base = host.slice(separator + 1);
  if (!isGatewayOriginLabel(label) || !registry.sharedHosts?.has(base)) return null;
  return { label, base };
}

export function resolveGatewayRoute(registry, authority, target) {
  const host = normalizeAuthority(authority);
  const requestTarget = splitTarget(target);
  if (!host || !requestTarget || unsafeRoutePath(requestTarget.pathname)) return { error: 'invalid' };

  const match = requestTarget.pathname.match(/^\/g\/([A-Za-z0-9_-]{1,64})(?:\/|$)/);
  const isolated = isolatedHost(registry, host);
  if (registry.sharedHosts.has(host) || isolated) {
    let gateway;
    if (isolated) {
      // The host label selects the Gateway; the path must name the same one.
      gateway = registry.byOriginLabel.get(isolated.label);
      if (!gateway) return { error: 'unknown-host' };
      if (!match) return { error: 'shared-path' };
      if (match[1] !== gateway.id) return { error: 'gateway-mismatch' };
    } else {
      if (!match) return { error: 'shared-path' };
      gateway = registry.byId.get(match[1]);
      if (!gateway) return { error: 'unknown-gateway' };
    }
    const prefix = `/g/${match[1]}`;
    const suffix = requestTarget.pathname.slice(prefix.length);
    let canonicalAuthority = null;
    try { canonicalAuthority = isolated ? host : isolatedGatewayAuthority(host, gateway.id); } catch {}
    return {
      gateway,
      target: `${suffix || '/'}${requestTarget.search}`,
      shared: true,
      isolated: Boolean(isolated),
      authority: host,
      canonicalAuthority,
    };
  }

  if (registry.legacy) {
    const only = registry.byId.values().next().value;
    return { gateway: only, target, shared: false };
  }
  return { error: 'unknown-host' };
}

/**
 * True when an Origin belongs to this Relay's shared root or to a different
 * Gateway's isolated origin. Such browser contexts never act for this Gateway;
 * unrelated origins are left to the Gateway's own exact allowlist.
 */
export function crossGatewayOrigin(registry, route, origin) {
  if (origin === undefined || !route?.isolated) return false;
  if (typeof origin !== 'string') return true;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.origin !== origin || !/^https?:$/.test(parsed.protocol)) return false;
  const host = normalizeAuthority(parsed.host);
  if (!host || host === route.authority) return false;
  return registry.sharedHosts.has(host) || isolatedHost(registry, host) !== null;
}

/**
 * Caddy on-demand TLS permission: allow exactly one active Gateway's derived
 * hostname under a configured shared hostname. Uses only the in-memory label
 * index, so the handshake path performs no disk I/O or full-ID hashing.
 */
export function onDemandTlsAllowed(registry, domain) {
  if (registry.legacy || typeof domain !== 'string' || domain.length > 253 || domain !== domain.toLowerCase()) return false;
  const separator = domain.indexOf('.');
  if (separator <= 0 || /[^a-z0-9.-]/.test(domain)) return false;
  const label = domain.slice(0, separator);
  const base = domain.slice(separator + 1);
  // Certificates are per hostname: a shared authority with a custom port
  // contributes only its hostname, and the asked name itself never has a port.
  let hostnameKnown = false;
  for (const shared of registry.sharedHosts) {
    if (shared === base || shared.replace(/:\d+$/, '') === base) { hostnameKnown = true; break; }
  }
  return hostnameKnown && isGatewayOriginLabel(label) && registry.byOriginLabel.has(label);
}

export function bearerToken(request) {
  const value = request.headers?.authorization;
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer ([A-Za-z0-9._~-]{1,512})$/);
  return match?.[1] ?? null;
}

export function tokenHash(value) {
  return createHash('sha256').update(value).digest('hex');
}
