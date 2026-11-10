import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildStunConfig,
  buildStunUnit,
  createStunLifecycleCommand,
  validateStunConfig,
  validateStunPort,
  validateStunUnit,
} from '../deploy/stun-lifecycle.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hostScript = path.join(repoRoot, 'apps/kcoder-relay/deploy/stun-host.sh');
const fixtureRoots = new Set();
const udpServers = new Set();

afterEach(async () => {
  for (const server of udpServers) {
    await new Promise((resolve) => server.close(resolve));
  }
  udpServers.clear();
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
});

function makeFixture({ distro = 'ubuntu', installedVersion = '' } = {}) {
  const root = path.join('/tmp', `kcoder-stun-fixture-${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(root, { mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fixtureRoots.add(root);
  const dirs = [
    'bin', 'etc', 'etc/coturn', 'etc/systemd', 'etc/systemd/system', 'var', 'var/lib', 'var/lib/fake',
    'usr', 'usr/bin', 'usr/lib', 'usr/lib/systemd', 'usr/lib/systemd/system', 'lib', 'lib/systemd',
    'lib/systemd/system', 'proc', 'proc/net',
  ];
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true, mode: dir === 'bin' ? 0o700 : 0o755 });
  fs.chmodSync(path.join(root, 'bin'), 0o700);
  fs.writeFileSync(path.join(root, 'etc/os-release'), `ID=${distro}\n`, { mode: 0o644 });
  fs.writeFileSync(path.join(root, 'proc/net/udp'), ' sl local_address rem_address st\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'proc/net/udp6'), ' sl local_address rem_address st\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'var/lib/fake/coturn-version'), `${installedVersion}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'var/lib/fake/trace'), '', { mode: 0o600 });
  writeShim(root, 'systemctl', systemctlShim);
  writeShim(root, 'systemd-analyze', systemdAnalyzeShim);
  writeShim(root, 'dpkg-query', dpkgQueryShim);
  writeShim(root, 'rpm', rpmShim);
  writeShim(root, 'apt-get', aptShim);
  writeShim(root, 'dnf', dnfShim);
  if (installedVersion) installFakeTurnserver(root);
  return root;
}

