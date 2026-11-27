import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { bridge, heartbeat } from './transport.mjs';
import { loadEnv, credentials, clientGatewaySecret } from './config.mjs';
import {
  prepareClientIdentity,
  readRegisteredClientIdentity,
  resolveIdentityFile,
  saveRegisteredClientIdentity,
  assertClientIdentityActive,
  clientIdentityPresent,
} from './client-identity.mjs';

const CREDENTIAL = /^[A-Za-z0-9._~-]{32,512}$/;
const GATEWAY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GATEWAY_URL_INVALID = 'RELAY_GATEWAY_URL_INVALID';

class GatewayUrlParseError extends Error {
  constructor(cause) {
    super('Gateway URL is invalid', { cause });
    this.code = GATEWAY_URL_INVALID;
  }
}

function registrationCancelled() {
  const error = new Error('Relay registration was cancelled; reconcile the original enrollment proof');
  error.name = 'AbortError';
  error.code = 'RELAY_REGISTRATION_CANCELLED';
  error.externalOutcome = 'unknown';
  return error;
}

function checkStartupSignal(signal) {
  if (signal?.aborted) throw registrationCancelled();
  signal?.throwIfAborted();
}

// A request owns its parent subscription and timeout through body consumption.
function createRequestSignal(parent, timeoutMs) {
  const controller = new AbortController();
  // Keep private caller reasons out of transport errors and diagnostics.
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new DOMException('Relay request deadline expired', 'TimeoutError')), timeoutMs);
  timer.unref?.();
  let disposed = false;
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function validateRelayUrl(url, allowInsecure) {
  if (typeof url !== 'string' || url.length === 0) throw new Error('Configure KCODER_RELAY_PUBLIC_URL');
  let base;
  try { base = new URL(url); }
  catch { throw new Error('Invalid relay URL'); }
  if ((base.protocol !== 'https:' && !(allowInsecure && base.protocol === 'http:')) || base.username || base.password || base.search || base.hash) {
    throw new Error(allowInsecure ? 'Relay URL must be HTTP(S) without credentials, query, or fragment' : 'Relay must use HTTPS');
  }
  return base;
}

function validateGateway(gateway) {
  let target;
  try { target = new URL(gateway); }
  catch (cause) { throw new GatewayUrlParseError(cause); }
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/' || target.username || target.password || target.search || target.hash) {
    throw new Error('Gateway must be a loopback HTTP origin');
  }
  return target;
}

