import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, relayServerConfig } from './config.mjs';
import {
  createRelayDeploymentConfig,
  resolveRelayRouteMode,
} from '../deploy/config.mjs';
import {
  combineRelayLifecycleResults,
  createRelayDeploymentCliDryRun,
  createRelayLifecycleRemoteCommand,
  parseRelayDeployArgs,
} from '../deploy/cli-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function deploymentTarget() {
  const hostname = process.env.KCODER_RELAY_SSH_HOSTNAME;
  const user = process.env.KCODER_RELAY_SSH_USER || 'admin';
  if (!/^[a-zA-Z0-9.-]+$/.test(hostname || '') || !/^[a-zA-Z0-9_-]+$/.test(user)) {
    throw new Error('Configure KCODER_RELAY_SSH_HOSTNAME and KCODER_RELAY_SSH_USER');
  }
  return `${user}@${hostname}`;
}

function sshSettings() {
  const identity = (process.env.KCODER_RELAY_SSH_IDENTITY || '~/.ssh/id_ed25519')
    .replace(/^~\//, `${homedir()}/`);
  if (/[\u0000-\u001f\u007f]/.test(identity)) throw new Error('Invalid KCODER_RELAY_SSH_IDENTITY');
  return [
    '-i', identity,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15',
  ];
}

function hasExplicitCanonicalHostInput() {
  return Boolean(process.env.KCODER_RELAY_PUBLIC_URL)
    || Boolean(process.env.KCODER_RELAY_REGISTRY_FILE)
    || Boolean(process.env.KCODER_RELAY_SHARED_HOSTS?.trim());
}

function createDeployment() {
  if (!hasExplicitCanonicalHostInput()) {
    throw new Error('Set KCODER_RELAY_PUBLIC_URL or configure one explicit Relay sharedHosts authority before deployment');
  }
  const relayConfig = relayServerConfig();
  const persistentStoreEnabled = Boolean(relayConfig.registrationStoreFile || relayConfig.registrationKey);
  resolveRelayRouteMode({
    registryMode: Boolean(process.env.KCODER_RELAY_REGISTRY_FILE) || persistentStoreEnabled,
    routeMode: process.env.KCODER_RELAY_ROUTE_MODE,
  });
  return createRelayDeploymentConfig({
    relayConfig,
    publicUrl: process.env.KCODER_RELAY_PUBLIC_URL || undefined,
    domain: process.env.KCODER_RELAY_DOMAIN || undefined,
    publicPort: process.env.KCODER_RELAY_PUBLIC_PORT || undefined,
    controlPort: process.env.KCODER_RELAY_CONTROL_PORT || 18452,
    proxyPort: process.env.KCODER_RELAY_PROXY_PORT || 18451,
    stunPort: process.env.KCODER_RELAY_STUN_PORT || undefined,
  });
}

function stageDirectory() {
  return `/var/tmp/kcoder-relay-deploy-${randomBytes(12).toString('hex')}`;
}

function writePrivateFile(path, contents) {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function parseLifecycleOutput(stdout, action, purgeData, remoteStatus) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 2) throw new Error('Remote lifecycle did not return both Relay and STUN results');
  let stun;
  let relay;
  try {
    const values = lines.map((line) => JSON.parse(line));
    stun = values.find((value) => value.component === 'stun');
    relay = values.find((value) => value.component === 'relay');
    if (!stun || !relay) throw new Error('Missing lifecycle component');
  } catch {
    throw new Error('Remote lifecycle returned an invalid status result');
  }
  return combineRelayLifecycleResults({ action, stun, relay, purgeData, remoteStatus });
}

function printRemoteError(error) {
  const detail = error.stderr?.toString().trim();
  if (detail) console.error(detail);
  const code = error.status === 2 ? 2 : error.status === 3 ? 3 : 4;
  console.error(`Relay deployment failed (exit ${code})`);
  return code;
}

