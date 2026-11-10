import { spawn } from 'node:child_process';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../../kcoder-relay/src/config.mjs';
import { resolveMobilePreviewConfig, mobilePreviewModelEnvironment } from '../src/mobile-preview-config.js';
import { randomBytes } from 'node:crypto';
import { fetchGatewayPairing } from '../../kcoder-relay/src/pair.mjs';

// New profile and transcript directories must not inherit group-write permissions.
process.umask(0o077);

const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(studioRoot, '../..');
loadEnv(resolve(repoRoot, '.env'));
const [role, stateArgument] = process.argv.slice(2);
if (!['check', 'gateway', 'proxy', 'tunnel', 'links'].includes(role) || !stateArgument) throw new Error('Expected role and owned preview state directory');
const stateRoot = resolve(stateArgument);
const owner = await lstat(stateRoot);
if (!owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== process.getuid() || (owner.mode & 0o022)) throw new Error('Unsafe preview state owner');
const options = JSON.parse(await readFile(resolve(stateRoot, 'preview-config.json'), 'utf8'));
const config = resolveMobilePreviewConfig(process.env, options);
if (role === 'check') {
  console.log(JSON.stringify({ publicBaseUrl: config.publicBaseUrl, stunUrls: config.stunUrls, sshHostname: config.sshHostname }));
  process.exit(0);
}
const baseEnv = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
function launch(command, args, env = baseEnv, quiet = false) {
  const child = spawn(command, args, { cwd: studioRoot, env, stdio: quiet ? 'ignore' : 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
  child.once('error', () => { process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
}
async function privateRelaySecret() {
  const tokenPath = resolve(stateRoot, 'gateway/relay-secret.txt');
  try { await writeFile(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(tokenPath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== owner.uid || info.nlink !== 1 || (info.mode & 0o077)) throw new Error('Unsafe preview credential file');
  return (await readFile(tokenPath, 'utf8')).trim();
}
if (role === 'gateway') {
  launch(process.execPath, [resolve(studioRoot, 'dev-server.mjs')], {
    ...baseEnv, ...mobilePreviewModelEnvironment(process.env),
    KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: String(config.gatewayPort),
    KCODER_STUDIO_RELAY_SECRET: await privateRelaySecret(), KCODER_STUDIO_SECURE_COOKIE: '1',
    ...(process.env.KCODER_STUDIO_AUTH_TOKEN ? { KCODER_STUDIO_AUTH_TOKEN: process.env.KCODER_STUDIO_AUTH_TOKEN } : {}),
    ...(process.env.KCODER_STUDIO_MOBILE_PAIRING_TOKEN ? { KCODER_STUDIO_MOBILE_PAIRING_TOKEN: process.env.KCODER_STUDIO_MOBILE_PAIRING_TOKEN } : {}),
    KCODER_STUDIO_PUBLIC_ACCESS_URL: config.publicBaseUrl,
    KCODER_STUDIO_PUBLIC_ORIGINS: `${config.publicOrigin},${config.localOrigin}`,
    KCODER_STUDIO_MOBILE_WEB_ORIGINS: `${config.publicOrigin},${config.localOrigin}`,
    KCODER_STUDIO_P2P: process.env.KCODER_STUDIO_P2P || '1', KCODER_STUDIO_P2P_STUN_URLS: config.stunUrls,
    KCODER_STUDIO_SERVERS_FILE: process.env.KCODER_RELAY_SERVERS_FILE,
    KCODER_STUDIO_DATA_DIR: resolve(stateRoot, 'gateway'),
    KCODER_STUDIO_SERVERS_STORE: resolve(stateRoot, 'gateway/servers-store.json'),
    KCODER_CONFIG_DIR: process.env.KCODER_RELAY_CONFIG_DIR,
    KCODER_STUDIO_KCODER_BIN: process.env.KCODER_RELAY_KCODER_BIN,
  }, true);
} else if (role === 'proxy') {
  const template = await readFile(resolve(stateRoot, 'nginx.template.conf'), 'utf8');
  if (!template.includes('__KCODER_PREVIEW_AUTHORITY__')) throw new Error('Preview proxy authority placeholder is absent');
  const output = resolve(stateRoot, 'nginx.conf');
  await writeFile(output, template.replaceAll('__KCODER_PREVIEW_AUTHORITY__', config.publicAuthority), { mode: 0o600 });
  launch('/usr/sbin/nginx', ['-c', output]);
} else if (role === 'tunnel') {
  const key = config.sshIdentity.startsWith('~/') ? resolve(homedir(), config.sshIdentity.slice(2)) : config.sshIdentity;
  launch('/usr/bin/ssh', ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none', '-o', 'LogLevel=ERROR', '-p', String(config.sshPort), '-i', key,
    '-R', `127.0.0.1:${config.remotePort}:127.0.0.1:${config.proxyPort}`, `${config.sshUser}@${config.sshHostname}`]);
} else if (role === 'links') {
  const path = resolve(stateRoot, 'gateway/mobile-one-click-login-url.txt');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== owner.uid || info.nlink !== 1 || (info.mode & 0o077)) throw new Error('Unsafe preview login file');
  const pairing = await fetchGatewayPairing({ localGateway: `http://127.0.0.1:${config.gatewayPort}`,
    gatewaySecret: await privateRelaySecret(), publicGateway: config.publicBaseUrl,
    tokenMode: process.env.KCODER_STUDIO_MOBILE_PAIRING_MODE || 'auto' });
  const login = new URL(config.publicBaseUrl + '/mobile/connect');
  login.searchParams.set('gateway', config.publicBaseUrl);
  login.hash = new URLSearchParams({ token: pairing.token }).toString();
  const pending = path + `.next-${process.pid}`;
  try {
    await writeFile(pending, login.toString() + '\n', { mode: 0o600, flag: 'wx' });
    await rename(pending, path);
  } finally { await rm(pending, { force: true }); }
  console.log(`Private Mobile pairing URL refreshed (${pairing.kind})`);
}
