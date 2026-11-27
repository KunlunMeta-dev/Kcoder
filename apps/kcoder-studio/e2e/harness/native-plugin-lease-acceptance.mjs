import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, copyFile, lstat, mkdir, readFile, readlink, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { runOwnedNativePhase } from './owned-dependencies.mjs';
import { repoRoot, runE2E } from './run-context.mjs';

const execute = promisify(execFile);
const consumer = 'apps/kcoder-studio/integration/gateway/plugin-version-retention.integration.mjs';
const buildPaths = ['Cargo.toml', 'Cargo.lock', '.cargo', 'crates', 'skills'];
const sourceProofBoundary = 'Before/after snapshots of the enumerated buildPaths only; not a complete compiler dependency closure, hermetic/reproducible build proof, or proof against transient changes that are restored between snapshots';
const sha = value => createHash('sha256').update(value).digest('hex');
const git = async args => (await execute('git', args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 })).stdout;

async function fileSha(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}

async function sourceIdentity() {
  const files = (await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...buildPaths]))
    .split('\0').filter(Boolean).sort();
  const entries = [];
  for (const path of [...new Set(files)]) {
    const absolute = resolve(repoRoot, path);
    const info = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    entries.push({ path, mode: info?.mode ?? null, sha256: !info ? null : info.isSymbolicLink()
      ? sha(await readlink(absolute)) : info.isFile() ? await fileSha(absolute) : null });
  }
  const dirty = await git(['status', '--porcelain=v1', '--untracked-files=all']);
  return { head: (await git(['rev-parse', 'HEAD'])).trim(), cleanReleaseClaim: false,
    sourceProofBoundary,
    dirtyPaths: dirty.split('\n').filter(Boolean), dirtyPathListSha256: sha(dirty),
    buildPaths, buildTreeSha256: sha(JSON.stringify(entries)), buildInputs: entries,
    cargoLockSha256: await fileSha(resolve(repoRoot, 'Cargo.lock')) };
}

async function consumerRuns(dates = [new Date()]) {
  const roots = new Set(dates.map(date => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(date).split('-');
    return resolve(repoRoot, 'target/e2e', ...parts, '../integration/gateway/plugin-version-retention.integration.mjs');
  }));
  const runs = [];
  for (const root of roots) for (const name of await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) runs.push(resolve(root, name));
  return runs;
}

