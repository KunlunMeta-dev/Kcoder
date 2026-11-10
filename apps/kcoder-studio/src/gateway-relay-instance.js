import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gatewayRelaySecret } from './gateway-relay-auth.js';
import { gatewayStunUrl } from './gateway-connectivity.js';

async function privateText(path) {
  let before;
  try { before = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Gateway Relay private file is unavailable'); }
  const validate = stat => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096 ||
        (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())))
      throw new Error('Gateway Relay private file must be a private owner-owned regular file');
  };
  validate(before);
  let file;
  try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch { throw new Error('Gateway Relay private file cannot be opened'); }
  try {
    const stat = await file.stat();
    validate(stat);
    if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('Gateway Relay private file changed while opening');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error('Gateway Relay private file exceeds its size limit');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

async function configuration(path) {
  const text = await privateText(path);
  if (text === null) return null;
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error('Invalid Gateway Relay configuration'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['url', 'registrationKey', 'activationCode', 'accountLoginToken', 'revision', 'selectedProfile', 'previousProfile', 'switchAttempt', 'disabled'].includes(key)))
    throw new Error('Invalid Gateway Relay configuration');
  const profileId = id => id === null || (typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id));
  if ((value.disabled !== undefined && typeof value.disabled !== 'boolean') ||
      (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)) ||
      (value.selectedProfile !== undefined && !profileId(value.selectedProfile)) ||
      (value.previousProfile !== undefined && !profileId(value.previousProfile)) ||
      (value.switchAttempt !== undefined && (!value.switchAttempt || !profileId(value.switchAttempt.id) || value.switchAttempt.id === null ||
        typeof value.switchAttempt.url !== 'string' || Object.keys(value.switchAttempt).some(key => !['id', 'url'].includes(key)))))
    throw new Error('Invalid Gateway Relay selection');
  return value;
}

async function internalSecret(directory, existingSecret) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid())))
    throw new Error('Gateway Relay identity directory must be private and owner-owned');
  const path = join(directory, 'gateway-secret');
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (file) {
    try { await file.writeFile((existingSecret ? gatewayRelaySecret({ KCODER_STUDIO_RELAY_SECRET: existingSecret }) : randomBytes(32).toString('base64url')) + '\n'); await file.sync(); }
    finally { await file.close(); }
  }
  const secret = (await privateText(path))?.trim();
  if (!secret) throw new Error('Gateway Relay credential is unavailable');
  if (existingSecret && existingSecret !== secret) throw new Error('Existing Gateway Relay credentials conflict');
  return gatewayRelaySecret({ KCODER_STUDIO_RELAY_SECRET: secret });
}

async function loadRelayRuntime(resourcesPath, loadRuntime) {
  if (loadRuntime) return loadRuntime();
  const root = resourcesPath ? join(resourcesPath, 'kcoder-relay/src') : resolve(import.meta.dirname, '../../kcoder-relay/src');
  const [client, origin, identity] = await Promise.all(['client.mjs', 'gateway-origin.mjs', 'client-identity.mjs']
    .map(file => import(pathToFileURL(join(root, file)).href)));
  return { ...client, ...origin, ...identity };
}

