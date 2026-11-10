import assert from 'node:assert/strict';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import { createNativeSystemdUser } from './native-systemd-user.mjs';

test('actual owned user manager and account are removed only after their original cleanup receipt', {
  skip: process.platform !== 'linux' || process.getuid() !== 0 || process.env.KCODER_TEST_SYSTEM_USERS !== '1',
}, async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'actual-owned-systemd-user-account' });
  let failure;
  try {
    const fixture = await createNativeSystemdUser(context);
    assert.ok(fixture.account.uid >= 1000);
    assert.equal((await fixture.close()).originalAccountRemoved, true);
    assert.equal((await fixture.close()).originalManagerStopped, true);
  } catch (error) { failure = error; }
  await context.finish(failure ? 'failed' : 'passed', { actualOwnedUserManager: true }, failure);
  if (failure) throw failure;
});

test('RunContext finalization receives the real account cleanup receipt without an explicit early close', {
  skip: process.platform !== 'linux' || process.getuid() !== 0 || process.env.KCODER_TEST_SYSTEM_USERS !== '1',
}, async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'actual-owned-systemd-user-finalization' });
  let failure;
  try { await createNativeSystemdUser(context); } catch (error) { failure = error; }
  await context.finish(failure ? 'failed' : 'passed', { actualFinalizationCleanup: true }, failure);
  if (failure) throw failure;
  assert.ok(context.cleanupSteps.every(step => step.status === 'completed'));
});
