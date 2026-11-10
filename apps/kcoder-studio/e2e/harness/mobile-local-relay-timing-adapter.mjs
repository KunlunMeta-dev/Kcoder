import { startLocalRelay } from './local-relay.mjs';

export const MOBILE_LOCAL_RELAY_TIMING_ADAPTER_VERSION = 1;

const MOBILE_WORKER_PATH = '__kcoder_offline_sw.js';
const GATEWAY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROUTE_KINDS = new Set([
  'entry', 'gateway', 'mobile', 'asset', 'api', 'rpc', 'worker', 'worker-scope',
]);
const ENTRY_KEYS = Object.freeze(['available', 'gatewayUrl', 'mobileUrl', 'version']);

/**
 * Start the owned loopback Relay before its Gateway. Both Gateway origin
 * allowlists are returned separately so the caller can inject them before the
 * Gateway starts. The returned route descriptor is usable only for this
 * adapter's single registered Gateway.
 */
export async function startMobileLocalRelayTimingAdapter(context, options = {}) {
  const relay = await startLocalRelay(context, {
    label: options.label ?? 'mobile-relay-timing',
    connectTimeoutMs: options.connectTimeoutMs,
    clientRetryMs: options.clientRetryMs,
    onlineTimeoutMs: options.onlineTimeoutMs,
  });
  const gatewayEnvironment = Object.freeze({
    KCODER_STUDIO_PUBLIC_ORIGINS: relay.origin,
    KCODER_STUDIO_MOBILE_WEB_ORIGINS: relay.origin,
  });
  let registrationAttempted = false;

  async function connectGateway(gateway) {
    if (registrationAttempted) throw new Error('Mobile Relay timing adapter registration is single-attempt');
    registrationAttempted = true;
    try {
      const registered = await relay.connectGateway(gateway);
      const descriptor = createMobileLocalRelayTimingLaneDescriptor(registered);
      return Object.freeze({
        ...descriptor,
        entryValidated: false,
        readMobileEntry: async (fetchImpl = globalThis.fetch) => {
          try {
            await fetchAndValidateMobileLocalRelayEntry(descriptor, fetchImpl);
            return Object.freeze({ ...descriptor, entryValidated: true });
          } catch {
            await relay.close().catch(() => {});
            throw new Error('Could not validate the owned Relay Mobile entry route');
          }
        },
      });
    } catch (error) {
      await relay.close().catch(() => {});
      throw error;
    }
  }

  return Object.freeze({
    version: MOBILE_LOCAL_RELAY_TIMING_ADAPTER_VERSION,
    origin: relay.origin,
    gatewayEnvironment,
    connectGateway,
    isOnline: relay.isOnline,
    diagnostics: relay.diagnostics,
    droppedDiagnosticCount: relay.droppedDiagnosticCount,
    close: relay.close,
  });
}

/** Build and validate the exact routes returned by startLocalRelay.connectGateway. */
export function createMobileLocalRelayTimingLaneDescriptor(registered) {
  const origin = validateLocalRelayOrigin(registered?.origin);
  const gatewayBase = parseExactUrl(registered?.gatewayBaseUrl, origin);
  const gatewayMatch = /^\/g\/([A-Za-z0-9_-]{1,64})$/.exec(gatewayBase.pathname);
  if (!gatewayMatch) throw new Error('Owned Relay Gateway route has an invalid mount prefix');

  const gatewayPrefix = `/g/${gatewayMatch[1]}`;
  const gatewayUrl = `${origin}${gatewayPrefix}`;
  const mobileEntryUrl = `${gatewayUrl}/mobile-entry`;
  const mobilePath = `${gatewayPrefix}/mobile/`;
  const mobileUrl = `${origin}${mobilePath}`;
  const workerPath = `${mobilePath}${MOBILE_WORKER_PATH}`;
  const workerUrl = `${origin}${workerPath}`;
  const workerScope = mobileUrl;
  const rpcUrl = `${origin.replace(/^http:/, 'ws:')}${gatewayPrefix}/rpc`;

  if (registered.gatewayBaseUrl !== gatewayUrl ||
      registered.mobileEntryUrl !== mobileEntryUrl || registered.mobileUrl !== mobileUrl) {
    throw new Error('Owned Relay Gateway routes do not share one exact mount prefix');
  }

  const descriptor = {
    version: MOBILE_LOCAL_RELAY_TIMING_ADAPTER_VERSION,
    origin,
    gatewayPrefix,
    gatewayUrl,
    mobileEntryUrl,
    mobileUrl,
    rpcUrl,
    workerUrl,
    workerScope,
    workerScopePath: mobilePath,
    assertRouteUrl(url, kind) {
      return assertMobileLocalRelayTimingRoute(descriptor, url, kind);
    },
    safeSummary() {
      return redactedMobileLocalRelayTimingSummary(descriptor);
    },
  };
  return Object.freeze(descriptor);
}

/** Validate the public entry payload without retaining or returning its body. */
export function validateMobileLocalRelayEntry(lane, payload) {
  if (!lane || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Relay Mobile entry does not match its owned mount');
  }
  const keys = Object.keys(payload).sort();
  if (keys.length !== ENTRY_KEYS.length || keys.some((key, index) => key !== ENTRY_KEYS[index])) {
    throw new Error('Relay Mobile entry does not match its owned mount');
  }
  if (payload.version !== 1 || payload.available !== true ||
      payload.mobileUrl !== lane.mobileUrl || payload.gatewayUrl !== lane.gatewayUrl) {
    throw new Error('Relay Mobile entry does not match its owned mount');
  }
  validateExactMountedUrl(payload.mobileUrl, lane.origin, lane.mobileUrl);
  validateExactMountedUrl(payload.gatewayUrl, lane.origin, lane.gatewayUrl);
  return true;
}