function diagnosticError(error) {
  // Never forward error messages, stacks, URLs or credential-bearing objects.
  if (Number.isInteger(error) && error >= 100 && error <= 599) {
    return { errorKind: 'handshake_status', handshakeStatus: error };
  }
  const status = typeof error?.message === 'string' && /^Unexpected server response: ([1-5][0-9]{2})$/.exec(error.message);
  if (status) return { errorKind: 'handshake_status', handshakeStatus: Number(status[1]) };
  if (error?.message === 'Opening handshake has timed out' || error?.code === 'ETIMEDOUT') return { errorKind: 'timeout' };
  if (error?.code === 'ECONNREFUSED') return { errorKind: 'refused' };
  if (['ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(error?.code)) return { errorKind: 'reset' };
  if (['EHOSTUNREACH', 'ENETUNREACH'].includes(error?.code)) return { errorKind: 'unreachable' };
  if (error?.code === 'EPROTO' || (typeof error?.code === 'string' && error.code.startsWith('WS_ERR_'))) return { errorKind: 'protocol' };
  return { errorKind: 'transport' };
}

function validateDiagnosticObserver(onDiagnostic) {
  if (onDiagnostic !== undefined && typeof onDiagnostic !== 'function') throw new Error('onDiagnostic must be a function');
}

function startControlClient({ base, secret, gatewayId, target, retryMs, onOnline, onDiagnostic,identityCheck }) {
  validateDiagnosticObserver(onDiagnostic);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const headers = { authorization: `Bearer ${secret}`, 'x-kcoder-device': gatewayId };
  const sockets = new Set();
  let stopped = false, timer, control, generation = 0;
  function diagnostic(event, currentGeneration, channelId, detail) {
    if (!onDiagnostic) return;
    try {
      const record = { event, generation: currentGeneration, atUnixMs: Date.now(), monotonicMs: performance.now() };
      if (channelId !== undefined) record.correlation = createHash('sha256').update(channelId).digest('hex');
      if (event.endsWith('_error')) Object.assign(record, diagnosticError(detail));
      if ((event === 'control_close' || event === 'data_close') && Number.isInteger(detail) && detail >= 1000 && detail <= 4999) record.closeCode = detail;
      if (event === 'local_close') record.hadError = Boolean(detail);
      if (event === 'open_rejected') record.rejectReason = detail;
      onDiagnostic(record);
    } catch { /* An observer must never change forwarding or cleanup. */ }
  }
  function socket(path, currentGeneration, channelId) {
    const kind = channelId === undefined ? 'control' : 'data';
    diagnostic(`${kind}_connecting`, currentGeneration, channelId);
    const endpoint = new URL(path, base);
    const ws = new WebSocket(endpoint, { headers, handshakeTimeout: 10000, maxPayload: 256 * 1024, perMessageDeflate: false });
    sockets.add(ws);
    ws.on('error', error => diagnostic(`${kind}_error`, currentGeneration, channelId, error));
    ws.once('close', code => {
      sockets.delete(ws);
      diagnostic(`${kind}_close`, currentGeneration, channelId, code);
    });
    return ws;
  }
  async function reconnect() {
    if (stopped) return;
    const currentGeneration = ++generation;
    if(identityCheck){
      try{await identityCheck();}catch(error){
        if(stopped||currentGeneration!==generation)return;
        stopped=true;diagnostic('control_error',currentGeneration,undefined,error);for(const ws of [...sockets])ws.terminate();return;
      }
      if(stopped||currentGeneration!==generation)return;
    }
    const owned = socket('/_relay/control', currentGeneration); control = owned;
    const current = () => !stopped && currentGeneration === generation && control === owned;
    owned.once('unexpected-response', (_request, response) => {
      if(!current()){response.resume();owned.terminate();return;}
      diagnostic('control_error', currentGeneration, undefined, response.statusCode);
      // Invalid/revoked credentials require operator action, not an endless retry loop.
      if (response.statusCode === 401 || response.statusCode === 403) stopped = true;
      response.resume();
      owned.terminate();
    });
    owned.once('open', () => {
      if(!current()){owned.terminate();return;}
      diagnostic('control_open', currentGeneration); heartbeat(owned); onOnline();
    });
    owned.on('message', async raw => {
      if(!current()||owned.readyState!==WebSocket.OPEN)return;
      let message;
      try { message = JSON.parse(raw.toString()); } catch { diagnostic('open_rejected', currentGeneration, undefined, 'invalid_frame'); return owned.terminate(); }
      if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== 'open' ||
          typeof message.id !== 'string' || !/^[a-f0-9]{48}$/.test(message.id)) {
        diagnostic('open_rejected', currentGeneration, undefined, 'invalid_open'); return;
      }
      if (sockets.size >= 129) { diagnostic('open_rejected', currentGeneration, undefined, 'socket_capacity'); return; }
      if (message.gatewayId !== undefined && message.gatewayId !== gatewayId) { diagnostic('open_rejected', currentGeneration, undefined, 'gateway_mismatch'); return owned.terminate(); }
      if(identityCheck){try{await identityCheck();}catch(error){
        if(!current())return;
        stopped=true;diagnostic('control_error',currentGeneration,undefined,error);for(const ws of [...sockets])ws.terminate();return;
      }}
      if(!current()||owned.readyState!==WebSocket.OPEN)return;
      if (sockets.size >= 129) { diagnostic('open_rejected', currentGeneration, undefined, 'socket_capacity'); return; }
      diagnostic('open_received', currentGeneration, message.id);
      const data = socket(`/_relay/data?id=${message.id}`, currentGeneration, message.id);
      data.once('open', () => {
        if(!current()||owned.readyState!==WebSocket.OPEN){data.terminate();return;}
        diagnostic('data_open', currentGeneration, message.id);
        heartbeat(data);
        diagnostic('local_connecting', currentGeneration, message.id);
        const local = connect({ host: target.hostname === '[::1]' ? '::1' : target.hostname, port: Number(target.port || 80) });
        local.on('error', error => diagnostic('local_error', currentGeneration, message.id, error));
        local.once('close', hadError => diagnostic('local_close', currentGeneration, message.id, hadError));
        local.setTimeout(10000, () => { diagnostic('local_timeout', currentGeneration, message.id); local.destroy(); });
        local.once('connect', () => { diagnostic('local_connect', currentGeneration, message.id); local.setTimeout(0); });
        bridge(local, data, () => diagnostic('bridge_closed', currentGeneration, message.id));
      });
    });
    owned.once('close', () => {
      if(control!==owned||currentGeneration!==generation)return;
      // Revoke this socket's ownership before any delayed identity read can resume.
      generation++;
      for (const ws of [...sockets]) ws.terminate();
      if (!stopped) { diagnostic('reconnect_scheduled', currentGeneration); timer = setTimeout(reconnect, retryMs); }
    });
  }
  reconnect();
  return { close() { stopped = true; clearTimeout(timer); diagnostic('client_stopped', generation); for (const ws of [...sockets]) ws.terminate(); } };
}

export function startClient({ url, secret, device, gatewayId: configuredGatewayId, gateway = 'http://127.0.0.1:4186', allowInsecure = false, retryMs = 2000, onOnline = () => {}, onDiagnostic }) {
  if (device !== undefined && configuredGatewayId !== undefined && device !== configuredGatewayId) {
    throw new Error('gatewayId conflicts with the legacy device ID');
  }
  const gatewayId = configuredGatewayId ?? device ?? 'cyx';
  if (typeof gatewayId !== 'string' || !GATEWAY_ID.test(gatewayId)) throw new Error('Invalid relay Gateway ID');
  const base = validateRelayUrl(url, allowInsecure);
  const target = validateGateway(gateway);
  if (typeof secret !== 'string' || secret.length < 32 || /[\u0000-\u001f\u007f]/.test(secret)) throw new Error('Relay requires a secret of at least 32 characters');
  return startControlClient({ base, secret, gatewayId, target, retryMs, onOnline, onDiagnostic });
}

async function readBoundedJson(response, maxBytes = 16 * 1024) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined && Number(contentLength) > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error('Relay registration response is too large');
  }
  if (!response.body?.getReader) {
    let text;
    try { text = await response.text(); }
    catch { throw new Error('Relay registration response could not be read'); }
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Relay registration response is too large');
    try { return JSON.parse(text); }
    catch { throw new Error('Relay returned an invalid registration response'); }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('Relay registration response is too large');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error.message === 'Relay registration response is too large') throw error;
    throw new Error('Relay registration response could not be read');
  } finally {
    reader.releaseLock();
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new Error('Relay returned invalid UTF-8 registration data'); }
  try { return JSON.parse(text); }
  catch { throw new Error('Relay returned an invalid registration response'); }
}

