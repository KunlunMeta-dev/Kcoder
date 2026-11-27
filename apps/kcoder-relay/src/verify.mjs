// This checks an already-running public relay; it never deploys services or requests a model turn.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { loadEnv, relayServerConfig } from './config.mjs';
import { readRegisteredClientId, resolveIdentityFile, clientIdentityPresent } from './client-identity.mjs';
import { createRelayUrls, resolveRelayRouteMode } from '../deploy/config.mjs';
import { verifyRelay } from './verify-client.mjs';

export async function main() {
  loadEnv();
  const configuredId = process.env.KCODER_RELAY_GATEWAY_ID || process.env.KCODER_RELAY_DEVICE_ID;
  const registrationKey = process.env.KCODER_RELAY_REGISTRATION_KEY || '';
  if (registrationKey && !/^[A-Za-z0-9._~-]{32,512}$/.test(registrationKey)) {
    throw new Error('Invalid relay registration key');
  }
  let selectedGateway;
  const identityFile = resolveIdentityFile();
  const identityMode = Boolean(
    registrationKey || process.env.KCODER_RELAY_IDENTITY_FILE
    || await clientIdentityPresent(identityFile)
  );
  let relayConfig;
  if (identityMode) {
    const gatewaySecret = process.env.KCODER_RELAY_GATEWAY_SECRET || '';
    if (!gatewaySecret) throw new Error('Set KCODER_RELAY_GATEWAY_SECRET for this local Gateway before verification');
    const id = await readRegisteredClientId({
      identityFile,
      relayUrl: process.env.KCODER_RELAY_PUBLIC_URL,
      gatewaySecret,
    });
    selectedGateway = { id, gatewaySecret };
  } else {
    relayConfig = relayServerConfig();
    if (configuredId) selectedGateway = relayConfig.gateways.find(gateway => gateway.id === configuredId);
    else if (relayConfig.gateways.length === 1) [selectedGateway] = relayConfig.gateways;
    else throw new Error('Configure KCODER_RELAY_GATEWAY_ID to select a Gateway for verification');
    if (!selectedGateway) throw new Error('Configured Gateway ID is not present in the relay registry');
  }

  const isRegistryMode = identityMode || Boolean(process.env.KCODER_RELAY_REGISTRY_FILE);
  const routeMode = resolveRelayRouteMode({
    registryMode: isRegistryMode,
    routeMode: process.env.KCODER_RELAY_ROUTE_MODE,
  });
  const urls = createRelayUrls({
    publicUrl: process.env.KCODER_RELAY_PUBLIC_URL,
    gatewayId: selectedGateway.id,
    routeMode,
    registryMode: isRegistryMode,
  });
  const evidence = await verifyRelay({ urls, selectedGateway, localGateway: process.env.KCODER_RELAY_LOCAL_GATEWAY });
  console.log(JSON.stringify(evidence, null, 2));
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href) await main();
