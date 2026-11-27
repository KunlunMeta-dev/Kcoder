import { isIP } from 'node:net';

function parseAuthority(authority) {
  if (typeof authority !== 'string' || !authority || /[\s\\/?#@]/.test(authority)) return null;
  try {
    const parsed = new URL(`http://${authority}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

function loopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'));
}

export function createGatewayAdmission({ authRequired, publicOrigins, listeningPort, trustedTunnelAuthorities = new Set(), retiredAuthorities = new Set() }) {
  const publicAuthority = authority => [...publicOrigins].some(value => new URL(value).host === authority);

  function isAllowedAuthority(authority) {
    const parsed = parseAuthority(authority);
    if (!parsed) return false;
    if (retiredAuthorities.has(authority)) return false;
    if (trustedTunnelAuthorities.has(authority)) return true;
    if (publicAuthority(authority)) return true;
    const directPort = parsed.port ? Number(parsed.port) : 80;
    // An unauthenticated listener must prove the host identity as well as the port.
    // Explicit public origins authorize the exact proxy authority, never unrelated hosts sharing its port.
    if (!authRequired) return loopbackHostname(parsed.hostname) && directPort === listeningPort();
    return directPort === listeningPort() || Boolean(parsed.port && [...publicOrigins].some(value => new URL(value).port === parsed.port));
  }

  function isAllowedOrigin(origin, authority) {
    if (typeof origin !== 'string' || !authority) return false;
    try {
      const parsed = new URL(origin);
      if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin || parsed.host !== authority) return false;
      if (retiredAuthorities.has(authority)) return false;
      if (publicAuthority(authority)) return publicOrigins.has(parsed.origin);
      return isAllowedAuthority(authority);
    } catch {
      return false;
    }
  }

  return { isAllowedAuthority, isAllowedOrigin, trustedTunnelAuthorities };
}