await runE2E(import.meta.url, {
  testId: 'current-dirty-source-native-plugin-lease-acceptance', tier: 'full-integration',
  modelPolicy: 'Owned loopback protocol fixture; no paid model, OS account, SSH, systemd or external platform',
  retainSuccessLogs: true,
}, async context => {
  let reusedBuild;
  if (process.env.KCODER_E2E_LEASE_REUSE_BUILD_RUN) {
    const root = resolve(process.env.KCODER_E2E_LEASE_REUSE_BUILD_RUN);
    const location = relative(resolve(repoRoot, 'target/e2e'), root);
    assert.ok(location && !isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`));
    const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.source, 'apps/kcoder-studio/e2e/harness/native-plugin-lease-acceptance.mjs');
    const receipt = JSON.parse(await readFile(resolve(root, 'artifacts/build-receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'completed', 'Reuse requires a completed actual CLI build receipt');
    const binary = JSON.parse(await readFile(resolve(root, 'artifacts/frozen-native-identity.json'), 'utf8'));
    assert.match(binary.binarySha256, /^[a-f0-9]{64}$/);
    reusedBuild = { root, receipt, binary };
  }
  const before = reusedBuild ? JSON.parse(await readFile(resolve(reusedBuild.root, 'artifacts/build-source-before.json'), 'utf8')) : await sourceIdentity();
  await context.writeArtifactJson('build-source-before.json', before);
  const args = ['build', '--offline', '--locked', '-p', 'kcoder_cli', '--bin', 'kcoder'];
  const buildEnv = context.isolatedEnvironment({
    CARGO_HOME: process.env.CARGO_HOME || resolve(homedir(), '.cargo'),
    RUSTUP_HOME: process.env.RUSTUP_HOME || resolve(homedir(), '.rustup'),
    CARGO_BUILD_JOBS: '4',
  });
  let buildFailure;
  try { if (!reusedBuild) {
    await runOwnedNativePhase(context, { label: 'current-source-native-cli-build', command: 'cargo', args,
      cwd: repoRoot, env: buildEnv, timeoutMs: 900_000 });
  }
  } catch (error) { buildFailure = error; }
  const after = await sourceIdentity();
  await context.writeArtifactJson('build-source-after.json', after);
  await context.writeArtifactJson('build-receipt.json', { command: ['cargo', ...args], jobs: 4,
    status: buildFailure ? 'failed' : 'completed', error: buildFailure?.message ?? null, sourceProofBoundary,
    reusedCompletedBuild: reusedBuild ?? null,
    headStable: before.head === after.head, buildSourceStable: before.buildTreeSha256 === after.buildTreeSha256 });
  if (buildFailure) throw buildFailure;
  if (!reusedBuild) assert.equal(after.buildTreeSha256, before.buildTreeSha256, 'Enumerated build inputs must match before and after the build');
  const directory = context.pathInState('frozen-native');
  await mkdir(directory);
  const binary = resolve(directory, 'kcoder');
  await copyFile(resolve(repoRoot, 'target/debug/kcoder'), binary, constants.COPYFILE_EXCL);
  await access(binary, constants.X_OK);
  const identity = await lstat(binary), binarySha256 = await fileSha(binary);
  if (reusedBuild) assert.equal(binarySha256, reusedBuild.binary.binarySha256, 'Refrozen bytes must exactly match the recorded completed build binary');
  assert.ok(identity.isFile() && !identity.isSymbolicLink());
  assert.equal(identity.nlink, 1);
  await context.writeArtifactJson('frozen-native-identity.json', { path: binary, binarySha256,
    dev: identity.dev, ino: identity.ino, size: identity.size, nlink: identity.nlink,
    sourceHead: before.head, sourceTreeSha256: before.buildTreeSha256,
    lifetime: 'This acceptance RunContext only; removed after consumer cleanup', cleanReleaseClaim: false,
    sourceProofBoundary, originalCompletedBuildRun: reusedBuild?.root ?? context.runRoot });
  const consumerDate = new Date(), previousRuns = new Set(await consumerRuns([consumerDate]));
  let consumerFailure;
  try {
    await runOwnedNativePhase(context, { label: 'native-plugin-lease-direct-consumer', command: process.execPath,
      args: [consumer], cwd: repoRoot, timeoutMs: 300_000,
      env: context.isolatedEnvironment({ KCODER_E2E_NATIVE_PLUGIN_SOURCE_LEASE: '1',
        KCODER_E2E_KCODER_BIN: binary, KCODER_E2E_KCODER_SHA256: binarySha256,
        ...(process.env.KCODER_E2E_GATEWAY_ROOT ? { KCODER_E2E_GATEWAY_ROOT: process.env.KCODER_E2E_GATEWAY_ROOT } : {}) }) });
  } catch (error) { consumerFailure = error; }
  const newRuns = (await consumerRuns([consumerDate, new Date()])).filter(path => !previousRuns.has(path));
  const consumers = [];
  for (const runRoot of newRuns) consumers.push({ runRoot,
    manifest: JSON.parse(await readFile(resolve(runRoot, 'manifest.json'), 'utf8')),
    result: JSON.parse(await readFile(resolve(runRoot, 'artifacts/result.json'), 'utf8')) });
  const finalIdentity = await lstat(binary);
  const binaryUnchanged = await fileSha(binary) === binarySha256 && finalIdentity.ino === identity.ino
    && finalIdentity.dev === identity.dev && finalIdentity.nlink === 1;
  await context.writeArtifactJson('native-plugin-lease-direct-consumer.json', {
    status: consumerFailure ? 'failed' : 'completed', binarySha256, binaryUnchanged,
    error: consumerFailure?.message ?? null, consumers });
  assert.ok(binaryUnchanged, 'Frozen binary must remain unchanged for the consumer lifetime');
  if (consumerFailure) throw consumerFailure;
  assert.equal(consumers.length, 1, 'One direct consumer RunContext is required');
  assert.equal(consumers[0].manifest.status, 'passed');
  assert.deepEqual(consumers[0].result.cleanupErrors, []);
  return { binarySha256, sourceHead: before.head, sourceTreeSha256: before.buildTreeSha256,
    cleanReleaseClaim: false, directConsumerRunRoot: consumers[0].runRoot, paidModelCalls: 0 };
});
