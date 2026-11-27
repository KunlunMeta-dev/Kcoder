import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import { observeOriginalIdentityBoundaries } from './remote-original-identity-boundaries.mjs';

for (const acceptedUnexpectedly of [false, true]) {
  test(`identity fault harness preserves and restores exact owned profiles after ${acceptedUnexpectedly ? 'unexpected acceptance' : 'both denials'}`, async () => {
    const context = await RunContext.create(import.meta.url, { testId: `owned-two-ended-identity-restoration-${acceptedUnexpectedly}` });
    let failure;
    try {
      const sourceProfile = context.pathInState('source');
      const receiverProfile = context.pathInState('receiver');
      for (const path of [sourceProfile, receiverProfile]) {
        await mkdir(path, { mode: 0o700 });
        await writeFile(join(path, 'settings.json'), '{}', { mode: 0o600 });
      }
      const before = await Promise.all([lstat(sourceProfile), lstat(receiverProfile)]);
      const calls = [];
      const run = observeOriginalIdentityBoundaries(context, { rpc: { async request(method, params) {
        calls.push({ method, operationId: params.operationId });
        if (acceptedUnexpectedly) return {};
        throw new Error('REMOTE_CONTROL_UNAVAILABLE');
      } }, scope: {}, operationId: 'original-operation', sourceProfile, receiverProfile,
      source: { requests: [] }, receiver: { requests: [] } });
      if (acceptedUnexpectedly) await assert.rejects(run, /Missing expected rejection/);
      else {
        const proof = await run;
        assert.deepEqual(proof.boundaries.map(row => row.endpoint), ['source', 'receiver']);
        assert.ok(proof.boundaries.every(row => row.oldAccessDenied && row.originalPreserved));
      }
      assert.ok(calls.every(row => row.method === 'integrations/remotes/readOperation' && row.operationId === 'original-operation'));
      for (const [index, path] of [sourceProfile, receiverProfile].entries()) {
        const current = await lstat(path);
        assert.deepEqual([current.dev, current.ino], [before[index].dev, before[index].ino]);
        assert.deepEqual(await readdir(path), ['settings.json']);
        assert.equal(await readFile(join(path, 'settings.json'), 'utf8'), '{}');
      }
    } catch (error) { failure = error; }
    await context.finish(failure ? 'failed' : 'passed', { modelIndependentHarnessOnly: true }, failure);
    if (failure) throw failure;
  });
}