/** One instance owns one Relay transport for its existing Gateway. */
export async function prepareGatewayRelay({ userDataDir, env = process.env, resourcesPath, signal, defaultRelayUrl, selection,
  loadRuntime, onOnline = () => {}, onDiagnostic, accountCredentials, accountSessionToken } = {}) {
  if (!userDataDir) throw new Error('Gateway Relay requires its application data directory');
  signal?.throwIfAborted();
  let configPath = env.KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE || join(userDataDir, 'desktop-relay.json');
  let config = await configuration(configPath);
  if (config?.disabled && selection === undefined) return null;
  if (selection !== undefined) config = { ...config, selectedProfile: selection };
  if (config?.selectedProfile) {
    userDataDir = join(userDataDir, 'relay-profiles', config.selectedProfile);
    configPath = join(userDataDir, 'desktop-relay.json');
    config = await configuration(configPath);
    if (!config || config.selectedProfile !== undefined) throw Error('Selected Relay profile is unavailable');
    env = selectedRelayEnvironment(env);
  }
  const url = env.KCODER_STUDIO_DESKTOP_RELAY_URL ?? env.KCODER_RELAY_PUBLIC_URL ?? config?.url ?? defaultRelayUrl;
  if (!url) {
    if (config || env.KCODER_STUDIO_DESKTOP_RELAY_REGISTRATION_KEY || env.KCODER_RELAY_REGISTRATION_KEY)
      throw new Error('Configure the Gateway Relay HTTPS URL');
    return null;
  }
  if (typeof url !== 'string') throw new Error('Gateway Relay requires an HTTPS root URL');
  const runtime = await loadRelayRuntime(resourcesPath, loadRuntime);
  let base;
  try { base = new URL(url); }
  catch { throw new Error('Gateway Relay requires an HTTPS root URL'); }
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password)
    throw new Error('Gateway Relay requires an HTTPS root URL without credentials');
  runtime.isolatedGatewayUrl(base.href, 'validation');
  const directory = join(userDataDir, 'desktop-relay');
  const registrationKey = env.KCODER_STUDIO_DESKTOP_RELAY_REGISTRATION_KEY ?? env.KCODER_RELAY_REGISTRATION_KEY ?? config?.registrationKey;
  // Presence is not trust: adoption validates both files and resumes interrupted two-link moves.
  if (!registrationKey && !config?.activationCode && !config?.accountLoginToken && !accountCredentials && !accountSessionToken &&
      !await lstat(runtime.resolveIdentityFile({}, userDataDir)).catch(error => { if (error.code !== 'ENOENT') throw error; }) &&
      !await lstat(join(directory, 'client-identity.json')).catch(error => { if (error.code !== 'ENOENT') throw error; })) return null;
  const gatewaySecret = await internalSecret(directory, env.KCODER_STUDIO_RELAY_SECRET);
  const identityFile = await runtime.prepareInstanceIdentityFile({ stateDirectory: userDataDir,
    legacyIdentityFile: join(directory, 'client-identity.json'), relayUrl: base.origin, gatewaySecret });
  const options = { url: base.href, gatewaySecret, identityFile, registrationKey,
    activationCode: config?.activationCode, accountLoginToken: config?.accountLoginToken, accountCredentials, accountSessionToken, signal };
  const identity = await runtime.ensureRegisteredClientIdentity(options);
  signal?.throwIfAborted();
  if ((config?.activationCode || config?.accountLoginToken) && configPath === join(userDataDir, 'desktop-relay.json')) {
    const saved = { ...config }; delete saved.activationCode; delete saved.accountLoginToken;
    await saveConfiguration(configPath, saved);
  }
  const publicBaseUrl = runtime.isolatedGatewayUrl(base.href, identity.id).href.replace(/\/$/, '');
  const origins = new Set(String(env.KCODER_STUDIO_PUBLIC_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
  origins.add(new URL(publicBaseUrl).origin);
  if (env.KCODER_STUDIO_PUBLIC_ACCESS_URL && env.KCODER_STUDIO_PUBLIC_ACCESS_URL.replace(/\/$/, '') !== publicBaseUrl)
    throw new Error('Desktop public URL conflicts with its Relay registration');
  let client = null;
  let generation = 0;
  const close = () => { generation++; client?.close(); client = null; };
  return {
    publicBaseUrl,
    relayOrigin: base.origin,
    identityFile,
    gatewaySecretFile: join(directory, 'gateway-secret'),
    gatewayEnvironment: {
      KCODER_STUDIO_PUBLIC_ACCESS_URL: publicBaseUrl,
      KCODER_STUDIO_PUBLIC_ORIGINS: [...origins].join(','),
      KCODER_STUDIO_RELAY_SECRET: gatewaySecret,
      KCODER_STUDIO_RELAY_IDENTITY_FILE: identityFile,
      KCODER_STUDIO_RELAY_ORIGIN: base.origin,
      KCODER_STUDIO_P2P_STUN_URLS: env.KCODER_STUDIO_P2P_STUN_URLS ?? gatewayStunUrl(base.href, env.KCODER_RELAY_STUN_PORT ?? 8452),
    },
    async connect(gateway, callbacks = {}) {
      close();
      const current = generation;
      signal?.throwIfAborted();
      const next = await runtime.startRegisteredClient({ ...options, registrationKey: undefined, activationCode: undefined,
        accountLoginToken: undefined, accountCredentials: undefined, accountSessionToken: undefined, gateway, onOnline: callbacks.onOnline || onOnline, onDiagnostic });
      if (current !== generation || signal?.aborted) { next.close(); return; }
      client = next;
    },
    close,
  };
}

async function saveConfiguration(path, value, expectedRevision) {
  if (expectedRevision !== undefined && ((await configuration(path))?.revision ?? 0) !== expectedRevision)
    throw Object.assign(Error('Relay configuration changed; refresh before applying'), { code: 'RELAY_CONFIG_CONFLICT' });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); await file.close(); file = null;
    if (expectedRevision !== undefined && ((await configuration(path))?.revision ?? 0) !== expectedRevision)
      throw Object.assign(Error('Relay configuration changed; refresh before applying'), { code: 'RELAY_CONFIG_CONFLICT' });
    await rename(temporary, path);
  } finally { await file?.close(); await unlink(temporary).catch(() => {}); }
}

