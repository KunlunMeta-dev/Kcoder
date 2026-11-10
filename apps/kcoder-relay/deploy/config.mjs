import { isGatewayOriginLabel, isolatedGatewayUrl } from '../src/gateway-origin.mjs';
const STUN_PORT = 8452;
const REGISTRATION_STORE_FILE = '/var/lib/kcoder-relay/registered-gateways.json';
const STUN_UNIT_NAME = 'kcoder-stun.service';
const STUN_UNIT_PATH = '/etc/systemd/system/kcoder-stun.service';
const STUN_CONFIG_PATH = '/etc/coturn/kcoder-stun.conf';
const STUN_OWNER_RECEIPT_PATH = '/var/lib/kcoder-relay-stun/owner.json';
const STUN_LIFECYCLE_ACTIONS = Object.freeze(['install', 'upgrade', 'status', 'cleanup']);

export function relayDeploymentScpOptions() {
  return ['-p', '-q', '-r'];
}

export function resolveRelayRouteMode({ registryMode = false, routeMode } = {}) {
  const resolved = routeMode ?? (registryMode ? 'path' : 'legacy');
  if (!['path', 'legacy'].includes(resolved)) throw new Error(`Unsupported relay route mode: ${resolved}`);
  if (registryMode && resolved !== 'path') throw new Error('Relay registry mode requires path routing');
  return resolved;
}

function positivePort(value, label) {
  const validInput = (typeof value === 'number' && Number.isInteger(value))
    || (typeof value === 'string' && /^\d{1,5}$/.test(value));
  const port = validInput ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${label}`);
  return port;
}

function unprivilegedPort(value, label) {
  const port = positivePort(value, label);
  if (port < 1024) throw new Error(`${label} must be between 1024 and 65535`);
  return port;
}

function validDnsDomain(value) {
  return typeof value === 'string'
    && value.length <= 253
    && value.split('.').length >= 2
    && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
    && value.split('.').every((label) => (
      label.length >= 1
      && label.length <= 63
      && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)
    ));
}

function validateDomain(value, label = 'KCODER_RELAY_DOMAIN') {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f/:@?#]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const normalized = value.toLowerCase();
  if (!validDnsDomain(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
}

function parsePublicAuthority(value) {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f/@?#]/.test(value)) {
    throw new Error('Invalid Relay sharedHosts authority');
  }
  const match = value.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) throw new Error('Invalid Relay sharedHosts authority');
  const parsedDomain = validateDomain(match[1], 'Relay sharedHosts hostname');
  const parsedPort = match[2] === undefined ? 443 : positivePort(match[2], 'Relay sharedHosts port');
  return { domain: parsedDomain, publicPort: parsedPort };
}

function parseCanonicalPublicSite({ publicUrl, domain, publicPort, sharedHosts } = {}) {
  let inputUrl = publicUrl;
  if (inputUrl === undefined) {
    let selectedDomain;
    let selectedPort;
    if (domain === undefined) {
      if (!Array.isArray(sharedHosts) || sharedHosts.length !== 1) {
        throw new Error('Configure one canonical Relay public URL or sharedHosts authority');
      }
      ({ domain: selectedDomain, publicPort: selectedPort } = parsePublicAuthority(sharedHosts[0]));
    } else {
      selectedDomain = validateDomain(domain);
      if (publicPort !== undefined) {
        selectedPort = positivePort(publicPort, 'KCODER_RELAY_PUBLIC_PORT');
      } else if (Array.isArray(sharedHosts) && sharedHosts.length === 1) {
        const sharedSite = parsePublicAuthority(sharedHosts[0]);
        if (sharedSite.domain !== selectedDomain) throw new Error('KCODER_RELAY_DOMAIN must match Relay sharedHosts');
        selectedPort = sharedSite.publicPort;
      } else {
        selectedPort = 443;
      }
    }
    if (publicPort !== undefined && positivePort(publicPort, 'KCODER_RELAY_PUBLIC_PORT') !== selectedPort) {
      throw new Error('KCODER_RELAY_PUBLIC_PORT must match Relay sharedHosts');
    }
    inputUrl = selectedPort === 443
      ? `https://${selectedDomain}`
      : `https://${selectedDomain}:${selectedPort}`;
  }
  if (typeof inputUrl !== 'string' || !inputUrl || /[\s\u0000-\u001f\u007f]/.test(inputUrl) || /[?#]/.test(inputUrl)) {
    throw new Error('Invalid KCODER_RELAY_PUBLIC_URL');
  }

  let url;
  try { url = new URL(inputUrl); }
  catch { throw new Error('Invalid KCODER_RELAY_PUBLIC_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '' && url.pathname !== '/')) {
    throw new Error('KCODER_RELAY_PUBLIC_URL must be a root HTTPS URL without credentials, path, query, or fragment');
  }

  const canonicalDomain = validateDomain(url.hostname, 'KCODER_RELAY_PUBLIC_URL hostname');
  const canonicalPort = positivePort(url.port || 443, 'KCODER_RELAY_PUBLIC_URL port');
  if (domain !== undefined && validateDomain(domain) !== canonicalDomain) {
    throw new Error('KCODER_RELAY_DOMAIN must match KCODER_RELAY_PUBLIC_URL');
  }
  if (publicPort !== undefined && positivePort(publicPort, 'KCODER_RELAY_PUBLIC_PORT') !== canonicalPort) {
    throw new Error('KCODER_RELAY_PUBLIC_PORT must match KCODER_RELAY_PUBLIC_URL');
  }

  const publicAuthority = canonicalPort === 443 ? canonicalDomain : `${canonicalDomain}:${canonicalPort}`;
  const canonicalPublicUrl = canonicalPort === 443
    ? `https://${canonicalDomain}`
    : `https://${canonicalDomain}:${canonicalPort}`;
  return { domain: canonicalDomain, publicPort: canonicalPort, publicAuthority, canonicalPublicUrl };
}

function validatePublicUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Invalid KCODER_RELAY_PUBLIC_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('KCODER_RELAY_PUBLIC_URL must be HTTPS without credentials, query, or fragment');
  }
  return url;
}

