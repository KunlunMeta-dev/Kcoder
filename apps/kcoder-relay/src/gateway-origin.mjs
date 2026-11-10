import { createHash } from 'node:crypto';

const GATEWAY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ORIGIN_LABEL = /^g-[a-f0-9]{40}$/;
const DNS_LABEL = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;

/** A DNS-safe, stable label; routing still verifies the original exact Gateway ID. */
export function gatewayOriginLabel(id) {
  if (typeof id !== 'string' || !GATEWAY_ID.test(id)) throw new Error('Invalid Gateway ID');
  return `g-${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}

export function isGatewayOriginLabel(value) {
  return typeof value === 'string' && ORIGIN_LABEL.test(value);
}

/**
 * Canonical public Relay authority: lowercase DNS name, default HTTPS port 443
 * omitted, explicit custom ports kept. IP literals cannot carry a Gateway label.
 */
export function canonicalRelayAuthority(authority) {
  if (typeof authority !== 'string' || /[\s\u0000-\u001f\u007f\/\\?#@\[\]]/.test(authority)) {
    throw new Error('Invalid Relay public authority');
  }
  const match = authority.toLowerCase().match(/^([a-z\d.-]+)(?::(\d{1,5}))?$/);
  const labels = match?.[1].split('.') ?? [];
  if (!match || labels.length < 2 || match[1].length > 253 || !labels.every(label => DNS_LABEL.test(label))
      || /^\d+$/.test(labels.at(-1))) {
    throw new Error('Invalid Relay public authority');
  }
  const port = match[2] === undefined ? 443 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (match[2] !== undefined && String(port) !== match[2])) {
    throw new Error('Invalid Relay public authority');
  }
  return port === 443 ? match[1] : `${match[1]}:${port}`;
}

/** Derive the exact per-Gateway hostname under one shared Relay hostname. */
export function isolatedGatewayHostname(hostname, id) {
  const base = canonicalRelayAuthority(hostname);
  if (base.includes(':')) throw new Error('Isolated Gateway hostnames do not include a port');
  if (isGatewayOriginLabel(base.split('.', 1)[0])) throw new Error('Relay public host is already a Gateway origin');
  const result = `${gatewayOriginLabel(id)}.${base}`;
  if (result.length > 253) throw new Error('Relay hostname is too long for an isolated Gateway origin');
  return result;
}

export function isolatedGatewayAuthority(authority, id) {
  const base = canonicalRelayAuthority(authority);
  const separator = base.indexOf(':');
  const hostname = separator < 0 ? base : base.slice(0, separator);
  const port = separator < 0 ? '' : base.slice(separator);
  return `${isolatedGatewayHostname(hostname, id)}${port}`;
}

/**
 * Return the Gateway's isolated HTTPS URL with its stable /g/<id>/ mount.
 * A URL already on that Gateway's origin is accepted; any other Gateway's
 * origin label is rejected so host and path identities cannot be mixed.
 */
export function isolatedGatewayUrl(publicUrl, id) {
  const base = new URL(publicUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Invalid Relay public URL');
  const label = gatewayOriginLabel(id);
  const authority = canonicalRelayAuthority(base.host);
  const [first] = authority.split('.', 1);
  let isolated;
  if (first === label) isolated = authority;
  else if (isGatewayOriginLabel(first)) throw new Error('Relay public URL belongs to a different Gateway origin');
  else isolated = isolatedGatewayAuthority(authority, id);
  return new URL(`https://${isolated}/g/${id}/`);
}