function writeShim(root, name, contents) {
  const file = path.join(root, 'bin', name);
  fs.writeFileSync(file, contents, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
}

const systemctlShim = `#!/bin/bash
set -eu
root=$KCODER_STUN_FIXTURE_ROOT
printf 'systemctl %s\\n' "$*" >> "$root/var/lib/fake/trace"
cmd=$1
shift
failure_mode=\${KCODER_STUN_TEST_SYSTEMCTL_FAIL:-}
if [[ "$failure_mode" == "$cmd" || "$failure_mode" == "$cmd-always" ]]; then
  printf 'injected systemctl failure: %s\\n' "$cmd" >&2; exit 1
fi
if [[ "$failure_mode" == "$cmd-once" && ! -e "$root/var/lib/fake/systemctl-$cmd-failed-once" ]]; then
  : > "$root/var/lib/fake/systemctl-$cmd-failed-once"
  printf 'injected one-time systemctl failure: %s\\n' "$cmd" >&2; exit 1
fi
if [[ "$cmd" == stop && "\${KCODER_STUN_TEST_SYSTEMCTL_FAIL:-}" == stop-residual ]]; then exit 0; fi
unit=
property=
for arg in "$@"; do
  case "$arg" in
    --property=*) property=\${arg#--property=} ;;
    --value) ;;
    -*) ;;
    *) unit=$arg ;;
  esac
done
state="$root/var/lib/fake/\${unit}.state"
case "$cmd" in
  daemon-reload) exit 0 ;;
  show)
    case "$unit" in
      coturn.service)
        if [[ -L "$root/etc/systemd/system/coturn.service" ]]; then
          case "$property" in LoadState) printf 'masked\\n';; FragmentPath) printf '/dev/null\\n';; *) printf '\\n';; esac
        else
          case "$property" in LoadState) printf 'not-found\\n';; *) printf '\\n';; esac
        fi
        ;;
      *)
        unitfile="$root/etc/systemd/system/$unit"
        case "$property" in
          LoadState) [[ -f "$unitfile" ]] && printf 'loaded\\n' || printf 'not-found\\n' ;;
          FragmentPath) [[ -f "$unitfile" ]] && printf '%s\\n' "$unitfile" || printf '\\n' ;;
          MainPID)
            if [[ -f "$state" ]] && [[ "$(<"$state")" == active:* ]]; then printf '4321\\n'; else printf '0\\n'; fi
            ;;
          DropInPaths)
            for dropdir in "$root/etc/systemd/system/$unit.d" "$root/usr/lib/systemd/system/$unit.d" "$root/lib/systemd/system/$unit.d"; do
              for dropin in "$dropdir"/*.conf; do [[ -f "$dropin" ]] && printf '%s ' "$dropin"; done
            done
            printf '\\n'
            ;;
          *) printf '\\n' ;;
        esac
        ;;
    esac
    ;;
  is-active)
    if [[ -f "$state" ]] && [[ "$(<"$state")" == active:* ]]; then printf 'active\\n'; exit 0; fi
    printf 'inactive\\n'; exit 3
    ;;
  is-enabled)
    if [[ "$unit" == coturn.service && -L "$root/etc/systemd/system/coturn.service" ]]; then printf 'masked\\n'; exit 1; fi
    if [[ -f "$state" ]] && [[ "$(<"$state")" == *:enabled ]]; then printf 'enabled\\n'; exit 0; fi
    printf 'disabled\\n'; exit 1
    ;;
  enable)
    [[ -f "$root/etc/systemd/system/$unit" ]] || exit 1
    old=inactive
    [[ -f "$state" && "$(<"$state")" == active:* ]] && old=active
    printf '%s:enabled\\n' "$old" > "$state"
    ;;
  disable)
    old=inactive
    [[ -f "$state" && "$(<"$state")" == active:* ]] && old=active
    printf '%s:disabled\\n' "$old" > "$state"
    ;;
  start|restart)
    [[ -f "$root/etc/systemd/system/$unit" ]] || exit 1
    printf 'active:enabled\\n' > "$state"
    ;;
  stop)
    enabled=disabled
    [[ -f "$state" && "$(<"$state")" == *:enabled ]] && enabled=enabled
    printf 'inactive:%s\\n' "$enabled" > "$state"
    ;;
  reset-failed)
    if [[ "$failure_mode" == reset-failed-not-loaded ]]; then
      printf 'Failed to reset failed state of unit %s: Unit %s not loaded.\\n' "$unit" "$unit" >&2
      exit 4
    fi
    if [[ -f "$state" && "$(<"$state")" == failed:* ]]; then printf 'inactive:disabled\\n' > "$state"; fi
    ;;
  *) printf 'unsupported fake systemctl command: %s\\n' "$cmd" >&2; exit 64 ;;
esac
`;

const systemdAnalyzeShim = `#!/bin/bash
set -eu
printf 'systemd-analyze %s\\n' "$*" >> "$KCODER_STUN_FIXTURE_ROOT/var/lib/fake/trace"
[[ "$1" == verify && -f "$2" ]]
unit_text=$(<"$2")
[[ "$unit_text" == *'ExecStart=/usr/bin/turnserver -c /etc/coturn/'* ]]
`;

const dpkgQueryShim = `#!/bin/bash
set -eu
printf 'dpkg-query %s\\n' "$*" >> "$KCODER_STUN_FIXTURE_ROOT/var/lib/fake/trace"
value=$(<"$KCODER_STUN_FIXTURE_ROOT/var/lib/fake/coturn-version")
if [[ "$*" == *'db:Status-Status'* ]]; then
  if [[ -n "$value" ]]; then printf 'installed';
  elif [[ -e "$KCODER_STUN_FIXTURE_ROOT/var/lib/fake/coturn-residual-version" ]]; then printf 'config-files';
  else exit 1; fi
  exit 0
fi
if [[ -z "$value" && -e "$KCODER_STUN_FIXTURE_ROOT/var/lib/fake/coturn-residual-version" ]]; then
  value=$(<"$KCODER_STUN_FIXTURE_ROOT/var/lib/fake/coturn-residual-version")
fi
[[ -n "$value" ]] || exit 1
printf '%s' "$value"
`;

const rpmShim = `#!/bin/bash
set -eu
printf 'rpm %s\\n' "$*" >> "$KCODER_STUN_FIXTURE_ROOT/var/lib/fake/trace"
value=$(<"$KCODER_STUN_FIXTURE_ROOT/var/lib/fake/coturn-version")
[[ -n "$value" ]] || exit 1
printf '%s' "$value"
`;

const aptShim = `#!/bin/bash
set -eu
root=$KCODER_STUN_FIXTURE_ROOT
printf 'apt-get %s\\n' "$*" >> "$root/var/lib/fake/trace"
args="$*"
if [[ "$args" == *' remove '* || "$args" == remove* ]]; then
  : > "$root/var/lib/fake/coturn-version"
  /bin/rm -f "$root/usr/bin/turnserver"
elif [[ "$args" == *'--only-upgrade'* ]]; then
  printf '2.0\\n' > "$root/var/lib/fake/coturn-version"
elif [[ "$args" == *'coturn='* ]]; then
  if [[ -e "$root/var/lib/fake/package-restore-lie" ]]; then exit 0; fi
  version=\${args##*coturn=}
  printf '%s\\n' "$version" > "$root/var/lib/fake/coturn-version"
elif [[ "$args" == install* ]]; then
  printf '1.0\\n' > "$root/var/lib/fake/coturn-version"
  printf '#!/bin/sh\\nexit 0\\n' > "$root/usr/bin/turnserver"
  /bin/chmod 755 "$root/usr/bin/turnserver"
else
  printf 'unsupported apt command\\n' >&2; exit 64
fi
`;

const dnfShim = `#!/bin/bash
set -eu
root=$KCODER_STUN_FIXTURE_ROOT
printf 'dnf %s\\n' "$*" >> "$root/var/lib/fake/trace"
args="$*"
if [[ "$args" == remove* ]]; then
  : > "$root/var/lib/fake/coturn-version"
  /bin/rm -f "$root/usr/bin/turnserver"
elif [[ "$args" == upgrade* ]]; then
  printf '2.0\\n' > "$root/var/lib/fake/coturn-version"
elif [[ "$args" == *'coturn-'* ]]; then
  version=\${args##*coturn-}
  printf '%s\\n' "$version" > "$root/var/lib/fake/coturn-version"
  printf '#!/bin/sh\\nexit 0\\n' > "$root/usr/bin/turnserver"
  /bin/chmod 755 "$root/usr/bin/turnserver"
elif [[ "$args" == install* ]]; then
  printf '1.0\\n' > "$root/var/lib/fake/coturn-version"
  printf '#!/bin/sh\\nexit 0\\n' > "$root/usr/bin/turnserver"
  /bin/chmod 755 "$root/usr/bin/turnserver"
else
  printf 'unsupported dnf command\\n' >&2; exit 64
fi
`;

function installFakeTurnserver(root) {
  const file = path.join(root, 'usr/bin/turnserver');
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function runHost(root, args, { failAt, failSystemctl } = {}) {
  const env = {
    ...process.env,
    KCODER_STUN_FIXTURE_ROOT: root,
    PATH: process.env.PATH,
  };
  if (failAt) env.KCODER_STUN_TEST_FAIL_AT = failAt;
  else delete env.KCODER_STUN_TEST_FAIL_AT;
  if (failSystemctl) env.KCODER_STUN_TEST_SYSTEMCTL_FAIL = failSystemctl;
  else delete env.KCODER_STUN_TEST_SYSTEMCTL_FAIL;
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', 'umask 077; exec bash "$@"', 'owned-stun-fixture', hostScript, ...args], { encoding: 'utf8', env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status: status ?? 128, signal, stdout, stderr }));
  });
}

