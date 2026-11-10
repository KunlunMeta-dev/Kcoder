import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { waitForStdioChildClose } from './app-server-stdio.mjs';
import { isolatedEnvironment, repoRoot } from './run-context.mjs';

/** A real new OS account and its actual user manager, owned by this run only. */
export async function createNativeSystemdUser(context,{baseDirectory='/var/tmp'}={}) {
  assert.equal(process.platform, 'linux', 'Actual Linux systemd host required');
  assert.equal(process.getuid(), 0, 'Explicit root account-fixture host required');
  assert.equal(process.env.KCODER_TEST_SYSTEM_USERS, '1', 'Explicit KCODER_TEST_SYSTEM_USERS=1 required');
  const scratch = await context.createOwnedScratchDirectory('systemd-user', {
    baseDirectory, ownedWorkerTraversal: true, requireCleanupConfirmation: true,
  });
  const child = context.spawnOwned('original-systemd-user-owner', '/usr/bin/python3', ['-u',
    resolve(repoRoot, 'scripts/install/tests/owned_systemd_user.py'), context.pathInScratch(scratch, 'identity')], {
    env: isolatedEnvironment({ KCODER_TEST_SYSTEM_USERS: '1' }), stdin: 'pipe',
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let account;
  let receipt;
  let failure;
  let readyResolve;
  let readyReject;
  const ready = new Promise((accept, reject) => { readyResolve = accept; readyReject = reject; });
  // Register rejection immediately; cleanup retains unconfirmed system identities.
  void ready.catch(() => {});
  reader.on('line', line => {
    try {
      const frame = JSON.parse(line);
      if (frame.ready === true && !account) {
        account = frame.account;
        assert.ok(Number.isInteger(account.uid) && account.uid >= 1000);
        assert.ok(Number.isInteger(account.gid) && account.gid > 0);
        assert.match(account.user, /^kcu_[a-f0-9]{24}$/);
        assert.equal(account.runtimeDir, `/run/user/${account.uid}`);
        assert.equal(account.busAddress, `unix:path=${account.runtimeDir}/bus`);
        readyResolve(account);
      } else if (frame.closed === true && !receipt) {
        assert.equal(frame.originalManagerStopped, true);
        assert.equal(frame.originalAccountRemoved, true);
        receipt = frame;
      } else throw new Error('Unexpected owned systemd fixture frame');
    } catch (error) { failure ??= error; readyReject(error); }
  });
  child.once('error', error => { failure ??= error; readyReject(error); });
  child.once('close', () => {
    if (!account) readyReject(new Error('Original owned user fixture exited before ready'));
  });
  let closing;
  const close = () => closing ??= (async () => {
    child.stdin.end();
    const exit = await waitForStdioChildClose(child, 45_000, 'original-systemd-user-owner');
    assert.equal(exit.code, 0, 'Retain account fixture until its exact OS cleanup is confirmed');
    if (failure) throw failure;
    assert.ok(receipt, 'Original account removal receipt is required');
    reader.close();
    await context.stopOwned('original-systemd-user-owner');
    await context.confirmOwnedScratchCleanup(scratch);
    await context.writeArtifactJsonInternal('original-systemd-user-closed.json', receipt);
    return receipt;
  })();
  context.addCleanup('stop original user manager before deleting owned account', close);
  let timer;
  try {
    await Promise.race([ready, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Actual owned user-manager startup timed out')), 45_000);
    })]);
  } finally { clearTimeout(timer); }
  await context.writeArtifactJson('original-systemd-user.json', {
    account, source: 'AccountStore/ensure_binding and original systemd user@UID.service',
    boundary: 'Real OS prerequisite; no channel background or cold-restore acceptance implied',
  });
  return { account, close, scratch };
}
