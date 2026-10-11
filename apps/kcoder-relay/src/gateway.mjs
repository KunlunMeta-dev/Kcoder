import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './config.mjs';
import { readRegisteredClientId, resolveIdentityFile } from './client-identity.mjs';
loadEnv();
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const local = new URL(process.env.KCODER_RELAY_LOCAL_GATEWAY || 'http://127.0.0.1:4186');
const relayPublicUrl = process.env.KCODER_RELAY_PUBLIC_URL ? new URL(process.env.KCODER_RELAY_PUBLIC_URL) : null;
const sharedPath = process.env.KCODER_RELAY_ROUTE_MODE === 'path' || Boolean(process.env.KCODER_RELAY_REGISTRATION_KEY);
let relayGatewayId = process.env.KCODER_RELAY_GATEWAY_ID || process.env.KCODER_RELAY_DEVICE_ID;
if (sharedPath && !relayGatewayId && relayPublicUrl) {
  try {
    relayGatewayId = await readRegisteredClientId({
      identityFile: resolveIdentityFile(process.env),
      relayUrl: relayPublicUrl.origin,
      pairingToken: process.env.KCODER_RELAY_GATEWAY_TOKEN,
    });
  } catch {
    console.error('KCoder relay public browser link unavailable: registered Gateway identity is not available yet');
  }
}
if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.pathname !== '/') throw new Error('Relay Gateway must bind to 127.0.0.1');
if ((process.env.KCODER_RELAY_GATEWAY_TOKEN || '').length < 32) throw new Error('Configure KCODER_RELAY_GATEWAY_TOKEN');
const gatewayEnv = { ...process.env };
for (const name of Object.keys(gatewayEnv)) if (name.startsWith('KCODER_RELAY_')) delete gatewayEnv[name];
const child = spawn(process.execPath, [resolve(repo, 'apps/kcoder-studio/dev-server.mjs')], {
  cwd: repo, stdio: 'inherit', env: {
    ...gatewayEnv,
    KCODER_CONFIG_DIR: process.env.KCODER_RELAY_CONFIG_DIR || resolve(repo, 'target/kcoder-relay/config'),
    KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_PORT: local.port || '4186',
    KCODER_STUDIO_AUTH_TOKEN: process.env.KCODER_RELAY_GATEWAY_TOKEN,
    KCODER_STUDIO_PUBLIC_ORIGINS: process.env.KCODER_RELAY_PUBLIC_ORIGINS || process.env.KCODER_RELAY_PUBLIC_URL,
    KCODER_STUDIO_PUBLIC_ACCESS_URL: process.env.KCODER_STUDIO_PUBLIC_ACCESS_URL ||
      (relayPublicUrl && (!sharedPath || relayGatewayId) ? `${relayPublicUrl.origin}${sharedPath ? `/g/${relayGatewayId}` : ''}` : ''),
    KCODER_STUDIO_SERVERS_FILE: process.env.KCODER_RELAY_SERVERS_FILE || resolve(repo, 'target/kcoder-relay/servers.json'),
    KCODER_STUDIO_KCODER_BIN: process.env.KCODER_RELAY_KCODER_BIN || resolve(repo, 'target/debug/kcoder'),
    KCODER_STUDIO_MOCK: '0', KCODER_STUDIO_SCENARIO: '',
  },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
