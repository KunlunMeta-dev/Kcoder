import { isAbsolute } from 'node:path';
import { gatewayStunUrl } from './gateway-connectivity.js';

// Preserve the explicitly configured built-in model environment in the owned
// Gateway process, without passing Relay or operator credentials to Metro/SSH.
export function mobilePreviewModelEnvironment(env) {
  return Object.fromEntries(['KUNLUNMETA_BASE_API_KEY', 'KUNLUNMETA_BASE_URL', 'KUNLUNMETA_BASE_MODEL']
    .filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
}

/** Resolve preview networking from the same private environment as the deployed Relay. */
export function resolveMobilePreviewConfig(env, options) {
  const publicUrl = new URL(env.KCODER_RELAY_PUBLIC_URL);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search ||
      publicUrl.hash || publicUrl.pathname !== '/') throw new Error('Preview requires a canonical HTTPS Relay root');
  if (!/^\/g\/[A-Za-z0-9_-]{1,64}$/.test(options.prefix)) throw new Error('Invalid preview Gateway prefix');
  for (const key of ['gatewayPort', 'proxyPort', 'remotePort']) {
    if (!Number.isInteger(options[key]) || options[key] < 1024 || options[key] > 65535) throw new Error('Invalid preview port');
  }
  if (new Set([options.gatewayPort, options.proxyPort, options.remotePort]).size !== 3) throw new Error('Preview ports must be distinct');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(env.KCODER_RELAY_SSH_HOSTNAME || '')) throw new Error('Invalid Relay SSH hostname');
  const sshUser = env.KCODER_RELAY_SSH_USER || 'root';
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(sshUser)) throw new Error('Invalid Relay SSH user');
  const sshPort = Number(env.KCODER_RELAY_SSH_PORT || 22);
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('Invalid Relay SSH port');
  for (const key of ['KCODER_RELAY_CONFIG_DIR', 'KCODER_RELAY_SERVERS_FILE', 'KCODER_RELAY_KCODER_BIN']) {
    if (!isAbsolute(env[key] || '')) throw new Error(`Preview requires an absolute ${key}`);
  }
  return {
    ...options, publicOrigin: publicUrl.origin, publicAuthority: publicUrl.host,
    publicBaseUrl: publicUrl.origin + options.prefix,
    localOrigin: `http://127.0.0.1:${options.proxyPort}`,
    sshHostname: env.KCODER_RELAY_SSH_HOSTNAME, sshUser, sshPort,
    sshIdentity: env.KCODER_RELAY_SSH_IDENTITY || '~/.ssh/id_ed25519',
    stunUrls: env.KCODER_STUDIO_P2P_STUN_URLS ?? gatewayStunUrl(publicUrl, env.KCODER_RELAY_STUN_PORT || 8452),
  };
}