function validateRegistrationResponse(value, gatewaySecret, authenticationSecrets) {
  const keys = ['id', 'secret', 'gatewaySecret', 'maxConnections', 'maxBytesPerWindow', 'trafficWindowMs'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('Relay returned an invalid registration response');
  }
  if (typeof value.id !== 'string' || !GATEWAY_ID.test(value.id) || typeof value.secret !== 'string' || !CREDENTIAL.test(value.secret)
      || authenticationSecrets.includes(value.secret) || value.secret === gatewaySecret || value.gatewaySecret !== gatewaySecret) {
    throw new Error('Relay returned invalid registered Gateway credentials');
  }
  for (const name of ['maxConnections', 'maxBytesPerWindow', 'trafficWindowMs']) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 1) throw new Error('Relay returned invalid Gateway limits');
  }
  return { id: value.id, secret: value.secret };
}

function registrationAuthentication({ registrationKey, activationCode, accountLoginToken, accountCredentials, accountSessionToken }) {
  const provided = value => value !== undefined && value !== null;
  if ([accountCredentials, accountSessionToken, accountLoginToken].filter(provided).length > 1) {
    throw new Error('Exactly one Relay account credential is required');
  }
  if (provided(accountCredentials)) {
    if (typeof accountCredentials !== 'object' || Array.isArray(accountCredentials)) throw new Error('Invalid Relay account credentials');
    const { username, password } = accountCredentials;
    if (typeof username !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)
        || typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new Error('Invalid Relay account credentials');
    }
    const proof = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    return { pathname: '/_relay/account/register', authorization: `Basic ${proof}`, secrets: [password, proof] };
  }
  let credential, pathname;
  if (provided(accountSessionToken)) {
    credential = accountSessionToken;
    pathname = '/_relay/account/enroll';
  } else if (provided(accountLoginToken)) {
    credential = accountLoginToken;
    pathname = '/_relay/account/register';
  } else if (provided(activationCode)) {
    credential = activationCode;
    pathname = '/_relay/activate-device';
  } else {
    credential = registrationKey;
    pathname = '/_relay/register';
  }
  if (typeof credential !== 'string' || !CREDENTIAL.test(credential)) throw new Error('Sign in to a Relay account or provide a private registration key');
  return { pathname, authorization: `Bearer ${credential}`, secrets: [credential] };
}