/** Persist one-time enrollment proofs; account passwords stay in the current request only. */
export async function activateGatewayRelay({ activationLink, relayUrl, accountCredentials, accountSessionToken, userDataDir, resourcesPath, signal, loadRuntime }) {
  if (accountCredentials && (typeof accountCredentials !== 'object' || Array.isArray(accountCredentials) ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(accountCredentials.username ?? '') ||
      typeof accountCredentials.password !== 'string' || accountCredentials.password.length < 12 || accountCredentials.password.length > 256 ||
      Object.keys(accountCredentials).some(key => !['username', 'password'].includes(key)))) throw Error('Invalid Relay account credentials');
  if ([activationLink, accountCredentials, accountSessionToken].filter(Boolean).length !== 1) throw Error('Exactly one Relay enrollment credential is required');
  let link = null;
  let accountLoginToken;
  let activationCode;
  if (activationLink) {
    if (/^[A-Za-z0-9_-]{43}$/.test(activationLink)) accountLoginToken = activationLink;
    else {
      try { link = new URL(activationLink); } catch { throw Error('Invalid Relay activation link'); }
      const code = new URLSearchParams(link.hash.slice(1));
      if (link.protocol !== 'https:' || link.username || link.password || link.search ||
          !['/_relay/activate', '/_relay/login'].includes(link.pathname) || [...code.keys()].length !== 1 ||
          !/^[A-Za-z0-9_-]{43}$/.test(code.get('code') ?? '')) throw Error('Invalid Relay activation link');
      if (link.pathname === '/_relay/login') accountLoginToken = code.get('code');
      else activationCode = code.get('code');
      if (relayUrl && new URL(relayUrl).origin !== link.origin) throw Error('Relay invite belongs to a different Relay');
    }
  }
  let origin;
  try { origin = link?.origin || new URL(relayUrl).origin; }
  catch { throw Error('Relay HTTPS address required'); }
  const target = new URL(origin);
  if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash)
    throw Error('Relay requires an HTTPS root URL');
  const path = join(userDataDir, 'desktop-relay.json');
  const previous = await configuration(path);
  const identities = await Promise.all(['relay/client-identity.json', 'desktop-relay/client-identity.json'].map(path => privateText(join(userDataDir, path))));
  for (const identityText of identities.filter(Boolean)) {
    let identity;
    try { identity = JSON.parse(identityText); } catch { throw Error('Gateway Relay identity is invalid'); }
    const proof = activationCode || accountLoginToken;
    const savedProof = activationCode ? previous?.activationCode : accountLoginToken ? previous?.accountLoginToken : undefined;
    if ((identity.id && (accountCredentials || accountSessionToken || savedProof !== proof)) || identity.relayOrigin !== origin)
      throw Error('This desktop already has a Relay identity; preserve its original configuration');
  }
  if (previous?.url && new URL(previous.url).origin !== origin) throw Error('Activation belongs to a different Relay');
  await saveConfiguration(path, { url: origin, ...(activationCode ? { activationCode } : {}),
    ...(accountLoginToken ? { accountLoginToken } : {}) });
  const relay = await prepareGatewayRelay({ userDataDir, resourcesPath, signal, loadRuntime,
    env: { KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE: path }, accountCredentials, accountSessionToken });
  relay.close();
  return { publicBaseUrl: relay.publicBaseUrl, restartRequired: true };
}

