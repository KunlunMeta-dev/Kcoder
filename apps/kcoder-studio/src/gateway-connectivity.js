/** HTTP stays local by default; public clients use P2P or the Relay ingress. */
export function gatewayListenHost(env = process.env) {
  return env.KCODER_STUDIO_HOST || '127.0.0.1';
}

/** Use the deployment's Relay hostname, never a bundled third-party STUN service. */
export function gatewayStunUrl(publicAccessUrl, port = 8452) {
  if (!publicAccessUrl) return '';
  const url = new URL(publicAccessUrl);
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1024 || number > 65535) throw new Error('Invalid Gateway STUN port');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid Gateway public URL for STUN discovery');
  }
  return `stun:${url.hostname}:${number}`;
}

export function gatewayPeerOptions(env = process.env, publicAccessUrl) {
  const setting = env.KCODER_STUDIO_P2P;
  if (setting !== undefined && !['0', '1'].includes(setting)) throw new Error('KCODER_STUDIO_P2P must be 0 or 1');
  return {
    enabled: setting !== '0',
    stunUrls: env.KCODER_STUDIO_P2P_STUN_URLS ?? gatewayStunUrl(publicAccessUrl),
  };
}