async function registerClient({ base, registrationKey, activationCode, accountLoginToken, accountCredentials, accountSessionToken, gatewaySecret, enrollmentToken, fetchImpl, signal }) {
  const authentication = registrationAuthentication({ registrationKey, activationCode, accountLoginToken, accountCredentials, accountSessionToken });
  if (typeof fetchImpl !== 'function') throw new Error('HTTP fetch is unavailable for relay registration');
  const endpoint = new URL(authentication.pathname, base.origin);
  checkStartupSignal(signal);
  const request = createRequestSignal(signal, 10_000);
  try {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: authentication.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ enrollmentToken, gatewaySecret }),
        redirect: 'error',
        signal: request.signal,
      });
    } catch {
      throw new Error('Relay registration request failed; the saved enrollment proof can be retried');
    }
    if (response.status !== 200 && response.status !== 201) {
      await response.body?.cancel?.().catch(() => {});
      const error = new Error(`Relay registration failed with HTTP ${response.status}`);
      error.status = response.status;
      if (response.status === 429 && response.headers?.get('x-kcoder-relay-error') === 'RELAY_ACCOUNT_CAPACITY') {
        error.code = 'RELAY_ACCOUNT_CAPACITY';
      }
      throw error;
    }
    const body = await readBoundedJson(response);
    return validateRegistrationResponse(body, gatewaySecret, authentication.secrets);
  } catch (error) {
    if (signal?.aborted) throw registrationCancelled();
    throw error;
  } finally {
    request.dispose();
  }
}

/** Resolve registration before the owned Gateway publishes its public origin. */
export async function ensureRegisteredClientIdentity({
  url,
  registrationKey,
  activationCode,
  accountLoginToken,
  accountCredentials,
  accountSessionToken,
  gatewaySecret,
  identityFile = resolveIdentityFile(),
  allowInsecure = false,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  checkStartupSignal(signal);
  const base = validateRelayUrl(url, allowInsecure);
  if ((accountCredentials || accountLoginToken || accountSessionToken) && base.protocol !== 'https:'
      && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('Relay account sign-in requires HTTPS');
  }
  const local = await prepareClientIdentity({ identityFile, relayUrl: base.origin, gatewaySecret });
  let assigned;
  if (local.status === 'registered') {
    assigned = { id: local.id, secret: local.secret };
  } else {
    if (!registrationKey && !activationCode && !accountLoginToken && !accountCredentials && !accountSessionToken)
      throw new Error('Sign in to a Relay account to complete client registration');
    if (!gatewaySecret) throw new Error('Configure KCODER_RELAY_GATEWAY_SECRET to complete client registration');
    await assertClientIdentityActive({identityFile,relayUrl:base.origin,gatewaySecret,enrollmentToken:local.enrollmentToken});
    assigned = await registerClient({ base, registrationKey, activationCode, accountLoginToken, accountCredentials, accountSessionToken, gatewaySecret,
      enrollmentToken: local.enrollmentToken, fetchImpl, signal });
    await saveRegisteredClientIdentity({ identityFile, relayUrl: base.origin, gatewaySecret, enrollmentToken: local.enrollmentToken, ...assigned });
  }
  return assigned;
}

/** Probe the live authorization of an existing owned device without opening a tunnel. */
export async function checkRegisteredClientAccess({
  url, identityFile, gatewaySecret, fetchImpl = globalThis.fetch, signal, allowInsecure = false, revoke = false,
}) {
  try {
    const base = validateRelayUrl(url, allowInsecure);
    if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) return 'unknown';
    const identity = await readRegisteredClientIdentity({
      identityFile, relayUrl: base.origin, gatewaySecret, requireSingleLink: true,
    });
    const request = createRequestSignal(signal, 3_000);
    try {
      const response = await fetchImpl(new URL('/_relay/account/access', base.origin), {
        ...(revoke ? { method: 'DELETE' } : {}),
        headers: { authorization: `Bearer ${identity.secret}`, 'x-kcoder-device': identity.id },
        redirect: 'error',
        signal: request.signal,
      });
      await response.body?.cancel?.().catch(() => {});
      if (response.status === 204) return revoke ? 'revoked' : 'authorized';
      if (response.status === 401 || response.status === 403) return 'denied';
    } finally { request.dispose(); }
  } catch(error) { if(error?.code==='RELAY_IDENTITY_REVOKED')return 'revoked'; /* Reachability and older servers do not prove revocation. */ }
  return 'unknown';
}

