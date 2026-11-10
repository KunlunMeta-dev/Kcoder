import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { repoRoot, requireExecutable, waitFor } from '../../harness/run-context.mjs';

export async function createLegacyHistoryFixture(context, profile, sourceJobId) {
  const binary = await requireExecutable(process.env.KCODER_MIGRATION_FIXTURE_BINARY
    || resolve(repoRoot, 'target/debug/examples/history_reinterpretation_fixture'));
  const child = context.spawnOwned('legacy-history-fixture', binary,
    ['--from-owned-job', profile, sourceJobId]);
  let output = '';
  let closed = false;
  let failure = null;
  child.stdout.on('data', chunk => {
    if (Buffer.byteLength(output) + chunk.length > 65536) {
      failure = new Error('Native legacy fixture output exceeded its bound');
      return;
    }
    output += chunk.toString('utf8');
  });
  child.once('error', error => { failure = error; });
  child.once('close', () => { closed = true; });
  await waitFor(() => closed || failure, 30000, 'Native legacy archive fixture');
  if (failure) throw failure;
  assert.equal(child.exitCode, 0, 'Native legacy fixture must create an actual legacy archive');
  const result = JSON.parse(output);
  assert.match(result.job.jobId, /^[a-f0-9-]{36}$/);
  assert.notEqual(result.job.jobId, sourceJobId);
  assert.equal(result.job.archived, true);
  await context.stopOwned('legacy-history-fixture');
  return result.job;
}