/** Assert that a browser-observed URL belongs to the exact Relay Gateway mount. */
export function assertMobileLocalRelayTimingRoute(lane, rawUrl, kind) {
  if (!lane || !ROUTE_KINDS.has(kind)) throw new Error('Unsupported Mobile Relay route assertion');
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error('Mobile Relay route violates its owned mount'); }
  if (url.username || url.password || url.hash || !safePathname(url.pathname)) {
    throw new Error('Mobile Relay route violates its owned mount');
  }

  const expectedOrigin = new URL(lane.origin);
  const websocket = kind === 'rpc';
  const expectedProtocol = websocket
    ? (expectedOrigin.protocol === 'https:' ? 'wss:' : 'ws:')
    : expectedOrigin.protocol;
  if (url.protocol !== expectedProtocol || url.host !== expectedOrigin.host) {
    throw new Error('Mobile Relay route violates its owned mount');
  }

  const exactPath = {
    entry: `${lane.gatewayPrefix}/mobile-entry`,
    gateway: lane.gatewayPrefix,
    mobile: lane.workerScopePath,
    rpc: `${lane.gatewayPrefix}/rpc`,
    worker: new URL(lane.workerUrl).pathname,
    'worker-scope': lane.workerScopePath,
  }[kind];
  let matches = false;
  if (exactPath !== undefined) {
    matches = url.pathname === exactPath;
    if (kind !== 'rpc' && url.search) matches = false;
  } else if (kind === 'asset') {
    matches = url.pathname.startsWith(lane.workerScopePath) && url.pathname !== lane.workerScopePath;
  } else if (kind === 'api') {
    const apiPrefix = `${lane.gatewayPrefix}/api/`;
    matches = url.pathname.startsWith(apiPrefix) && url.pathname.length > apiPrefix.length;
  }
  if (!matches) throw new Error('Mobile Relay route violates its owned mount');
  return true;
}

/** A safe artifact projection: no Gateway ID, pairing token, URL query, or raw entry body. */
export function redactedMobileLocalRelayTimingSummary(lane) {
  if (!lane || typeof lane.origin !== 'string') throw new Error('Invalid Mobile Relay lane descriptor');
  return Object.freeze({
    adapterVersion: MOBILE_LOCAL_RELAY_TIMING_ADAPTER_VERSION,
    origin: lane.origin,
    gatewayPath: '/g/<gateway>',
    entryPath: '/g/<gateway>/mobile-entry',
    mobilePath: '/g/<gateway>/mobile/',
    apiPathPrefix: '/g/<gateway>/api/',
    rpcPath: '/g/<gateway>/rpc',
    workerPath: '/g/<gateway>/mobile/__kcoder_offline_sw.js',
    workerScope: '/g/<gateway>/mobile/',
  });
}

export async function fetchAndValidateMobileLocalRelayEntry(lane, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Invalid entry fetch implementation');
  try {
    const response = await fetchImpl(lane.mobileEntryUrl, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response || response.status !== 200 || response.redirected === true ||
        (typeof response.url === 'string' && response.url !== '' && response.url !== lane.mobileEntryUrl)) {
      throw new Error('Invalid Relay Mobile entry response');
    }
    const contentType = response.headers?.get?.('content-type');
    if (typeof contentType === 'string' && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new Error('Invalid Relay Mobile entry response');
    }
    if (typeof response.json !== 'function') throw new Error('Invalid Relay Mobile entry response');
    validateMobileLocalRelayEntry(lane, await response.json());
  } catch {
    throw new Error('Relay Mobile entry does not match its owned mount');
  }
}

function validateLocalRelayOrigin(rawOrigin) {
  if (typeof rawOrigin !== 'string') throw new Error('Invalid owned Relay origin');
  let url;
  try { url = new URL(rawOrigin); }
  catch { throw new Error('Invalid owned Relay origin'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/' || url.username || url.password || url.search || url.hash ||
      rawOrigin !== url.origin) {
    throw new Error('Invalid owned Relay origin');
  }
  return url.origin;
}

function parseExactUrl(rawUrl, expectedOrigin) {
  if (typeof rawUrl !== 'string') throw new Error('Invalid owned Relay Gateway route');
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error('Invalid owned Relay Gateway route'); }
  if (url.origin !== expectedOrigin || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid owned Relay Gateway route');
  }
  return url;
}

function validateExactMountedUrl(rawUrl, expectedOrigin, expectedUrl) {
  const url = parseExactUrl(rawUrl, expectedOrigin);
  if (url.href !== expectedUrl) throw new Error('Relay Mobile entry does not match its owned mount');
}

function safePathname(pathname) {
  if (/%(?:2f|5c|00)/i.test(pathname)) return false;
  for (const segment of pathname.split('/')) {
    if (!segment) continue;
    let decoded;
    try { decoded = decodeURIComponent(segment); }
    catch { return false; }
    if (decoded === '.' || decoded === '..' || /[\\/\0]/.test(decoded)) return false;
  }
  return true;
}
