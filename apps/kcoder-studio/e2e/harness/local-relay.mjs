import { createServer as createNetServer } from 'node:net';
import { request as requestHttp } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes as randomCredential } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startRegisteredClient } from '../../../kcoder-relay/src/client.mjs';
import { readRegisteredClientIdentity } from '../../../kcoder-relay/src/client-identity.mjs';
import { startRelay } from '../../../kcoder-relay/src/server.mjs';
import { isolatedGatewayAuthority } from '../../../kcoder-relay/src/gateway-origin.mjs';
import { waitFor } from './run-context.mjs';

const LOOPBACK = '127.0.0.1';
const MAX_DIAGNOSTICS = 2_000;
const CREDENTIAL = /^[A-Za-z0-9._~-]{32,512}$/;
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const DIAGNOSTIC_EVENTS = new Set([
  'control_connecting', 'control_error', 'control_open', 'control_close',
  'open_received', 'open_rejected', 'data_connecting', 'data_error', 'data_open',
  'data_close', 'local_connecting', 'local_error', 'local_connect', 'local_close',
  'bridge_closed', 'reconnect_scheduled', 'client_stopped',
]);

/** Reach this run's canonical Gateway authority over its owned loopback listener. */
export function fetchOwnedLocalRelay(registered, rawUrl, { signal, headers = {}, timeoutMs = 5_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('Local Relay fetch timeout must be a positive integer within 30000ms');
  }
  const target = new URL(rawUrl);
  const origin = new URL(registered.origin);
  const transport = new URL(registered.transportOrigin);
  const expected = isolatedGatewayAuthority(`relay.kcoder.localhost:${transport.port}`, registered.gatewayId);
  const prefix = `/g/${registered.gatewayId}`;
  if (origin.protocol !== 'http:' || origin.host !== expected || target.origin !== origin.origin ||
      target.username || target.password || target.hash ||
      !(target.pathname === prefix || target.pathname.startsWith(`${prefix}/`)) ||
      transport.protocol !== 'http:' || transport.hostname !== LOOPBACK || transport.pathname !== '/' ||
      transport.search || transport.hash || transport.username || transport.password ||
      origin.port !== transport.port || registered.transportHeaders?.host !== expected) {
    throw new Error('Local Relay fetch requires its exact owned Gateway and loopback transport');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return new Promise((accept, reject) => {
    const request = requestHttp({ hostname: LOOPBACK, port: transport.port, method: 'GET',
      path: target.pathname + target.search, headers: { ...headers, host: expected }, signal: abort }, response => {
      try {
        const bodyless = [204, 205, 304].includes(response.statusCode);
        if (bodyless) response.resume();
        const result = new Response(bodyless ? null : Readable.toWeb(response), {
          status: response.statusCode,
          headers: Object.entries(response.headers).flatMap(([name, value]) =>
            value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(item => [name, item])),
        });
        Object.defineProperty(result, 'url', { value: target.href });
        accept(result);
      } catch (error) { response.destroy(); reject(error); }
    });
    request.once('error', reject);
    request.end();
  });
}
const DIAGNOSTIC_ERROR_KINDS = new Set(['handshake_status', 'timeout', 'refused', 'reset', 'unreachable', 'protocol', 'transport']);
const REJECT_REASONS = new Set(['invalid_frame', 'invalid_open', 'socket_capacity', 'gateway_mismatch']);

/**
 * Start one isolated loopback Relay before its Gateway, so callers can configure
 * the Gateway's public/mobile origin before the Gateway starts.
 *
 * connectGateway is deliberately single-attempt: a lost registration result is
 * not replayed against another Gateway. The supplied Gateway must own a port
 * already registered in this RunContext.
 */
export async function startLocalRelay(context, {
  label = 'local-relay',
  connectTimeoutMs = 5_000,
  clientRetryMs = 100,
  onlineTimeoutMs = 10_000,
} = {}, { launch = startRelay } = {}) {
  assertContext(context);
  if (typeof launch !== 'function') throw new Error('Local Relay launch must be a function');
  if (!LABEL.test(label)) throw new Error('Invalid local Relay label');
  if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 10_000 ||
      !Number.isSafeInteger(clientRetryMs) || clientRetryMs < 25 || clientRetryMs > 5_000 ||
      !Number.isSafeInteger(onlineTimeoutMs) || onlineTimeoutMs < 1 || onlineTimeoutMs > 30_000) {
    throw new Error('Invalid local Relay timing budget');
  }

  const registrationKey = randomCredential(32).toString('base64url');
  context.registerSecret(registrationKey);
  const scratch = typeof process.getuid === 'function' && typeof context.createOwnedScratchDirectory === 'function'
    ? await context.createOwnedScratchDirectory(`${label}-private-store`, { baseDirectory: await realpath(tmpdir()), requireCleanupConfirmation: true })
    : null;
  const ownedPath = name => scratch ? context.pathInScratch(scratch, name) : context.pathInState(name);
  const registrationStoreFile = ownedPath(`${label}-registration-store.json`);
  const identityFile = ownedPath(`${label}-client-identity.json`);
  let proxyPort, authority, origin, pendingRelay, relayClosing = false;
  const diagnostics = [];
  let droppedDiagnostics = 0;
  let relay;
  let client;
  let pendingClient;
  let online = false;
  let connectAttempted = false;
  let clientClosePromise;
  let relayClosePromise;
  let closePromise;

  const closeClient = () => {
    if (!clientClosePromise) {
      online = false;
      clientClosePromise = Promise.resolve().then(async () => (client ?? await pendingClient)?.close());
    }
    return clientClosePromise;
  };
  const closeRelay = () => {
    relayClosing = true;
    if (!relayClosePromise) relayClosePromise = Promise.resolve().then(async () => {
      let original = relay;
      if (!original && pendingRelay) {
        try { original = await pendingRelay; }
        catch (error) { if (!await canRetryOwnedRelayStartup(error, registrationStoreFile)) throw error; }
      }
      await original?.close();
      if (scratch) await context.confirmOwnedScratchCleanup(scratch);
    });
    return relayClosePromise;
  };
  const close = () => {
    if (!closePromise) closePromise = closeOwnedLocalRelayResources(closeClient, closeRelay);
    return closePromise;
  };

  context.addCleanup(`close ${label} Relay`, closeRelay);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const reservation = await reserveProxyPort(context, `${label}-startup-${attempt + 1}`);
      await reservation.release();
      context.assertActive?.();
      if (relayClosing) throw new Error('Local Relay stopped before listener startup');
      proxyPort = reservation.port;
      authority = `relay.kcoder.localhost:${proxyPort}`;
      origin = `http://${LOOPBACK}:${proxyPort}`;
      pendingRelay = launch({ gateways: [], sharedHosts: [authority], registrationKey, registrationStoreFile,
        controlPort: 0, proxyPort, connectTimeout: connectTimeoutMs });
      try { relay = await pendingRelay; break; }
      catch (error) {
        // The Relay API rolls back failed listens. Never retry while its original store lock remains.
        if (attempt === 2 || relayClosing || !await canRetryOwnedRelayStartup(error, registrationStoreFile)) throw error;
      }
    }
  } catch (error) {
    throw safeFailure(context, 'Could not start the owned local Relay', error);
  }
  if (relay.proxyPort !== proxyPort) {
    await relay.close();
    throw new Error('Owned local Relay did not bind its reserved proxy port');
  }
  try {
    context.registerPort(`${label}-control`, relay.controlPort);
  } catch (error) {
    await closeRelay();
    throw error;
  }

  async function connectGateway(gateway, { gatewaySecret = gateway?.authToken } = {}) {
    if (closePromise || relayClosing) throw new Error('Local Relay is already closing');
    if (connectAttempted) throw new Error('Local Relay Gateway registration is single-attempt');
    const target = validateOwnedGateway(context, gateway, [proxyPort, relay.controlPort]);
    context.registerSecret(gateway.authToken);
    if (!CREDENTIAL.test(gatewaySecret || '')) throw new Error('Owned Relay requires a bounded Gateway internal credential');
    context.registerSecret(gatewaySecret);
    if (gatewaySecret === registrationKey) throw new Error('Gateway pairing token must be independent from Relay registration key');
    connectAttempted = true;

    try {
      pendingClient = startRegisteredClient({
        url: `http://${LOOPBACK}:${relay.controlPort}`,
        registrationKey,
        gatewaySecret,
        identityFile,
        gateway: target.origin,
        allowInsecure: true,
        retryMs: clientRetryMs,
        onOnline: () => { online = true; },
        onDiagnostic: record => {
          const safe = safeDiagnostic(record);
          if (!safe) return;
          if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(safe);
          else droppedDiagnostics += 1;
          if (safe.event === 'control_open') online = true;
          if (safe.event === 'control_close' || safe.event === 'client_stopped') online = false;
        },
      });
      client = await pendingClient;
      if (closePromise) {
        await closeClient();
        throw new Error('Local Relay closed during Gateway registration');
      }
      context.addCleanup(`close ${label} registered Gateway client`, closeClient);
      const identity = await readRegisteredClientIdentity({
        identityFile,
        relayUrl: `http://${LOOPBACK}:${relay.controlPort}`,
        gatewaySecret,
      });
      context.registerSecret(identity.secret);
      await waitFor(() => online ? true : null, onlineTimeoutMs,
        `${label} registered Gateway control channel`, 50, context.abortSignal);

      const gatewayAuthority = isolatedGatewayAuthority(authority, identity.id);
      const gatewayOrigin = `http://${gatewayAuthority}`;
      const gatewayBaseUrl = `${gatewayOrigin}/g/${identity.id}`;
      return Object.freeze({
        gatewayId: identity.id,
        origin: gatewayOrigin,
        transportOrigin: origin,
        transportGatewayBaseUrl: `${origin}/g/${identity.id}`,
        transportHeaders: Object.freeze({ host: gatewayAuthority }),
        gatewayBaseUrl,
        mobileEntryUrl: `${gatewayBaseUrl}/mobile-entry`,
        mobileUrl: `${gatewayBaseUrl}/mobile/`,
        isOnline: () => online,
        diagnostics: () => diagnostics.map(record => ({ ...record })),
        droppedDiagnosticCount: () => droppedDiagnostics,
      });
    } catch (error) {
      await closeClient().catch(() => {});
      throw safeFailure(context, 'Could not register or connect the owned Gateway to local Relay', error);
    }
  }

  return Object.freeze({
    origin,
    authority,
    publicOrigin: `http://${authority}`,
    controlPort: relay.controlPort,
    proxyPort,
    connectGateway,
    registrationObservationSource: () => Object.freeze({ identityFile, relayOrigin: `http://${LOOPBACK}:${relay.controlPort}` }),
    privateStorePaths: () => Object.freeze({ registrationStoreFile, identityFile }),
    isOnline: () => online,
    diagnostics: () => diagnostics.map(record => ({ ...record })),
    droppedDiagnosticCount: () => droppedDiagnostics,
    close,
  });
}

