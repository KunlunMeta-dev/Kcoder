import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildStageCleanupInvocation,
  buildStageCreateProgram,
  lifecycleSshFailureDetails,
  sharedCoturnUnchanged,
  SNAPSHOT_PY,
} from './stun-host.live.mjs';

test('live runner gates SSH, records exact coturn versions, and protects its owned stage', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'kcoder-stun-live-test-'));
  try {
    const sshMarker = path.join(temporaryDirectory, 'ssh-was-called');
    const fakeBin = path.join(temporaryDirectory, 'bin');
    mkdirSync(fakeBin, { mode: 0o700 });
    const fakeSsh = path.join(fakeBin, 'ssh');
    writeFileSync(fakeSsh, `#!/bin/sh\nprintf called > '${sshMarker}'\nexit 99\n`, { mode: 0o700 });
    writeFileSync(path.join(fakeBin, 'systemctl'), `#!/bin/sh
case "$1" in
  show)
    case "$2" in
      *LoadState*) printf loaded ;;
      *ActiveState*) printf active ;;
      *SubState*) printf running ;;
      *MainPID*) printf 1234 ;;
      *UnitFileState*) printf enabled ;;
      *) printf '' ;;
    esac
    ;;
  is-enabled) printf enabled ;;
  is-active) printf active ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
    writeFileSync(path.join(fakeBin, 'dpkg-query'), `#!/bin/sh
case "$*" in
  *Status-Status*) printf installed ;;
  *Version*) printf '1:4.6.2-1ubuntu1' ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
    writeFileSync(path.join(fakeBin, 'rpm'), `#!/bin/sh
printf 'coturn-4.6.2-1.x86_64'
`, { mode: 0o700 });
    const snapshotOutput = execFileSync('python3', ['-'], {
      input: SNAPSHOT_PY,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    });
    const snapshot = JSON.parse(snapshotOutput);
    assert.deepEqual(snapshot.coturnPackage, { dpkg: true, rpm: true });
    assert.deepEqual(snapshot.coturnPackageVersion, {
      dpkg: '1:4.6.2-1ubuntu1',
      rpm: 'coturn-4.6.2-1.x86_64',
    });
    assert.deepEqual(Object.keys(snapshot.units).sort(), [
      'caddy.service',
      'coturn.service',
      'kcoder-relay.service',
      'kcoder-stun.service',
      'myapp.service',
    ]);
    for (const unit of Object.values(snapshot.units)) {
      assert.equal(unit.LoadState, 'loaded');
      assert.equal(unit.ActiveState, 'active');
      assert.equal(unit.MainPID, '1234');
      assert.deepEqual(Object.keys(unit).sort(), [
        'ActiveState', 'DropInPaths', 'EnvironmentFiles', 'FragmentPath',
        'LoadState', 'MainPID', 'SubState', 'UnitFileState',
      ]);
    }
    assert.equal(sharedCoturnUnchanged(snapshot, snapshot), true);
    const upgradedSnapshot = structuredClone(snapshot);
    upgradedSnapshot.coturnPackageVersion.dpkg = '1:4.6.2-2ubuntu1';
    assert.equal(sharedCoturnUnchanged(snapshot, upgradedSnapshot), false);
    const lifecycleDiagnostic = lifecycleSshFailureDetails({
      status: 17,
      stdout: 'stdout secret must not be retained',
      stderr: '\u001b[31mSTUN unit start failed\u001b[0m',
    });
    assert.deepEqual(lifecycleDiagnostic, {
      exitStatus: 17,
      stderr: 'STUN unit start failed',
      stderrTruncated: false,
    });
    assert.equal('stdout' in lifecycleDiagnostic, false);
    const boundedDiagnostic = lifecycleSshFailureDetails({ status: 9, stderr: 'x'.repeat(4096) });
    assert.equal(boundedDiagnostic.stderr.length, 2048);
    assert.equal(boundedDiagnostic.stderrTruncated, true);

    const runner = fileURLToPath(new URL('./stun-host.live.mjs', import.meta.url));
    const blocked = spawnSync(process.execPath, [runner, '--host', 'tenxunyun2_1', '--port', '18462', '--namespace', 'abcdef123456'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, KCODER_STUN_HOST_LIVE_ACCEPT: '' },
    });
    assert.equal(blocked.status, 2);
    assert.deepEqual(JSON.parse(blocked.stdout), {
      component: 'stun-live-acceptance',
      state: 'blocked',
      code: 'LIVE_CONSENT_REQUIRED',
      requiredEnv: 'KCODER_STUN_HOST_LIVE_ACCEPT',
      host: 'tenxunyun2_1',
      port: 18462,
      namespace: 'abcdef123456',
    });
    assert.equal(existsSync(sshMarker), false);

    const stagePath = path.join(temporaryDirectory, 'owned-stage');
    const files = {
      'deploy/stun-host.sh': Buffer.from('#!/bin/sh\n', 'utf8').toString('base64'),
      'deploy/stun-lifecycle.mjs': Buffer.from('export const lifecycle = true;\n', 'utf8').toString('base64'),
    };
    const ownerUid = process.getuid?.() ?? 0;
    const created = execFileSync('python3', ['-'], {
      input: buildStageCreateProgram(stagePath, files, ownerUid),
      encoding: 'utf8',
    });
    const identity = JSON.parse(created);
    assert.deepEqual(Object.keys(identity.files).sort(), Object.keys(files).sort());
    assert.equal(statSync(stagePath).uid, ownerUid);
    assert.equal(statSync(stagePath).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(stagePath, 'deploy/stun-host.sh')).mode & 0o777, 0o600);

    const hostScriptPath = path.join(stagePath, 'deploy/stun-host.sh');
    const originalHostScript = readFileSync(hostScriptPath);
    writeFileSync(hostScriptPath, Buffer.from('altered\n'));
    const cleanup = buildStageCleanupInvocation(stagePath, identity, ownerUid);
    const rejected = execFileSync('python3', ['-', ...cleanup.args], { input: cleanup.source, encoding: 'utf8' });
    assert.equal(JSON.parse(rejected).removed, false);
    assert.equal(existsSync(stagePath), true);

    writeFileSync(hostScriptPath, originalHostScript);
    const removed = execFileSync('python3', ['-', ...cleanup.args], { input: cleanup.source, encoding: 'utf8' });
    assert.equal(JSON.parse(removed).removed, true);
    assert.equal(existsSync(stagePath), false);

    const rollbackPath = path.join(temporaryDirectory, 'rollback-stage');
    const invalidSecondFile = {
      'deploy/stun-host.sh': Buffer.from('first file\n', 'utf8').toString('base64'),
      'deploy/stun-lifecycle.mjs': `${Buffer.from('second file\n', 'utf8').toString('base64')}#`,
    };
    assert.throws(() => execFileSync('python3', ['-'], {
      input: buildStageCreateProgram(rollbackPath, invalidSecondFile, ownerUid),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }));
    assert.equal(existsSync(rollbackPath), false);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
