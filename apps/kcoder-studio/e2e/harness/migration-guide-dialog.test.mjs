import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { runMigrationGuideDialog } from './migration-guide-dialog.mjs';

function fixture({ writeError } = {}) {
  const child = { exitCode: null, stdout: new PassThrough() };
  let writes = 0;
  child.stdin = new Writable({
    write(_bytes, _encoding, done) { writes++; if (writeError) { child.exitCode = 1; done(new Error('owned_input_failed')); } else done(); },
    final(done) { child.exitCode = 0; done(); },
  });
  return { child, writes: () => writes, context: {
    isolatedEnvironment: () => ({}),
    spawnOwned: () => child,
    abortSignal: new AbortController().signal,
  } };
}
const question = { type: 'prompt', id: 'original', code: 'question' };

test('failed observation closes input once and queued prompts cannot write after end or replace the original failure', async () => {
  const owned = fixture(); let answers = 0;
  queueMicrotask(() => owned.child.stdout.write(`${JSON.stringify({ type: 'receipt' })}\n${JSON.stringify(question)}\n`));
  await assert.rejects(runMigrationGuideDialog({ context: owned.context, binary: 'unused', label: 'owned failure',
    observe() { throw new Error('original_observation_failed'); },
    answer() { answers++; return 'IMPORT'; },
  }), /original_observation_failed/);
  assert.equal(answers, 0); assert.equal(owned.writes(), 0);
});

test('owned child stdin failure remains a caught dialog error and never becomes an unhandled process event', async () => {
  const owned = fixture({ writeError: true });
  queueMicrotask(() => owned.child.stdout.write(`${JSON.stringify(question)}\n${JSON.stringify(question)}\n`));
  await assert.rejects(runMigrationGuideDialog({ context: owned.context, binary: 'unused', label: 'owned input failure',
    answer: () => 'IMPORT',
  }), /owned_input_failed/);
  assert.equal(owned.writes(), 1);
});
