import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, credentials } from './config.mjs';
import { resolveIdentityFile } from './client-identity.mjs';
loadEnv();
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
if (/[\s%"]/.test(repo + process.execPath)) throw new Error('Unsupported systemd executable path');
const state = resolve(repo, 'target/kcoder-relay'); mkdirSync(state, { recursive: true, mode: 0o700 }); chmodSync(state, 0o700);
const identityFile = resolveIdentityFile();
if (/[\u0000-\u001f\u007f]/.test(identityFile)) throw new Error('KCODER_RELAY_IDENTITY_FILE cannot contain control characters');
const registrationKey = process.env.KCODER_RELAY_REGISTRATION_KEY;
const hasRegistrationKey = registrationKey !== undefined && registrationKey !== '';
const automaticRegistration = hasRegistrationKey || existsSync(identityFile) || Boolean(process.env.KCODER_RELAY_IDENTITY_FILE);
if (automaticRegistration) {
  if (hasRegistrationKey && !/^[A-Za-z0-9._~-]{32,512}$/.test(registrationKey)) throw new Error('Invalid KCODER_RELAY_REGISTRATION_KEY');
  if (hasRegistrationKey && !existsSync(identityFile) && !/^[A-Za-z0-9._~-]{32,512}$/.test(process.env.KCODER_RELAY_GATEWAY_TOKEN || '')) {
    throw new Error('Configure KCODER_RELAY_GATEWAY_TOKEN before installing the relay client');
  }
  if (!hasRegistrationKey && !existsSync(identityFile)) throw new Error('Client identity is missing; configure registration before installing the relay client');
} else {
  credentials();
}
writeFileSync(process.env.KCODER_RELAY_SERVERS_FILE || resolve(state, 'servers.json'), JSON.stringify([{ id: 'local', label: 'CYX 内网服务器', transport: 'local', command: process.env.KCODER_RELAY_KCODER_BIN || resolve(repo, 'target/debug/kcoder'), workspace: repo }], null, 2)+'\n');
const units = resolve(homedir(), '.config/systemd/user'); mkdirSync(units, { recursive: true });
for (const [name, script] of [['kcoder-cyx-relay-gateway', 'gateway'], ['kcoder-cyx-relay-client', 'client']]) {
  const identityEnvironment = script === 'client' && automaticRegistration
    ? `Environment="KCODER_RELAY_IDENTITY_FILE=${identityFile.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`
    : '';
  writeFileSync(resolve(units, `${name}.service`), `[Unit]
Description=KCoder CYX relay ${script}
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${repo}
ExecStart="${process.execPath}" "${repo}/apps/kcoder-relay/src/${script}.mjs"
${identityEnvironment}Restart=always
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
