import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rename } from 'node:fs/promises';
import { RunContext } from './run-context.mjs';
import { binaryResearchIdentity, assertResearchBinary } from './research-identities.mjs';

test('frozen binary hash and identity reject replacement before another sample starts', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'binary-research-freeze', tier: 'model-independent', modelPolicy: 'owned file identity fixture; no executable or model request' });
  let failure;
  try {
    const path = context.pathInState('frozen-bytes');
    const other = context.pathInState('replacement-bytes');
    await writeFile(path, 'first owned bytes');
    const identity = await binaryResearchIdentity(path);
    assert.equal(identity.sha256.length, 64);
    await assertResearchBinary(path, identity);
    await assert.rejects(binaryResearchIdentity(path, '0'.repeat(64)), /does not match/);
    await writeFile(other, 'replacement owned bytes');
    await rename(other, path);
    await assert.rejects(assertResearchBinary(path, identity), /changed/);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', {}, failure); }
});
