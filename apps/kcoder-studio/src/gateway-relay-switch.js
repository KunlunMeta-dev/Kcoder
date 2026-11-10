import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { activateGatewayRelay, prepareGatewayRelay, readRelayConfiguration, writeRelayConfiguration,
  preserveRelayGatewaySecret, selectedRelayEnvironment, relayProfileState, relayProfileNeedsEnrollment } from './gateway-relay-instance.js';

const validId = id => typeof id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id);
const conflict = message => Object.assign(Error(message), { code: 'RELAY_CONFIG_CONFLICT' });

export async function verifyRelayMount(url, parentSignal, nonce, fetchImpl = fetch) {
  const timeout = AbortSignal.timeout(25000);
  const mount = new URL(url);
  if (!mount.pathname.endsWith('/')) mount.pathname += '/';
  const response = await fetchImpl(mount, { method: 'HEAD', redirect: 'manual',
    signal: parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout });
  await response.body?.cancel();
  if (response.status !== 204 || response.headers.get('x-kcoder-relay-verification') !== nonce)
    throw Error(`Relay mount verification failed with HTTP ${response.status}`);
}

/** Verify the newly enrolled control connection before publishing a startup selection. */
export async function verifyRelayProfile(relay, { publicBaseUrl, signal,
  checkOrigin = verifyRelayMount } = {}) {
  if (relay.publicBaseUrl === publicBaseUrl) return; // The running worker already owns this exact registration.
  const nonce = randomBytes(32).toString('base64url');
  const probe = createServer((request, response) => {
    if (request.method !== 'HEAD' || request.url !== '/') { response.writeHead(404); response.end(); return; }
    response.writeHead(204, { 'cache-control': 'no-store', 'x-kcoder-relay-verification': nonce });
    response.end();
  });
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') { await new Promise(resolve => probe.close(resolve)); throw Error('Relay verification probe could not bind'); }
  let online, fail;
  const ready = new Promise((resolve, reject) => { online = resolve; fail = reject; });
  const timer = setTimeout(() => fail(Error('Relay connection verification timed out')), 20000);
  const abort = () => fail(Error('Relay verification cancelled'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  try {
    await Promise.all([relay.connect(`http://127.0.0.1:${address.port}`, { onOnline: online }), ready]);
    await checkOrigin(relay.publicBaseUrl, signal, nonce);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    relay.close();
    probe.closeAllConnections?.();
    await new Promise(resolve => probe.close(resolve));
  }
}

/** One persistent configuration owns the selection; profile credentials remain separate. */
export function createGatewayRelaySwitch({ userDataDir, env = process.env, resourcesPath, loadRuntime,
  publicBaseUrl, verify = verifyRelayProfile, allowUntrackedOriginal = false } = {}) {
  const path = env.KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE || join(userDataDir, 'desktop-relay.json');
  const load = () => readRelayConfiguration(path);
  const save = async (config, expectedRevision) => {
    const next = { ...config, revision: expectedRevision + 1 };
    await writeRelayConfiguration(path, next, expectedRevision);
    return next;
  };
  async function prepare(profile) {
    return prepareGatewayRelay({ userDataDir, resourcesPath, loadRuntime,
      env: selectedRelayEnvironment(env),
      selection: profile,
    });
  }
  return {
    async switch(input, { allowUntrackedOriginal: allowUntrackedOriginalForSwitch, pendingOriginCorrection = false } = {}) {
      let config = await load();
      const revision = config?.revision ?? 0;
      if (!validId(input.requestId)) throw Error('Invalid Relay switch request');
      if (config?.selectedProfile === input.requestId) {
        const selected = await readRelayConfiguration(join(userDataDir, 'relay-profiles', input.requestId, 'desktop-relay.json'));
        if (input.relayUrl && new URL(input.relayUrl).origin !== selected?.url) throw conflict('Switch identity belongs to a different Relay');
        return;
      }
      if (input.expectedRevision !== revision) throw conflict('Relay settings changed; refresh first');
      if (config?.switchAttempt && config.switchAttempt.id !== input.requestId) throw conflict('A different Relay switch is pending');
      const invitationUrl = input.activationLink && !/^[A-Za-z0-9_-]{43}$/.test(input.activationLink)
        ? new URL(input.activationLink) : null;
      let origin = config?.switchAttempt?.url;
      if (input.relayUrl) {
        const url = new URL(input.relayUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Relay requires an HTTPS root URL');
        if (origin && origin !== url.origin) throw conflict('Pending switch belongs to a different Relay');
        origin = url.origin;
      }
      if (invitationUrl) {
        if (origin && origin !== invitationUrl.origin) throw conflict('Pending switch belongs to a different Relay');
        origin = invitationUrl.origin;
      }
      if (!origin && (input.accountCredentials || input.activationLink))
        origin = config?.url || env.KCODER_STUDIO_RELAY_ORIGIN || env.KCODER_STUDIO_RELAY_DEFAULT_URL || env.KCODER_RELAY_PUBLIC_URL;
      if (!origin) throw Error('Relay HTTPS address required');
      if (pendingOriginCorrection && !config?.switchAttempt && config?.url && new URL(config.url).origin === origin)
        throw conflict('Retry the existing Relay login with its original proof');
      if (!config?.switchAttempt) {
        const original = config?.disabled ? null : await relayProfileState({ userDataDir, profile: config?.selectedProfile ?? null, resourcesPath, loadRuntime,
          legacyUrl: config?.url || env.KCODER_STUDIO_RELAY_ORIGIN });
        const canProceedWithoutOriginal = allowUntrackedOriginalForSwitch ?? allowUntrackedOriginal;
        if ((!original && !canProceedWithoutOriginal && !config?.disabled) || (original && original.publicBaseUrl !== publicBaseUrl))
          throw conflict('Original Relay registration is unavailable or changed');
        // Preserve the original managed registration, not a newly minted replacement.
        if (original && !config?.selectedProfile && env.KCODER_STUDIO_RELAY_SECRET)
          await preserveRelayGatewaySecret(join(userDataDir, 'desktop-relay'), env.KCODER_STUDIO_RELAY_SECRET);
        config = await save({ ...config, url: config?.url || env.KCODER_STUDIO_RELAY_ORIGIN || origin,
          switchAttempt: { id: input.requestId, url: origin } }, revision);
      }
      const directory = join(userDataDir, 'relay-profiles', input.requestId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const candidate = await readRelayConfiguration(join(directory, 'desktop-relay.json'));
      if (candidate && candidate.url !== origin) throw conflict('Candidate identity belongs to a different Relay');
      const needsEnrollment = !candidate || await relayProfileNeedsEnrollment(directory);
      if (needsEnrollment) {
        if (!input.activationLink && !input.accountCredentials && !input.accountSessionToken) throw Error('Relay login required to finish this switch');
        let link = input.activationLink;
        if (link && !/^[A-Za-z0-9_-]{43}$/.test(link) && new URL(link).origin !== origin) throw Error('Activation link belongs to a different Relay');
        await activateGatewayRelay({ activationLink: link, accountCredentials: input.accountCredentials, accountSessionToken: input.accountSessionToken,
          relayUrl: origin, userDataDir: directory, resourcesPath, loadRuntime });
      }
      const relay = await prepareGatewayRelay({ userDataDir: directory, env: {}, resourcesPath, loadRuntime });
      try {
        // Re-enrollment has no live mount to protect. Apply opens the real control
        // connection, while Caddy can provision HTTPS on the first public visit.
        if (!config.disabled) await verify(relay, { publicBaseUrl });
      } finally { relay?.close(); }
      const current = await load();
      if (current?.revision !== config.revision || current?.switchAttempt?.id !== input.requestId) throw conflict('Relay selection changed during verification');
      const next = { ...current, selectedProfile: input.requestId };
      if (current.disabled) {
        delete next.disabled;
        delete next.previousProfile;
      } else if (current.selectedProfile !== undefined) next.previousProfile = current.selectedProfile;
      else {
        const original = await relayProfileState({ userDataDir, profile: null, resourcesPath, loadRuntime,
          legacyUrl: current.url || env.KCODER_STUDIO_RELAY_ORIGIN });
        const canProceedWithoutOriginal = allowUntrackedOriginalForSwitch ?? allowUntrackedOriginal;
        if (original || (canProceedWithoutOriginal && !pendingOriginCorrection)) next.previousProfile = null;
        else delete next.previousProfile;
      }
      delete next.switchAttempt;
      await save(next, current.revision);
    },
    async cancel(expectedRevision) {
      const config = await load();
      if (config?.revision !== expectedRevision) throw conflict('Relay settings changed; refresh first');
      if (!config.switchAttempt) return;
      const next = { ...config }; delete next.switchAttempt;
      await save(next, expectedRevision);
    },
    async rollback(expectedRevision) {
      const config = await load();
      if (config?.revision !== expectedRevision || config.previousProfile === undefined) throw conflict('Previous Relay selection is unavailable');
      const next = { ...config, selectedProfile: config.previousProfile, previousProfile: config.selectedProfile ?? null };
      delete next.switchAttempt;
      const relay = await prepare(config.previousProfile);
      try { await verify(relay, { publicBaseUrl }); } finally { relay?.close(); }
      await save(next, expectedRevision);
    },
  };
}
