import { prepareGatewayRelay, gatewayRelayExternalAccessState, selectedRelayEnvironment } from './gateway-relay-instance.js';

export function gatewayPublicOriginSet(value) {
  return new Set((value || '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const url = new URL(item);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw Error(`Invalid KCODER_STUDIO_PUBLIC_ORIGINS entry: ${item}`);
    return url.origin;
  }));
}

export function replacePublicOrigin(origins, retired, previous, next) {
  if (previous) {
    origins.delete(previous.origin);
    retired.add(previous.host);
  }
  if (next) {
    origins.add(next.origin);
    retired.delete(next.host);
  }
}

/** Owns only the public transport. The listening server and its sessions outlive it. */
export function createLiveGatewayRelay({ initial, environment, initialStatus, options, localBase, present }) {
  let current = initial;
  let credentials = environment;
  let status = 'offline';
  let stopped = false;
  const currentStatus = () => initial && current === initial ? initialStatus() : status;

  function observe(owner, event) {
    if (current !== owner) return;
    if (event.event === 'control_open') status = 'online';
    else if (event.event === 'control_close') status = status === 'denied' ? 'denied' : 'offline';
    else if (event.event === 'control_error' && [401, 403].includes(event.handshakeStatus)) status = 'denied';
  }

  return {
    get environment() { return credentials; },
    get status() { return currentStatus(); },
    async apply() {
      const signal = AbortSignal.timeout(20_000);
      let candidate;
      const env = selectedRelayEnvironment(options.env);
      env.KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE = options.env.KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE;
      candidate = await prepareGatewayRelay({ ...options, env, signal, onDiagnostic: event => observe(candidate, event) });
      if (!candidate || stopped) throw Error('Gateway Relay registration is unavailable');
      if (candidate.publicBaseUrl === credentials?.KCODER_STUDIO_PUBLIC_ACCESS_URL && currentStatus() === 'online') return;
      const previous = current, previousCredentials = credentials, previousStatus = status;
      try {
        await present(candidate.gatewayEnvironment);
        if (stopped) throw Error('Gateway is stopping');
        current = candidate;
        credentials = candidate.gatewayEnvironment;
        status = 'offline';
        let abort;
        try {
          await new Promise((resolve, reject) => {
            abort = () => reject(signal.reason);
            if (signal.aborted) { abort(); return; }
            signal.addEventListener('abort', abort, { once: true });
            candidate.connect(localBase(), { onOnline: resolve }).catch(reject);
          });
        } finally { signal.removeEventListener('abort', abort); }
        if (stopped) throw Error('Gateway is stopping');
        status = 'online';
        previous?.close();
      } catch (error) {
        candidate.close();
        if (!stopped) {
          current = previous;
          credentials = previousCredentials;
          status = previousStatus;
          await present(previousCredentials);
        }
        throw error;
      }
    },
    revoke() { return gatewayRelayExternalAccessState({ ...options, env: credentials, revoke: true }); },
    async clear() {
      current?.close();
      current = null;
      credentials = {};
      status = 'offline';
      await present(credentials);
    },
    close() { stopped = true; current?.close(); },
  };
}
