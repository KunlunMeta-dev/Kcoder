import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertPort80ListenerStateUnchanged,
  buildRelayCaddySnippet,
  createCaddyCleanupPlan,
  createCaddyInstallPlan,
  port80ListenerState,
  RELAY_FRAGMENT_PATH,
  validateRelayOnDemandTls,
} from '../deploy/caddy-lifecycle.mjs';

const SHARED_CADDYFILE = [
  '{',
  '    auto_https disable_redirects',
  '}',
  '',
  'http://myapp.example.test:80 {',
  '    respond "myapp" 200',
  '}',
  '',
  'other.example.test {',
  '    handle /other {',
  '        respond "other" 200',
  '    }',
  '}',
  '',
].join('\n');

const OTHER_SITE = [
  '',
  'added.example.test {',
  '    handle /added {',
  '        respond "added" 200',
  '    }',
  '}',
  '',
].join('\n');

function parseArgs(args) {
  let caddyPath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--caddy' || caddyPath || index + 1 >= args.length) {
      throw new Error('Usage: node caddy-adapter.live.mjs --caddy /absolute/path/to/caddy');
    }
    caddyPath = args[index + 1];
    index += 1;
  }
  if (!caddyPath || !caddyPath.startsWith('/')) {
    throw new Error('Usage: node caddy-adapter.live.mjs --caddy /absolute/path/to/caddy');
  }
  const resolved = realpathSync(caddyPath);
  const stat = lstatSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error('--caddy must identify an executable file');
  return resolved;
}

function makePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function isolatedEnvironment(root) {
  const directories = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_RUNTIME_DIR: join(root, 'xdg-runtime'),
    TMPDIR: join(root, 'tmp'),
  };
  for (const directory of Object.values(directories)) makePrivateDir(directory);
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    ...directories,
  };
}

function runCaddy(caddyPath, args, { cwd, env }) {
  assert.ok(args[0] === 'version' || args[0] === 'adapt', 'only Caddy version/adapt commands are permitted');
  const result = spawnSync(caddyPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`caddy ${args[0]} failed with exit ${result.status}: ${detail}`);
  }
  return result.stdout.trim();
}

