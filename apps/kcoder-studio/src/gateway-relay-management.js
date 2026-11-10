import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { activateGatewayRelay, gatewayRelayExternalAccessState, gatewayRelayRegistrationState, prepareGatewayRelay,
  readRelayConfiguration, removeRevokedRelayCredentials, writeRelayConfiguration } from './gateway-relay-instance.js';
import { studioDataDirectory } from './studio-login-link.js';
import { createGatewayRelaySwitch } from './gateway-relay-switch.js';
import { productAccountCookieScope, productAccountIssuer, updateProductAccount, validAccountProof } from './gateway-product-account.js';

// Browsers may cap persistence. Relay still checks the authoritative session on every use.
const MAX_ACCOUNT_COOKIE_AGE = 2_147_483_647;

function accountCookieLifetime(sessionExpiresAt) {
  return Number.isSafeInteger(sessionExpiresAt)
    ? Math.min(MAX_ACCOUNT_COOKIE_AGE, Math.max(0, Math.ceil((sessionExpiresAt - Date.now()) / 1000)))
    : MAX_ACCOUNT_COOKIE_AGE;
}

export function gatewayRelayOptions(env = process.env) {
  return {
    userDataDir: env.KCODER_STUDIO_RELAY_CONFIG_DIR || studioDataDirectory({
      dataDirectory: env.KCODER_STUDIO_DATA_DIR, serversStore: env.KCODER_STUDIO_SERVERS_STORE }),
    resourcesPath: env.KCODER_STUDIO_RELAY_RESOURCES_PATH,
    defaultRelayUrl: env.KCODER_STUDIO_RELAY_DEFAULT_URL,
    env,
  };
}

function validAccountCredentials(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.username ?? '') &&
    typeof value.password === 'string' && value.password.length >= 12 && value.password.length <= 256 &&
    Object.keys(value).every(key => key === 'username' || key === 'password'));
}

function loopbackLoginOrigin(request) {
  try {
    const origin = new URL(request.headers.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.host ||
        !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) return false;
    const remote = request.socket?.remoteAddress || '';
    return remote === '::1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1';
  } catch { return false; }
}

function protectedLoginOrigin(request) {
  try { return new URL(request.headers.origin).protocol === 'https:' || loopbackLoginOrigin(request); }
  catch { return false; }
}

export function observeGatewayRelayConnectionStatus(current, event) {
  if (event?.event === 'control_open') return 'online';
  if (event?.event === 'control_error') {
    if (event.errorKind === 'handshake_status' && [401, 403].includes(event.handshakeStatus)) return 'denied';
    return current === 'denied' ? 'denied' : 'offline';
  }
  if (event?.event === 'control_close') return current === 'denied' ? 'denied' : 'offline';
  return current;
}

/** An externally managed registration keeps its existing owner and transport. */
export async function restoreGatewayRelay(env = process.env, onError = () => {}, observers = {}) {
  if (env.KCODER_STUDIO_PUBLIC_ACCESS_URL || env.KCODER_STUDIO_RELAY_SECRET) return null;
  try {
    const relay = await prepareGatewayRelay({ ...gatewayRelayOptions(env), ...observers });
    if (relay) Object.assign(env, relay.gatewayEnvironment);
    return relay;
  } catch (error) {
    onError(error);
    return null;
  }
}

