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

export function createGatewayAdmission({ authRequired, publicOrigins, listeningPort, trustedTunnelAuthorities = new Set() }) {
  const authorities = new Set([...publicOrigins].map(value => new URL(value).host));
  const proxyPorts = new Set([...publicOrigins].map(value => new URL(value).port).filter(Boolean));

  function isAllowedAuthority(authority) {
    const parsed = parseAuthority(authority);
    if (!parsed) return false;
    if (trustedTunnelAuthorities.has(authority)) return true;
    if (authorities.has(authority)) return true;
    const directPort = parsed.port ? Number(parsed.port) : 80;
    // An unauthenticated listener must prove the host identity as well as the port.
    // Explicit public origins authorize the exact proxy authority, never unrelated hosts sharing its port.
    if (!authRequired) return loopbackHostname(parsed.hostname) && directPort === listeningPort();
    return directPort === listeningPort() || proxyPorts.has(parsed.port);
  }

  function isAllowedOrigin(origin, authority) {
    if (typeof origin !== 'string' || !authority) return false;
    try {
      const parsed = new URL(origin);
      if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin || parsed.host !== authority) return false;
      if (authorities.has(authority)) return publicOrigins.has(parsed.origin);
      return isAllowedAuthority(authority);
    } catch {
      return false;
    }
  }

  return { isAllowedAuthority, isAllowedOrigin, trustedTunnelAuthorities };
}
