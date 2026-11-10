import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_ROOT = resolve(HERE, '..');
const HOST_LIFECYCLE = join(RELAY_ROOT, 'deploy', 'relay-lifecycle.mjs');
const ROUTE_CONTRACT = resolve(RELAY_ROOT, '../kcoder-studio/shared/gatewayConnectionRoutes.js');
const RELAY_UID = process.getuid?.();
const RELAY_GID = process.getgid?.();
const DOMAIN = 'relay.example.test';
const CONTROL_PORT = 4184;
const PROXY_PORT = 4185;
const PUBLIC_PORT = 443;

const SYSTEMCTL_SHIM = String.raw`#!/bin/sh
set -eu
state=@@{TEST_STATE_DIR:?}
printf 'systemctl %s\n' "$*" >> "$state/commands.log"
unit_marker() {
  case "$1" in
    caddy.service) printf '%s\n' "$state/systemd/active-caddy" ;;
    kcoder-relay.service) printf '%s\n' "$state/systemd/active-relay" ;;
    *) exit 2 ;;
  esac
}
marker_is_one() {
  marker=$1
  [ -f "$marker" ] || return 1
  IFS= read -r value < "$marker" || return 1
  [ "$value" = 1 ]
}
case "@@{1:-}" in
  is-active)
    marker=$(unit_marker "@@{3:-}")
    if [ "@@{3:-}" = kcoder-relay.service ] && marker_is_one "$marker" && [ -f "$state/fail-next-relay-active-check" ]; then
      IFS= read -r failure < "$state/fail-next-relay-active-check" || failure=0
      if [ "$failure" = 1 ]; then
        printf '0\n' > "$state/fail-next-relay-active-check"
        printf '1\n' > "$state/relay-active-check-failed"
        exit 5
      fi
    fi
    marker_is_one "$marker" && exit 0
    exit 3
    ;;
  is-enabled)
    [ "@@{3:-}" = kcoder-relay.service ] || exit 2
    marker_is_one "$state/systemd/enabled-relay" && exit 0
    exit 1
    ;;
  show)
    case "@@{2:-}:@@{3:-}" in
      caddy.service:--property=ExecStart)
        printf 'path=%s; argv[]=%s run --config %s --adapter caddyfile\n' "$CADDY_BIN" "$CADDY_BIN" "$CADDY_CONFIG"
        ;;
      caddy.service:--property=MainPID)
        printf '1\n' >> "$state/mainpid-read"
        printf '1\n'
        ;;
      kcoder-relay.service:--property=MainPID)
        if marker_is_one "$state/systemd/active-relay"; then printf '1234\n'; else printf '0\n'; fi
        ;;
      kcoder-relay.service:--property=FragmentPath)
        if [ -f "$KCODER_RELAY_INTERNAL_TEST_ROOT/etc/systemd/system/kcoder-relay.service" ]; then
          printf '%s\n' "$KCODER_RELAY_INTERNAL_TEST_ROOT/etc/systemd/system/kcoder-relay.service"
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  daemon-reload)
    exit 0
    ;;
  enable)
    if [ "@@{2:-}" = --now ] && [ "@@{3:-}" = kcoder-relay.service ]; then
      printf '1\n' > "$state/systemd/active-relay"
      printf '1\n' > "$state/systemd/enabled-relay"
      exit 0
    fi
    [ "@@{2:-}" = kcoder-relay.service ] || exit 2
    printf '1\n' > "$state/systemd/enabled-relay"
    ;;
  disable)
    if [ "@@{2:-}" = --now ] && [ "@@{3:-}" = kcoder-relay.service ]; then
      printf '0\n' > "$state/systemd/active-relay"
      printf '0\n' > "$state/systemd/enabled-relay"
      exit 0
    fi
    [ "@@{2:-}" = kcoder-relay.service ] || exit 2
    if [ -f "$state/fail-next-relay-disable" ]; then
      IFS= read -r failure < "$state/fail-next-relay-disable" || failure=0
      if [ "$failure" = 1 ]; then
        printf '0\n' > "$state/fail-next-relay-disable"
        printf '1\n' > "$state/relay-disable-failed"
        exit 1
      fi
    fi
    printf '0\n' > "$state/systemd/enabled-relay"
    ;;
  restart)
    [ "@@{2:-}" = kcoder-relay.service ] || exit 2
    if [ "@@{FAIL_RELAY_RESTART_ONCE:-}" = 1 ] && [ ! -f "$state/relay-restart-failed" ]; then
      printf '1\n' > "$state/relay-restart-failed"
      exit 1
    fi
    printf '1\n' > "$state/systemd/active-relay"
    ;;
  stop)
    [ "@@{2:-}" = kcoder-relay.service ] || exit 2
    if [ -f "$state/fail-next-relay-stop" ]; then
      IFS= read -r failure < "$state/fail-next-relay-stop" || failure=0
      if [ "$failure" = 1 ]; then
        printf '0\n' > "$state/fail-next-relay-stop"
        printf '1\n' > "$state/relay-stop-failed"
        exit 1
      fi
    fi
    printf '0\n' > "$state/systemd/active-relay"
    ;;
  reload)
    [ "@@{2:-}" = caddy.service ] || exit 2
    if [ "@@{FAIL_CADDY_RELOAD_ONCE:-}" = 1 ] && [ ! -f "$state/caddy-reload-failed" ]; then
      printf '1\n' > "$state/caddy-reload-failed"
      exit 1
    fi
    ;;
  *)
    printf 'unsupported systemctl fixture call: %s\n' "$*" >&2
    exit 2
    ;;
esac
`.replaceAll('@@{', '${');

