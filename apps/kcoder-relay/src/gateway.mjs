import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, clientGatewaySecret } from './config.mjs';
import { resolveIdentityFile } from './client-identity.mjs';
import { gatewayPublicOrigins, resolveGatewayPresentation } from './gateway-presentation.mjs';
import { gatewayStunUrl } from '../../kcoder-studio/src/gateway-connectivity.js';
import { sourceAppServerBinary } from '../../kcoder-studio/src/source-app-server-binary.js';
import { spawn } from 'node:child_process';
import { gatewayRelayOptions } from '../../kcoder-studio/src/gateway-relay-management.js';
import { readRelayConfiguration } from '../../kcoder-studio/src/gateway-relay-instance.js';
loadEnv();
process.env.KCODER_RELAY_GATEWAY_SECRET = clientGatewaySecret() || '';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const local = new URL(process.env.KCODER_RELAY_LOCAL_GATEWAY || 'http://127.0.0.1:4186');
const presentation = await resolveGatewayPresentation();
if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.pathname !== '/') throw new Error('Relay Gateway must bind to 127.0.0.1');
const gatewayHost = process.env.KCODER_RELAY_GATEWAY_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0', '::'].includes(gatewayHost)) {
  throw new Error('KCODER_RELAY_GATEWAY_HOST must be 127.0.0.1, 0.0.0.0, or ::');
}
if ((process.env.KCODER_RELAY_GATEWAY_SECRET || '').length < 32) throw new Error('Configure KCODER_RELAY_GATEWAY_SECRET');
const gatewayEnv = { ...process.env };
for (const name of Object.keys(gatewayEnv)) if (name.startsWith('KCODER_RELAY_')) delete gatewayEnv[name];
const { userDataDir } = gatewayRelayOptions(gatewayEnv);
const selection = await readRelayConfiguration(gatewayEnv.KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE || resolve(userDataDir, 'desktop-relay.json'));
const instanceOwned = Boolean(selection?.disabled || selection?.selectedProfile);
const child = spawn(process.execPath, [resolve(repo, 'apps/kcoder-studio/dev-server.mjs')], {
  cwd: repo, stdio: 'inherit', env: {
    ...gatewayEnv,
    KCODER_CONFIG_DIR: process.env.KCODER_RELAY_CONFIG_DIR || resolve(repo, 'target/kcoder-relay/config'),
    KCODER_STUDIO_HOST: gatewayHost,
    KCODER_STUDIO_PORT: local.port || '4186',
    KCODER_STUDIO_RELAY_SECRET: instanceOwned ? '' : process.env.KCODER_RELAY_GATEWAY_SECRET,
    KCODER_STUDIO_RELAY_IDENTITY_FILE: instanceOwned ? '' : resolveIdentityFile(process.env),
    KCODER_STUDIO_RELAY_ORIGIN: instanceOwned ? '' : process.env.KCODER_RELAY_PUBLIC_URL,
    KCODER_STUDIO_P2P_STUN_URLS: process.env.KCODER_STUDIO_P2P_STUN_URLS ?? gatewayStunUrl(process.env.KCODER_RELAY_PUBLIC_URL || presentation.publicAccessUrl, process.env.KCODER_RELAY_STUN_PORT || 8452),
    KCODER_STUDIO_PUBLIC_ORIGINS: instanceOwned ? (gatewayEnv.KCODER_STUDIO_PUBLIC_ORIGINS || '') :
      gatewayPublicOrigins(process.env.KCODER_RELAY_PUBLIC_ORIGINS, presentation.publicAccessUrl),
    KCODER_STUDIO_PUBLIC_ACCESS_URL: instanceOwned ? '' : presentation.publicAccessUrl,
    KCODER_STUDIO_SERVERS_FILE: process.env.KCODER_RELAY_SERVERS_FILE || resolve(repo, 'target/kcoder-relay/servers.json'),
    KCODER_STUDIO_KCODER_BIN: process.env.KCODER_RELAY_KCODER_BIN || sourceAppServerBinary(repo),
    KCODER_STUDIO_MOCK: '0', KCODER_STUDIO_SCENARIO: '',
  },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