/** Build the deployment files without I/O so the single public site can be dry-run tested. */
export function createRelayDeploymentConfig({
  relayConfig,
  publicUrl,
  domain,
  publicPort,
  controlPort = 18452,
  proxyPort = 18451,
  stunPort = STUN_PORT,
} = {}) {
  if (!relayConfig || !Array.isArray(relayConfig.gateways)) {
    throw new Error('Relay configuration must contain a Gateway list');
  }
  const publicSite = parseCanonicalPublicSite({ publicUrl, domain, publicPort, sharedHosts: relayConfig.sharedHosts });
  ({ domain, publicPort } = publicSite);
  controlPort = positivePort(controlPort, 'KCODER_RELAY_CONTROL_PORT');
  proxyPort = positivePort(proxyPort, 'KCODER_RELAY_PROXY_PORT');
  stunPort = unprivilegedPort(stunPort, 'KCODER_RELAY_STUN_PORT');
  if (new Set([publicPort, controlPort, proxyPort, stunPort]).size !== 4) {
    throw new Error('Relay public, control, proxy, and STUN ports must be distinct');
  }

  const registrationKey = relayConfig.registrationKey || '';
  const adminPasswordHash = relayConfig.adminPasswordHash;
  const adminUsername = relayConfig.adminUsername || 'admin';
  if (adminPasswordHash && !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(adminPasswordHash)) throw Error('Invalid Relay administrator password hash');
  if (relayConfig.requireAccount !== undefined && (typeof relayConfig.requireAccount !== 'boolean' ||
      (relayConfig.requireAccount && !adminPasswordHash))) throw Error('Relay account enrollment requires an enabled administrator panel');
  if (!/^[A-Za-z0-9_.@-]{1,100}$/.test(adminUsername)) throw Error('Invalid Relay administrator username');
  const registrationStoreEnabled = Boolean(relayConfig.registrationStoreFile || registrationKey || adminPasswordHash);
  const registrationStoreFile = registrationStoreEnabled ? REGISTRATION_STORE_FILE : '';
  if (registrationKey && !/^[A-Za-z0-9._~-]{32,512}$/.test(registrationKey)) {
    throw new Error('Invalid relay registration key');
  }
  if (relayConfig.gateways.length === 0 && !registrationStoreFile) {
    throw new Error('An empty Gateway list requires the persistent registration store');
  }
  if (relayConfig.legacy === true && registrationStoreFile) {
    throw new Error('Relay registration requires path-routed registry mode');
  }

  const { publicAuthority, canonicalPublicUrl } = publicSite;
  const sharedHosts = relayConfig.sharedHosts;
  if (!Array.isArray(sharedHosts) || sharedHosts.length !== 1) {
    throw new Error(`Relay sharedHosts must contain only ${publicAuthority}`);
  }
  const sharedSite = parsePublicAuthority(sharedHosts[0]);
  if (sharedSite.domain !== domain || sharedSite.publicPort !== publicPort) {
    throw new Error(`Relay sharedHosts must contain only ${publicAuthority}`);
  }

  const relaySecrets = new Set();
  const gatewaySecrets = new Set();
  const gateways = relayConfig.gateways.map(({ id, secret, gatewaySecret, maxConnections, maxBytesPerWindow, trafficWindowMs }) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid Gateway ID');
    if (typeof secret !== 'string' || secret.length < 32 || /[\u0000-\u001f\u007f]/.test(secret)) throw new Error(`Gateway ${id} requires a 32+ character relay secret`);
    if (typeof gatewaySecret !== 'string' || gatewaySecret.length < 32 || /[\u0000-\u001f\u007f]/.test(gatewaySecret)) throw new Error(`Gateway ${id} requires a 32+ character pairing token`);
    if (secret === gatewaySecret) throw new Error(`Gateway ${id} relay secret and pairing token must be distinct`);
    if (relaySecrets.has(secret) || gatewaySecrets.has(gatewaySecret) || relaySecrets.has(gatewaySecret) || gatewaySecrets.has(secret)) {
      throw new Error('Different Gateways must use distinct relay secrets and pairing tokens');
    }
    relaySecrets.add(secret);
    gatewaySecrets.add(gatewaySecret);
    for (const [value, label] of [[maxConnections, 'maxConnections'], [maxBytesPerWindow, 'maxBytesPerWindow'], [trafficWindowMs, 'trafficWindowMs']]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid Gateway ${label} for ${id}`);
    }
    return { id, secret, gatewaySecret, maxConnections, maxBytesPerWindow, trafficWindowMs };
  });

  const registrationEnv = registrationStoreFile
    ? `KCODER_RELAY_REGISTRATION_STORE_FILE=${registrationStoreFile}\n${registrationKey ? `KCODER_RELAY_REGISTRATION_KEY=${registrationKey}\n` : ''}`
    : '';
  const adminEnv = adminPasswordHash ? `KCODER_RELAY_ADMIN_USERNAME=${adminUsername}\nKCODER_RELAY_ADMIN_PASSWORD_HASH=${adminPasswordHash}\n` : '';
  const accountEnv = relayConfig.requireAccount === undefined ? '' : `KCODER_RELAY_REQUIRE_ACCOUNT=${relayConfig.requireAccount ? 1 : 0}\n`;
  const commonCloudEnv = `KCODER_RELAY_PUBLIC_URL=${canonicalPublicUrl}\nKCODER_RELAY_CONTROL_PORT=${controlPort}\nKCODER_RELAY_PROXY_PORT=${proxyPort}\n${registrationEnv}${adminEnv}${accountEnv}`;
  const caddyEnv = [
    `KCODER_RELAY_DOMAIN=${domain}`,
    `KCODER_RELAY_PUBLIC_PORT=${publicPort}`,
    `KCODER_RELAY_CONTROL_PORT=${controlPort}`,
    `KCODER_RELAY_PROXY_PORT=${proxyPort}`,
    '',
  ].join('\n');
  const stun = {
    enabled: true,
    mode: 'stun-only',
    publicUrl: `stun:${domain}:${stunPort}`,
    protocol: 'udp',
    listenAddress: '0.0.0.0',
    port: stunPort,
    unitName: STUN_UNIT_NAME,
    unitPath: STUN_UNIT_PATH,
    configPath: STUN_CONFIG_PATH,
    ownerReceiptPath: STUN_OWNER_RECEIPT_PATH,
    lifecycleActions: [...STUN_LIFECYCLE_ACTIONS],
  };

  if (relayConfig.legacy === true) {
    if (gateways.length !== 1) throw new Error('Legacy deployment supports exactly one Gateway');
    const [gateway] = gateways;
    return {
      publicAuthority,
      publicUrl: canonicalPublicUrl,
      canonicalPublicUrl,
      domain,
      publicPort,
      stun,
      gateways: gateways.map(({ id }) => id),
      registrationStoreFile: null,
      registrationKeyConfigured: false,
      registryJson: null,
      cloudEnv: `${commonCloudEnv}KCODER_RELAY_DEVICE_ID=${gateway.id}\nKCODER_RELAY_SECRET=${gateway.secret}\n`,
      caddyEnv,
    };
  }

  const registryJson = gateways.length > 0
    ? `${JSON.stringify({ sharedHosts: [publicAuthority], gateways }, null, 2)}\n`
    : null;
  return {
    publicAuthority,
    publicUrl: canonicalPublicUrl,
    canonicalPublicUrl,
    domain,
    publicPort,
    stun,
    gateways: gateways.map(({ id }) => id),
    registrationStoreFile: registrationStoreFile || null,
    registrationKeyConfigured: Boolean(registrationKey),
    registryJson,
    cloudEnv: `${commonCloudEnv}${registryJson ? 'KCODER_RELAY_REGISTRY_FILE=/etc/kcoder-relay-registry.json\n' : ''}`,
    caddyEnv,
  };
}

/** Return safe deployment metadata; never include environment-file contents or credential values. */
export function createRelayDeploymentDryRunSummary({ target, deployment } = {}) {
  if (typeof target !== 'string' || !deployment) throw new Error('Relay deployment summary requires a target and plan');
  return {
    mode: 'DRY_RUN',
    target,
    publicSite: deployment.publicUrl,
    gateways: deployment.gateways,
    routing: {
      gatewayPrefix: '/g/<id>',
      controlPrefix: '/_relay/*',
      // Each Gateway is served from its own origin; DNS needs one wildcard record.
      gatewayOrigin: `https://g-<sha256(id)[0:40]>.${deployment.publicAuthority}`,
      gatewayTls: 'Caddy on-demand TLS; loopback ask allows only active registry Gateway names',
      requiredDns: `*.${deployment.domain}`,
    },
    staticRegistry: deployment.registryJson
      ? '/etc/kcoder-relay-registry.json (owner kcoder-relay, mode 0600)'
      : 'not generated',
    registration: {
      enabled: Boolean(deployment.registrationKeyConfigured),
      storeFile: deployment.registrationStoreFile || null,
    },
    stun: deployment.stun,
    cloudSecretFiles: 'staged mode 0600 and removed after install',
    deploymentPerformed: false,
  };
}

