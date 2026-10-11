import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { runE2E, requireExecutable } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, { testId: 'workflow-storage-write-scope-and-lock-metrics', tier: 'manual-live',
  modelPolicy: 'model-independent; real isolated filesystem, kernel lock and syscall byte observations; no provider requests' }, async context => {
  const executable = await requireExecutable(process.env.KCODER_E2E_WORKFLOW_STORAGE_TEST_BIN, 'dedicated storage measurement test');
  const strace = await requireExecutable('/usr/bin/strace', 'actual write-byte observer');
  const output = context.pathInState('storage-metrics.json');
  const trace = context.pathInState('writes.strace');
  const child = context.spawnOwned('storage-metrics', strace, ['--seccomp-bpf', '-f', '-ttt', '-yy', '-s', '0', '-e', 'trace=write,pwrite64,writev,pwritev,flock', '-o', trace,
    executable, '--ignored', '--exact', 'measure_store_write_scope_and_lock_boundaries', '--nocapture'], {
    env: context.isolatedEnvironment({ KCODER_STORAGE_METRICS_OUTPUT: output, KCODER_STORAGE_METRICS_ROOT: context.pathInState('library') }),
  });
  const timer = setTimeout(() => { void context.stopOwned('storage-metrics'); }, 90_000);
  let code; try { [code] = await once(child, 'exit'); } finally { clearTimeout(timer); }
  assert.equal(code, 0, 'real storage measurement failed');
  const report = JSON.parse(await readFile(output, 'utf8')); const traceText = await readFile(trace, 'utf8');
  const writes = [];
  for (const line of traceText.split('\n')) {
    const match = line.match(/^\d+\s+(\d+\.\d+)\s+(write|pwrite64|writev|pwritev)\(\d+<([^>]+)>.*=\s+(\d+)\s*$/);
    if (match && match[3].startsWith(report.libraryRoot + '/')) writes.push({ time: Number(match[1]), path: match[3].slice(report.libraryRoot.length + 1), bytes: Number(match[4]) });
  }
  assert.ok(writes.length > 0, 'observer must see actual library writes');
  for (const phase of report.phases) {
    const observed = writes.filter(write => write.time >= phase.startUnix && write.time <= phase.endUnix);
    phase.actualWriteBytes = observed.reduce((sum, write) => sum + write.bytes, 0);
    phase.actualWriteFiles = [...new Set(observed.map(write => write.path))];
    assert.ok(phase.actualWriteBytes > 0, `${phase.phase} must contain real writes`);
    assert.ok(phase.actualWriteFiles.every(path => !path.includes('version-')), 'existing immutable versions must not be rewritten');
  }
  const lockEvents = [];
  for (const line of traceText.split('\n')) {
    const match = line.match(/^(\d+)\s+(\d+\.\d+)\s+flock\(\d+<([^>]+)>, (LOCK_EX\|LOCK_NB)\).*?=\s+(-?\d+)/);
    if (match && match[3] === report.libraryRoot + '/library.lock') lockEvents.push({ thread: match[1], time: Number(match[2]), success: Number(match[5]) === 0 });
  }
  const shortEvents = lockEvents.filter(event => event.time >= report.shortSample.startUnix && event.time <= report.shortSample.endUnix);
  const blocked = shortEvents.find(event => !event.success);
  const acquired = blocked && shortEvents.find(event => event.thread === blocked.thread && event.success && event.time > blocked.time);
  assert.ok(blocked && acquired, 'short contention requires actual failed and successful kernel flock observations');
  report.shortKernelLockWaitMs = (acquired.time - blocked.time) * 1000;
  const timeoutEvents = lockEvents.filter(event => event.time >= report.timeoutSample.startUnix && event.time <= report.timeoutSample.endUnix);
  assert.ok(timeoutEvents.length >= 2 && timeoutEvents.every(event => !event.success), 'timeout requires actual unsuccessful kernel flock observations');
  report.timeoutKernelContentionMs = (timeoutEvents.at(-1).time - timeoutEvents[0].time) * 1000;
  report.shortKernelAttempts = shortEvents.length;
  report.timeoutKernelAttempts = timeoutEvents.length;
  delete report.libraryRoot;
  await context.writeArtifactJson('storage-metrics.json', report);
  return { phases: report.phases.map(({phase,actualWriteBytes,elapsedMs}) => ({phase,actualWriteBytes,elapsedMs})), shortContentionMs: report.shortContentionMs, timeoutContentionMs: report.timeoutContentionMs };
});