/** Read only the registration phase; credentials never enter the management API. */
export async function gatewayRelayRegistrationState({ userDataDir, publicBaseUrl, env = process.env, resourcesPath, loadRuntime }) {
  const saved = await configuration(env.KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE || join(userDataDir, 'desktop-relay.json'));
  if (saved?.disabled) return {
    disabled: true, configured: Boolean(publicBaseUrl), needsLogin: true, publicBaseUrl: publicBaseUrl || null,
    restartRequired: Boolean(publicBaseUrl), revision: saved.revision ?? 0, selectedProfileId: null,
    relayUrl: saved.url || env.KCODER_STUDIO_RELAY_DEFAULT_URL || null,
    ...(saved.switchAttempt ? { switchAttempt: { ...saved.switchAttempt,
      needsActivation: await relayProfileNeedsEnrollment(join(userDataDir, 'relay-profiles', saved.switchAttempt.id)) } } : {}),
  };
  const identity = !publicBaseUrl && saved && (await privateText(join(userDataDir, 'relay/client-identity.json')) ||
    await privateText(join(userDataDir, 'desktop-relay/client-identity.json')));
  const selected = saved?.selectedProfile !== undefined ? await relayProfileState({ userDataDir, profile: saved.selectedProfile, resourcesPath, loadRuntime, legacyUrl: saved.url }) : null;
  const previous = saved?.previousProfile !== undefined ? await relayProfileState({ userDataDir, profile: saved.previousProfile, resourcesPath, loadRuntime, legacyUrl: saved.url }) : null;
  const selectedIdentity = saved?.selectedProfile
    ? await privateText(join(userDataDir, 'relay-profiles', saved.selectedProfile, 'relay/client-identity.json')) ||
      await privateText(join(userDataDir, 'relay-profiles', saved.selectedProfile, 'desktop-relay/client-identity.json'))
    : identity;
  return {
    configured: Boolean(publicBaseUrl && (env.KCODER_STUDIO_RELAY_IDENTITY_FILE || env.KCODER_STUDIO_RELAY_SECRET)),
    needsLogin: Boolean(!publicBaseUrl && (!selectedIdentity || !JSON.parse(selectedIdentity).id)),
    hasPendingIdentity: Boolean(!publicBaseUrl && !saved?.selectedProfile && identity && !JSON.parse(identity).id),
    ...(publicBaseUrl && !env.KCODER_STUDIO_RELAY_IDENTITY_FILE && !env.KCODER_STUDIO_RELAY_SECRET ? { externallyManaged: true } : {}),
    publicBaseUrl: publicBaseUrl || null,
    restartRequired: selected ? selected.publicBaseUrl !== (publicBaseUrl || null) : !publicBaseUrl && Boolean(saved?.activationCode || saved?.accountLoginToken || (identity && JSON.parse(identity).id)),
    revision: saved?.revision ?? 0,
    selectedProfileId: saved?.selectedProfile ?? null,
    relayUrl: selected?.url || env.KCODER_STUDIO_RELAY_ORIGIN || saved?.url || env.KCODER_STUDIO_RELAY_DEFAULT_URL || env.KCODER_RELAY_PUBLIC_URL || null,
    ...(selected && selected.publicBaseUrl !== publicBaseUrl ? { selectedRelay: selected } : {}),
    ...(previous ? { previousRelay: previous } : {}),
    ...(saved?.switchAttempt ? { switchAttempt: { ...saved.switchAttempt,
      needsActivation: await relayProfileNeedsEnrollment(join(userDataDir, 'relay-profiles', saved.switchAttempt.id)) } } : {}),
  };
}