function runRemoteLifecycle({ action, target, settings, stageDir, deployment, options }) {
  const remoteCommand = createRelayLifecycleRemoteCommand({
    action,
    stageDir,
    ...(deployment ? { port: Number(deployment.stun.port) } : {}),
    adoptExisting: options.adoptExisting,
    purgeData: options.purgeData,
  });
  let output;
  let remoteStatus = 0;
  try {
    output = execFileSync('ssh', [...settings, target, remoteCommand], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    output = error.stdout?.toString() || '';
    remoteStatus = Number.isInteger(error.status) ? error.status : 4;
    if (!output.trim()) throw error;
  }
  const result = parseLifecycleOutput(output, action, options.purgeData, remoteStatus);
  if (remoteStatus === 2 || remoteStatus === 3) return { exitCode: remoteStatus, result };
  return { exitCode: remoteStatus !== 0 || !result.success ? 4 : 0, result };
}

function prepareStagedFiles(temp, deployment, { includeApplication }) {
  const files = [resolve(root, 'deploy')];
  if (!includeApplication) return files;

  const cloudEnvPath = resolve(temp, 'cloud.env');
  const caddyEnvPath = resolve(temp, 'caddy.env');
  writePrivateFile(cloudEnvPath, deployment.cloudEnv);
  writePrivateFile(caddyEnvPath, deployment.caddyEnv);

  const packagePath = resolve(temp, 'package.json');
  const lockPath = resolve(temp, 'package-lock.json');
  copyFileSync(resolve(root, 'package.json'), packagePath);
  copyFileSync(resolve(root, 'package-lock.json'), lockPath);
  const dependencyRoot = resolve(temp, 'dependency-install');
  mkdirSync(dependencyRoot, { mode: 0o700 });
  copyFileSync(packagePath, resolve(dependencyRoot, 'package.json'));
  copyFileSync(lockPath, resolve(dependencyRoot, 'package-lock.json'));
  execFileSync('npm', [
    'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
  ], { cwd: dependencyRoot, stdio: 'inherit' });

  const runtimeConnectionRoutesPath = resolve(temp, 'gatewayConnectionRoutes.runtime.mjs');
  copyFileSync(resolve(root, '../kcoder-studio/shared/gatewayConnectionRoutes.js'), runtimeConnectionRoutesPath);

  files.push(
    resolve(root, 'src'),
    packagePath,
    lockPath,
    resolve(dependencyRoot, 'node_modules'),
    runtimeConnectionRoutesPath,
    cloudEnvPath,
    caddyEnvPath,
  );
  if (deployment.registryJson) {
    const registryPath = resolve(temp, 'registry.json');
    writePrivateFile(registryPath, deployment.registryJson);
    files.push(registryPath);
  }
  return files;
}

function executeStagedAction({ action, target, settings, options, deployment }) {
  const temp = mkdtempSync(resolve(tmpdir(), 'kcoder-relay-deploy-'));
  chmodSync(temp, 0o700);
  const stageDir = stageDirectory();
  let stageMayExist = false;
  let result = 4;
  let summary;
  let stageCleanup = 'not-needed';
  try {
    const files = prepareStagedFiles(temp, deployment, { includeApplication: Boolean(deployment) });
    stageMayExist = true;
    execFileSync('ssh', [...settings, target, `umask 077; mkdir -- '${stageDir}'; chmod 700 -- '${stageDir}'`], { stdio: 'ignore' });
    execFileSync('scp', [...settings, '-p', '-q', '-r', ...files, `${target}:${stageDir}/`], { stdio: 'inherit' });
    const lifecycle = runRemoteLifecycle({ action, target, settings, stageDir, deployment, options });
    result = lifecycle.exitCode;
    summary = lifecycle.result;
  } catch (error) {
    result = printRemoteError(error);
  } finally {
    if (stageMayExist) {
      try {
        execFileSync('ssh', [...settings, target, `rm -rf -- '${stageDir}'`], { stdio: 'ignore' });
        stageCleanup = 'removed';
      } catch {
        console.error('Remote private staging cleanup could not be confirmed; the remote staging directory may remain');
        stageCleanup = 'unconfirmed';
        if (result === 0) result = 4;
      }
    }
    rmSync(temp, { recursive: true, force: true });
  }
  if (summary) {
    summary.remoteStagingCleanup = stageCleanup;
    if (stageCleanup === 'unconfirmed') summary.success = false;
    console.log(JSON.stringify(summary, null, 2));
  }
  return result;
}

function executeDeployment({ action, target, settings, options }) {
  const deployment = createDeployment();
  const dryRun = options.dryRun || process.env.KCODER_RELAY_DEPLOY_DRY_RUN === '1';
  if (dryRun) {
    console.log(JSON.stringify(createRelayDeploymentCliDryRun({
      action,
      target,
      deployment,
    }), null, 2));
    return 0;
  }
  return executeStagedAction({ action, target, settings, options, deployment });
}

export async function main(argv = process.argv.slice(2)) {
  loadEnv();
  let options;
  try {
    options = parseRelayDeployArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  let target;
  let settings;
  try {
    target = deploymentTarget();
    settings = sshSettings();
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  if (options.action === 'status' || options.action === 'cleanup') {
    if (process.env.KCODER_RELAY_DEPLOY_DRY_RUN === '1') {
      console.error('KCODER_RELAY_DEPLOY_DRY_RUN=1 cannot be used with status or cleanup');
      return 2;
    }
    return executeStagedAction({ action: options.action, target, settings, options });
  }
  try {
    return executeDeployment({
      action: options.action,
      target,
      settings,
      options,
    });
  } catch (error) {
    console.error(error.message);
    return 4;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
