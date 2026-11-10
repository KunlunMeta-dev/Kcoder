import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';
import { nativeCodeFixture, changeNativeCodeExecutionSettings } from './native-code-service.mjs';
import { RunContext } from './run-context.mjs';
import { startGateway } from './gateway.mjs';

test('isolated Gateway identity rejects root, incomplete and nonnumeric account fixtures before spawning', async () => {
  for (const identity of [{ uid: 0, gid: 0 }, { uid: 65534 }, { uid: '65534', gid: 65534 }]) {
    await assert.rejects(startGateway({}, identity), /Invalid isolated Gateway UID\/GID/);
  }
});

test('owned native UID fixture retains its files until its original manager cleanup is confirmed', { skip: process.platform !== 'linux' }, async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'native-code-service-owned-uid-fixture' });
  let failure;
  try {
    const scratch = await context.createOwnedScratchDirectory('native-owner-cleanup-fence', {
      baseDirectory: '/var/tmp', ownedWorkerTraversal: true, requireCleanupConfirmation: true,
    });
    const fixture = await nativeCodeFixture(context, '/usr/bin/true', { scratch });
    assert.notEqual(fixture.uid, 0);
    for (const path of [fixture.profile, fixture.workspace, fixture.home]) {
      const actual = await stat(path);
      assert.equal(actual.uid, fixture.uid);
      assert.equal(actual.mode & 0o777, 0o700);
    }
    const binary = await stat(fixture.binary);
    assert.equal(binary.uid, fixture.uid);
    assert.equal(binary.nlink, 1);
    assert.equal(binary.mode & 0o777, 0o500);
    assert.equal(fixture.imageSha256, createHash('sha256').update(await readFile('/usr/bin/true')).digest('hex'));
    const settingsBefore = await readFile(fixture.settings, 'utf8');
    const restoreSettings = await changeNativeCodeExecutionSettings(fixture);
    const changed = JSON.parse(await readFile(fixture.settings, 'utf8'));
    assert.equal(changed.integrations.services.enabled, true);
    assert.equal(changed.integrations.knowledge.business_automation_enabled, true);
    assert.equal((await stat(fixture.settings)).uid, fixture.uid);
    assert.equal((await stat(fixture.settings)).mode & 0o777, 0o600);
    await restoreSettings();
    assert.equal(await readFile(fixture.settings, 'utf8'), settingsBefore);
    fixture.activeManagers.add('unconfirmed-original-manager');
    const cleanup = context.cleanups.find(entry => entry.label === 'remove stopped native-code owned UID fixture');
    // Exercise the same registered owner fence without ending the RunContext.
    try {
      await assert.rejects(cleanup.callback(), /Retain Native fixture/);
      await assert.rejects(context.removeOwnedScratchDirectory(scratch), /retained until original external cleanup/);
      await stat(fixture.root);
    } finally {
      fixture.activeManagers.clear();
    }
  } catch (error) { failure = error; }
  await context.finish(failure ? 'failed' : 'passed', { actualOwnedUid: true }, failure);
  if (failure) throw failure;
});

test('read-only pidfd observer reports exact owned manager exit without signaling another process', { skip: process.platform !== 'linux' }, async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'native-code-service-read-only-kernel-pidfd' });
  let failure;
  try {
    const child = context.spawnOwned('exact-observed-manager', '/usr/bin/sleep', ['30']);
    const hash = createHash('sha256').update(await readFile('/usr/bin/sleep')).digest('hex');
    const observer = context.spawnOwned('exact-kernel-observer', '/usr/bin/python3', ['-u',
      fileURLToPath(new URL('./native-code-service-pidfd.py', import.meta.url)), String(child.pid), String(process.getuid()), hash], { stdin: 'pipe' });
    const client = new AppServerStdioClient('exact-kernel-observer', observer);
    assert.deepEqual((await client.request('observe')).result, { managerAlive: true, workers: [] });
    await context.stopOwned('exact-observed-manager');
    assert.deepEqual((await client.request('observe')).result, { managerAlive: false, workers: [] });
    observer.stdin.end();
    await waitForStdioChildClose(observer, 5000, 'exact-kernel-observer');
    client.closeReader();
  } catch (error) { failure = error; }
  await context.finish(failure ? 'failed' : 'passed', { actualKernelPidfd: true, observerSendsSignals: false }, failure);
  if (failure) throw failure;
});
