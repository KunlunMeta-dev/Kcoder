import { existsSync } from 'node:fs';
import { relayGatewayId } from './config.mjs';
import { readRegisteredClientId, resolveIdentityFile } from './client-identity.mjs';
import { createRelayUrls, resolveRelayRouteMode } from '../deploy/config.mjs';

/**
 * The Gateway must accept the origin it is presented on. Older private env
 * files may list only the shared Relay root; the derived isolated origin is
 * added rather than requiring per-Gateway configuration.
 */
export function gatewayPublicOrigins(configured, publicAccessUrl) {
  const origins = String(configured || '').split(',').map(value => value.trim()).filter(Boolean);
  if (publicAccessUrl) {
    const origin = new URL(publicAccessUrl).origin;
    if (!origins.some(value => { try { return new URL(value).origin === origin; } catch { return false; } })) origins.push(origin);
  }
  return origins.join(',');
}

// Match client/verify identity-mode selection; legacy aliases never override an
// assigned identity. Reading presentation metadata cannot enroll a new identity.
export async function resolveGatewayPresentation(env = process.env, {
  identityFile = resolveIdentityFile(env), identityExists = existsSync,
} = {}) {
  const registrationKey = env.KCODER_RELAY_REGISTRATION_KEY;
  if (registrationKey && !/^[A-Za-z0-9._~-]{32,512}$/.test(registrationKey)) throw new Error('Invalid relay registration key');
  const registered = Boolean(registrationKey || env.KCODER_RELAY_IDENTITY_FILE || identityExists(identityFile));
  const registryMode = registered || Boolean(env.KCODER_RELAY_REGISTRY_FILE);
  const routeMode = resolveRelayRouteMode({ registryMode, routeMode: env.KCODER_RELAY_ROUTE_MODE });
  const gatewayId = registered ? await readRegisteredClientId({
    identityFile, relayUrl: env.KCODER_RELAY_PUBLIC_URL, gatewaySecret: env.KCODER_RELAY_GATEWAY_SECRET,
  }) : relayGatewayId(env);
  const urls = env.KCODER_RELAY_PUBLIC_URL ? createRelayUrls({
    publicUrl: env.KCODER_RELAY_PUBLIC_URL, gatewayId, routeMode, registryMode,
  }) : null;
  const publicAccessUrl = urls?.gatewayBase.toString().replace(/\/$/, '') || '';
  if (env.KCODER_STUDIO_PUBLIC_ACCESS_URL && new URL(env.KCODER_STUDIO_PUBLIC_ACCESS_URL).toString().replace(/\/$/, '') !== publicAccessUrl) {
    throw new Error('Public access URL conflicts with the selected Relay identity');
  }
  return { gatewayId, routeMode, publicAccessUrl };
}
