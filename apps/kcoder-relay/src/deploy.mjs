import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, relayServerConfig } from './config.mjs';
import {
  createRelayDeploymentConfig,
  createRelayDeploymentDryRunSummary,
  relayDeploymentScpOptions,
  resolveRelayRouteMode,
} from '../deploy/config.mjs';

loadEnv();
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostname = process.env.KCODER_RELAY_SSH_HOSTNAME;
const user = process.env.KCODER_RELAY_SSH_USER || 'admin';
if (!/^[a-zA-Z0-9.-]+$/.test(hostname || '') || !/^[a-zA-Z0-9_-]+$/.test(user)) {
  throw new Error('Configure KCODER_RELAY_SSH_HOSTNAME and KCODER_RELAY_SSH_USER');
}

const relayConfig = relayServerConfig();
const persistentStoreEnabled = Boolean(relayConfig.registrationStoreFile || relayConfig.registrationKey);
resolveRelayRouteMode({
  registryMode: Boolean(process.env.KCODER_RELAY_REGISTRY_FILE) || persistentStoreEnabled,
  routeMode: process.env.KCODER_RELAY_ROUTE_MODE,
});
const deployment = createRelayDeploymentConfig({
  relayConfig,
  domain: process.env.KCODER_RELAY_DOMAIN || 'hyf2333.top',
  publicPort: process.env.KCODER_RELAY_PUBLIC_PORT || 8451,
  controlPort: process.env.KCODER_RELAY_CONTROL_PORT || 18452,
  proxyPort: process.env.KCODER_RELAY_PROXY_PORT || 18451,
});
const target = `${user}@${hostname}`;
const identity = (process.env.KCODER_RELAY_SSH_IDENTITY || '~/.ssh/id_ed25519').replace(/^~\//, `${homedir()}/`);
const sshOptions = ['-i', identity, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15'];

if (process.env.KCODER_RELAY_DEPLOY_DRY_RUN === '1') {
  console.log(JSON.stringify(createRelayDeploymentDryRunSummary({ target, deployment }), null, 2));
  process.exit(0);
}

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const temp = mkdtempSync(resolve(tmpdir(), 'kcoder-relay-deploy-'));
chmodSync(temp, 0o700);
let remoteStageMayExist = false;
try {
  const cloudEnvPath = resolve(temp, 'cloud.env');
  const caddyEnvPath = resolve(temp, 'caddy.env');
  writeFileSync(cloudEnvPath, deployment.cloudEnv, { mode: 0o600 });
  writeFileSync(caddyEnvPath, deployment.caddyEnv, { mode: 0o600 });
  const files = [
    resolve(root, 'src'),
    resolve(root, 'deploy'),
    resolve(root, 'package.json'),
    resolve(root, 'package-lock.json'),
    cloudEnvPath,
    caddyEnvPath,
  ];
  if (deployment.registryJson) {
    const registryPath = resolve(temp, 'registry.json');
    writeFileSync(registryPath, deployment.registryJson, { mode: 0o600 });
    files.push(registryPath);
  }

  run('ssh', [...sshOptions, target, 'umask 077; mkdir -p ~/kcoder-relay-deploy; chmod 700 ~/kcoder-relay-deploy']);
  remoteStageMayExist = true;
  run('scp', [...sshOptions, ...relayDeploymentScpOptions(), ...files, `${target}:kcoder-relay-deploy/`]);

  const installRegistry = deployment.registryJson
    ? `sudo -n install -o kcoder-relay -g kcoder-relay -m 600 ~/kcoder-relay-deploy/registry.json /etc/kcoder-relay-registry.json
sudo -n -u kcoder-relay test -r /etc/kcoder-relay-registry.json`
    : '';
  run('ssh', [...sshOptions, target, `set -eu
cleanup() { rm -f ~/kcoder-relay-deploy/cloud.env ~/kcoder-relay-deploy/caddy.env${deployment.registryJson ? ' ~/kcoder-relay-deploy/registry.json' : ''}; }
trap cleanup EXIT
cd ~/kcoder-relay-deploy
chmod 600 cloud.env caddy.env${deployment.registryJson ? ' registry.json' : ''}
if ! command -v node >/dev/null || ! command -v npm >/dev/null || ! command -v caddy >/dev/null; then
  sudo -n apt-get update -qq
  sudo -n env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y nodejs npm caddy
fi
# Refuse to overwrite unrelated Caddy sites. Only the stock site or this exact Relay template is replaceable.
if ! sudo -n grep -Fq 'root * /usr/share/caddy' /etc/caddy/Caddyfile && ! sudo -n cmp -s ~/kcoder-relay-deploy/deploy/Caddyfile /etc/caddy/Caddyfile; then
  echo 'Existing custom Caddyfile requires manual integration' >&2
  exit 1
fi
sudo -n mkdir -p /opt/kcoder-relay /etc/systemd/system/caddy.service.d
sudo -n cp -r ~/kcoder-relay-deploy/src ~/kcoder-relay-deploy/deploy ~/kcoder-relay-deploy/package.json ~/kcoder-relay-deploy/package-lock.json /opt/kcoder-relay/
sudo -n install -m 600 ~/kcoder-relay-deploy/cloud.env /etc/kcoder-relay.env
sudo -n install -m 600 ~/kcoder-relay-deploy/caddy.env /etc/kcoder-relay-caddy.env
sudo -n install -m 644 ~/kcoder-relay-deploy/deploy/kcoder-relay.service /etc/systemd/system/kcoder-relay.service
sudo -n install -m 644 ~/kcoder-relay-deploy/deploy/caddy-env.conf /etc/systemd/system/caddy.service.d/kcoder-relay.conf
if ! sudo -n test -f /etc/caddy/Caddyfile.before-kcoder-relay; then sudo -n cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-kcoder-relay; fi
sudo -n install -m 644 ~/kcoder-relay-deploy/deploy/Caddyfile /etc/caddy/Caddyfile
id kcoder-relay >/dev/null 2>&1 || sudo -n useradd --system --no-create-home --shell /usr/sbin/nologin kcoder-relay
${installRegistry}
cd /opt/kcoder-relay
sudo -n npm ci --omit=dev --ignore-scripts --no-audit --no-fund
sudo -n systemctl daemon-reload
sudo -n systemctl enable kcoder-relay caddy
sudo -n systemctl restart kcoder-relay caddy
sudo -n systemctl is-active kcoder-relay caddy`]);
} finally {
  if (remoteStageMayExist) {
    try {
      execFileSync('ssh', [...sshOptions, target, 'rm -f ~/kcoder-relay-deploy/cloud.env ~/kcoder-relay-deploy/caddy.env ~/kcoder-relay-deploy/registry.json'], { stdio: 'ignore' });
    } catch { /* Best effort if the remote host or SSH connection is unavailable. */ }
  }
  rmSync(temp, { recursive: true, force: true });
}
