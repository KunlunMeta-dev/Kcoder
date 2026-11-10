import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { originalSystemdCarrier, originalUserUnit } from '../../harness/native-systemd-carrier.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, {
  testId: 'recover-only-original-task-socket-fixture-cleanup', tier: 'manual-live',
  modelPolicy: 'Recover one retained owned test fixture only after original process and OS-unit termination; no task, SDK or model starts.',
}, async context => {
  const original = resolve(process.env.KCODER_E2E_RECOVER_TASK_SOCKET_RUN || '');
  assert.match(relative(resolve(repoRoot, 'target/test/apps/kcoder-studio/e2e/suites/gateway/native-task-ui-core-socket.e2e.mjs'), original), /^\d{8}-\d{6}\.\d{3}Z$/);
  const manifest = JSON.parse(await readFile(resolve(original, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.scratchDirectories.length, 1);
  assert.equal(manifest.cleanupSteps.find(item => item.label === 'close original foreground-only pidfd observer')?.status, 'completed');
  const scratch = await context.resumeOwnedScratchDirectory(manifest.scratchDirectories[0]);
  const uid = process.getuid();
  const fixture = { uid, gid: process.getgid(), profile: resolve(scratch.path, 'owned-account/profile'),
    workspace: resolve(scratch.path, 'owned-account/workspace'),
    env: context.isolatedEnvironment({ XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` }) };
  const carrier = await originalSystemdCarrier(fixture);
  const status = await originalUserUnit(context, fixture, carrier, 'show', 'verify-original-socket-unit-ended');
  assert.equal(status.MainPID, '0');
  assert.ok(['inactive', 'failed'].includes(status.ActiveState));
  const tree = JSON.parse(await readFile(resolve(original, 'artifacts/before-original-task-resume.json'), 'utf8')).originalTree;
  const unitLog = await readFile(resolve(original, 'logs/task-socket-original-unit.log'), 'utf8');
  const rootPid = Number(/^MainPID=(\d+)$/m.exec(unitLog)?.[1]);
  assert.ok(rootPid > 1);
  const originalPids = [rootPid, ...tree.processes.map(item => item.pid), ...(tree.keepers || []).map(item => item.pid)];
  for (const pid of originalPids) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z', 'Retain scratch while an original PID is executing');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await context.writeArtifactJson('original-owned-cleanup-confirmed.json', {
    originalRun: original, originalResultPreserved: 'failed', originalPids, unit: carrier.unit,
    observedUnit: status, scopePidfdCleanupPreviouslyConfirmed: true, nativeRuntimeStarts: 0,
  });
  await context.confirmOwnedScratchCleanup(scratch);
  return { originalFailurePreserved: true, originalUnitEnded: true, originalPidsEnded: true, inputSubmitted: false };
});