export async function canRetryOwnedRelayStartup(error, registrationStoreFile) {
  if (error?.code !== 'EADDRINUSE') return false;
  try { await lstat(`${registrationStoreFile}.lock`); return false; }
  catch (inspectionError) { if (inspectionError.code === 'ENOENT') return true; throw inspectionError; }
}

export async function closeOwnedLocalRelayResources(closeClient, closeRelay) {
  if (typeof closeClient !== 'function' || typeof closeRelay !== 'function') {
    throw new Error('Local Relay cleanup requires owned client and Relay closers');
  }
  const failures = [];
  for (const closeResource of [closeClient, closeRelay]) {
    try { await closeResource(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Owned local Relay client and Relay cleanup failed');
}

function assertContext(context) {
  for (const method of ['pathInState', 'registerPort', 'registerSecret', 'addCleanup', 'redactText']) {
    if (typeof context?.[method] !== 'function') throw new Error('Local Relay requires an active RunContext');
  }
}

function validateOwnedGateway(context, gateway, relayPorts) {
  if (!gateway || typeof gateway !== 'object' || typeof gateway.baseUrl !== 'string' ||
      typeof gateway.authToken !== 'string' || !CREDENTIAL.test(gateway.authToken)) {
    throw new Error('Local Relay requires an authenticated owned Gateway');
  }
  let target;
  try { target = new URL(gateway.baseUrl); }
  catch { throw new Error('Invalid owned Gateway origin'); }
  if (target.protocol !== 'http:' || target.hostname !== LOOPBACK || target.pathname !== '/' ||
      target.username || target.password || target.search || target.hash ||
      !Number.isSafeInteger(gateway.port) || Number(target.port) !== gateway.port ||
      !context.ports.some(row => row.port === gateway.port) || relayPorts.includes(gateway.port)) {
    throw new Error('Gateway must be a RunContext-owned loopback origin');
  }
  return { origin: target.origin };
}

async function reserveProxyPort(context, label) {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a loopback Relay port');
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  };
  try {
    context.registerPort(`${label}-proxy`, address.port);
    context.addCleanup(`release ${label} Relay port reservation`, release);
  } catch (error) {
    await release();
    throw error;
  }
  return { port: address.port, release };
}

function safeDiagnostic(record) {
  if (!record || typeof record !== 'object' || !DIAGNOSTIC_EVENTS.has(record.event)) return null;
  const result = { event: record.event };
  if (Number.isSafeInteger(record.generation)) result.generation = record.generation;
  if (Number.isFinite(record.atUnixMs)) result.atUnixMs = record.atUnixMs;
  if (Number.isFinite(record.monotonicMs)) result.monotonicMs = record.monotonicMs;
  if (typeof record.correlation === 'string' && /^[a-f0-9]{64}$/.test(record.correlation)) result.correlation = record.correlation;
  if (DIAGNOSTIC_ERROR_KINDS.has(record.errorKind)) result.errorKind = record.errorKind;
  if (Number.isInteger(record.handshakeStatus) && record.handshakeStatus >= 100 && record.handshakeStatus <= 599) result.handshakeStatus = record.handshakeStatus;
  if (Number.isInteger(record.closeCode) && record.closeCode >= 1000 && record.closeCode <= 4999) result.closeCode = record.closeCode;
  if (typeof record.hadError === 'boolean') result.hadError = record.hadError;
  if (REJECT_REASONS.has(record.rejectReason)) result.rejectReason = record.rejectReason;
  return result;
}

function safeFailure(context, prefix, error) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${prefix}: ${context.redactText(message)}`);
}
