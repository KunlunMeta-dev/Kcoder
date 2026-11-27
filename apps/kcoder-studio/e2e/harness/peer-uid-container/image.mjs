import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, requireExecutable } from '../run-context.mjs';
import { waitForStdioChildClose } from '../app-server-stdio.mjs';
import { pinPeerUidNative } from './native-input.mjs';

const leases = new WeakMap();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const peerUidImageLabel = 'kcoder.test.peer-uid-owner';
const inspectFormat = `{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},"user":{{json (or (index .Config "User") "")}},"owner":{{json (index .Config.Labels "${peerUidImageLabel}")}},"tags":{{json .RepoTags}}}`;

export function requirePeerUidContainerConsent(environment = process.env, platform = process.platform, uid = process.getuid?.()) {
  assert.equal(platform, 'linux', 'UNMET_PREREQUISITE: Linux fixture host required');
  assert.equal(uid, 0, 'UNMET_PREREQUISITE: root-owned disposable container controller required');
  assert.equal(environment.KCODER_E2E_PEER_UID_CONTAINER_PREPARE, '1', 'UNMET_PREREQUISITE: explicit peer UID image preparation gate required');
}

export function assertOriginalPeerUidImage(expected, actual) {
  assert.match(expected.owner, /^[a-f0-9-]{36}$/);
  assert.equal(expected.tag, `kcoder-peer-uids-e2e:${expected.owner}`);
  assert.match(expected.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(actual.id, expected.imageId, 'Original fixture image identity changed');
  assert.equal(actual.owner, expected.owner, 'Original fixture image ownership changed');
  assert.deepEqual(actual.tags, [expected.tag], 'Fixture image tags changed; refuse unrelated cleanup');
  assert.equal(actual.os, 'linux');
  assert.equal(actual.architecture, 'amd64');
  assert.ok(['', '0', '0:0', 'root'].includes(actual.user), 'Fixture PID1 must initialize private container identities');
}

/** No personal Docker context/config is consulted; only this explicit local socket. */
export async function createPeerUidDockerConnection(context, {
  executablePath = '/usr/bin/docker',
  inspectSocket = path => lstat(path, { bigint: true }),
} = {}) {
  const executable = await requireExecutable(executablePath, 'local Docker client');
  const socket = '/var/run/docker.sock';
  const owner = await inspectSocket(socket);
  assert.ok(owner.isSocket() && !owner.isSymbolicLink() && owner.uid === 0n, 'UNMET_PREREQUISITE: original local root Docker socket required');
  const configuration = context.pathInState('peer-uid-docker-config');
  await mkdir(configuration, { mode: 0o700 });
  const environment = context.isolatedEnvironment({});
  let sequence = 0;
  const launch = async (arguments_, { label = 'inspect', stdin = 'ignore', onStdout } = {}) => {
    const actual = await inspectSocket(socket);
    assert.ok(actual.isSocket() && actual.dev === owner.dev && actual.ino === owner.ino && actual.uid === owner.uid, 'Original local Docker endpoint changed');
    const spawn = context.finishing ? context.spawnCleanupOwned.bind(context) : context.spawnOwned.bind(context);
    const child = spawn(`peer-uid-docker-${label}-${++sequence}`, executable,
      ['--config', configuration, '--host', `unix://${socket}`, ...arguments_], {
        cwd: repoRoot, env: environment, stdin,
      });
    if (onStdout) child.stdout.on('data', onStdout);
    return child;
  };
  const execute = async (arguments_, { timeoutMs = 15000, label = 'inspect' } = {}) => {
    const chunks = []; let bytes = 0;
    // Adopt output synchronously before the async launch result can yield to
    // a very short-lived owned cleanup command's data/close notifications.
    const child = await launch(arguments_, { label, onStdout: chunk => { bytes += chunk.length; if (bytes <= 1024 * 1024) chunks.push(chunk); } });
    const exit = await waitForStdioChildClose(child, timeoutMs, `peer-uid-${label}`);
    assert.equal(exit.code, 0, `Owned Docker ${label} failed; inspect its original redacted process log`);
    assert.ok(bytes <= 1024 * 1024, 'Owned Docker metadata exceeded its bound');
    return Buffer.concat(chunks).toString('utf8');
  };
  execute.launch = launch;
  execute.configuration = configuration;
  return execute;
}

/** This handle is local to the original run, never reconstructed from JSON. */
export async function observeOwnedPeerUidImage(context, expected, execute) {
  const actual = JSON.parse(await execute(['image', 'inspect', expected.imageId, '--format', inspectFormat]));
  assertOriginalPeerUidImage(expected, actual);
  const handle = Object.freeze({});
  leases.set(handle, { context, expected: structuredClone(expected), execute, removed: false });
  return handle;
}

export async function cleanupOwnedPeerUidImage(context, handle) {
  const lease = leases.get(handle);
  assert.ok(lease && lease.context === context, 'Unowned or forged fixture image handle');
  if (lease.removed) return;
  const actual = JSON.parse(await lease.execute(['image', 'inspect', lease.expected.imageId, '--format', inspectFormat]));
  assertOriginalPeerUidImage(lease.expected, actual);
  // Removing this original tag does not prune caches, base images or peers.
  await lease.execute(['image', 'rm', lease.expected.tag], { label: 'remove-owned-image' });
  lease.removed = true;
}

/** Prepare only the OS image. No container, account, SSH server or model starts. */
async function beginImagePreparation(context, source, sourceSha256) {
  requirePeerUidContainerConsent();
  const execute = await createPeerUidDockerConnection(context);
  const owner = randomUUID(), tag = `kcoder-peer-uids-e2e:${owner}`;
  let expected, handle, handedOff = false;
  context.metadata.peerUidContainerImage = { owner, tag, state: 'preparing', hostAccountsModified: false };
  await context.writeArtifactJson('peer-uid-image-owner.json', { schemaVersion: 1, owner, tag, source, sourceSha256, state: 'original_build_requested' });
  context.addCleanup('remove only unhanded original peer UID image', async () => {
    if (handedOff) return;
    if (!handle) {
      const ids = (await execute(['image', 'ls', '--all', '--no-trunc', '--filter', `label=${peerUidImageLabel}=${owner}`, '--format', '{{.ID}}'])).trim();
      if (!ids) return;
      assert.match(ids, /^sha256:[a-f0-9]{64}$/);
      expected = { owner, tag, imageId: ids };
      handle = await observeOwnedPeerUidImage(context, expected, execute);
    }
    await cleanupOwnedPeerUidImage(context, handle);
  });
  return { execute, owner, tag,
    async handoff(imageId, details = {}) {
      expected = { owner, tag, imageId };
      handle = await observeOwnedPeerUidImage(context, expected, execute);
      const receipt = { schemaVersion: 1, ...expected, source, sourceSha256, ...details,
        endpoint: 'unix:///var/run/docker.sock', createdAt: new Date().toISOString(), state: 'prepared_retained_for_later_uid_acceptance',
        hostAccountsModified: false, testContainersStarted: 0, sshServersStarted: 0, modelCalls: 0,
        note: 'Image preparation only. Real SSH authentication, two OS UIDs, Native and cleanup acceptance remain unexecuted.' };
      await context.writeArtifactJson('peer-uid-image.json', receipt);
      context.metadata.peerUidContainerImage = receipt;
      handedOff = true;
      return receipt;
    },
  };
}

export async function preparePeerUidImage(context) {
  const source = resolve(repoRoot, 'apps/kcoder-studio/e2e/fixtures/accounts');
  const dockerfile = resolve(source, 'Dockerfile');
  const sourceSha256 = sha(await readFile(dockerfile));
  const { execute, owner, tag, handoff } = await beginImagePreparation(context, 'apps/kcoder-studio/e2e/fixtures/accounts/Dockerfile', sourceSha256);
  const iidFile = context.pathInState('peer-uid-image.id');
  await execute(['build', '--pull', '--label', `${peerUidImageLabel}=${owner}`, '--tag', tag, '--iidfile', iidFile, source], { timeoutMs: 600000, label: 'image-build' });
  const imageId = (await readFile(iidFile, 'utf8')).trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(sha(await readFile(dockerfile)), sourceSha256, 'Image source changed during its actual build');
  const base = JSON.parse(await execute(['image', 'inspect', 'ubuntu:24.04', '--format', '{"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}']));
  return handoff(imageId, { base });
}

export async function prepareOfflinePeerUidImage(context) {
  requirePeerUidContainerConsent();
  const native = await pinPeerUidNative(process.env.KCODER_E2E_KCODER_BIN, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const directory = resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/peer-uid-container');
  const dockerfile = resolve(directory, 'Dockerfile.offline'), collector = resolve(directory, 'offline-rootfs.py');
  const sourceSha256 = sha(await readFile(dockerfile)), collectorSha256 = sha(await readFile(collector));
  const { execute, owner, tag, handoff } = await beginImagePreparation(context, 'apps/kcoder-studio/e2e/harness/peer-uid-container/Dockerfile.offline', sourceSha256);
  const buildContext = context.pathInState('offline-build'); await mkdir(buildContext, { mode: 0o700 });
  const manifestPath = context.pathInState('offline-rootfs.json');
  const child = context.spawnOwned('peer-uid-offline-rootfs-collector', '/usr/bin/python3', ['-I', '-S', '-B', collector,
    '--output', resolve(buildContext, 'rootfs'), '--native', native.path, '--native-sha256', native.sha256, '--manifest', manifestPath], {
    cwd: repoRoot, env: context.isolatedEnvironment({}), stdin: 'ignore',
  });
  const exit = await waitForStdioChildClose(child, 120000, 'offline peer UID rootfs collector');
  assert.equal(exit.code, 0, 'Offline rootfs collector failed; inspect its original owned log');
  assert.equal(sha(await readFile(collector)), collectorSha256);
  assert.equal(sha(await readFile(dockerfile)), sourceSha256);
  const rootfs = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(rootfs.hostAccountDatabaseCopied, false); assert.equal(rootfs.hostKeysCopied, false); assert.equal(rootfs.hostEtcCopied, false);
  await context.writeArtifactJson('offline-rootfs-inventory.json', rootfs);
  await copyFile(dockerfile, resolve(buildContext, 'Dockerfile'));
  const iidFile = context.pathInState('peer-uid-image.id');
  await execute(['build', '--network', 'none', '--pull=false', '--label', `${peerUidImageLabel}=${owner}`, '--tag', tag, '--iidfile', iidFile, buildContext], { timeoutMs: 180000, label: 'offline-image-build' });
  const imageId = (await readFile(iidFile, 'utf8')).trim(); assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  return handoff(imageId, { base: 'scratch', collectorSha256, rootfsSha256: rootfs.rootfsSha256, rootfsFileCount: rootfs.fileCount, rootfsBytes: rootfs.bytes, nativeDependencyInput: native, network: 'none', packagesDownloaded: 0, sourceOwnership: 'root-owned audited system programs; container NSS generated from constants' });
}
