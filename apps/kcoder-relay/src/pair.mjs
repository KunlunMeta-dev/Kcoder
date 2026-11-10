import { isolatedGatewayUrl } from './gateway-origin.mjs';
import { existsSync } from 'node:fs';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { TextDecoder } from 'node:util';
import QRCode from 'qrcode';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv, relayGatewayId, relayServerConfig, clientGatewaySecret } from './config.mjs';
import { readRegisteredClientId, resolveIdentityFile } from './client-identity.mjs';
import {
  canonicalGatewayConnectionUrl,
  isLoopbackGatewayConnectionUrl,
  parseGatewayConnectionRoutes,
} from './connection-routes.mjs';

const MAX_CONNECTION_ROUTES_BYTES = 32 * 1024;
const LOCAL_GATEWAY_REQUEST_TIMEOUT_MS = 5_000;
const MAX_PAIRING_LINK_LENGTH = 8_192;

function validGatewayId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

function validPairingToken(value) {
  return typeof value === 'string' && value.length >= 32 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validatedPublicUrl(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Configure KCODER_RELAY_PUBLIC_URL');
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error('Invalid KCODER_RELAY_PUBLIC_URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('KCODER_RELAY_PUBLIC_URL must be an HTTPS URL without credentials, query, or fragment');
  }
  return parsed;
}

function validatedConnectionRoutes(value, gateway) {
  const routes = parseGatewayConnectionRoutes(value);
  if (!routes) throw new Error('Local Gateway returned invalid connection routes');
  const canonicalGateway = canonicalGatewayConnectionUrl(gateway);
  if (!canonicalGateway || !routes.endpoints.some(endpoint =>
    endpoint.kind === 'public' && endpoint.url === canonicalGateway)) {
    throw new Error('Local Gateway connection routes do not contain the paired public Gateway URL');
  }
  return routes;
}

function localGatewayForRouteDiscovery(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid KCODER_RELAY_LOCAL_GATEWAY for route discovery');
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error('Invalid KCODER_RELAY_LOCAL_GATEWAY for route discovery'); }
  if (parsed.protocol !== 'http:' || !isLoopbackGatewayConnectionUrl(value) ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.port === '0') {
    throw new Error('KCODER_RELAY_LOCAL_GATEWAY for route discovery must be a loopback HTTP URL without credentials, path, query, or fragment');
  }
  return parsed;
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CONNECTION_ROUTES_BYTES) {
    throw new Error('Local Gateway pairing response is too large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Local Gateway pairing response is empty');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CONNECTION_ROUTES_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Local Gateway pairing response is too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)); }
  catch { throw new Error('Local Gateway pairing response is not valid UTF-8'); }
  try { return JSON.parse(text); }
  catch { throw new Error('Local Gateway pairing response is not valid JSON'); }
}

export async function fetchGatewayPairing({ localGateway, gatewaySecret, publicGateway, tokenMode = 'auto', fetchImpl = globalThis.fetch }) {
  const local = localGatewayForRouteDiscovery(localGateway);
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(gatewaySecret || '')) throw new Error('Configure a private Gateway Relay secret');
  if (!['auto', 'fixed', 'temporary'].includes(tokenMode)) throw new Error('Invalid mobile pairing token mode');
  let response;
  try {
    response = await fetchImpl(new URL('/api/mobile/pairing/relay', local), {
      method: 'GET', headers: { 'x-kcoder-relay-validation': gatewaySecret, 'x-kcoder-pairing-token-mode': tokenMode },
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(LOCAL_GATEWAY_REQUEST_TIMEOUT_MS),
    });
  } catch { throw new Error('Local Gateway pairing discovery failed'); }
  if (response.status !== 200) throw new Error(`Local Gateway pairing discovery failed (HTTP ${response.status})`);
  const pairing = await readBoundedJson(response);
  const validCredential = pairing?.kind === 'fixed'
    ? /^[A-Za-z0-9._~-]{32,512}$/.test(pairing.token || '') && pairing.expiresAt === null
    : pairing?.kind === 'temporary' && /^[a-f0-9]{64}$/.test(pairing.token || '') && Number.isSafeInteger(pairing.expiresAt) && pairing.expiresAt > Date.now();
  if (!validCredential || (tokenMode !== 'auto' && pairing.kind !== tokenMode) || pairing.token === gatewaySecret ||
      canonicalGatewayConnectionUrl(pairing.publicBaseUrl) !== canonicalGatewayConnectionUrl(publicGateway)) {
    throw new Error('Local Gateway returned invalid mobile pairing credentials');
  }
  return { kind: pairing.kind, token: pairing.token, expiresAt: pairing.expiresAt,
    connectionRoutes: validatedConnectionRoutes(pairing.connectionRoutes, publicGateway) };
}

function pairingGateway(publicUrl, gatewayId, routeMode) {
  const parsedPublicUrl = validatedPublicUrl(publicUrl);
  const mode = routeMode ?? (gatewayId !== undefined ? 'path' : 'legacy');
  let gateway = publicUrl;
  if (mode === 'path') {
    if (!validGatewayId(gatewayId)) throw new Error('Path routing requires a valid Gateway ID');
    gateway = isolatedGatewayUrl(parsedPublicUrl, gatewayId).toString().replace(/\/$/, '');
  } else if (mode !== 'legacy') {
    throw new Error(`Unsupported relay route mode: ${mode}`);
  }

  return { gateway, mode };
}