const GETENT_SHIM = String.raw`#!/bin/sh
set -eu
state=@@{TEST_STATE_DIR:?}
uid=@@SERVICE_UID@@
gid=@@SERVICE_GID@@
printf 'getent %s\n' "$*" >> "$state/commands.log"
if [ "@@{1:-}" = group ] && { [ "@@{2:-}" = kcoder-relay ] || [ "@@{2:-}" = "$gid" ]; }; then
  [ -f "$state/account-group" ] || exit 2
  printf 'kcoder-relay:x:%s:\n' "$gid"
  exit 0
fi
if [ "@@{1:-}" = passwd ] && { [ "@@{2:-}" = kcoder-relay ] || [ "@@{2:-}" = "$uid" ]; }; then
  [ -f "$state/account-user" ] || exit 2
  printf 'kcoder-relay:x:%s:%s::/var/lib/kcoder-relay:/usr/sbin/nologin\n' "$uid" "$gid"
  exit 0
fi
exit 2
`.replaceAll('@@{', '${');

const ID_SHIM = String.raw`#!/bin/sh
set -eu
printf 'id %s\n' "$*" >> "@@{TEST_STATE_DIR:?}/commands.log"
[ "@@{1:-}" = -G ] && [ "@@{2:-}" = kcoder-relay ] || exit 2
[ -f "$TEST_STATE_DIR/account-user" ] || exit 2
printf '%s\n' '@@SERVICE_GID@@'
`.replaceAll('@@{', '${');

const GROUPADD_SHIM = String.raw`#!/bin/sh
set -eu
printf 'groupadd %s\n' "$*" >> "@@{TEST_STATE_DIR:?}/commands.log"
[ "@@{1:-}" = --system ] && [ "@@{2:-}" = kcoder-relay ] || exit 2
printf '1\n' > "$TEST_STATE_DIR/account-group"
`.replaceAll('@@{', '${');

const USERADD_SHIM = String.raw`#!/bin/sh
set -eu
printf 'useradd %s\n' "$*" >> "@@{TEST_STATE_DIR:?}/commands.log"
[ "@@{1:-}" = --system ] || exit 2
printf '1\n' > "$TEST_STATE_DIR/account-user"
`.replaceAll('@@{', '${');

const CHOWN_SHIM = String.raw`#!/bin/sh
set -eu
printf 'chown %s\n' "$*" >> "@@{TEST_STATE_DIR:?}/commands.log"
[ "@@{1:-}" = "@@SERVICE_UID@@:@@SERVICE_GID@@" ] || exit 2
case "@@{2:-}" in
  "@@{KCODER_RELAY_INTERNAL_TEST_ROOT:?}"/*) ;;
  *) exit 2 ;;
esac
printf '%s\t%s\n' "$1" "$2" >> "$TEST_STATE_DIR/chown.log"
`.replaceAll('@@{', '${');

const NODE_SHIM = String.raw`#!/bin/sh
set -eu
printf 'node shim should not be executed by the lifecycle fixture\n' >&2
exit 97
`;