function trace(root) {
  return fs.readFileSync(path.join(root, 'var/lib/fake/trace'), 'utf8');
}

async function makeStunResponder(port = 0, { dropFirst = false, onRequest } = {}) {
  let requestCount = 0;
  const server = dgram.createSocket('udp4');
  server.on('message', (request, peer) => {
    if (request.length < 20 || request.readUInt16BE(0) !== 1 || request.readUInt32BE(4) !== 0x2112a442) return;
    requestCount += 1;
    onRequest?.(request, requestCount);
    if (dropFirst && requestCount === 1) return;
    const response = Buffer.alloc(20);
    response.writeUInt16BE(0x0101, 0);
    response.writeUInt16BE(0, 2);
    response.writeUInt32BE(0x2112a442, 4);
    request.copy(response, 8, 8, 20);
    server.send(response, peer.port, peer.address);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.bind(port, '127.0.0.1', resolve);
  });
  udpServers.add(server);
  return server.address().port;
}

function outputJson(result) {
  const line = result.stdout.trim();
  assert.ok(line, `expected one JSON result, stderr=${result.stderr}`);
  return JSON.parse(line);
}

describe('STUN host lifecycle builder contracts', () => {
  it('uses strict decimal UDP ports from 1024 through 65535', () => {
    assert.equal(validateStunPort(1024), 1024);
    assert.equal(validateStunPort('65535'), 65535);
    for (const value of [1023, 0, 65536, '8e3', ' 8452', '+8452', '']) {
      assert.throws(() => validateStunPort(value));
    }
    assert.throws(() => buildStunConfig({ port: 80 }));
  });

  it('generates and validates the strict STUN-only policy and dedicated unit', () => {
    const config = buildStunConfig({ port: 8452 });
    assert.deepEqual(validateStunConfig(config, { port: 8452 }).directives.sort(), [
      'listening-port', 'listening-ip', 'stun-only', 'no-auth', 'no-tcp', 'no-tls', 'no-dtls', 'no-cli',
    ].sort());
    assert.throws(() => validateStunConfig(`${config}user=turn\n`, { port: 8452 }));
    const unit = buildStunUnit();
    assert.deepEqual(validateStunUnit(unit), { unitName: 'kcoder-stun.service', configPath: '/etc/coturn/kcoder-stun.conf' });
    assert.throws(() => validateStunUnit(unit.replace('/usr/bin/turnserver', '/bin/sh')));
  });

  it('builds shell-safe host commands and requires explicit ports only for mutations', () => {
    assert.equal(
      createStunLifecycleCommand({ action: 'install', port: 8452, scriptPath: '/tmp/stun host.sh' }),
      "sudo -n bash '/tmp/stun host.sh' install --port 8452",
    );
    assert.equal(createStunLifecycleCommand({ action: 'cleanup' }), 'sudo -n bash \'/opt/kcoder-relay/deploy/stun-host.sh\' cleanup');
    assert.throws(() => createStunLifecycleCommand({ action: 'install', port: 443 }));
    assert.throws(() => createStunLifecycleCommand({ action: 'cleanup', port: 8452 }));
  });
});