async function relayProfileNeedsEnrollment(directory) {
  const text = await privateText(join(directory, 'relay/client-identity.json')) ||
    await privateText(join(directory, 'desktop-relay/client-identity.json'));
  if (!text) return true;
  try { return !JSON.parse(text).id; } catch { throw Error('Gateway Relay identity is invalid'); }
}

/** Probe external launcher-owned identity only after an explicit authenticated settings read. */
export async function gatewayRelayExternalAccessState({ env = process.env, resourcesPath, loadRuntime, revoke = false } = {}) {
  const identityFile = env.KCODER_STUDIO_RELAY_IDENTITY_FILE;
  const relayUrl = env.KCODER_STUDIO_RELAY_ORIGIN;
  const gatewaySecret = env.KCODER_STUDIO_RELAY_SECRET ?? env.KCODER_RELAY_GATEWAY_SECRET;
  if (typeof identityFile !== 'string' || typeof relayUrl !== 'string' || typeof gatewaySecret !== 'string') return 'unknown';
  try {
    const runtime = await loadRelayRuntime(resourcesPath, loadRuntime);
    if (typeof runtime.checkRegisteredClientAccess !== 'function') return 'unknown';
    const result = await runtime.checkRegisteredClientAccess({ url: relayUrl, identityFile, gatewaySecret, revoke });
    return ['authorized', 'denied', 'revoked'].includes(result) ? result : 'unknown';
  } catch { return 'unknown'; }
}

export async function removeRevokedRelayCredentials(userDataDir, identityFile) {
  if (!identityFile) return;
  const path = relative(userDataDir, identityFile).replaceAll('\\', '/');
  if (!/^(?:relay-profiles\/[a-f0-9-]{36}\/)?(?:relay|desktop-relay)\/client-identity\.json$/.test(path)) return;
  const directory = dirname(dirname(identityFile));
  for (const file of [identityFile, join(directory, 'desktop-relay', 'gateway-secret')]) {
    const parent = dirname(file);
    if (await realpath(parent).catch(() => null) !== resolve(parent)) continue;
    if (await privateText(file) !== null) await unlink(file);
  }
}

function selectedRelayEnvironment(env) {
  const result = { ...env };
  for (const key of ['KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE', 'KCODER_STUDIO_DESKTOP_RELAY_URL',
    'KCODER_STUDIO_DESKTOP_RELAY_REGISTRATION_KEY', 'KCODER_RELAY_PUBLIC_URL', 'KCODER_RELAY_REGISTRATION_KEY',
    'KCODER_STUDIO_RELAY_SECRET', 'KCODER_RELAY_GATEWAY_SECRET', 'KCODER_STUDIO_PUBLIC_ACCESS_URL']) delete result[key];
  return result;
}

async function relayProfileState({ userDataDir, profile, resourcesPath, loadRuntime, legacyUrl }) {
  const directory = profile ? join(userDataDir, 'relay-profiles', profile) : userDataDir;
  const config = await configuration(join(directory, 'desktop-relay.json'));
  const text = await privateText(join(directory, 'relay/client-identity.json')) || await privateText(join(directory, 'desktop-relay/client-identity.json'));
  if (!text) return null;
  const identity = JSON.parse(text);
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw Error('Relay profile identity is invalid');
  if (!identity.id) return null;
  const url = profile ? config?.url : legacyUrl || config?.url;
  if (!url || identity.relayOrigin !== new URL(url).origin) throw Error('Relay profile identity does not match');
  const runtime = await loadRelayRuntime(resourcesPath, loadRuntime);
  return { url, publicBaseUrl: runtime.isolatedGatewayUrl(url, identity.id).href.replace(/\/$/, '') };
}

export { configuration as readRelayConfiguration, saveConfiguration as writeRelayConfiguration, privateText as readRelayPrivateText,
  internalSecret as preserveRelayGatewaySecret, selectedRelayEnvironment, relayProfileState, relayProfileNeedsEnrollment };
