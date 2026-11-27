import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRelayEnvironment, readRelayFile, resolveRelayFilePath, credentials, clientGatewaySecret } from './config.mjs';
import { resolveIdentityFile, clientIdentityPresent } from './client-identity.mjs';
import { sourceAppServerBinary } from '../../kcoder-studio/src/source-app-server-binary.js';

if (process.platform !== 'linux') throw new Error('Local Relay installation requires Linux user systemd');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
if (/[\s%"]/.test(repo + process.execPath)) throw new Error('Unsupported systemd executable path');
const selectedEnv = readRelayFile(resolve(process.env.KCODER_RELAY_ENV_FILE || resolve(repo, '.env')), { limit: 1024 * 1024, label: 'Relay service environment' });
const envFile = selectedEnv.path;
const persisted = parseRelayEnvironment(selectedEnv.bytes);
for (const [name, value] of Object.entries(persisted)) if (process.env[name] === undefined) process.env[name] = value;
if (process.env.KCODER_RELAY_GATEWAY_SECRET_FILE) process.env.KCODER_RELAY_GATEWAY_SECRET_FILE = resolveRelayFilePath(process.env.KCODER_RELAY_GATEWAY_SECRET_FILE);
// Secrets remain in the selected private environment/credential file, never units.
for (const name of ['KCODER_RELAY_REGISTRATION_KEY', 'KCODER_RELAY_ACCOUNT_LOGIN_TOKEN', 'KCODER_RELAY_SECRET', 'KCODER_RELAY_GATEWAY_SECRET']) {
  if (name === 'KCODER_RELAY_GATEWAY_SECRET' && process.env.KCODER_RELAY_GATEWAY_SECRET_FILE) continue;
  if (process.env[name] && process.env[name] !== persisted[name]) throw new Error(`Persist ${name} in the selected private KCODER_RELAY_ENV_FILE before installation`);
}
const gatewaySecret = clientGatewaySecret();
if (!/^[A-Za-z0-9._~-]{32,512}$/.test(gatewaySecret || '')) throw new Error('Configure a private Gateway Relay credential before installation');
const publicUrl = new URL(process.env.KCODER_RELAY_PUBLIC_URL || '');
if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) throw new Error('Configure the canonical Relay HTTPS origin');
const local = new URL(process.env.KCODER_RELAY_LOCAL_GATEWAY || 'http://127.0.0.1:4186');
if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.pathname !== '/' || local.search || local.hash || local.username || local.password) throw new Error('Relay Gateway must use an explicit loopback HTTP origin');
const state = resolve(repo, 'target/kcoder-relay'); mkdirSync(state, { recursive: true });
const stateInfo = lstatSync(state);
if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) throw new Error('Relay installer state must be an ordinary directory');
const identityFile = resolveIdentityFile();
const registrationKey = process.env.KCODER_RELAY_REGISTRATION_KEY;
const accountLoginToken = process.env.KCODER_RELAY_ACCOUNT_LOGIN_TOKEN;
const hasRegistrationKey = Boolean(registrationKey), hasAccountToken = Boolean(accountLoginToken);
const hasIdentity = await clientIdentityPresent(identityFile);
const automaticRegistration = hasRegistrationKey || hasAccountToken || hasIdentity || Boolean(process.env.KCODER_RELAY_IDENTITY_FILE);
if (automaticRegistration) {
  if (hasRegistrationKey && !/^[A-Za-z0-9._~-]{32,512}$/.test(registrationKey)) throw new Error('Invalid KCODER_RELAY_REGISTRATION_KEY');
  if (hasAccountToken && !/^[A-Za-z0-9_-]{43}$/.test(accountLoginToken)) throw new Error('Invalid KCODER_RELAY_ACCOUNT_LOGIN_TOKEN');
  if (!hasRegistrationKey && !hasAccountToken && !hasIdentity) throw new Error('Client identity is missing; configure registration before installing the relay client');
} else credentials();
const serversFile = resolveRelayFilePath(process.env.KCODER_RELAY_SERVERS_FILE || resolve(state, 'servers.json'));
const binary = process.env.KCODER_RELAY_KCODER_BIN || sourceAppServerBinary(repo);
try {
  writeFileSync(serversFile, JSON.stringify([{ id: 'local', label: 'KCoder 本机', runtime: 'kcoder', transport: 'local', command: binary, workspace: repo }], null, 2) + '\n', { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const existing = readRelayFile(serversFile, { limit: 1024 * 1024, label: 'Relay server registry' });
  let servers;
  try { servers = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(existing.bytes)); }
  catch { throw new Error('Existing Relay server registry must contain a valid array'); }
  if (!Array.isArray(servers)) throw new Error('Existing Relay server registry must contain an array');
}
const units = resolve(homedir(), '.config/systemd/user'); mkdirSync(units, { recursive: true });
const quote = value => {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid Relay unit configuration value');
  return `"${value.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};
const variables = { KCODER_RELAY_ENV_FILE: envFile, KCODER_RELAY_IDENTITY_FILE: identityFile, KCODER_RELAY_SERVERS_FILE: serversFile, KCODER_RELAY_KCODER_BIN: binary,
  KCODER_RELAY_PUBLIC_URL: publicUrl.origin, KCODER_RELAY_LOCAL_GATEWAY: local.href,
  ...Object.fromEntries(['KCODER_RELAY_CONFIG_DIR', 'KCODER_RELAY_GATEWAY_SECRET_FILE', 'KCODER_RELAY_GATEWAY_HOST', 'KCODER_RELAY_PUBLIC_ORIGINS', 'KCODER_RELAY_STUN_PORT', 'KCODER_RELAY_ROUTE_MODE'].filter(name => process.env[name]).map(name => [name, process.env[name]])) };
for (const [name, script] of [['kcoder-cyx-relay-gateway', 'gateway'], ['kcoder-cyx-relay-client', 'client']]) {
  writeFileSync(resolve(units, `${name}.service`), `[Unit]
Description=KCoder Relay ${script}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${repo}
ExecStart=${quote(process.execPath)} ${quote(`${repo}/apps/kcoder-relay/src/${script}.mjs`)}
${Object.entries(variables).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`).join('\n')}
Restart=always
RestartSec=3
KillMode=control-group
TimeoutStopSec=15

[Install]
WantedBy=default.target
`);
}
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', 'kcoder-cyx-relay-gateway', 'kcoder-cyx-relay-client'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'restart', 'kcoder-cyx-relay-gateway', 'kcoder-cyx-relay-client'], { stdio: 'inherit' });
