import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOriginalPeerUidImage, cleanupOwnedPeerUidImage, createPeerUidDockerConnection, observeOwnedPeerUidImage, requirePeerUidContainerConsent } from './image.mjs';

const owner = '00000000-0000-4000-8000-000000000001';
const expected = { owner, tag: `kcoder-peer-uids-e2e:${owner}`, imageId: 'sha256:' + 'a'.repeat(64) };
const image = () => ({ id: expected.imageId, owner, tags: [expected.tag], os: 'linux', architecture: 'amd64', user: '' });

test('image preparation requires the exact gate before host mutation and never enables another platform', () => {
  for (const value of [undefined, '', 'true', '0']) assert.throws(() => requirePeerUidContainerConsent({ KCODER_E2E_PEER_UID_CONTAINER_PREPARE: value }, 'linux', 0));
  assert.throws(() => requirePeerUidContainerConsent({ KCODER_E2E_PEER_UID_CONTAINER_PREPARE: '1' }, 'win32', 0));
  assert.throws(() => requirePeerUidContainerConsent({ KCODER_E2E_PEER_UID_CONTAINER_PREPARE: '1' }, 'linux', 1000));
  requirePeerUidContainerConsent({ KCODER_E2E_PEER_UID_CONTAINER_PREPARE: '1' }, 'linux', 0);
});

test('serialized or foreign image handles cannot invoke Docker cleanup', async () => {
  const context = {};
  await assert.rejects(cleanupOwnedPeerUidImage(context, { ...expected }), /forged/);
  const calls = [];
  const handle = await observeOwnedPeerUidImage(context, expected, async arguments_ => { calls.push(arguments_); return JSON.stringify(image()); });
  await assert.rejects(cleanupOwnedPeerUidImage({}, handle), /forged/);
  assert.equal(calls.length, 1);
});

test('cleanup identity or ownership drift refuses removal before any mutation', async () => {
  for (const change of [{ id: 'sha256:' + 'b'.repeat(64) }, { owner: 'another-owner' }, { tags: [expected.tag, 'somebody-else:latest'] }]) {
    const calls = []; let observed = image(); const context = {};
    const handle = await observeOwnedPeerUidImage(context, expected, async arguments_ => { calls.push(arguments_); return JSON.stringify(observed); });
    observed = { ...observed, ...change };
    await assert.rejects(cleanupOwnedPeerUidImage(context, handle));
    assert.ok(calls.every(arguments_ => arguments_[1] === 'inspect'));
  }
});

test('only the original prepared image tag is removed and completed cleanup does not repeat', async () => {
  const calls = []; const context = {};
  const handle = await observeOwnedPeerUidImage(context, expected, async arguments_ => { calls.push(arguments_); return arguments_[1] === 'inspect' ? JSON.stringify(image()) : ''; });
  await cleanupOwnedPeerUidImage(context, handle); await cleanupOwnedPeerUidImage(context, handle);
  assert.deepEqual(calls.at(-1), ['image', 'rm', expected.tag]); assert.equal(calls.length, 3);
});

test('a foreign image execution user or architecture cannot impersonate the root fixture initializer', () => {
  assert.throws(() => assertOriginalPeerUidImage(expected, { ...image(), user: '20001' }));
  assert.throws(() => assertOriginalPeerUidImage(expected, { ...image(), architecture: 'arm64' }));
});

test('finalization uses the original environment and cleanup-owned process API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'peer-uid-cleanup-api-'));
  const calls = []; let environmentReads = 0;
  const context = {
    finishing: false,
    pathInState: name => join(root, name),
    isolatedEnvironment() { assert.equal(this.finishing, false); environmentReads++; return { owned: 'original' }; },
    spawnOwned() { throw Error('active-only spawn cannot run during finalization'); },
    spawnCleanupOwned(_label, _command, _args, options) {
      assert.equal(this.finishing, true); calls.push(options.env);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.exitCode = null; child.signalCode = null;
      queueMicrotask(() => { child.stdout.end('[]'); child.exitCode = 0; child.emit('close', 0, null); });
      return child;
    },
  };
  const socket = { isSocket: () => true, isSymbolicLink: () => false, uid: 0n, dev: 1n, ino: 2n };
  try {
    const execute = await createPeerUidDockerConnection(context, { executablePath: process.execPath, inspectSocket: async () => socket });
    context.finishing = true;
    assert.equal(await execute(['image', 'ls']), '[]');
    assert.equal(environmentReads, 1); assert.deepEqual(calls, [{ owned: 'original' }]);
  } finally { await rm(root, { recursive: true }); }
});