describe('STUN host lifecycle shell execution in a private fixture domain', {
  skip: process.platform === 'linux'
    ? false
    : 'requires Linux bash, GNU coreutils, and canonical /tmp fixture paths',
}, () => {
  it('creates traversable public config directories under a private caller umask', async () => {
    const root = makeFixture();
    fs.rmdirSync(path.join(root, 'etc/coturn'));
    const port = await makeStunResponder();
    const result = await runHost(root, ['install', '--port', String(port)]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(path.join(root, 'etc/coturn')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(root, 'var/lib/kcoder-relay-stun')).mode & 0o777, 0o700);
  });

  it('does not mistake residual Debian config files for an installed package during rollback', async () => {
    const root = makeFixture();
    fs.writeFileSync(path.join(root, 'var/lib/fake/coturn-residual-version'), '0.9\n', { mode: 0o600 });
    const port = await makeStunResponder();
    const result = await runHost(root, ['install', '--port', String(port)], { failAt: 'config-rename' });
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stderr, /injected fixture failure at config-rename/);
    assert.doesNotMatch(result.stderr, /rollback is pending/);
    assert.equal(fs.existsSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'etc/systemd/system/coturn.service')), false);
  });

  it('installs, upgrades, reports, and cleans a newly owned apt package with a real UDP probe', async () => {
    const root = makeFixture();
    const firstPort = await makeStunResponder();
    const secondPort = await makeStunResponder();

    const install = await runHost(root, ['install', '--port', String(firstPort)]);
    assert.equal(install.status, 0, install.stderr);
    assert.deepEqual(outputJson(install), {
      component: 'stun', action: 'install', state: 'active', unit: 'kcoder-stun.service',
      config: '/etc/coturn/kcoder-stun.conf', port: firstPort, packageManager: 'apt',
      packageInstalledByKcoder: true, receiptState: 'active',
    });
    const stateDir = path.join(root, 'var/lib/kcoder-relay-stun');
    assert.equal((fs.statSync(stateDir).mode & 0o777), 0o700);
    assert.equal((fs.statSync(path.join(stateDir, 'owner.json')).mode & 0o777), 0o600);
    assert.equal(fs.readFileSync(path.join(root, 'etc/coturn/kcoder-stun.conf'), 'utf8').includes('stun-only'), true);
    assert.equal(fs.lstatSync(path.join(root, 'etc/systemd/system/coturn.service')).isSymbolicLink(), true);

    const status = await runHost(root, ['status']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(outputJson(status).port, firstPort);

    const badInstall = await runHost(root, ['install', '--port', String(secondPort)]);
    assert.equal(badInstall.status, 3);
    assert.match(badInstall.stderr, /install cannot change the owned port/);
    assert.equal(fs.readFileSync(path.join(stateDir, 'owner.json'), 'utf8').includes(`"port": ${firstPort}`), true);

    const upgrade = await runHost(root, ['upgrade', '--port', String(secondPort)]);
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.equal(outputJson(upgrade).port, secondPort);
    assert.match(trace(root), /apt-get install -y --only-upgrade coturn/);
    assert.match(trace(root), /systemctl restart kcoder-stun.service/);

    fs.writeFileSync(path.join(root, 'var/lib/fake/kcoder-stun.service.state'), 'inactive:enabled\n');
    const inactiveStatus = await runHost(root, ['status']);
    assert.equal(inactiveStatus.status, 0, inactiveStatus.stderr);
    assert.deepEqual(outputJson(inactiveStatus), {
      component: 'stun', action: 'status', state: 'inactive', healthy: false, unit: 'kcoder-stun.service',
      config: '/etc/coturn/kcoder-stun.conf', port: secondPort, packageManager: 'apt',
      packageInstalledByKcoder: true, receiptState: 'active',
    });

    const cleanup = await runHost(root, ['cleanup']);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(outputJson(cleanup).state, 'absent');
    assert.equal(fs.existsSync(path.join(root, 'etc/coturn/kcoder-stun.conf')), false);
    assert.equal(fs.existsSync(path.join(root, 'etc/systemd/system/kcoder-stun.service')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'owner.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'etc/systemd/system/coturn.service')), false);
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '');
  });

  it('retries the same Binding transaction when the first startup probe is dropped', async () => {
    const root = makeFixture();
    const transactions = [];
    const port = await makeStunResponder(0, {
      dropFirst: true,
      onRequest: (request) => transactions.push(request.subarray(8, 20).toString('hex')),
    });
    const install = await runHost(root, ['install', '--port', String(port)]);
    assert.equal(install.status, 0, install.stderr);
    assert.ok(transactions.length >= 2, `expected a retry, saw ${transactions.length} Binding request`);
    assert.equal(new Set(transactions).size, 1, 'retries keep the same STUN transaction ID');

    const cleanup = await runHost(root, ['cleanup']);
    assert.equal(cleanup.status, 0, cleanup.stderr);
  });

  it('keeps a preinstalled shared dnf package through upgrade and cleanup', async () => {
    const root = makeFixture({ distro: 'opencloudos', installedVersion: '4.6.2-1.el9' });
    const port = await makeStunResponder();
    const install = await runHost(root, ['install', '--port', String(port)]);
    assert.equal(install.status, 0, install.stderr);
    assert.equal(outputJson(install).packageManager, 'dnf');
    assert.equal(outputJson(install).packageInstalledByKcoder, false);

    const upgrade = await runHost(root, ['upgrade', '--port', String(port)]);
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.doesNotMatch(trace(root), /dnf (?:upgrade|install|remove)/);

    const cleanup = await runHost(root, ['cleanup']);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '4.6.2-1.el9');
    assert.equal(fs.existsSync(path.join(root, 'etc/systemd/system/coturn.service')), false);
  });

  it('refuses to upgrade a KCoder-installed package after another coturn consumer appears', async () => {
    const root = makeFixture();
    const port = await makeStunResponder();
    const install = await runHost(root, ['install', '--port', String(port)]);
    assert.equal(install.status, 0, install.stderr);
    const otherService = path.join(root, 'etc/systemd/system/other-turn.service');
    fs.writeFileSync(otherService, '[Service]\nExecStart=/usr/bin/turnserver -c /etc/other-turn.conf\n', { mode: 0o644 });

    const upgrade = await runHost(root, ['upgrade', '--port', String(port)]);
    assert.equal(upgrade.status, 3);
    assert.match(upgrade.stderr, /other consumers; refusing package upgrade/);
    assert.doesNotMatch(trace(root), /apt-get install -y --only-upgrade coturn/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json'), 'utf8')).state, 'active');
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '1.0');

    fs.unlinkSync(otherService);
    const cleanup = await runHost(root, ['cleanup']);
    assert.equal(cleanup.status, 0, cleanup.stderr);
  });

  it('requires explicit, semantic adoption of the prior KCoder STUN unit', async () => {
    const root = makeFixture({ installedVersion: '4.6.2' });
    const port = await makeStunResponder();
    const config = [
      '# Historical KCoder STUN configuration',
      `listening-port=${port}`, 'listening-ip=0.0.0.0', 'stun-only', 'no-auth', 'no-tcp', 'no-tls', 'no-dtls', 'no-cli', '',
    ].join('\n');
    const unit = [
      '[Unit]', 'Description=KCoder Relay STUN service', 'After=network-online.target', '',
      '[Service]', 'Type=simple', 'User=kcoder-stun', 'Group=kcoder-stun',
      `ExecStart=/usr/bin/turnserver -c /etc/coturn/kcoder-stun.conf`, 'Restart=on-failure',
      'NoNewPrivileges=yes', 'PrivateTmp=yes', 'ProtectSystem=strict', 'ProtectHome=yes',
      'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX', '',
      '[Install]', 'WantedBy=multi-user.target', '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'etc/coturn/kcoder-stun.conf'), config, { mode: 0o644 });
    fs.writeFileSync(path.join(root, 'etc/systemd/system/kcoder-stun.service'), unit, { mode: 0o644 });

    const refused = await runHost(root, ['install', '--port', String(port)]);
    assert.equal(refused.status, 3);
    assert.equal(fs.existsSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json')), false);
    const adopted = await runHost(root, ['install', '--port', String(port), '--adopt-existing']);
    assert.equal(adopted.status, 0, adopted.stderr);
    assert.equal(outputJson(adopted).packageInstalledByKcoder, false);
    assert.match(fs.readFileSync(path.join(root, 'etc/systemd/system/kcoder-stun.service'), 'utf8'), /DynamicUser=yes/);
  });

  it('refuses pre-existing dedicated unit drop-ins before installation', async () => {
    const root = makeFixture();
    const port = await makeStunResponder();
    const dropInDirectory = path.join(root, 'etc/systemd/system/kcoder-stun.service.d');
    fs.mkdirSync(dropInDirectory);
    fs.writeFileSync(path.join(dropInDirectory, 'override.conf'), '[Service]\nExecStart=/bin/sh -c true\n', { mode: 0o644 });

    const result = await runHost(root, ['install', '--port', String(port)]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /unowned drop-ins/);
    assert.equal(fs.existsSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json')), false);
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '');
    assert.doesNotMatch(trace(root), /apt-get install -y coturn/);
  });

  it('rolls files, package, and mask back after an injected atomic-replacement failure', async () => {
    const root = makeFixture();
    const port = await makeStunResponder();
    const result = await runHost(root, ['install', '--port', String(port)], { failAt: 'config-rename' });
    assert.equal(result.status, 4);
    assert.match(result.stderr, /injected fixture failure at config-rename/);
    assert.equal(fs.existsSync(path.join(root, 'etc/coturn/kcoder-stun.conf')), false);
    assert.equal(fs.existsSync(path.join(root, 'etc/systemd/system/kcoder-stun.service')), false);
    assert.equal(fs.existsSync(path.join(root, 'etc/systemd/system/coturn.service')), false);
    assert.equal(fs.existsSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json')), false);
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '');
    assert.match(trace(root), /apt-get remove -y coturn/);
    assert.doesNotMatch(trace(root), /systemctl (?:start|restart) kcoder-stun.service/);
  });

  it('leaves an explicit rollback-pending receipt if rollback itself fails', async () => {
    const root = makeFixture();
    const port = await makeStunResponder();
    const result = await runHost(root, ['install', '--port', String(port)], { failAt: 'config-rename,rollback' });
    assert.equal(result.status, 4);
    assert.match(result.stderr, /rollback is pending/);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json'), 'utf8'));
    assert.equal(receipt.state, 'rollback-pending');
    assert.equal(receipt.transaction.phase, 'rollback-pending');
  });

  it('rolls cleanup back when systemd stop or disable itself fails', async () => {
    for (const failedCommand of ['stop-once', 'disable-once', 'reset-failed-once']) {
      const root = makeFixture();
      const port = await makeStunResponder();
      const install = await runHost(root, ['install', '--port', String(port)]);
      assert.equal(install.status, 0, install.stderr);

      const cleanup = await runHost(root, ['cleanup'], { failSystemctl: failedCommand });
      assert.equal(cleanup.status, 4, cleanup.stderr);
      const systemctlCommand = failedCommand.replace(/-once$/, '');
      assert.match(cleanup.stderr, new RegExp(`systemctl ${systemctlCommand} kcoder-stun\\.service failed`));
      const receipt = JSON.parse(fs.readFileSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json'), 'utf8'));
      assert.equal(receipt.state, 'active');
      assert.equal(fs.existsSync(path.join(root, 'etc/coturn/kcoder-stun.conf')), true);
      assert.equal(fs.existsSync(path.join(root, 'etc/systemd/system/kcoder-stun.service')), true);
      assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '1.0');
      assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/kcoder-stun.service.state'), 'utf8').trim(), 'active:enabled');
    }
  });

  it('does not claim rollback when stopping the changed service fails during rollback', async () => {
    const root = makeFixture();
    const firstPort = await makeStunResponder();
    const secondPort = await makeStunResponder();
    const install = await runHost(root, ['install', '--port', String(firstPort)]);
    assert.equal(install.status, 0, install.stderr);

    const upgrade = await runHost(root, ['upgrade', '--port', String(secondPort)], {
      failAt: 'probe', failSystemctl: 'stop-always',
    });
    assert.equal(upgrade.status, 4);
    assert.match(upgrade.stderr, /rollback is pending/);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json'), 'utf8'));
    assert.equal(receipt.state, 'rollback-pending');
    assert.equal(receipt.transaction.phase, 'rollback-pending');
    assert.match(receipt.transaction.rollbackFailure, /systemctl stop kcoder-stun\.service failed/);
  });

  it('accepts systemd garbage collection during reset-failed only after proving the service is stopped', async () => {
    const root = makeFixture();
    const port = await makeStunResponder();
    const install = await runHost(root, ['install', '--port', String(port)]);
    assert.equal(install.status, 0, install.stderr);

    const cleanup = await runHost(root, ['cleanup'], { failSystemctl: 'reset-failed-not-loaded' });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(outputJson(cleanup).state, 'absent');
    assert.match(trace(root), /systemctl reset-failed kcoder-stun\.service/);
    assert.equal(fs.existsSync(path.join(root, 'etc/coturn/kcoder-stun.conf')), false);
    assert.equal(fs.existsSync(path.join(root, 'etc/systemd/system/kcoder-stun.service')), false);
    assert.equal(fs.existsSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json')), false);
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/kcoder-stun.service.state'), 'utf8').trim(), 'inactive:disabled');
  });

  it('keeps rollback pending when package restore reports success but leaves the wrong version', async () => {
    {
      const root = makeFixture();
      const firstPort = await makeStunResponder();
      const secondPort = await makeStunResponder();
      const install = await runHost(root, ['install', '--port', String(firstPort)]);
      assert.equal(install.status, 0, install.stderr);
      fs.writeFileSync(path.join(root, 'var/lib/fake/package-restore-lie'), '1\n', { mode: 0o600 });

      const upgrade = await runHost(root, ['upgrade', '--port', String(secondPort)], { failAt: 'probe' });
      assert.equal(upgrade.status, 4);
      assert.match(upgrade.stderr, /rollback is pending/);
      assert.match(upgrade.stderr, /expected 1\.0, got 2\.0/);
      assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '2.0');
      assert.match(fs.readFileSync(path.join(root, 'etc/coturn/kcoder-stun.conf'), 'utf8'), new RegExp(`listening-port=${firstPort}`));
      const receipt = JSON.parse(fs.readFileSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json'), 'utf8'));
      assert.equal(receipt.state, 'rollback-pending');
      assert.equal(receipt.transaction.packageAction, 'upgrade-attempted');
      assert.match(receipt.transaction.rollbackFailure, /expected 1\.0, got 2\.0/);
    }

    {
      const root = makeFixture();
      const port = await makeStunResponder();
      const install = await runHost(root, ['install', '--port', String(port)]);
      assert.equal(install.status, 0, install.stderr);
      const otherService = path.join(root, 'etc/systemd/system/other-turn.service');
      fs.writeFileSync(otherService, '[Service]\nExecStart=/usr/bin/turnserver -c /etc/other-turn.conf\n', { mode: 0o644 });
      const firstCleanup = await runHost(root, ['cleanup']);
      assert.equal(firstCleanup.status, 0, firstCleanup.stderr);
      assert.equal(outputJson(firstCleanup).state, 'resources-removed');
      fs.unlinkSync(otherService);
      fs.writeFileSync(path.join(root, 'var/lib/fake/package-restore-lie'), '1\n', { mode: 0o600 });

      const cleanup = await runHost(root, ['cleanup'], { failAt: 'package-remove' });
      assert.equal(cleanup.status, 4);
      assert.match(cleanup.stderr, /rollback is pending/);
      assert.match(cleanup.stderr, /expected 1\.0, got absent/);
      assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '');
      const receipt = JSON.parse(fs.readFileSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json'), 'utf8'));
      assert.equal(receipt.state, 'rollback-pending');
      assert.equal(receipt.transaction.packageAction, 'remove-attempted');
      assert.match(receipt.transaction.rollbackFailure, /expected 1\.0, got absent/);
    }
  });

  it('preserves the committed receipt when post-commit backup cleanup fails', async () => {
    const root = makeFixture();
    const firstPort = await makeStunResponder();
    const secondPort = await makeStunResponder();
    const install = await runHost(root, ['install', '--port', String(firstPort)]);
    assert.equal(install.status, 0, install.stderr);

    const upgrade = await runHost(root, ['upgrade', '--port', String(secondPort)], { failAt: 'backup-cleanup' });
    assert.equal(upgrade.status, 4);
    assert.match(upgrade.stderr, /committed but post-commit cleanup or reporting failed/);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json'), 'utf8'));
    assert.equal(receipt.state, 'active');
    assert.equal(receipt.transaction, null);
    assert.equal(receipt.port, secondPort);
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/kcoder-stun.service.state'), 'utf8').trim(), 'active:enabled');
    assert.match(fs.readFileSync(path.join(root, 'etc/coturn/kcoder-stun.conf'), 'utf8'), new RegExp(`listening-port=${secondPort}`));
    assert.equal(fs.readdirSync(path.join(root, 'var/lib/kcoder-relay-stun')).filter((name) => name.startsWith('backup-')).length, 2);

    const status = await runHost(root, ['status']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(outputJson(status).state, 'active');
    assert.equal(outputJson(status).healthy, true);
  });

  it('rolls back if the consumer-retained receipt cannot be committed', async () => {
    const root = makeFixture();
    const port = await makeStunResponder();
    const install = await runHost(root, ['install', '--port', String(port)]);
    assert.equal(install.status, 0, install.stderr);
    const otherService = path.join(root, 'etc/systemd/system/other-turn.service');
    fs.writeFileSync(otherService, '[Service]\nExecStart=/usr/bin/turnserver -c /etc/other-turn.conf\n', { mode: 0o644 });

    const cleanup = await runHost(root, ['cleanup'], { failAt: 'consumer-receipt-write' });
    assert.equal(cleanup.status, 4);
    assert.match(cleanup.stderr, /injected fixture failure at consumer-receipt-write/);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json'), 'utf8'));
    assert.equal(receipt.state, 'active');
    assert.equal(receipt.transaction, null);
    assert.equal(fs.existsSync(path.join(root, 'etc/coturn/kcoder-stun.conf')), true);
    assert.equal(fs.existsSync(path.join(root, 'etc/systemd/system/kcoder-stun.service')), true);
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '1.0');
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/kcoder-stun.service.state'), 'utf8').trim(), 'active:enabled');
  });

  it('restores an owned package and mask when cleanup retries fail after resources were removed', async () => {
    const root = makeFixture();
    const port = await makeStunResponder();
    const install = await runHost(root, ['install', '--port', String(port)]);
    assert.equal(install.status, 0, install.stderr);

    const otherService = path.join(root, 'etc/systemd/system/other-turn.service');
    fs.writeFileSync(otherService, '[Service]\nExecStart=/usr/bin/turnserver -c /etc/other-turn.conf\n', { mode: 0o644 });
    const firstCleanup = await runHost(root, ['cleanup']);
    assert.equal(firstCleanup.status, 0, firstCleanup.stderr);
    assert.equal(outputJson(firstCleanup).state, 'resources-removed');
    assert.equal(fs.existsSync(path.join(root, 'etc/coturn/kcoder-stun.conf')), false);
    fs.unlinkSync(otherService);

    const packageFailure = await runHost(root, ['cleanup'], { failAt: 'package-remove' });
    assert.equal(packageFailure.status, 4);
    assert.match(packageFailure.stderr, /injected fixture failure at package-remove/);
    let receipt = JSON.parse(fs.readFileSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json'), 'utf8'));
    assert.equal(receipt.state, 'resources-removed');
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '1.0');
    assert.equal(fs.readlinkSync(path.join(root, 'etc/systemd/system/coturn.service')), '/dev/null');

    const maskFailure = await runHost(root, ['cleanup'], { failAt: 'mask-remove' });
    assert.equal(maskFailure.status, 4);
    assert.match(maskFailure.stderr, /injected fixture failure at mask-remove/);
    receipt = JSON.parse(fs.readFileSync(path.join(root, 'var/lib/kcoder-relay-stun/owner.json'), 'utf8'));
    assert.equal(receipt.state, 'resources-removed');
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '1.0');
    assert.equal(fs.readlinkSync(path.join(root, 'etc/systemd/system/coturn.service')), '/dev/null');

    const finalCleanup = await runHost(root, ['cleanup']);
    assert.equal(finalCleanup.status, 0, finalCleanup.stderr);
    assert.equal(outputJson(finalCleanup).state, 'absent');
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/coturn-version'), 'utf8').trim(), '');
    assert.equal(fs.existsSync(path.join(root, 'etc/systemd/system/coturn.service')), false);
  });

  it('status and cleanup on an absent target do not create target directories or call host shims', async () => {
    const root = makeFixture();
    const status = await runHost(root, ['status']);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(outputJson(status).state, 'absent');
    const cleanup = await runHost(root, ['cleanup']);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(outputJson(cleanup).state, 'absent');
    assert.equal(fs.existsSync(path.join(root, 'var/lib/kcoder-relay-stun')), false);
    assert.equal(fs.existsSync(path.join(root, 'etc/coturn')), true);
    assert.equal(fs.readFileSync(path.join(root, 'var/lib/fake/trace'), 'utf8'), '');
  });

  it('rejects an unsafe host-shim environment when any required fixture command is missing', async () => {
    const root = makeFixture();
    fs.unlinkSync(path.join(root, 'bin/systemctl'));
    const port = await makeStunResponder();
    const result = await runHost(root, ['install', '--port', String(port)]);
    assert.equal(result.status, 4);
    assert.match(result.stderr, /fixture shim is missing or unsafe: systemctl/);
  });
});
