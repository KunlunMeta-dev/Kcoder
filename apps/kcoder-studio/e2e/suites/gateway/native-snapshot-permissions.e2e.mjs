import assert from 'node:assert/strict';
import { chmod, chown, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitForStdioChildClose } from '../../harness/app-server-stdio.mjs';
import { nativeCodeFixture } from '../../harness/native-code-service.mjs';
import { requireExecutable, runE2E } from '../../harness/run-context.mjs';

const testName = 'app_server::tests::snapshot_policy_unreadable_file_cannot_be_reported_as_success';

await runE2E(import.meta.url, {
  testId: 'native-unprivileged-worktree-snapshot-permission-denial',
  tier: 'full-integration',
  modelPolicy: 'Actual nonprivileged Linux filesystem denial and native snapshot libtest; no model, account, network or installed-host claim',
}, async context => {
  assert.equal(process.platform, 'linux', 'UNMET_PREREQUISITE: actual Unix permission denial requires the owned Linux runner');
  const binary = await requireExecutable(process.env.KCODER_E2E_SNAPSHOT_TEST_BIN, 'current native snapshot libtest image');
  const expected = process.env.KCODER_E2E_SNAPSHOT_TEST_SHA256;
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, 'Explicit frozen input image SHA256 required');
  const scratch = await context.createOwnedScratchDirectory('snapshot-permission-denial', {
    baseDirectory: process.env.KCODER_E2E_NATIVE_SERVICE_SCRATCH_BASE || '/var/tmp',
    ownedWorkerTraversal: true,
    requiredBytes: 1024n * 1024n * 1024n,
  });
  const fixture = await nativeCodeFixture(context, binary, { scratch });
  assert.ok(fixture.uid > 0, 'The native test must actually run without Root read privileges');
  assert.equal(fixture.imageSha256, expected);
  const temporary = resolve(fixture.home, 'snapshot-temporary');
  await mkdir(temporary, { mode: 0o700 });
  await chmod(temporary, 0o700);
  if (process.getuid() === 0) await chown(temporary, fixture.uid, fixture.gid);
  const label = 'native-unprivileged-snapshot-libtest';
  fixture.activeManagers.add(label);
  const child = context.spawnOwned(label, fixture.binary,
    [testName, '--exact', '--ignored', '--nocapture', '--test-threads=1'], {
      uid: fixture.uid, gid: fixture.gid, cwd: fixture.workspace,
      env: { ...fixture.env, TMPDIR: temporary, RUST_MIN_STACK: '16777216' },
    });
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk.toString('utf8');
    if (Buffer.byteLength(output) > 16 * 1024) child.stdout.destroy(new Error('Owned native permission result exceeded bound'));
  });
  try {
    await waitForStdioChildClose(child, 30_000, label);
  } finally {
    await context.stopOwned(label);
    fixture.activeManagers.delete(label);
  }
  assert.equal(child.exitCode, 0, 'Native permission regression failed; inspect its retained stderr');
  assert.ok(output.includes(`test ${testName} ... ok`), 'The exact native denial test must execute');
  assert.match(output, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
  const result = {
    testName, uid: fixture.uid, gid: fixture.gid, imageSha256: fixture.imageSha256,
    actualUnreadableModeDenied: true, incompleteSnapshotRejected: true,
    modelCalls: 0, selectedPassed: 1, unselectedTestsAreNotPasses: true,
  };
  await context.writeArtifactJson('native-snapshot-permission-result.json', result);
  return result;
});