const CADDY_SHIM = String.raw`#!/bin/sh
set -eu
state=@@{TEST_STATE_DIR:?}
printf '%s decoy=%s\n' "@@{1:-}" "@@{HOST_ENV_DECOY:-absent}" >> "$state/caddy-trace.log"
case "@@{1:-}" in
  adapt)
    count=0
    if [ -f "$state/adapt-count" ]; then IFS= read -r count < "$state/adapt-count"; fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$state/adapt-count"
    # Model Caddy's adapted on-demand permission from the candidate's ask line (shell builtins only).
    ask=
    while IFS= read -r line; do
      case "$line" in
        *"ask http://127.0.0.1:"*"/_relay/tls-ask") ask=@@{line##* } ;;
      esac
    done < "@@{3:?}"
    if [ -n "$ask" ]; then
      printf '{"apps":{"http":{"servers":{"https":{"listen":[":443"]},"http":{"listen":[":80"]}}},"tls":{"automation":{"on_demand":{"ask":"%s"}}}}}\n' "$ask"
    else
      printf '%s\n' '{"apps":{"http":{"servers":{"https":{"listen":[":443"]},"http":{"listen":[":80"]}}}}}'
    fi
    if [ "$count" -eq 2 ] && [ -f "$state/mutate-caddy-after-second-adapt" ]; then
      printf '%s\n' 'external.example.test {' '    respond "external-revision"' '}' > "$KCODER_RELAY_INTERNAL_TEST_ROOT/etc/caddy/Caddyfile"
      printf '0\n' > "$state/mutate-caddy-after-second-adapt"
      printf '1\n' > "$state/caddy-mutated"
    fi
    ;;
  validate)
    exit 0
    ;;
  *) exit 2 ;;
esac
`.replaceAll('@@{', '${');

const POISON_SYSTEMCTL = String.raw`#!/bin/sh
set -eu
printf 'called %s\n' "$*" >> '@@POISON_MARKER@@'
exit 99
`;

function currentOwnerCanModelServiceIdentity() {
  return Number.isInteger(RELAY_UID) && Number.isInteger(RELAY_GID)
    && RELAY_UID > 0 && RELAY_UID < 65534 && RELAY_GID > 0 && RELAY_GID < 65534;
}

function skipUnsupportedFixture(t) {
  if (process.platform !== 'linux') {
    t.skip('Relay host lifecycle fixtures require Linux filesystem and systemd state semantics');
    return true;
  }
  if (!currentOwnerCanModelServiceIdentity()) {
    t.skip('Relay host lifecycle fixture needs an ordinary caller UID/GID for its private service account');
    return true;
  }
  return false;
}