/** Shared browser/Electron API. Paired devices cannot enroll or restart a Gateway. */
export function createGatewayRelayManagement({ env = process.env, publicBaseUrl, isAdmin,
  sameOrigin, requestBody, jsonResponse, activate = activateGatewayRelay,
  getState = gatewayRelayRegistrationState, restart, restoreFailed = false, externallyManaged = false,
  externalOwnerCanApply = false, accountCookies, cookiePath = () => '/', accountFetch, liveRelay, publicAccess,
  getConnectionStatus = () => undefined, getExternalAccessStatus = gatewayRelayExternalAccessState } = {}) {
  // Startup observers consume private env entries; keep this owner's registration context.
  env = { ...env };
  const options = gatewayRelayOptions(env);
  const configPath = env.KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE || join(options.userDataDir, 'desktop-relay.json');
  const issuer = productAccountIssuer(env);
  const cookieScope = request => productAccountCookieScope(options.userDataDir, cookiePath(request), issuer);
  const browserProof = request => {
    const token = accountCookies?.read(request, cookieScope(request));
    return validAccountProof(token) ? token : null;
  };
  async function requireProductAccount(request, response, proof, session) {
    if (!proof) {
      jsonResponse(response, 401, { error: 'KCODER_ACCOUNT_SIGN_IN_REQUIRED' });
      return false;
    }
    const account = await updateProductAccount({ issuer, proof, method: 'GET', fetchImpl: accountFetch });
    if (!account.body.account) {
      jsonResponse(response, account.status === 200 ? 401 : account.status,
        { error: account.body.error || 'KCODER_ACCOUNT_SIGN_IN_REQUIRED' });
      return false;
    }
    if (isAdmin(request, session)) return true;
    jsonResponse(response, 403, { error: 'Gateway browser authorization required' });
    return false;
  }
  const switches = createGatewayRelaySwitch({ ...options, publicBaseUrl,
    allowUntrackedOriginal: Boolean(externallyManaged && !externalOwnerCanApply) });
  let activating = false;
  let restarting = false;
  const relayEnv = () => liveRelay ? liveRelay.environment : env;
  const runtimeState = () => getState({ ...options, env: { ...env,
    KCODER_STUDIO_RELAY_SECRET: relayEnv().KCODER_STUDIO_RELAY_SECRET,
    KCODER_STUDIO_RELAY_IDENTITY_FILE: relayEnv().KCODER_STUDIO_RELAY_IDENTITY_FILE,
    KCODER_STUDIO_RELAY_ORIGIN: relayEnv().KCODER_STUDIO_RELAY_ORIGIN },
    publicBaseUrl: liveRelay ? relayEnv().KCODER_STUDIO_PUBLIC_ACCESS_URL : publicBaseUrl });

  async function enrollSignedInGateway(proof) {
    if (externallyManaged || activating || restarting) return;
    activating = true;
    try {
      const state = await runtimeState();
      if (state.configured || state.externallyManaged || state.disabled || state.switchAttempt || state.restartRequired) return;
      await activate({ ...options, relayUrl: issuer, accountSessionToken: proof });
      if (liveRelay) await liveRelay.apply();
    } catch {
      // Product login has already succeeded. Manual enrollment remains available.
      return { relayRegistrationFailed: true };
    } finally { activating = false; }
  }

  function requestRestart(request, response) {
    if (restarting) return;
    restarting = true;
    response.once('finish', () => restart(loopbackLoginOrigin(request) ? request.headers.host : undefined));
  }
  return async (request, response, pathname, session) => {
    if (!['/api/kcoder-account', '/api/relay', '/api/relay/public-access', '/api/relay/activation', '/api/relay/restart', '/api/relay/apply', '/api/relay/revoke', '/api/relay/switch', '/api/relay/switch/cancel', '/api/relay/rollback'].includes(pathname)) return false;
    if (!isAdmin(request, session)) { jsonResponse(response, 403, { error: 'Gateway browser authorization required' }); return true; }
    try {
      if (pathname === '/api/kcoder-account') {
        const { method } = request;
        if (!['GET', 'POST', 'DELETE'].includes(method)) { jsonResponse(response, 405, { error: 'Method not allowed' }); return true; }
        if (method !== 'GET' && (!sameOrigin(request) || !protectedLoginOrigin(request))) {
          jsonResponse(response, 403, { error: 'KCODER_ACCOUNT_SECURE_ORIGIN_REQUIRED' }); return true;
        }
        const proof = browserProof(request);
        const sendCookie = (token, lifetime) => ({
          'set-cookie': accountCookies.header(request, token, lifetime, cookiePath(request), cookieScope(request)),
        });
        const guest = { available: Boolean(issuer), account: null };
        if (method === 'GET') {
          const result = proof ? await updateProductAccount({ issuer, proof, method, fetchImpl: accountFetch })
            : { status: 200, body: guest };
          let headers = {};
          if (issuer && accountCookies && result.status === 200) {
            headers = result.body.account
              ? sendCookie(proof, accountCookieLifetime(result.sessionExpiresAt))
              : sendCookie(randomBytes(32).toString('base64url'), 86400);
          }
          jsonResponse(response, result.status, issuer && result.status === 200 ? { ...result.body, portalUrl: new URL('/_relay/account/', issuer).href } : result.body, headers);
          return true;
        }
        if (method === 'DELETE' && !proof) {
          jsonResponse(response, 200, guest);
          return true;
        }
        const input = method === 'POST' ? JSON.parse(await requestBody(request, 4096)) : undefined;
        const result = await updateProductAccount({ issuer, proof, method, input, fetchImpl: accountFetch });
        if (method === 'DELETE') {
          jsonResponse(response, 200, { ...guest,
            ...(result.status === 200 ? {} : { revocationUnconfirmed: true }) }, sendCookie('', 0));
          return true;
        }
        const headers = result.status === 200 ? sendCookie(proof, accountCookieLifetime(result.sessionExpiresAt)) : {};
        const enrollment = result.status === 200 && result.body.account && await enrollSignedInGateway(proof);
        jsonResponse(response, result.status, enrollment ? { ...result.body, ...enrollment } : result.body, headers);
        return true;
      }
      const state = await runtimeState();
      const currentExternal = externallyManaged && (!liveRelay || relayEnv().KCODER_STUDIO_RELAY_IDENTITY_FILE === env.KCODER_STUDIO_RELAY_IDENTITY_FILE && Boolean(relayEnv().KCODER_STUDIO_RELAY_SECRET));
      if (pathname === '/api/relay' && request.method === 'GET') {
        const external = currentExternal || state.externallyManaged;
        const connectionStatus = !external ? getConnectionStatus() : undefined;
        const accountAccessStatus = external ? await getExternalAccessStatus(options).catch(() => 'unknown') : undefined;
        const independentLauncher = external && !externalOwnerCanApply;
        const pendingOriginCorrection = Boolean(state.needsLogin && state.hasPendingIdentity);
        const switchSupported = independentLauncher
          ? accountAccessStatus === 'denied' && (!state.restartRequired || Boolean(state.switchAttempt))
          : (state.configured || pendingOriginCorrection) && !state.externallyManaged;
        jsonResponse(response, 200, { ...state, productAccountOrigin: issuer, ...(external ? { accountAccessStatus } : {}),
          ...(independentLauncher ? { configured: false, externallyManaged: true } : {}),
          ...(!external && ['online', 'offline', 'denied'].includes(connectionStatus) ? { connectionStatus } : {}),
          liveApplySupported: Boolean(liveRelay), ...(publicAccess ? { publicAccess: publicAccess.state } : {}),
          revokeSupported: Boolean((restart || liveRelay) && relayEnv().KCODER_STUDIO_RELAY_IDENTITY_FILE && !state.disabled && !state.restartRequired && !state.switchAttempt),
          switchSupported, restartSupported: typeof restart === 'function', ...(restoreFailed ? { restoreFailed: true } : {}) }); return true;
      }
      if (request.method !== 'POST' || pathname === '/api/relay') {
        jsonResponse(response, 405, { error: 'Method not allowed' }); return true;
      }
      if (!sameOrigin(request)) { jsonResponse(response, 403, { error: 'Same-origin JSON request required' }); return true; }
      const input = JSON.parse(await requestBody(request, 4096));
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid request');
      if (!isAdmin(request, session)) { jsonResponse(response, 403, { error: 'Gateway browser authorization required' }); return true; }
      if (pathname === '/api/relay/public-access' && publicAccess) {
        const status = await publicAccess.update(input);
        jsonResponse(response, status, status === 200 ? publicAccess.state :
          { error: status === 409 ? 'RELAY_CONFIG_CONFLICT' : 'INVALID_PUBLIC_ACCESS' });
        return true;
      }
      if (pathname === '/api/relay/revoke') {
        if ((!restart && !liveRelay) || !relayEnv().KCODER_STUDIO_RELAY_IDENTITY_FILE || activating || restarting ||
            state.switchAttempt || (state.restartRequired && !state.disabled) ||
            input.expectedRevision !== state.revision || Object.keys(input).length !== 1) {
          jsonResponse(response, 409, { error: 'RELAY_CONFIG_CONFLICT' }); return true;
        }
        activating = true;
        try {
          if (!state.disabled) {
            const saved = await readRelayConfiguration(configPath);
            if ((saved?.revision ?? 0) !== input.expectedRevision) {
              jsonResponse(response, 409, { error: 'RELAY_CONFIG_CONFLICT' }); return true;
            }
            const result = await (liveRelay ? liveRelay.revoke() : getExternalAccessStatus({ ...options, revoke: true }));
            if (result !== 'revoked') {
              jsonResponse(response, 503, { error: 'RELAY_REVOCATION_UNCONFIRMED' }); return true;
            }
            await writeRelayConfiguration(configPath, { url: saved?.url || relayEnv().KCODER_STUDIO_RELAY_ORIGIN,
              disabled: true, revision: state.revision + 1 }, state.revision);
          }
          if (liveRelay) {
            const identityFile = relayEnv().KCODER_STUDIO_RELAY_IDENTITY_FILE;
            await liveRelay.clear();
            const cleanupPending = await removeRevokedRelayCredentials(options.userDataDir, identityFile).then(() => false, () => true);
            jsonResponse(response, 200, { ...await runtimeState(), productAccountOrigin: issuer, liveApplySupported: true,
              restartSupported: false, ...(cleanupPending ? { cleanupPending } : {}) });
            return true;
          }
          requestRestart(request, response);
          jsonResponse(response, 202, { restartRequested: true });
        } finally { activating = false; }
        return true;
      }
      if (['/api/relay/switch', '/api/relay/switch/cancel', '/api/relay/rollback'].includes(pathname)) {
        const external = currentExternal || state.externallyManaged;
        const independentLauncher = external && !externalOwnerCanApply;
        const accountAccessStatus = external ? await getExternalAccessStatus(options).catch(() => 'unknown') : undefined;
        const pendingOriginCorrection = Boolean(state.needsLogin && state.hasPendingIdentity);
        if ((independentLauncher ? accountAccessStatus !== 'denied' : !state.configured && !pendingOriginCorrection && !state.disabled) || activating || restarting) {
          jsonResponse(response, 409, { error: 'Gateway Relay is unavailable or busy' }); return true;
        }
        const allowed = pathname === '/api/relay/switch' ? ['expectedRevision', 'requestId', 'relayUrl', 'activationLink', 'accountCredentials', 'useKCoderAccount'] : ['expectedRevision'];
        if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || Object.keys(input).some(key => !allowed.includes(key))) throw Error('Invalid Relay configuration change');
        const proof = input.useKCoderAccount === true && browserProof(request);
        if (input.useKCoderAccount !== undefined && (!proof || !protectedLoginOrigin(request) ||
            input.activationLink !== undefined || input.accountCredentials !== undefined || input.relayUrl !== issuer)) {
          jsonResponse(response, 403, { error: 'KCODER_ACCOUNT_SIGN_IN_REQUIRED' }); return true;
        }
        if (pathname === '/api/relay/switch' && (input.accountCredentials !== undefined && !validAccountCredentials(input.accountCredentials) ||
            input.activationLink !== undefined && (typeof input.activationLink !== 'string' || input.activationLink.length > 2048) ||
            input.activationLink && input.accountCredentials)) throw Error('Invalid Relay account login');
        if (pathname === '/api/relay/switch' && state.restartRequired && !state.switchAttempt &&
            state.selectedProfileId !== input.requestId && !pendingOriginCorrection) {
          jsonResponse(response, 409, { error: 'Apply or restore the pending Relay selection first' }); return true;
        }
        if (pathname === '/api/relay/switch' && (input.accountCredentials || input.activationLink) && !protectedLoginOrigin(request)) {
          jsonResponse(response, 400, { error: 'RELAY_LOGIN_REQUIRES_SECURE_ORIGIN' }); return true;
        }
        activating = true;
        try {
          if (proof && !await requireProductAccount(request, response, proof, session)) return true;
          if (pathname === '/api/relay/switch') await switches.switch({ ...input, accountSessionToken: proof || undefined }, {
            allowUntrackedOriginal: Boolean(independentLauncher || pendingOriginCorrection),
            pendingOriginCorrection: Boolean(pendingOriginCorrection && !independentLauncher) });
          else if (pathname === '/api/relay/switch/cancel') await switches.cancel(input.expectedRevision);
          else await switches.rollback(input.expectedRevision);
          if (liveRelay && pathname !== '/api/relay/switch/cancel') await liveRelay.apply();
          const next = await runtimeState();
          const nextAccessStatus = external ? await getExternalAccessStatus(options).catch(() => 'unknown') : undefined;
          jsonResponse(response, 200, { ...next, productAccountOrigin: issuer,
            ...(external ? { accountAccessStatus: nextAccessStatus } : {}),
            ...(independentLauncher ? { configured: false, externallyManaged: true } : {}),
            switchSupported: independentLauncher ? nextAccessStatus === 'denied' && (!next.restartRequired || Boolean(next.switchAttempt)) : true,
            liveApplySupported: Boolean(liveRelay), revokeSupported: Boolean(liveRelay && next.configured && !next.restartRequired),
            restartSupported: typeof restart === 'function' });
        } finally { activating = false; }
        return true;
      }
      if (pathname === '/api/relay/activation') {
        if (state.configured || state.externallyManaged || activating || restarting) { jsonResponse(response, 409, { error: 'Gateway public access is already configured or busy' }); return true; }
        const useAccount = input.useKCoderAccount === true;
        if (Object.keys(input).some(key => !['activationLink', 'relayUrl', 'accountCredentials', 'useKCoderAccount'].includes(key)) ||
            (input.activationLink !== undefined && (typeof input.activationLink !== 'string' || input.activationLink.length > 2048)) ||
            (input.accountCredentials !== undefined && !validAccountCredentials(input.accountCredentials)) ||
            [input.activationLink, input.accountCredentials, useAccount].filter(Boolean).length !== 1) throw Error('Invalid activation');
        const proof = useAccount && browserProof(request);
        if (useAccount && (!proof || (input.relayUrl && input.relayUrl !== issuer))) {
          jsonResponse(response, 403, { error: 'KCODER_ACCOUNT_SIGN_IN_REQUIRED' }); return true;
        }
        if (!protectedLoginOrigin(request)) {
          jsonResponse(response, 400, { error: 'RELAY_LOGIN_REQUIRES_SECURE_ORIGIN' }); return true;
        }
        const inviteOrigin = input.activationLink && !/^[A-Za-z0-9_-]{43}$/.test(input.activationLink)
          ? new URL(input.activationLink).origin : null;
        if (input.relayUrl) {
          const target = new URL(input.relayUrl);
          if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== '/' ||
              (inviteOrigin && inviteOrigin !== target.origin)) throw Error('Invalid Relay address');
        }
        activating = true;
        try {
          if (useAccount && !await requireProductAccount(request, response, proof, session)) return true;
          const credentials = { activationLink: input.activationLink,
            accountCredentials: input.accountCredentials, accountSessionToken: proof || undefined,
            relayUrl: (useAccount ? issuer : null) || input.relayUrl || inviteOrigin || env.KCODER_STUDIO_RELAY_DEFAULT_URL || env.KCODER_STUDIO_RELAY_ORIGIN || env.KCODER_RELAY_PUBLIC_URL };
          let result;
          if (state.disabled) {
            await switches.switch({ ...credentials, requestId: state.switchAttempt?.id || randomUUID(), expectedRevision: state.revision });
            result = await runtimeState();
          } else result = await activate({ ...options, ...credentials });
          if (liveRelay) {
            await liveRelay.apply();
            result = await runtimeState();
          }
          jsonResponse(response, 200, { configured: false, ...result, productAccountOrigin: issuer,
            liveApplySupported: Boolean(liveRelay), revokeSupported: Boolean(liveRelay), restartSupported: typeof restart === 'function' });
        } finally { activating = false; }
        return true;
      }
      if (Object.keys(input).length) throw Error('Invalid request');
      if (pathname === '/api/relay/apply' && liveRelay && state.restartRequired && !state.needsLogin && !activating) {
        activating = true;
        try {
          await liveRelay.apply();
          jsonResponse(response, 200, { ...await runtimeState(), productAccountOrigin: issuer,
            liveApplySupported: true, revokeSupported: true, restartSupported: false });
        } finally { activating = false; }
        return true;
      }
      if (pathname !== '/api/relay/restart') { jsonResponse(response, 409, { error: 'No pending Relay connection' }); return true; }
      if (!restart || !state.restartRequired || state.needsLogin) { jsonResponse(response, 409, { error: 'A registered Relay identity is required before restarting the Gateway' }); return true; }
      requestRestart(request, response);
      jsonResponse(response, 202, { restartRequested: true });
    } catch (error) {
      const loginRejected = error.status === 401 || error.status === 403;
      const loginLimited = error.status === 429;
      const accountCapacity = error.code === 'RELAY_ACCOUNT_CAPACITY';
      jsonResponse(response, error.code === 'RELAY_CONFIG_CONFLICT' ? 409 : loginRejected ? 401 : loginLimited || accountCapacity ? 429 : 400,
        { error: loginRejected && pathname === '/api/kcoder-account' ? 'KCODER_ACCOUNT_INVITATION_REJECTED' : loginRejected ? 'RELAY_ACCOUNT_LOGIN_REJECTED' : accountCapacity ? 'RELAY_ACCOUNT_CAPACITY' : loginLimited ? 'RELAY_ACCOUNT_LOGIN_RATE_LIMITED' : 'Relay operation did not complete; check registration status before retrying' });
    }
    return true;
  };
}
