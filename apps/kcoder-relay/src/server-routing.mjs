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
  if (port && Number(port.slice(1)) > 65535) return null;
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
  const ids = new Set();
  const secrets = new Set();
  const pairingTokens = new Set();

  for (const config of source) {
    if (!config || typeof config !== 'object' || typeof config.id !== 'string' || !GATEWAY_ID.test(config.id)) {
      throw new Error('Invalid Gateway ID');
    }
    const normalizedId = config.id.toLowerCase();
    if (ids.has(normalizedId)) throw new Error('Duplicate Gateway ID');
    ids.add(normalizedId);
    if (typeof config.secret !== 'string' || config.secret.length < 32 || /[\u0000-\u001f\u007f]/.test(config.secret)) throw new Error(`Gateway ${config.id} requires a secret of at least 32 characters`);
    if (secrets.has(config.secret)) throw new Error('Each Gateway must have an independent control secret');
    if (pairingTokens.has(config.secret)) throw new Error('Pairing tokens must be independent from all control secrets');
    secrets.add(config.secret);

    let pairingToken = config.pairingToken;
    if (!legacy && (typeof pairingToken !== 'string' || pairingToken.length < 32 || /[\u0000-\u001f\u007f]/.test(pairingToken) || pairingToken === config.secret)) {
      throw new Error(`Gateway ${config.id} requires an independent pairingToken of at least 32 characters`);
    }
    if (pairingToken !== undefined && (typeof pairingToken !== 'string' || pairingToken.length < 32 || /[\u0000-\u001f\u007f]/.test(pairingToken) || pairingToken === config.secret)) {
      throw new Error(`Gateway ${config.id} has an invalid pairingToken`);
    }
    if (pairingToken !== undefined && (pairingTokens.has(pairingToken) || secrets.has(pairingToken))) {
      throw new Error('Each Gateway must have an independent pairingToken');
    }
    if (pairingToken !== undefined) pairingTokens.add(pairingToken);

    const state = {
      id: config.id,
      secret: Buffer.from(config.secret),
      pairingToken: pairingToken === undefined ? null : Buffer.from(pairingToken),
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
    byId.set(state.id, state);
  }

  for (const pairingToken of pairingTokens) {
    if (secrets.has(pairingToken)) throw new Error('Pairing tokens must be independent from all control secrets');
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
  }

  return { legacy, byId, sharedHosts: bySharedHost };
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
  for (const current of registry.byId.values()) {
    if (current.id.toLowerCase() === candidateId) throw new Error('Duplicate Gateway ID');
    const currentSecret = current.secret.toString();
    const currentPairingToken = current.pairingToken?.toString() ?? null;
    const nextSecret = candidate.secret.toString();
    const nextPairingToken = candidate.pairingToken?.toString() ?? null;
    if (nextSecret === currentSecret || nextSecret === currentPairingToken ||
        nextPairingToken === currentSecret || nextPairingToken === currentPairingToken) {
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

export function resolveGatewayRoute(registry, authority, target) {
  const host = normalizeAuthority(authority);
  const requestTarget = splitTarget(target);
  if (!host || !requestTarget) return { error: 'invalid' };

  if (registry.sharedHosts.has(host)) {
    const match = requestTarget.pathname.match(/^\/g\/([A-Za-z0-9_-]{1,64})(?:\/|$)/);
    if (!match) return { error: 'shared-path' };
    const gateway = registry.byId.get(match[1]);
    if (!gateway) return { error: 'unknown-gateway' };
    const prefix = `/g/${match[1]}`;
    const suffix = requestTarget.pathname.slice(prefix.length);
    return {
      gateway,
      target: `${suffix || '/'}${requestTarget.search}`,
      shared: true,
    };
  }

  if (registry.legacy) {
    const only = registry.byId.values().next().value;
    return { gateway: only, target, shared: false };
  }
  return { error: 'unknown-host' };
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
