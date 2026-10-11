const PUBLIC_DOMAIN = 'hyf2333.top';
const PUBLIC_PORT = 8451;
const REGISTRATION_STORE_FILE = '/var/lib/kcoder-relay/registered-gateways.json';

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
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${label}`);
  return port;
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
  domain = PUBLIC_DOMAIN,
  publicPort = PUBLIC_PORT,
  controlPort = 18452,
  proxyPort = 18451,
} = {}) {
  if (domain !== PUBLIC_DOMAIN) throw new Error(`This deployment is fixed to ${PUBLIC_DOMAIN}`);
  publicPort = positivePort(publicPort, 'KCODER_RELAY_PUBLIC_PORT');
  if (publicPort !== PUBLIC_PORT) throw new Error(`This deployment is fixed to port ${PUBLIC_PORT}`);
  controlPort = positivePort(controlPort, 'KCODER_RELAY_CONTROL_PORT');
  proxyPort = positivePort(proxyPort, 'KCODER_RELAY_PROXY_PORT');
  if (!relayConfig || !Array.isArray(relayConfig.gateways)) {
    throw new Error('Relay configuration must contain a Gateway list');
  }

  const registrationKey = relayConfig.registrationKey || '';
  const registrationStoreEnabled = Boolean(relayConfig.registrationStoreFile || registrationKey);
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

  const publicAuthority = `${domain}:${publicPort}`;
  const sharedHosts = relayConfig.sharedHosts;
  if (!Array.isArray(sharedHosts) || sharedHosts.length !== 1 || sharedHosts[0].toLowerCase() !== publicAuthority) {
    throw new Error(`Relay sharedHosts must contain only ${publicAuthority}`);
  }

  const relaySecrets = new Set();
  const pairingTokens = new Set();
  const gateways = relayConfig.gateways.map(({ id, secret, pairingToken, maxConnections, maxBytesPerWindow, trafficWindowMs }) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid Gateway ID');
    if (typeof secret !== 'string' || secret.length < 32 || /[\u0000-\u001f\u007f]/.test(secret)) throw new Error(`Gateway ${id} requires a 32+ character relay secret`);
    if (typeof pairingToken !== 'string' || pairingToken.length < 32 || /[\u0000-\u001f\u007f]/.test(pairingToken)) throw new Error(`Gateway ${id} requires a 32+ character pairing token`);
    if (secret === pairingToken) throw new Error(`Gateway ${id} relay secret and pairing token must be distinct`);
    if (relaySecrets.has(secret) || pairingTokens.has(pairingToken) || relaySecrets.has(pairingToken) || pairingTokens.has(secret)) {
      throw new Error('Different Gateways must use distinct relay secrets and pairing tokens');
    }
    relaySecrets.add(secret);
    pairingTokens.add(pairingToken);
    for (const [value, label] of [[maxConnections, 'maxConnections'], [maxBytesPerWindow, 'maxBytesPerWindow'], [trafficWindowMs, 'trafficWindowMs']]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid Gateway ${label} for ${id}`);
    }
    return { id, secret, pairingToken, maxConnections, maxBytesPerWindow, trafficWindowMs };
  });

  const registrationEnv = registrationStoreFile
    ? `KCODER_RELAY_REGISTRATION_STORE_FILE=${registrationStoreFile}\n${registrationKey ? `KCODER_RELAY_REGISTRATION_KEY=${registrationKey}\n` : ''}`
    : '';
  const commonCloudEnv = `KCODER_RELAY_CONTROL_PORT=${controlPort}\nKCODER_RELAY_PROXY_PORT=${proxyPort}\n${registrationEnv}`;
  const caddyEnv = [
    `KCODER_RELAY_DOMAIN=${domain}`,
    `KCODER_RELAY_PUBLIC_PORT=${publicPort}`,
    `KCODER_RELAY_CONTROL_PORT=${controlPort}`,
    `KCODER_RELAY_PROXY_PORT=${proxyPort}`,
    '',
  ].join('\n');

  if (relayConfig.legacy === true) {
    if (gateways.length !== 1) throw new Error('Legacy deployment supports exactly one Gateway');
    const [gateway] = gateways;
    return {
      publicAuthority,
      publicUrl: `https://${publicAuthority}`,
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
    publicUrl: `https://${publicAuthority}`,
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
    routing: { gatewayPrefix: '/g/<id>', controlPrefix: '/_relay/*' },
    staticRegistry: deployment.registryJson
      ? '/etc/kcoder-relay-registry.json (owner kcoder-relay, mode 0600)'
      : 'not generated',
    registration: {
      enabled: Boolean(deployment.registrationKeyConfigured),
      storeFile: deployment.registrationStoreFile || null,
    },
    cloudSecretFiles: 'staged mode 0600 and removed after install',
    deploymentPerformed: false,
  };
}

/** Keep mobile requests under /g/<id>, while the relay health route stays at the public root. */
export function createRelayUrls({ publicUrl, gatewayId, routeMode, registryMode = false } = {}) {
  const input = validatePublicUrl(publicUrl);
  const routeMatch = input.pathname.match(/^\/g\/([a-zA-Z0-9_-]{1,64})\/?$/);
  if (input.pathname !== '/' && !routeMatch) throw new Error('Public URL path must be empty, /, or /g/<id>');
  if (routeMatch && gatewayId && routeMatch[1] !== gatewayId) throw new Error('Public URL Gateway ID conflicts with KCODER_RELAY_GATEWAY_ID');
  const mode = resolveRelayRouteMode({ registryMode, routeMode });
  const selectedId = routeMatch?.[1] || (mode === 'path' ? gatewayId : undefined);
  if (selectedId && !/^[a-zA-Z0-9_-]{1,64}$/.test(selectedId)) throw new Error('Invalid Gateway ID');
  if (mode === 'path' && !selectedId) throw new Error('Path routing requires a Gateway ID');

  const gateway = new URL(input);
  gateway.pathname = selectedId ? `/g/${selectedId}/` : '/';
  const root = new URL(input);
  root.pathname = '/';
  return {
    publicRoot: root,
    gatewayBase: gateway,
    gatewayEndpoint(path) {
      if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Gateway endpoint path must start with /');
      return new URL(`${gateway.pathname.replace(/\/$/, '')}${path}`, gateway.origin);
    },
  };
}