/**
 * Path-routed Gateways live on their own isolated origin and keep the /g/<id>
 * mount; the Relay health/control routes stay on the shared public root.
 */
export function createRelayUrls({ publicUrl, gatewayId, routeMode, registryMode = false } = {}) {
  const input = validatePublicUrl(publicUrl);
  const routeMatch = input.pathname.match(/^\/g\/([a-zA-Z0-9_-]{1,64})\/?$/);
  if (input.pathname !== '/' && !routeMatch) throw new Error('Public URL path must be empty, /, or /g/<id>');
  if (routeMatch && gatewayId && routeMatch[1] !== gatewayId) throw new Error('Public URL Gateway ID conflicts with KCODER_RELAY_GATEWAY_ID');
  const mode = resolveRelayRouteMode({ registryMode, routeMode });
  const selectedId = routeMatch?.[1] || (mode === 'path' ? gatewayId : undefined);
  if (selectedId && !/^[a-zA-Z0-9_-]{1,64}$/.test(selectedId)) throw new Error('Invalid Gateway ID');
  if (mode === 'path' && !selectedId) throw new Error('Path routing requires a Gateway ID');

  const gateway = mode === 'path' ? isolatedGatewayUrl(input, selectedId) : new URL(input);
  if (mode !== 'path') gateway.pathname = selectedId ? `/g/${selectedId}/` : '/';
  const root = new URL(input);
  root.pathname = '/';
  if (isGatewayOriginLabel(root.hostname.split('.', 1)[0])) {
    // A configured Gateway origin is never the control/health root.
    root.hostname = root.hostname.slice(root.hostname.indexOf('.') + 1);
  }
  return {
    publicRoot: root,
    gatewayBase: gateway,
    gatewayEndpoint(path) {
      if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Gateway endpoint path must start with /');
      return new URL(`${gateway.pathname.replace(/\/$/, '')}${path}`, gateway.origin);
    },
  };
}