/** Build the mobile app deep link without exposing a relay control secret. */
export function buildPairingLink({ publicUrl, token, gatewayId, routeMode, includeGatewayId, client = 'native', connectionRoutes } = {}) {
  if (!validPairingToken(token)) throw new Error('Gateway pairing token must be at least 32 characters');
  const { gateway, mode } = pairingGateway(publicUrl, gatewayId, routeMode);

  const routes = connectionRoutes === undefined ? undefined : validatedConnectionRoutes(connectionRoutes, gateway);

  if (client !== 'native' && client !== 'web') throw new Error('Unsupported pairing client');
  const deepLink = client === 'web'
    ? new URL(`${gateway.replace(/\/$/, '')}/mobile/connect`)
    : new URL('kcoder-studio://connect');
  deepLink.searchParams.set('gateway', gateway);
  if (routes) deepLink.searchParams.set('routes', JSON.stringify(routes));
  if (client === 'web') deepLink.hash = new URLSearchParams({ token }).toString();
  else deepLink.searchParams.set('token', token);
  if (includeGatewayId === true || (includeGatewayId !== false && mode === 'path')) {
    if (!validGatewayId(gatewayId)) throw new Error('A valid Gateway ID is required for explicit routing');
    deepLink.searchParams.set('gatewayId', gatewayId);
  }
  const link = deepLink.toString();
  if (link.length > MAX_PAIRING_LINK_LENGTH) throw new Error('Pairing link exceeds the supported 8192-character limit');
  return link;
}

export async function writePairingQr({ env = process.env, output, onMobileEntry, fetchImpl = globalThis.fetch } = {}) {
  let selected;
  const identityFile = resolveIdentityFile(env);
  const registrationKey = env.KCODER_RELAY_REGISTRATION_KEY;
  const hasRegistrationKey = registrationKey !== undefined && registrationKey !== '';
  if (hasRegistrationKey && !/^[A-Za-z0-9._~-]{32,512}$/.test(registrationKey)) throw new Error('Invalid KCODER_RELAY_REGISTRATION_KEY');
  const autoRegistration = hasRegistrationKey
    || Boolean(env.KCODER_RELAY_IDENTITY_FILE)
    || existsSync(identityFile);
  let registryMode = Boolean(env.KCODER_RELAY_REGISTRY_FILE);
  if (autoRegistration) {
    const gatewaySecret = env.KCODER_RELAY_GATEWAY_SECRET;
    let id;
    try {
      id = await readRegisteredClientId({
        identityFile,
        relayUrl: env.KCODER_RELAY_PUBLIC_URL,
        gatewaySecret: gatewaySecret || undefined,
      });
    } catch (error) {
      if (/Client identity file does not exist|Client identity is not registered/.test(error.message)) {
        throw new Error('Relay client is not registered yet. Start and connect the client before generating the pairing QR.');
      }
      throw error;
    }
    selected = { id, gatewaySecret };
    registryMode = true;
  } else {
    const config = relayServerConfig(env);
    const hasConfiguredId = env.KCODER_RELAY_GATEWAY_ID !== undefined || env.KCODER_RELAY_DEVICE_ID !== undefined;
    const requestedId = hasConfiguredId ? relayGatewayId(env) : undefined;
    if (requestedId !== undefined) selected = config.gateways.find(gateway => gateway.id === requestedId);
    else if (config.gateways.length === 1) [selected] = config.gateways;
    else throw new Error('Configure KCODER_RELAY_GATEWAY_ID to select a Gateway for pairing');
    if (!selected) throw new Error('Configured Gateway ID is not present in the relay registry');
  }
  if (!validPairingToken(selected.gatewaySecret)) throw new Error('Configure a private Gateway Relay secret');

  const routeMode = autoRegistration ? 'path' : env.KCODER_RELAY_ROUTE_MODE ?? (registryMode ? 'path' : 'legacy');
  if (registryMode && routeMode !== 'path') throw new Error('Registry mode requires path-based Gateway routing');
  if (routeMode === 'host') throw new Error('Host-based Gateway routing is not supported');
  const pairingOptions = {
    publicUrl: env.KCODER_RELAY_PUBLIC_URL,
    gatewayId: selected.id,
    routeMode,
    includeGatewayId: registryMode || routeMode === 'path',
    client: env.KCODER_RELAY_PAIR_CLIENT || 'native',
  };
  const { gateway: publicGateway } = pairingGateway(pairingOptions.publicUrl, selected.id, routeMode);
  const pairing = await fetchGatewayPairing({ localGateway: env.KCODER_RELAY_LOCAL_GATEWAY || 'http://127.0.0.1:4186',
    gatewaySecret: selected.gatewaySecret, publicGateway, tokenMode: env.KCODER_STUDIO_MOBILE_PAIRING_MODE || 'auto', fetchImpl });
  const pairingLink = buildPairingLink({ ...pairingOptions, token: pairing.token, connectionRoutes: pairing.connectionRoutes });
  const destination = resolve(output || resolve(dirname(fileURLToPath(import.meta.url)), '../../../target/kcoder-relay/pairing.png'));
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const bytes = await QRCode.toBuffer(pairingLink, { type: 'png', width: 600, margin: 3 });
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  if (onMobileEntry) {
    const pairedGateway = new URL(pairingLink).searchParams.get('gateway');
    onMobileEntry(`${pairedGateway.replace(/\/$/, '')}/mobile/`);
  }
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  process.env.KCODER_RELAY_GATEWAY_SECRET = clientGatewaySecret() || '';
  const output = await writePairingQr({ output: process.argv[2], onMobileEntry: url => console.log(`Mobile Web: ${url}`) });
  console.log(`Pairing QR saved to ${output}`);
}