/** Register once, cache the assigned identity, and then connect with its private secret. */
export async function startRegisteredClient(options = {}) {
  const { url, gateway = 'http://127.0.0.1:4186', allowInsecure = false,
    retryMs = 2000, onOnline = () => {}, onDiagnostic, signal } = options;
  validateDiagnosticObserver(onDiagnostic);
  const base = validateRelayUrl(url, allowInsecure);
  const target = validateGateway(gateway);
  const assigned = await ensureRegisteredClientIdentity(options);
  checkStartupSignal(signal);
  return startControlClient({ base, secret: assigned.secret, gatewayId: assigned.id, target, retryMs, onOnline, onDiagnostic,
    identityCheck:()=>assertClientIdentityActive({identityFile:options.identityFile??resolveIdentityFile(),relayUrl:validateRelayUrl(url,allowInsecure).origin,gatewaySecret:options.gatewaySecret,...assigned}) });
}

async function runClientCli() {
  loadEnv();
  process.env.KCODER_RELAY_GATEWAY_SECRET = clientGatewaySecret() || '';
  const identityFile = resolveIdentityFile();
  const registrationKey = process.env.KCODER_RELAY_REGISTRATION_KEY;
  const hasRegistrationKey = registrationKey !== undefined && registrationKey !== '';
  const accountLoginToken = process.env.KCODER_RELAY_ACCOUNT_LOGIN_TOKEN || undefined;
  if (accountLoginToken && !/^[A-Za-z0-9_-]{43}$/.test(accountLoginToken)) throw new Error('Invalid KCODER_RELAY_ACCOUNT_LOGIN_TOKEN');
  if (hasRegistrationKey && !CREDENTIAL.test(registrationKey)) throw new Error('Invalid KCODER_RELAY_REGISTRATION_KEY');
  let denied = false;
  const onDiagnostic = event => {
    if (!denied && event.event === 'control_error' && [401, 403].includes(event.handshakeStatus)) {
      denied = true;
      process.exitCode = 1;
      console.error('RELAY_AUTHORIZATION_DENIED');
    }
  };
  let client;
  if (accountLoginToken || hasRegistrationKey || Boolean(process.env.KCODER_RELAY_IDENTITY_FILE) || await clientIdentityPresent(identityFile)) {
    client = await startRegisteredClient({
      url: process.env.KCODER_RELAY_PUBLIC_URL,
      registrationKey: hasRegistrationKey ? registrationKey : undefined,
      accountLoginToken,
      gatewaySecret: process.env.KCODER_RELAY_GATEWAY_SECRET || undefined,
      identityFile,
      gateway: process.env.KCODER_RELAY_LOCAL_GATEWAY,
      onOnline: () => console.log('KCoder relay connected'),
      onDiagnostic,
    });
  } else {
    client = startClient({ ...credentials(), url: process.env.KCODER_RELAY_PUBLIC_URL, gateway: process.env.KCODER_RELAY_LOCAL_GATEWAY, onOnline: () => console.log('KCoder relay connected'), onDiagnostic });
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { client.close(); process.exit(0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runClientCli(); }
  catch (error) {
    if (!(error instanceof GatewayUrlParseError)) throw error;
    process.exitCode = 1;
    console.error(GATEWAY_URL_INVALID);
  }
}