function mkdirPrivate(path, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

function writeExecutable(path, contents) {
  mkdirPrivate(dirname(path));
  writeFileSync(path, contents, { mode: 0o700, flag: 'wx' });
  chmodSync(path, 0o700);
}

function copyTrustedTree(source, destination) {
  const sourceStat = lstatSync(source);
  assert.ok(sourceStat.isDirectory() && !sourceStat.isSymbolicLink(), `trusted source is a real directory: ${source}`);
  mkdirPrivate(destination, 0o755);
  for (const name of readdirSync(source).sort()) {
    if (name === '.bin') continue;
    const from = join(source, name);
    const to = join(destination, name);
    const stat = lstatSync(from);
    assert.equal(stat.isSymbolicLink(), false, `trusted staged input contains no symlink: ${from}`);
    if (stat.isDirectory()) {
      copyTrustedTree(from, to);
    } else {
      assert.ok(stat.isFile(), `trusted staged input is a regular file: ${from}`);
      copyFileSync(from, to);
      chmodSync(to, stat.mode & 0o777);
    }
  }
}

function createPoisonPath() {
  const directory = join('/tmp', `kcoder-relay-host-poison-${randomBytes(12).toString('hex')}`);
  try {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    const marker = join(directory, 'invoked.log');
    writeExecutable(join(directory, 'systemctl'), POISON_SYSTEMCTL.replace('@@POISON_MARKER@@', marker));
    return { directory, marker };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function createFixture({ missingShim } = {}) {
  assert.ok(currentOwnerCanModelServiceIdentity(), 'lifecycle integration tests need an ordinary account UID/GID');
  const root = join('/tmp', `kcoder-relay-lifecycle-test-${randomBytes(12).toString('hex')}`);
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  const stageDir = join('/var/tmp', `kcoder-relay-deploy-${randomBytes(12).toString('hex')}`);
  let rootCreated = false;
  let stageCreated = false;
  let poison;
  try {
    mkdirSync(root, { mode: 0o700 });
    rootCreated = true;
    chmodSync(root, 0o700);
    assert.equal(realpathSync(root), root);
    poison = createPoisonPath();
  mkdirPrivate(bin);
  mkdirPrivate(state);
  mkdirPrivate(join(state, 'systemd'));
  mkdirSync(stageDir, { mode: 0o700 });
  stageCreated = true;
  chmodSync(stageDir, 0o700);
  mkdirPrivate(join(root, 'usr', 'local', 'bin'), 0o755);
    mkdirPrivate(join(root, 'opt'), 0o755);
  mkdirPrivate(join(root, 'etc', 'caddy'), 0o755);
  mkdirPrivate(join(root, 'etc', 'systemd', 'system'), 0o755);
  mkdirPrivate(join(root, 'var', 'lib'), 0o755);
  mkdirPrivate(join(root, 'var', 'lib', 'kcoder-relay'), 0o700);

  const requiredShims = new Map([
    ['systemctl', SYSTEMCTL_SHIM],
    ['getent', GETENT_SHIM],
    ['id', ID_SHIM],
    ['groupadd', GROUPADD_SHIM],
    ['useradd', USERADD_SHIM],
    ['chown', CHOWN_SHIM],
  ]);
  for (const [name, source] of requiredShims) {
      if (name !== missingShim) {
        const serviceBoundSource = source
          .replaceAll('@@SERVICE_UID@@', String(RELAY_UID))
          .replaceAll('@@SERVICE_GID@@', String(RELAY_GID));
        writeExecutable(join(bin, name), serviceBoundSource);
      }
  }
  writeExecutable(join(bin, 'node'), NODE_SHIM);
  writeExecutable(join(root, 'usr', 'local', 'bin', 'caddy'), CADDY_SHIM);
  writeFileSync(join(state, 'systemd', 'active-caddy'), '1\n', { mode: 0o600 });

  const originalCaddyfile = [
    '{',
    '    auto_https disable_redirects',
    '}',
    '',
    'myapp.example.test {',
    '    respond "fixture site retained"',
    '}',
    ].join('\n') + '\n';
  writeFileSync(join(root, 'etc', 'caddy', 'Caddyfile'), originalCaddyfile, { mode: 0o644 });

  const storePath = join(root, 'var', 'lib', 'kcoder-relay', 'registered-gateways.json');
  const storeContents = '{"version":1,"gateways":[{"id":"fixture-existing"}]}\n';
  writeFileSync(storePath, storeContents, { mode: 0o600 });

  copyTrustedTree(join(RELAY_ROOT, 'src'), join(stageDir, 'src'));
  copyTrustedTree(join(RELAY_ROOT, 'deploy'), join(stageDir, 'deploy'));
  copyTrustedTree(join(RELAY_ROOT, 'node_modules'), join(stageDir, 'node_modules'));
  copyFileSync(join(RELAY_ROOT, 'package.json'), join(stageDir, 'package.json'));
  copyFileSync(join(RELAY_ROOT, 'package-lock.json'), join(stageDir, 'package-lock.json'));
  copyFileSync(ROUTE_CONTRACT, join(stageDir, 'gatewayConnectionRoutes.runtime.mjs'));
  chmodSync(join(stageDir, 'package.json'), 0o644);
  chmodSync(join(stageDir, 'package-lock.json'), 0o644);
  chmodSync(join(stageDir, 'gatewayConnectionRoutes.runtime.mjs'), 0o644);

  const fixture = {
    root,
    bin,
    state,
    stageDir,
    poison,
    originalCaddyfile,
    storePath,
    storeContents,
    registryContents: JSON.stringify({
      sharedHosts: [DOMAIN],
      gateways: [{
        id: 'fixture-gateway',
        secret: 'fixture-relay-secret-value-000000000001',
        gatewaySecret: 'fixture-pairing-token-value-0000000002',
        maxConnections: 8,
        maxBytesPerWindow: 1024 * 1024,
        trafficWindowMs: 60_000,
      }],
    }) + '\n',
  };
  writeStageConfiguration(fixture, { controlPort: CONTROL_PORT, proxyPort: PROXY_PORT });
  writePrivateFile(join(stageDir, 'registry.json'), fixture.registryContents);

  return fixture;
  } catch (error) {
    if (stageCreated) rmSync(stageDir, { recursive: true, force: true });
    if (rootCreated) rmSync(root, { recursive: true, force: true });
    if (poison) rmSync(poison.directory, { recursive: true, force: true });
    throw error;
  }
}

function writePrivateFile(path, contents) {
  writeFileSync(path, contents, { mode: 0o600, flag: 'w' });
  chmodSync(path, 0o600);
}

function writeStageConfiguration(fixture, { controlPort, proxyPort }) {
  const cloud = [
    `KCODER_RELAY_PUBLIC_URL=https://${DOMAIN}`,
    `KCODER_RELAY_CONTROL_PORT=${controlPort}`,
    `KCODER_RELAY_PROXY_PORT=${proxyPort}`,
    'KCODER_RELAY_REGISTRATION_STORE_FILE=/var/lib/kcoder-relay/registered-gateways.json',
    '',
  ].join('\n');
  const caddy = [
    `KCODER_RELAY_DOMAIN=${DOMAIN}`,
    `KCODER_RELAY_PUBLIC_PORT=${PUBLIC_PORT}`,
    `KCODER_RELAY_CONTROL_PORT=${controlPort}`,
    `KCODER_RELAY_PROXY_PORT=${proxyPort}`,
    '',
  ].join('\n');
  writePrivateFile(join(fixture.stageDir, 'cloud.env'), cloud);
  writePrivateFile(join(fixture.stageDir, 'caddy.env'), caddy);
}

function remotePath(fixture, absoluteHostPath) {
  return join(fixture.root, absoluteHostPath.replace(/^\/+/, ''));
}

function lifecycleEnvironment(fixture, additional = {}) {
  return {
    HOME: fixture.root,
    LC_ALL: 'C',
    PATH: fixture.poison.directory,
    HOST_ENV_DECOY: 'host-env-should-not-reach-fixture-tools',
    TEST_STATE_DIR: fixture.state,
    CADDY_BIN: join(fixture.root, 'usr', 'local', 'bin', 'caddy'),
    CADDY_CONFIG: remotePath(fixture, '/etc/caddy/Caddyfile'),
    KCODER_RELAY_INTERNAL_TEST_ROOT: fixture.root,
    KCODER_RELAY_INTERNAL_TEST_NODE: join(fixture.bin, 'node'),
    KCODER_RELAY_INTERNAL_TEST_UID: String(RELAY_UID),
    KCODER_RELAY_INTERNAL_TEST_GID: String(RELAY_GID),
    ...additional,
  };
}

function runLifecycle(fixture, action, additional = {}) {
  const result = spawnSync(process.execPath, [HOST_LIFECYCLE, action, '--stage-dir', fixture.stageDir], {
    encoding: 'utf8',
    env: lifecycleEnvironment(fixture, additional),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  let payload;
  if (output.length > 0) payload = JSON.parse(output.at(-1));
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, payload };
}

function setStageRevision(fixture, { controlPort, proxyPort, sourceMarker }) {
  const serverPath = join(fixture.stageDir, 'src', 'server.mjs');
  const trustedSource = readFileSync(join(RELAY_ROOT, 'src', 'server.mjs'));
  writeFileSync(serverPath, Buffer.concat([trustedSource, Buffer.from(`\n// ${sourceMarker}\n`)]), { mode: 0o644 });
  writeStageConfiguration(fixture, { controlPort, proxyPort });
}

function captureFile(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `fixture state contains a regular file: ${path}`);
  return {
    contents: readFileSync(path),
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
    nlink: stat.nlink,
  };
}

function captureTree(path, result) {
  if (!existsSync(path)) return;
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name);
    const stat = lstatSync(child);
    assert.equal(stat.isSymbolicLink(), false, `fixture state contains no symlink: ${child}`);
    if (stat.isDirectory()) captureTree(child, result);
    else result.set(child, captureFile(child));
  }
}

function snapshotRemoteFiles(fixture) {
  const result = new Map();
  const paths = [
    '/etc/kcoder-relay.env',
    '/etc/kcoder-relay-registry.json',
    '/etc/systemd/system/kcoder-relay.service',
    '/etc/caddy/Caddyfile',
    '/etc/caddy/kcoder-relay.caddy',
    '/var/lib/kcoder-relay/registered-gateways.json',
    '/var/lib/kcoder-relay-deploy/owner.json',
  ];
  for (const path of paths) {
    const state = captureFile(remotePath(fixture, path));
    if (state) result.set(path, state);
  }
  captureTree(remotePath(fixture, '/opt/kcoder-relay'), result);
  return new Map([...result.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function markerValue(path) {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8').trim();
}

function assertRelayActive(fixture, { active, enabled }) {
  assert.equal(markerValue(join(fixture.state, 'systemd', 'active-relay')) === '1', active);
  assert.equal(markerValue(join(fixture.state, 'systemd', 'enabled-relay')) === '1', enabled);
  assert.equal(markerValue(join(fixture.state, 'systemd', 'active-caddy')) === '1', true);
}

function assertNoPoisonCommand(fixture) {
  assert.equal(existsSync(fixture.poison.marker), false, 'ambient PATH decoy was never executed');
}

function cleanupFixture(fixture) {
  rmSync(fixture.stageDir, { recursive: true, force: true });
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(fixture.poison.directory, { recursive: true, force: true });
  assert.equal(existsSync(fixture.stageDir), false);
  assert.equal(existsSync(fixture.root), false);
  assert.equal(existsSync(fixture.poison.directory), false);
}

test('Relay host upgrade restart failure restores installed files, receipt, and active state', (t) => {
  if (skipUnsupportedFixture(t)) return;
  const fixture = createFixture();
  t.after(() => cleanupFixture(fixture));

  const installed = runLifecycle(fixture, 'install');
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.payload?.state, 'active');
  assert.equal(installed.payload?.component, 'relay');
  assertRelayActive(fixture, { active: true, enabled: true });
  assert.ok(existsSync(join(fixture.state, 'chown.log')), 'static registry ownership was handled by the private shim');
  assertNoPoisonCommand(fixture);

  const installedReceipt = JSON.parse(readFileSync(remotePath(fixture, '/var/lib/kcoder-relay-deploy/owner.json'), 'utf8'));
  assert.equal(installedReceipt.state, 'active');
  assert.equal(installedReceipt.action, 'install');
  const beforeUpgrade = snapshotRemoteFiles(fixture);

  setStageRevision(fixture, {
    controlPort: CONTROL_PORT + 10,
    proxyPort: PROXY_PORT + 10,
    sourceMarker: 'lifecycle fixture revision 2',
  });
  assert.match(readFileSync(join(fixture.stageDir, 'src', 'server.mjs'), 'utf8'), /lifecycle fixture revision 2/);

  const upgraded = runLifecycle(fixture, 'upgrade', { FAIL_RELAY_RESTART_ONCE: '1' });
  assert.equal(upgraded.status, 4, upgraded.stderr);
  assert.equal(upgraded.payload?.state, 'partial');
  assert.equal(markerValue(join(fixture.state, 'relay-restart-failed')), '1', 'the injected restart error fired once');
  assert.deepEqual(snapshotRemoteFiles(fixture), beforeUpgrade, 'all installed files and the prior receipt were restored byte-for-byte');
  assertRelayActive(fixture, { active: true, enabled: true });
  assert.equal(markerValue(join(fixture.state, 'mainpid-read')), undefined, 'TEST_ROOT never reads the host Caddy MainPID environment');
  assertNoPoisonCommand(fixture);

  const receiptAfterRollback = JSON.parse(readFileSync(remotePath(fixture, '/var/lib/kcoder-relay-deploy/owner.json'), 'utf8'));
  assert.deepEqual(receiptAfterRollback, installedReceipt);
  assert.equal(readdirSync(remotePath(fixture, '/var/lib/kcoder-relay-deploy')).sort().join(','), 'owner.json');
  const caddyTrace = readFileSync(join(fixture.state, 'caddy-trace.log'), 'utf8');
  assert.match(caddyTrace, /decoy=absent/);
  assert.doesNotMatch(caddyTrace, /host-env-should-not-reach-fixture-tools/);
});

test('Relay cleanup rolls back Caddy reload failure, preserves registry and store, then retries idempotently', (t) => {
  if (skipUnsupportedFixture(t)) return;
  const fixture = createFixture();
  t.after(() => cleanupFixture(fixture));

  const installed = runLifecycle(fixture, 'install');
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.payload?.state, 'active');
  const beforeCleanup = snapshotRemoteFiles(fixture);
  const registryBefore = captureFile(remotePath(fixture, '/etc/kcoder-relay-registry.json'));
  const storeBefore = captureFile(fixture.storePath);
  assert.ok(registryBefore);
  assert.ok(storeBefore);

  const failedCleanup = runLifecycle(fixture, 'cleanup', { FAIL_CADDY_RELOAD_ONCE: '1' });
  const envPath = remotePath(fixture, '/etc/kcoder-relay.env');
  const ownerDebug = `receipt owner=${JSON.parse(readFileSync(remotePath(fixture, '/var/lib/kcoder-relay-deploy/owner.json'), 'utf8')).fileOwners?.[envPath]}, actual uid=${lstatSync(envPath).uid}, fixture uid=${RELAY_UID}`;
  assert.equal(failedCleanup.status, 4, `${failedCleanup.stderr}; ${ownerDebug}`);
  assert.equal(failedCleanup.payload?.state, 'incomplete');
  assert.equal(markerValue(join(fixture.state, 'caddy-reload-failed')), '1', 'the injected Caddy reload error fired once');
  assert.deepEqual(snapshotRemoteFiles(fixture), beforeCleanup, 'failed cleanup restored every Relay, Caddy, registry, store, and receipt file');
  assertRelayActive(fixture, { active: true, enabled: true });
  assert.equal(markerValue(join(fixture.state, 'mainpid-read')), undefined);
  assertNoPoisonCommand(fixture);

  const cleanup = runLifecycle(fixture, 'cleanup');
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(cleanup.payload?.state, 'resources-removed');
  assert.equal(cleanup.payload?.registrationStore?.state, 'present');
  assertRelayActive(fixture, { active: false, enabled: false });
  assert.equal(existsSync(remotePath(fixture, '/etc/kcoder-relay.env')), false);
  assert.equal(existsSync(remotePath(fixture, '/etc/systemd/system/kcoder-relay.service')), false);
  assert.equal(existsSync(remotePath(fixture, '/etc/caddy/kcoder-relay.caddy')), false);
  assert.equal(existsSync(remotePath(fixture, '/var/lib/kcoder-relay-deploy/owner.json')), false);
  assert.equal(existsSync(remotePath(fixture, '/opt/kcoder-relay/src/server.mjs')), false);
  assert.equal(readFileSync(remotePath(fixture, '/etc/caddy/Caddyfile'), 'utf8'), fixture.originalCaddyfile);
  assert.deepEqual(captureFile(remotePath(fixture, '/etc/kcoder-relay-registry.json')), registryBefore);
  assert.deepEqual(captureFile(fixture.storePath), storeBefore);
  assert.equal(markerValue(join(fixture.state, 'mainpid-read')), undefined);
  assertNoPoisonCommand(fixture);

  const retainedState = snapshotRemoteFiles(fixture);
  const repeated = runLifecycle(fixture, 'cleanup');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.payload?.state, 'absent');
  assert.equal(repeated.payload?.registrationStore?.state, 'present');
  assert.deepEqual(snapshotRemoteFiles(fixture), retainedState, 'repeated cleanup leaves retained registry and registration store untouched');
  assertRelayActive(fixture, { active: false, enabled: false });
  assertNoPoisonCommand(fixture);
});

test('missing required command shim fails closed without consulting ambient PATH', (t) => {
  if (skipUnsupportedFixture(t)) return;
  const fixture = createFixture({ missingShim: 'systemctl' });
  t.after(() => cleanupFixture(fixture));

  const result = runLifecycle(fixture, 'install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required internal command shim is missing/);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(join(fixture.state, 'commands.log')), false, 'no fixture host command ran before the fail-closed import error');
  assertNoPoisonCommand(fixture);
});

for (const failedRollbackStep of ['stop', 'disable']) {
  test(`new-unit rollback keeps files and receipt when systemctl ${failedRollbackStep} fails, then recovers`, (t) => {
    if (skipUnsupportedFixture(t)) return;
    const fixture = createFixture();
    t.after(() => cleanupFixture(fixture));

    writeFileSync(join(fixture.state, 'fail-next-relay-active-check'), '1\n', { mode: 0o600 });
    writeFileSync(join(fixture.state, `fail-next-relay-${failedRollbackStep}`), '1\n', { mode: 0o600 });
    const failedInstall = runLifecycle(fixture, 'install');
    assert.equal(failedInstall.status, 4, failedInstall.stderr);
    assert.equal(failedInstall.payload?.state, 'partial');
    assert.equal(markerValue(join(fixture.state, 'relay-active-check-failed')), '1');
    assert.equal(markerValue(join(fixture.state, `relay-${failedRollbackStep}-failed`)), '1');

    const receiptPath = remotePath(fixture, '/var/lib/kcoder-relay-deploy/owner.json');
    const pendingReceipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(pendingReceipt.state, 'rollback-pending');
    assert.equal(pendingReceipt.transaction.state, 'rollback-pending');
    assert.ok(existsSync(remotePath(fixture, '/etc/kcoder-relay.env')));
    assert.ok(existsSync(remotePath(fixture, '/etc/systemd/system/kcoder-relay.service')));
    assert.ok(existsSync(remotePath(fixture, '/etc/caddy/kcoder-relay.caddy')));
    assert.ok(existsSync(remotePath(fixture, '/opt/kcoder-relay/src/server.mjs')));
    assert.equal(
      markerValue(join(fixture.state, 'systemd', 'active-relay')) === '1',
      failedRollbackStep === 'stop',
      'a failed stop leaves the new process active; a failed disable happens after stop',
    );
    assert.equal(markerValue(join(fixture.state, 'systemd', 'enabled-relay')), '1');
    assertNoPoisonCommand(fixture);

    const pendingFiles = snapshotRemoteFiles(fixture);
    const status = runLifecycle(fixture, 'status');
    const ownerDebug = `receipt owner=${JSON.parse(readFileSync(receiptPath, 'utf8')).fileOwners?.[remotePath(fixture, '/etc/kcoder-relay.env')]}, actual uid=${lstatSync(remotePath(fixture, '/etc/kcoder-relay.env')).uid}, fixture uid=${RELAY_UID}`;
    assert.equal(status.status, 0, `${status.stderr}; ${ownerDebug}`);
    assert.equal(status.payload?.state, 'rollback-pending');
    assert.deepEqual(snapshotRemoteFiles(fixture), pendingFiles, 'status reports but does not alter pending transaction files');

    const recovered = runLifecycle(fixture, 'cleanup');
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.payload?.state, 'absent');
    assert.equal(readFileSync(remotePath(fixture, '/etc/caddy/Caddyfile'), 'utf8'), fixture.originalCaddyfile);
    assert.equal(existsSync(remotePath(fixture, '/etc/kcoder-relay.env')), false);
    assert.equal(existsSync(remotePath(fixture, '/etc/systemd/system/kcoder-relay.service')), false);
    assert.equal(existsSync(remotePath(fixture, '/etc/caddy/kcoder-relay.caddy')), false);
    assert.equal(existsSync(receiptPath), false);
    assert.equal(existsSync(remotePath(fixture, '/opt/kcoder-relay/src/server.mjs')), false);
    assert.equal(readFileSync(fixture.storePath, 'utf8'), fixture.storeContents);
    assertRelayActive(fixture, { active: false, enabled: false });
    assertNoPoisonCommand(fixture);
  });
}

test('Relay install Caddy compare-and-swap preserves a concurrent external revision', (t) => {
  if (skipUnsupportedFixture(t)) return;
  const fixture = createFixture();
  t.after(() => cleanupFixture(fixture));
  const concurrentCaddyfile = [
    'external.example.test {',
    '    respond "external-revision"',
    '}',
    '',
  ].join('\n');
  writeFileSync(join(fixture.state, 'mutate-caddy-after-second-adapt'), '1\n', { mode: 0o600 });

  const result = runLifecycle(fixture, 'install');
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.payload?.state, 'conflict');
  assert.equal(markerValue(join(fixture.state, 'caddy-mutated')), '1');
  assert.equal(readFileSync(remotePath(fixture, '/etc/caddy/Caddyfile'), 'utf8'), concurrentCaddyfile);
  assert.equal(existsSync(remotePath(fixture, '/etc/caddy/kcoder-relay.caddy')), false);
  assert.equal(existsSync(remotePath(fixture, '/etc/kcoder-relay.env')), false);
  assert.equal(existsSync(remotePath(fixture, '/etc/systemd/system/kcoder-relay.service')), false);
  assert.equal(existsSync(remotePath(fixture, '/var/lib/kcoder-relay-deploy/owner.json')), false);
  assert.equal(markerValue(join(fixture.state, 'systemd', 'active-relay')), undefined);
  assert.equal(markerValue(join(fixture.state, 'systemd', 'enabled-relay')), undefined);
  assertNoPoisonCommand(fixture);
});