function writePrivateText(path, contents) {
  makePrivateDir(dirname(path));
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function adaptText({ caddyPath, scratch, env, label, contents }) {
  const configPath = join(scratch, `${label}.Caddyfile`);
  writePrivateText(configPath, contents);
  const output = runCaddy(caddyPath, [
    'adapt', '--config', configPath, '--adapter', 'caddyfile', '--pretty',
  ], { cwd: scratch, env });
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Caddy adapt did not return JSON for ${label}`);
  }
}

function adaptPlan({ caddyPath, scratch, env, label, plan, fragmentContents }) {
  const importCount = plan.mainContents.split(RELAY_FRAGMENT_PATH).length - 1;
  if (importCount !== 1) throw new Error(`${label} planner output must contain exactly one Relay fragment import`);
  const fragmentPath = join(scratch, `${label}.relay-fragment.caddy`);
  writePrivateText(fragmentPath, fragmentContents);
  const mappedMain = plan.mainContents.replaceAll(RELAY_FRAGMENT_PATH, fragmentPath);
  return adaptText({ caddyPath, scratch, env, label, contents: mappedMain });
}

function hostRoutes(config, host) {
  const servers = config?.apps?.http?.servers;
  if (!servers || typeof servers !== 'object') return [];
  const routes = [];
  for (const server of Object.values(servers)) {
    for (const route of server?.routes || []) {
      const hostMatches = (route?.match || []).some((matcher) => (
        Array.isArray(matcher?.host) && matcher.host.includes(host)
      ));
      if (hostMatches) routes.push(route);
    }
  }
  return routes.map((route) => JSON.stringify(route)).sort();
}

function assertRedirectSuppression(config, label) {
  const servers = config?.apps?.http?.servers;
  const flags = Object.values(servers || {})
    .map((server) => server?.automatic_https?.disable_redirects)
    .filter((value) => value !== undefined);
  assert.ok(flags.length > 0, `${label}: Caddy adapt did not emit an automatic_https policy`);
  assert.ok(flags.every((value) => value === true), `${label}: automatic HTTPS redirects are not disabled`);
}

function assertRelayBackends(config, settings, label) {
  const routes = hostRoutes(config, settings.domain);
  assert.ok(routes.length > 0, `${label}: Relay site is missing`);
  const serialized = routes.join('\n');
  assert.ok(serialized.includes(`127.0.0.1:${settings.controlPort}`), `${label}: control route uses the wrong upstream`);
  assert.ok(serialized.includes(`127.0.0.1:${settings.proxyPort}`), `${label}: Gateway route uses the wrong upstream`);
}

function assertNoRelaySite(config, domain, label) {
  assert.equal(hostRoutes(config, domain).length, 0, `${label}: Relay route remains after cleanup`);
}

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function assertPreservedRoutes(before, after, hosts, label) {
  for (const host of hosts) {
    assert.deepEqual(hostRoutes(after, host), hostRoutes(before, host), `${label}: route changed for ${host}`);
  }
}

function runSharedLifecycle({ caddyPath, scratch, env }) {
  const originalConfig = adaptText({
    caddyPath,
    scratch,
    env,
    label: 'shared-before',
    contents: SHARED_CADDYFILE,
  });
  assertRedirectSuppression(originalConfig, 'shared-before');
  const preservedHosts = ['myapp.example.test', 'other.example.test'];
  assert.ok(hostRoutes(originalConfig, preservedHosts[0]).length > 0, 'original port-80 site is missing');
  assert.ok(hostRoutes(originalConfig, preservedHosts[1]).length > 0, 'other HTTPS site is missing');

  const initialSettings = {
    domain: 'relay.example.test',
    publicPort: 443,
    controlPort: 18452,
    proxyPort: 18451,
  };
  const initialFragment = buildRelayCaddySnippet(initialSettings);
  const installPlan = createCaddyInstallPlan({
    mainContents: SHARED_CADDYFILE,
    mainFileExists: true,
    settings: initialSettings,
    fragmentContents: initialFragment,
  });
  const installedConfig = adaptPlan({
    caddyPath,
    scratch,
    env,
    label: 'shared-install',
    plan: installPlan,
    fragmentContents: initialFragment,
  });
  assertPort80ListenerStateUnchanged(originalConfig, installedConfig);
  assertPreservedRoutes(originalConfig, installedConfig, preservedHosts, 'install');
  assertRedirectSuppression(installedConfig, 'shared-install');
  assertRelayBackends(installedConfig, initialSettings, 'install');
  assertGatewayOrigins(installedConfig, initialSettings, 'install');

  const upgradedSettings = { ...initialSettings, controlPort: 18453, proxyPort: 18454 };
  const upgradedFragment = buildRelayCaddySnippet(upgradedSettings);
  const upgradePlan = createCaddyInstallPlan({
    mainContents: installPlan.mainContents,
    mainFileExists: true,
    existingFragment: initialFragment,
    fragmentHashOwned: true,
    settings: upgradedSettings,
    fragmentContents: upgradedFragment,
  });
  const upgradedConfig = adaptPlan({
    caddyPath,
    scratch,
    env,
    label: 'shared-upgrade',
    plan: upgradePlan,
    fragmentContents: upgradedFragment,
  });
  assertPort80ListenerStateUnchanged(originalConfig, upgradedConfig);
  assertPreservedRoutes(originalConfig, upgradedConfig, preservedHosts, 'upgrade');
  assertRedirectSuppression(upgradedConfig, 'shared-upgrade');
  assertRelayBackends(upgradedConfig, upgradedSettings, 'upgrade');
  assertGatewayOrigins(upgradedConfig, upgradedSettings, 'upgrade');
  const upgradedRelayJson = hostRoutes(upgradedConfig, upgradedSettings.domain).join('\n');
  assert.ok(!upgradedRelayJson.includes('127.0.0.1:18452'), 'upgrade retained the old control upstream');
  assert.ok(!upgradedRelayJson.includes('127.0.0.1:18451'), 'upgrade retained the old Gateway upstream');

  const cleanupPlan = createCaddyCleanupPlan({
    mainContents: upgradePlan.mainContents,
    expectedFragmentHash: digest(upgradedFragment),
    actualFragmentHash: digest(upgradedFragment),
    mainFileCreatedByKcoder: false,
  });
  const cleanedConfig = adaptText({
    caddyPath,
    scratch,
    env,
    label: 'shared-cleanup',
    contents: cleanupPlan.mainContents,
  });
  assertPort80ListenerStateUnchanged(originalConfig, cleanedConfig);
  assertPreservedRoutes(originalConfig, cleanedConfig, preservedHosts, 'cleanup');
  assertRedirectSuppression(cleanedConfig, 'shared-cleanup');
  assertNoRelaySite(cleanedConfig, initialSettings.domain, 'cleanup');
  assert.equal(cleanedConfig?.apps?.tls?.automation?.on_demand, undefined, 'cleanup: the Relay on-demand ask remains');
  assert.equal(cleanupPlan.mainContents, SHARED_CADDYFILE, 'cleanup: shared Caddyfile was not restored byte-for-byte');
}

// Real Caddy JSON: the global permission is the Relay loopback ask and only the
// wildcard Gateway-origin policy is on-demand; its routes reach only the proxy.
function assertGatewayOrigins(config, settings, label) {
  validateRelayOnDemandTls(config, settings);
  const policies = config?.apps?.tls?.automation?.policies || [];
  assert.ok(policies.some((policy) => policy.on_demand === true && policy.subjects?.includes(`*.${settings.domain}`)),
    `${label}: no on-demand policy for the Gateway origin wildcard`);
  const wildcard = hostRoutes(config, `*.${settings.domain}`).join('\n');
  assert.ok(wildcard.includes(`127.0.0.1:${settings.proxyPort}`), `${label}: Gateway origins use the wrong upstream`);
  assert.ok(!wildcard.includes(`127.0.0.1:${settings.controlPort}`), `${label}: Gateway origins reach the control listener`);
}

function runFreshCleanup({ caddyPath, scratch, env }) {
  const settings = {
    domain: 'fresh-relay.example.test',
    publicPort: 443,
    controlPort: 19452,
    proxyPort: 19451,
  };
  const fragment = buildRelayCaddySnippet(settings);
  const installPlan = createCaddyInstallPlan({
    mainContents: '',
    mainFileExists: false,
    settings,
    fragmentContents: fragment,
  });
  assert.equal(installPlan.createdGlobal, true, 'fresh install should create the redirect-suppression global option');
  const installedConfig = adaptPlan({
    caddyPath,
    scratch,
    env,
    label: 'fresh-install',
    plan: installPlan,
    fragmentContents: fragment,
  });
  assertRedirectSuppression(installedConfig, 'fresh-install');
  assertRelayBackends(installedConfig, settings, 'fresh-install');

  const persistedWithOtherSite = `${installPlan.mainContents}${OTHER_SITE}`;
  const fragmentPath = join(scratch, 'fresh-before-cleanup.relay-fragment.caddy');
  writePrivateText(fragmentPath, fragment);
  const beforeCleanup = adaptText({
    caddyPath,
    scratch,
    env,
    label: 'fresh-before-cleanup',
    contents: persistedWithOtherSite.replaceAll(RELAY_FRAGMENT_PATH, fragmentPath),
  });
  assertRedirectSuppression(beforeCleanup, 'fresh-before-cleanup');
  assert.ok(hostRoutes(beforeCleanup, 'added.example.test').length > 0, 'later-added HTTPS site is missing');

  const cleanupPlan = createCaddyCleanupPlan({
    mainContents: persistedWithOtherSite,
    expectedFragmentHash: digest(fragment),
    actualFragmentHash: digest(fragment),
    mainFileCreatedByKcoder: true,
  });
  assert.equal(cleanupPlan.globalRelinquished, true, 'cleanup should preserve redirect suppression for the added site');
  const cleanedConfig = adaptText({
    caddyPath,
    scratch,
    env,
    label: 'fresh-cleanup',
    contents: cleanupPlan.mainContents,
  });
  assertNoRelaySite(cleanedConfig, settings.domain, 'fresh-cleanup');
  assert.ok(hostRoutes(cleanedConfig, 'added.example.test').length > 0, 'cleanup removed the later-added HTTPS site');
  assertPreservedRoutes(beforeCleanup, cleanedConfig, ['added.example.test'], 'fresh-cleanup');
  assertRedirectSuppression(cleanedConfig, 'fresh-cleanup');
  assert.deepEqual(port80ListenerState(cleanedConfig), []);
}

function main() {
  const caddyPath = parseArgs(process.argv.slice(2));
  const scratch = mkdtempSync(join(tmpdir(), 'kcoder-caddy-adapter-live-'));
  try {
    chmodSync(scratch, 0o700);
    const env = isolatedEnvironment(scratch);
    const version = runCaddy(caddyPath, ['version'], { cwd: scratch, env });
    runSharedLifecycle({ caddyPath, scratch, env });
    runFreshCleanup({ caddyPath, scratch, env });
    process.stdout.write(`${JSON.stringify({
      status: 'PASS',
      caddyVersion: version,
      caseCount: 2,
      cases: [
        { name: 'shared-install-upgrade-cleanup', status: 'PASS' },
        { name: 'fresh-global-cleanup-preserves-redirect-suppression', status: 'PASS' },
      ],
    })}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
