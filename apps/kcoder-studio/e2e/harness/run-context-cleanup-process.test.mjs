import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import { processTreeAlive } from './owned-process.mjs';

test('cleanup-only spawn is phase-restricted, tracked, redacted and cannot register late cleanup', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'cleanup-process-phase', retainSuccessLogs: true });
  context.registerSecret('OWNED_SYNTHETIC_CLEANUP_VALUE');
  assert.throws(() => context.spawnCleanupOwned('before-finish', process.execPath, ['-e', 'process.exit(0)']), /finish transaction/);
  context.addCleanup('controlled cleanup command', async () => {
    assert.throws(() => context.spawnOwned('late-normal', process.execPath, []), /finishing/);
    assert.throws(() => context.addCleanup('late', () => {}), /finishing/);
    const child = context.spawnCleanupOwned('cleanup-command', process.execPath, ['-e', "console.log('OWNED_SYNTHETIC_CLEANUP_VALUE')"]);
    try { await new Promise((accept, reject) => { child.once('close', accept); child.once('error', reject); }); }
    finally { await context.stopOwned('cleanup-command'); }
  });
  await context.finish('passed', { scope: 'cleanup process lifecycle only' });
  assert.throws(() => context.spawnCleanupOwned('after-finish', process.execPath, []), /finish transaction/);
  const manifest = JSON.parse(await readFile(`${context.runRoot}/manifest.json`, 'utf8'));
  assert.equal(manifest.processes.length, 1);
  assert.equal(manifest.processes[0].cleanupOnly, true);
  assert.equal(manifest.processes[0].stopped, true);
  assert.ok(manifest.processes[0].pid > 0);
  const log = await readFile(`${context.runRoot}/logs/cleanup-command.log`, 'utf8');
  assert.equal(log.includes('OWNED_SYNTHETIC_CLEANUP_VALUE'), false);
  assert.match(log, /REDACTED/);
});

test('a timed-out cleanup cannot leave its recorded cleanup process alive', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'cleanup-process-timeout', cleanupTimeoutMs: 50 });
  let record;
  context.addCleanup('uncooperative cleanup command', () => {
    context.spawnCleanupOwned('cleanup-never-ends', process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    record = context.processes.get('cleanup-never-ends');
    return new Promise(() => {});
  });
  await assert.rejects(context.finish('passed', null), /did not finish within 50ms/);
  assert.equal(await processTreeAlive(record.child, record.identity), false);
  assert.equal(record.stopped, true);
  await assert.rejects(access(context.stateDir), { code: 'ENOENT' });
  const result = JSON.parse(await readFile(`${context.runRoot}/artifacts/result.json`, 'utf8'));
  assert.equal(result.status, 'failed');
  assert.match(result.cleanupErrors.join('\n'), /uncooperative cleanup/);
});
