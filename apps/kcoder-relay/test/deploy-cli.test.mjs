import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRelayLifecycleRemoteCommand } from '../deploy/cli-contract.mjs';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const deployCli = join(appRoot, 'src/deploy.mjs');
const linuxTest = process.platform === 'linux' ? test : test.skip;

function writeExecutable(path, contents) {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function temporaryRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cliEnvironment(root, bin) {
  const registryPath = join(root, 'registry.json');
  writeFileSync(registryPath, `${JSON.stringify({
    sharedHosts: ['relay.example.test'],
    gateways: [{
      id: 'fixture',
      secret: 's'.repeat(40),
      gatewaySecret: 'p'.repeat(40),
      maxConnections: 8,
      maxBytesPerWindow: 1024,
      trafficWindowMs: 60_000,
    }],
  })}\n`, { mode: 0o600 });
  return {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    KCODER_RELAY_ENV_FILE: '/dev/null',
    KCODER_RELAY_SSH_HOSTNAME: 'relay.example.test',
    KCODER_RELAY_SSH_USER: 'deploy',
    KCODER_RELAY_SSH_IDENTITY: join(root, 'ssh-key'),
    KCODER_RELAY_PUBLIC_URL: 'https://relay.example.test',
    KCODER_RELAY_REGISTRY_FILE: registryPath,
    KCODER_RELAY_STUN_PORT: '8452',
    KCODER_RELAY_ROUTE_MODE: 'path',
  };
}

test('deploy CLI dry-run uses the canonical HTTPS/STUN plan and never starts SSH or SCP', () => {
  const root = temporaryRoot('kcoder-relay-cli-dry-');
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const sshMarker = join(root, 'ssh-called');
    const scpMarker = join(root, 'scp-called');
    writeExecutable(join(bin, 'ssh'), `#!/bin/sh\ntouch '${sshMarker}'\n`);
    writeExecutable(join(bin, 'scp'), `#!/bin/sh\ntouch '${scpMarker}'\n`);
    const result = spawnSync(process.execPath, [deployCli, 'install', '--dry-run'], {
      cwd: appRoot,
      env: cliEnvironment(root, bin),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, 'DRY_RUN');
    assert.equal(summary.publicUrl, 'https://relay.example.test');
    assert.equal(summary.stun.publicUrl, 'stun:relay.example.test:8452');
    assert.equal(summary.stun.port, 8452);
    assert.equal(summary.deploymentPerformed, false);
    assert.doesNotMatch(result.stdout, /s{40}|p{40}/);
    assert.equal(existsSync(sshMarker), false);
    assert.equal(existsSync(scpMarker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deploy CLI refuses registration runtime fallback when no canonical host source is configured', () => {
  const root = temporaryRoot('kcoder-relay-cli-no-canonical-');
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const sshMarker = join(root, 'ssh-called');
    const scpMarker = join(root, 'scp-called');
    writeExecutable(join(bin, 'ssh'), `#!/bin/sh\ntouch '${sshMarker}'\n`);
    writeExecutable(join(bin, 'scp'), `#!/bin/sh\ntouch '${scpMarker}'\n`);
    const env = cliEnvironment(root, bin);
    delete env.KCODER_RELAY_PUBLIC_URL;
    delete env.KCODER_RELAY_REGISTRY_FILE;
    env.KCODER_RELAY_REGISTRATION_KEY = 'k'.repeat(40);
    env.KCODER_RELAY_REGISTRATION_STORE_FILE = '/var/lib/kcoder-relay/registered-gateways.json';
    const result = spawnSync(process.execPath, [deployCli, 'install', '--dry-run'], {
      cwd: appRoot,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 4);
    assert.match(result.stderr, /Set KCODER_RELAY_PUBLIC_URL or configure one explicit Relay sharedHosts authority/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /hyf2333\.top|:8451|:8452/);
    assert.equal(existsSync(sshMarker), false);
    assert.equal(existsSync(scpMarker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deploy CLI can infer the canonical site from the configured static registry', () => {
  const root = temporaryRoot('kcoder-relay-cli-registry-host-');
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const env = cliEnvironment(root, bin);
    delete env.KCODER_RELAY_PUBLIC_URL;
    const result = spawnSync(process.execPath, [deployCli, 'install', '--dry-run'], {
      cwd: appRoot,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.publicUrl, 'https://relay.example.test');
    assert.equal(summary.stun.publicUrl, 'stun:relay.example.test:8452');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest('status stages only lifecycle helpers and uses strict SSH host-key checking', () => {
  const root = temporaryRoot('kcoder-relay-cli-status-');
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const sshTrace = join(root, 'ssh.trace');
    const scpTrace = join(root, 'scp.trace');
    writeExecutable(join(bin, 'ssh'), `#!/bin/sh\nfor arg do printf '%s\\0' "$arg" >> "$SSH_TRACE"; done\nprintf '\\036' >> "$SSH_TRACE"\nlast=\nfor arg do last=$arg; done\ncase "$last" in *'mkdir -- '*) exit 0;; *'rm -rf -- '*) exit 0;; esac\nprintf '%s\\n' '{"component":"stun","action":"status","state":"active","healthy":true}' '{"component":"relay","action":"status","state":"active","healthy":true}'\n`);
    writeExecutable(join(bin, 'scp'), `#!/bin/sh\nfor arg do printf '%s\\0' "$arg" >> "$SCP_TRACE"; done\nprintf '\\036' >> "$SCP_TRACE"\n`);
    const env = {
      ...cliEnvironment(root, bin),
      SSH_TRACE: sshTrace,
      SCP_TRACE: scpTrace,
    };
    const result = spawnSync(process.execPath, [deployCli, 'status'], { cwd: appRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\nSSH ${existsSync(sshTrace) ? readFileSync(sshTrace, 'utf8').replaceAll('\\0', '<NUL>') : 'no trace'}\nSCP ${existsSync(scpTrace) ? readFileSync(scpTrace, 'utf8').replaceAll('\\0', '<NUL>') : 'no trace'}`);
    assert.equal(JSON.parse(result.stdout).success, true);
    const sshArgs = readFileSync(sshTrace, 'utf8');
    const scpArgs = readFileSync(scpTrace, 'utf8');
    assert.match(sshArgs, /StrictHostKeyChecking=yes/);
    assert.match(scpArgs, /\/deploy\x00/);
    assert.doesNotMatch(scpArgs, /package-lock\.json|cloud\.env|node_modules|\/src\x00/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest('install runs the pinned npm preparation and stages application plus private configuration', () => {
  const root = temporaryRoot('kcoder-relay-cli-install-');
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const npmTrace = join(root, 'npm.trace');
    const scpTrace = join(root, 'scp.trace');
    const sshTrace = join(root, 'ssh.trace');
    const modeTrace = join(root, 'private-modes.trace');
    writeExecutable(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" > "$NPM_TRACE"\nmkdir -p node_modules/ws\nprintf '{"name":"fixture"}\\n' > node_modules/ws/package.json\n`);
    writeExecutable(join(bin, 'ssh'), `#!/bin/sh\nfor arg do printf '%s\\0' "$arg" >> "$SSH_TRACE"; done\nprintf '\\036' >> "$SSH_TRACE"\nlast=\nfor arg do last=$arg; done\ncase "$last" in *'mkdir -- '*) exit 0;; *'rm -rf -- '*) exit 0;; esac\nprintf '%s\\n' '{"component":"stun","action":"install","state":"active","healthy":true}' '{"component":"relay","action":"install","state":"active","healthy":true}'\n`);
    writeExecutable(join(bin, 'scp'), `#!/bin/sh\nfor arg do\n  printf '%s\\0' "$arg" >> "$SCP_TRACE"\n  case "$arg" in */cloud.env|*/caddy.env|*/registry.json) printf '%s %s\\n' "$(basename "$arg")" "$(stat -c %a -- "$arg")" >> "$MODE_TRACE";; esac\ndone\nprintf '\\036' >> "$SCP_TRACE"\n`);
    const env = {
      ...cliEnvironment(root, bin),
      NPM_TRACE: npmTrace,
      SCP_TRACE: scpTrace,
      SSH_TRACE: sshTrace,
      MODE_TRACE: modeTrace,
    };
    const result = spawnSync(process.execPath, [deployCli, 'install'], { cwd: appRoot, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).success, true);
    assert.equal(readFileSync(npmTrace, 'utf8').trim(), 'ci --omit=dev --ignore-scripts --no-audit --no-fund');
    const stagedArgs = readFileSync(scpTrace, 'utf8');
    for (const entry of ['/deploy\0', '/src\0', 'node_modules\0', 'package.json\0', 'package-lock.json\0', 'gatewayConnectionRoutes.runtime.mjs\0', 'cloud.env\0', 'caddy.env\0', 'registry.json\0']) {
      assert.ok(stagedArgs.includes(entry), `Expected staged source entry ${entry.replaceAll('\0', '<NUL>')}`);
    }
    assert.match(readFileSync(modeTrace, 'utf8'), /cloud\.env 600/);
    assert.match(readFileSync(modeTrace, 'utf8'), /caddy\.env 600/);
    assert.match(readFileSync(modeTrace, 'utf8'), /registry\.json 600/);
    assert.match(readFileSync(sshTrace, 'utf8'), /StrictHostKeyChecking=yes/);
    assert.doesNotMatch(result.stdout, /s{40}|p{40}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function cliStageCleanupFixture(root, { remoteStatus = 0 } = {}) {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const cleanupMarker = join(root, 'remote-stage-cleanup-called');
  writeExecutable(join(bin, 'npm'), '#!/bin/sh\nmkdir -p node_modules/ws\nprintf \'{"name":"fixture"}\\n\' > node_modules/ws/package.json\n');
  writeExecutable(join(bin, 'ssh'), `#!/bin/sh\nlast=\nfor arg do last=$arg; done\ncase "$last" in\n  *'umask 077; mkdir -- '*) exit 0;;\n  *'rm -rf -- '*) touch "$SSH_CLEANUP_MARKER"; [ "$SSH_FAIL_CLEANUP" != 1 ] || exit 9; exit 0;;\nesac\nprintf '%s\\n' '{"component":"stun","action":"install","state":"active","healthy":true}' '{"component":"relay","action":"install","state":"active","healthy":true}'\nexit "$SSH_REMOTE_STATUS"\n`);
  writeExecutable(join(bin, 'scp'), '#!/bin/sh\nexit 0\n');
  return {
    env: {
      ...cliEnvironment(root, bin),
      SSH_CLEANUP_MARKER: cleanupMarker,
      SSH_FAIL_CLEANUP: '1',
      SSH_REMOTE_STATUS: String(remoteStatus),
    },
    cleanupMarker,
  };
}

linuxTest('CLI returns failure and marks the summary unsuccessful when remote staging cleanup fails after success', () => {
  const root = temporaryRoot('kcoder-relay-cli-cleanup-fail-success-');
  try {
    const { env, cleanupMarker } = cliStageCleanupFixture(root);
    const result = spawnSync(process.execPath, [deployCli, 'install'], {
      cwd: appRoot,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 4, `${result.stderr}\n${result.stdout}`);
    assert.equal(existsSync(cleanupMarker), true);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.success, false);
    assert.equal(summary.remoteStagingCleanup, 'unconfirmed');
    assert.match(result.stderr, /remote staging directory may remain/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /s{40}|p{40}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxTest('CLI preserves the lifecycle failure code and reports remote staging cleanup failure', () => {
  const root = temporaryRoot('kcoder-relay-cli-cleanup-fail-action-');
  try {
    const { env, cleanupMarker } = cliStageCleanupFixture(root, { remoteStatus: 3 });
    const result = spawnSync(process.execPath, [deployCli, 'install'], {
      cwd: appRoot,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 3, `${result.stderr}\n${result.stdout}`);
    assert.equal(existsSync(cleanupMarker), true);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.success, false);
    assert.equal(summary.remoteStagingCleanup, 'unconfirmed');
    assert.match(result.stderr, /remote staging directory may remain/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /s{40}|p{40}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function lifecycleFixture() {
  const id = randomBytes(12).toString('hex');
  const namespace = `/tmp/kcoder-relay-cli-test-${id}`;
  const stageDir = `/var/tmp/kcoder-relay-deploy-${randomBytes(12).toString('hex')}`;
  const bin = join(namespace, 'bin');
  mkdirSync(join(namespace, 'run'), { recursive: true, mode: 0o700 });
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(join(stageDir, 'deploy'), { recursive: true, mode: 0o700 });
  const log = join(namespace, 'actions.log');
  const started = join(namespace, 'install-started');
  const release = join(namespace, 'release-install');
  const stunInstalled = join(namespace, 'stun-installed');
  const relayInstalled = join(namespace, 'relay-installed');
  const relayConflict = join(namespace, 'relay-unmanaged');
  writeExecutable(join(bin, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n');
  writeExecutable(join(stageDir, 'deploy/stun-host.sh'), `#!/bin/bash\naction=$1\ncase "$action" in install|upgrade) [[ "$2" == --port && "$3" == 8452 ]] || exit 2;; status|cleanup) [[ "$#" == 1 ]] || exit 2;; esac\nprintf 'stun %s\\n' "$action" >> '${log}'\ncase "$action" in\n  status) if [[ -e '${stunInstalled}' ]]; then echo '{"component":"stun","action":"status","state":"active","healthy":true}'; else echo '{"component":"stun","action":"status","state":"absent"}'; fi;;\n  install|upgrade) touch '${started}'; for ((i=0; i<500; i++)); do [[ -e '${release}' ]] && break; sleep 0.01; done; [[ -e '${release}' ]] || exit 4; touch '${stunInstalled}'; echo '{"component":"stun","action":"install","state":"active","healthy":true}';;\n  cleanup) rm -f '${stunInstalled}'; echo '{"component":"stun","action":"cleanup","state":"resources-removed"}';;\nesac\n`);
  writeExecutable(join(stageDir, 'deploy/relay-host.sh'), `#!/bin/bash\naction=$1\n[[ "$2" == --stage-dir && "$3" == '${stageDir}' ]] || exit 2\nprintf 'relay %s\\n' "$action" >> '${log}'\ncase "$action" in\n  prepare) exit 0;;\n  status) if [[ -e '${relayConflict}' ]]; then echo '{"component":"relay","action":"status","state":"unmanaged"}'; exit 3; elif [[ -e '${relayInstalled}' ]]; then echo '{"component":"relay","action":"status","state":"active","healthy":true}'; else echo '{"component":"relay","action":"status","state":"absent"}'; fi;;\n  install|upgrade) touch '${relayInstalled}'; echo '{"component":"relay","action":"install","state":"active"}';;\n  cleanup) rm -f '${relayInstalled}'; echo '{"component":"relay","action":"cleanup","state":"resources-removed"}';;\nesac\n`);
  return { namespace, stageDir, bin, log, started, release, stunInstalled, relayInstalled, relayConflict };
}

function spawnLifecycle(command, fixture) {
  return spawn('/bin/bash', ['-c', command], {
    env: { ...process.env, PATH: `${fixture.bin}:/usr/bin:/bin` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commandResult(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectPromise);
    child.once('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

async function waitFor(path) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

linuxTest('one host lock serializes the full STUN plus Relay install/cleanup pair', async () => {
  const fixture = lifecycleFixture();
  try {
    const install = createRelayLifecycleRemoteCommand({
      action: 'install', stageDir: fixture.stageDir, port: 8452, testNamespace: fixture.namespace,
    });
    const cleanup = createRelayLifecycleRemoteCommand({
      action: 'cleanup', stageDir: fixture.stageDir, testNamespace: fixture.namespace,
    });
    const installProcess = spawnLifecycle(install, fixture);
    await waitFor(fixture.started);
    const cleanupProcess = spawnLifecycle(cleanup, fixture);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    const beforeRelease = readFileSync(fixture.log, 'utf8');
    assert.doesNotMatch(beforeRelease, /stun status|relay status|stun cleanup|relay cleanup/);
    writeFileSync(fixture.release, 'go');
    const [installResult, cleanupResult] = await Promise.all([
      commandResult(installProcess), commandResult(cleanupProcess),
    ]);
    assert.equal(installResult.status, 0, installResult.stderr || installResult.stdout);
    assert.equal(cleanupResult.status, 0, cleanupResult.stderr || cleanupResult.stdout);
    const log = readFileSync(fixture.log, 'utf8');
    assert.ok(log.indexOf('relay install') < log.indexOf('stun status'));
    assert.ok(log.indexOf('stun status') < log.indexOf('relay status'));
    assert.ok(log.indexOf('relay status') < log.indexOf('stun cleanup'));
    assert.ok(log.indexOf('stun cleanup') < log.indexOf('relay cleanup'));
    assert.equal(existsSync(fixture.stunInstalled), false);
    assert.equal(existsSync(fixture.relayInstalled), false);
  } finally {
    rmSync(fixture.stageDir, { recursive: true, force: true });
    rmSync(fixture.namespace, { recursive: true, force: true });
  }
});

linuxTest('cleanup checks both owners before dispatch and never cleans either side after a conflict', async () => {
  const fixture = lifecycleFixture();
  try {
    writeFileSync(fixture.stunInstalled, 'owned');
    writeFileSync(fixture.relayConflict, 'unmanaged');
    const cleanup = createRelayLifecycleRemoteCommand({
      action: 'cleanup', stageDir: fixture.stageDir, testNamespace: fixture.namespace,
    });
    const result = await commandResult(spawnLifecycle(cleanup, fixture));
    assert.equal(result.status, 3, `${result.stderr}\n${result.stdout}`);
    assert.deepEqual(readFileSync(fixture.log, 'utf8').trim().split('\n'), [
      'relay prepare',
      'stun status',
      'relay status',
    ]);
    assert.equal(existsSync(fixture.stunInstalled), true);
    assert.equal(existsSync(fixture.relayInstalled), false);
    assert.match(result.stdout, /"component":"stun","action":"status"/);
    assert.match(result.stdout, /"component":"relay","action":"status","state":"unmanaged"/);
  } finally {
    rmSync(fixture.stageDir, { recursive: true, force: true });
    rmSync(fixture.namespace, { recursive: true, force: true });
  }
});
