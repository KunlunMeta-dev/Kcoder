import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { repoRoot, requireExecutable, runIntegration, waitFor } from '../e2e/harness/run-context.mjs';
import { hashHistoryFile } from '../e2e/harness/migration-large-history.mjs';

const CASE = 'storage::component_publication::tests::linux_cross_filesystem_publication_recovers_original_operation_and_preserves_source';
await runIntegration(import.meta.url, {
  testId: 'storage-config-linux-cross-filesystem', tier: 'manual-live', variantId: 'linux-ext4-tmpfs',
  modelPolicy: 'actual Linux Config component publication and same-operation recovery across filesystems; no Electron, installed Windows, CLI, addon or model',
  retainSuccessLogs: true,
}, async context => {
  assert.equal(process.platform, 'linux', 'UNMET_PREREQUISITE: actual Linux filesystems required');
  assert.equal(process.env.KCODER_E2E_STORAGE_CROSS_VOLUME, '1', 'UNMET_PREREQUISITE: explicit cross-filesystem consent required');
  assert.match(process.env.KCODER_E2E_CONFIG_LIBTEST_SHA256 ?? '', /^[a-f0-9]{64}$/, 'UNMET_PREREQUISITE: immutable Config libtest SHA256 required');
  const libtest = await requireExecutable(process.env.KCODER_E2E_CONFIG_LIBTEST, 'immutable Config libtest');
  const binarySha256 = await hashHistoryFile(libtest);
  assert.equal(binarySha256, process.env.KCODER_E2E_CONFIG_LIBTEST_SHA256);
  const sources = await Promise.all([
    'Cargo.lock', 'crates/kcoder_config/Cargo.toml',
    'crates/kcoder_config/src/storage/component_publication_tests.rs',
    'crates/kcoder_config/src/storage/component_publication.rs',
    'crates/kcoder_config/src/storage/control.rs', 'crates/kcoder_config/src/storage/tree_copy.rs',
    'apps/kcoder-studio/integration/storage-cross-filesystem.integration.mjs',
  ].map(async path => ({ path, sha256: await hashHistoryFile(resolve(repoRoot, path)) })));
  await context.writeArtifactJson('inputs.json', { libtest, binarySha256, exactCase: CASE, sources });

  const temporary = context.pathInState('temporary'), home = context.pathInState('home');
  for (const path of [temporary, home]) await mkdir(path);
  const sourceInfo = await lstat(temporary, { bigint: true });
  const sourceFilesystem = await statfs(temporary, { bigint: true });
  assert.equal(sourceFilesystem.type, 0xef53n, 'UNMET_PREREQUISITE: source TEMP must use the ext filesystem');
  const scratch = await context.createOwnedScratchDirectory('storage-cross-filesystem', {
    baseDirectory: '/dev/shm', expectedFilesystemType: 0x1021994n,
    requiredBytes: 4n * 1024n * 1024n, reserveBytes: 4n * 1024n * 1024n,
  });
  const owner = randomUUID(), root = context.pathInScratch(scratch, `kcoder-package-${owner}`);
  await mkdir(root);
  await writeFile(join(root, '.owner.json'), JSON.stringify({ owner }), { flag: 'wx' });
  const targetInfo = await lstat(root, { bigint: true });
  assert.notEqual(sourceInfo.dev, targetInfo.dev, 'UNMET_PREREQUISITE: target and source TEMP must have different devices');
  assert.equal(targetInfo.uid, BigInt(process.getuid()));
  const filesystemProof = { sourceTemporaryRoot: temporary, sourceDevice: String(sourceInfo.dev),
    sourceFilesystemType: '0xef53', targetRoot: root, targetDevice: String(targetInfo.dev),
    targetInode: String(targetInfo.ino), targetUid: String(targetInfo.uid), targetFilesystemType: scratch.filesystemType,
    scratchRoot: scratch.path, scratchDevice: scratch.dev, scratchInode: scratch.ino, scratchUid: scratch.uid, owner };
  await context.writeArtifactJson('filesystem-owner.json', filesystemProof);

  const args = [CASE, '--ignored', '--exact', '--nocapture', '--test-threads=1'];
  const child = context.spawnOwned('config-cross-filesystem', libtest, args, { cwd: context.stateDir,
    env: context.isolatedEnvironment({ TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
      KCODER_E2E_STORAGE_CROSS_VOLUME: '1', KCODER_E2E_STORAGE_CROSS_VOLUME_ROOT: root }) });
  let output = '', overflow = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    if (output.length + chunk.length > 64 * 1024) overflow = true;
    else output += chunk.toString('utf8');
  });
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 60_000,
    'owned Config cross-filesystem libtest completes', 25, context.abortSignal);
  await context.stopOwned('config-cross-filesystem');
  await context.writeArtifactJson('libtest-result.json', { exactCase: CASE, args, exitCode: child.exitCode,
    signal: child.signalCode, output, overflow });
  assert.equal(overflow, false);
  assert.equal(child.exitCode, 0, output);
  assert.equal(child.signalCode, null);
  assert.match(output, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
  assert.ok(output.includes(`test ${CASE} ... ok`), 'the exact ignored case must actually run');
  assert.equal(await hashHistoryFile(libtest), binarySha256);
  for (const source of sources) assert.equal(await hashHistoryFile(resolve(repoRoot, source.path)), source.sha256, source.path);
  assert.deepEqual(JSON.parse(await readFile(join(root, '.owner.json'), 'utf8')), { owner });
  await context.writeArtifactJson('cross-filesystem-proof.json', { ...filesystemProof, binarySha256, exactCase: CASE,
    settingsAndSqliteAndUnicodeAttachmentCopied: true, originalOperationRecoveredAfterCopy: true,
    originalSourcePreservedByExactCase: true, sourceHashesUnchanged: true,
    configComponentOnly: true, electronAcceptance: false, installedWindowsAcceptance: false, modelCalls: 0 });
  return { exactCase: CASE, passedCases: 1, sourceDevice: String(sourceInfo.dev), targetDevice: String(targetInfo.dev),
    configComponentOnly: true, binarySha256 };
});