test('Relay install refuses a missing persistent Caddyfile without writing host state', (t) => {
  if (skipUnsupportedFixture(t)) return;
  const fixture = createFixture();
  t.after(() => cleanupFixture(fixture));
  const caddyfile = remotePath(fixture, '/etc/caddy/Caddyfile');
  rmSync(caddyfile);
  const beforeInstall = snapshotRemoteFiles(fixture);

  const result = runLifecycle(fixture, 'install');
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.payload?.state, 'conflict');
  assert.match(result.stderr, /persistent \/etc\/caddy\/Caddyfile/);
  assert.deepEqual(snapshotRemoteFiles(fixture), beforeInstall, 'install did not create or replace Caddy or Relay target files');
  assert.equal(existsSync(caddyfile), false);
  assert.equal(existsSync(remotePath(fixture, '/etc/kcoder-relay.env')), false);
  assert.equal(existsSync(remotePath(fixture, '/etc/kcoder-relay-registry.json')), false);
  assert.equal(existsSync(remotePath(fixture, '/etc/systemd/system/kcoder-relay.service')), false);
  assert.equal(existsSync(remotePath(fixture, '/etc/caddy/kcoder-relay.caddy')), false);
  assert.equal(existsSync(remotePath(fixture, '/var/lib/kcoder-relay-deploy/owner.json')), false);
  assert.equal(existsSync(remotePath(fixture, '/opt/kcoder-relay/src/server.mjs')), false);
  assertRelayActive(fixture, { active: false, enabled: false });
  assert.equal(markerValue(join(fixture.state, 'account-group')), undefined);
  assert.equal(markerValue(join(fixture.state, 'account-user')), undefined);
  assert.equal(existsSync(join(fixture.state, 'caddy-trace.log')), false);
  assertNoPoisonCommand(fixture);
});
