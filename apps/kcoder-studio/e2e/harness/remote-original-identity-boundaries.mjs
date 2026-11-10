import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

/** Fault injection only. Replace this run's actual configured profile object,
 * preserving the original intact. Product recovery must derive the current
 * native identity and must never read the preserved test-only path.
 */
async function withReplacedOwnedProfile(context, path, label, consume) {
  const state = resolve(context.pathInState('.'));
  const absolute = resolve(path);
  const within = relative(state, absolute);
  assert.ok(within && !within.startsWith('..') && !within.startsWith('/'), 'run-owned profile required');
  const before = await lstat(absolute);
  assert.ok(before.isDirectory() && !before.isSymbolicLink() && before.uid === process.getuid());
  const originalSettings = await readFile(join(absolute, 'settings.json'));
  const preserved = join(dirname(absolute), `${basename(absolute)}-original-identity-preserved`);
  await assert.rejects(lstat(preserved), { code: 'ENOENT' });
  await rename(absolute, preserved);
  let replacement;
  let restored = false;
  const restore = async () => {
    if (restored) return;
    if (replacement) {
      const current = await lstat(absolute);
      assert.deepEqual([current.dev, current.ino, current.uid], [replacement.dev, replacement.ino, replacement.uid]);
      await rm(absolute, { recursive: true });
    }
    await rename(preserved, absolute);
    restored = true;
    const actual = await lstat(absolute);
    assert.deepEqual([actual.dev, actual.ino], [before.dev, before.ino]);
  };
  context.addCleanup(`restore ${label} original owned profile identity`, restore);
  try {
    await mkdir(absolute, { mode: 0o700 });
    replacement = await lstat(absolute);
    await writeFile(join(absolute, 'settings.json'), originalSettings, { mode: 0o600, flag: 'wx' });
    assert.notEqual(replacement.ino, before.ino);
    await consume();
    assert.deepEqual(await readdir(absolute), ['settings.json'], 'denied readonly lookup cannot initialize native state');
    return { realProfileObjectChanged: true, sameActualUid: true, originalPreserved: true, deniedProfileUnchanged: true };
  } finally { await restore(); }
}

/** Two actual Linux endpoints change identity independently, on the same
 * original operation. No alternate target, invocation or model is requested.
 */
export async function observeOriginalIdentityBoundaries(context, { rpc, scope, operationId,
  sourceProfile, receiverProfile, source, receiver }) {
  const counts = { source: source.requests.length, receiver: receiver.requests.length };
  const proof = { operationId, actualLinuxEndpoints: true, faultInjectionOnly: true,
    originalOperationOnly: true, newTurnOrDelegateRequested: false, paidCalls: 0, boundaries: [] };
  try {
    for (const [endpoint, path] of [['source', sourceProfile], ['receiver', receiverProfile]]) {
      const facts = await withReplacedOwnedProfile(context, path, endpoint, async () => {
        await assert.rejects(rpc.request('integrations/remotes/readOperation', {
          requestId: `read-original-denied-${endpoint}-identity`, scope, operationId,
        }), /REMOTE_CONTROL_UNAVAILABLE/);
        assert.deepEqual({ source: source.requests.length, receiver: receiver.requests.length }, counts,
          'identity denial cannot dispatch another Source/Receiver model');
      });
      proof.boundaries.push({ endpoint, ...facts, oldAccessDenied: true, noTargetFallback: true });
    }
    proof.countsBefore = counts;
    proof.countsAfter = { source: source.requests.length, receiver: receiver.requests.length };
    return proof;
  } finally {
    await context.writeArtifactJson('original-operation-two-ended-identity-boundaries.json', proof);
  }
}
