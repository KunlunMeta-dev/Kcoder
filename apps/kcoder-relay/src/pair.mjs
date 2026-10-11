import { existsSync } from 'node:fs';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import QRCode from 'qrcode';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnv, relayGatewayId, relayServerConfig } from './config.mjs';
import { readRegisteredClientId, resolveIdentityFile } from './client-identity.mjs';

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

/** Build the mobile app deep link without exposing a relay control secret. */
export function buildPairingLink({ publicUrl, token, gatewayId, routeMode, includeGatewayId, client = 'native' } = {}) {
  if (!validPairingToken(token)) throw new Error('Gateway pairing token must be at least 32 characters');
  const parsedPublicUrl = validatedPublicUrl(publicUrl);
  const mode = routeMode ?? (gatewayId !== undefined ? 'path' : 'legacy');
  let gateway = publicUrl;
  if (mode === 'path') {
    if (!validGatewayId(gatewayId)) throw new Error('Path routing requires a valid Gateway ID');
    parsedPublicUrl.pathname = `/g/${gatewayId}`;
    gateway = parsedPublicUrl.toString().replace(/\/$/, '');
  } else if (mode !== 'legacy') {
    throw new Error(`Unsupported relay route mode: ${mode}`);
  }

  if (client !== 'native' && client !== 'web') throw new Error('Unsupported pairing client');
  const deepLink = client === 'web'
    ? new URL(`${gateway.replace(/\/$/, '')}/mobile/connect`)
    : new URL('kcoder-studio://connect');
  deepLink.searchParams.set('gateway', gateway);
  if (client === 'web') deepLink.hash = new URLSearchParams({ token }).toString();
  else deepLink.searchParams.set('token', token);
  if (includeGatewayId === true || (includeGatewayId !== false && mode === 'path')) {
    if (!validGatewayId(gatewayId)) throw new Error('A valid Gateway ID is required for explicit routing');
    deepLink.searchParams.set('gatewayId', gatewayId);
  }
  return deepLink.toString();
}

export async function writePairingQr({ env = process.env, output, onMobileEntry } = {}) {
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
    const pairingToken = env.KCODER_RELAY_GATEWAY_TOKEN;
    let id;
    try {
      id = await readRegisteredClientId({
        identityFile,
        relayUrl: env.KCODER_RELAY_PUBLIC_URL,
        pairingToken: pairingToken || undefined,
      });
    } catch (error) {
      if (/Client identity file does not exist|Client identity is not registered/.test(error.message)) {
        throw new Error('Relay client is not registered yet. Start and connect the client before generating the pairing QR.');
      }
      throw error;
    }
    selected = { id, pairingToken };
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
  if (!validPairingToken(selected.pairingToken)) throw new Error('Configure a Gateway pairing token of at least 32 characters');

  const routeMode = autoRegistration ? 'path' : env.KCODER_RELAY_ROUTE_MODE ?? (registryMode ? 'path' : 'legacy');
  if (registryMode && routeMode !== 'path') throw new Error('Registry mode requires path-based Gateway routing');
  if (routeMode === 'host') throw new Error('Host-based Gateway routing is not supported');
  const pairingLink = buildPairingLink({
    publicUrl: env.KCODER_RELAY_PUBLIC_URL,
    token: selected.pairingToken,
    gatewayId: selected.id,
    routeMode,
    includeGatewayId: registryMode || routeMode === 'path',
    client: env.KCODER_RELAY_PAIR_CLIENT || 'native',
  });
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
  const output = await writePairingQr({ output: process.argv[2], onMobileEntry: url => console.log(`Mobile Web: ${url}`) });
  console.log(`Pairing QR saved to ${output}`);
}
