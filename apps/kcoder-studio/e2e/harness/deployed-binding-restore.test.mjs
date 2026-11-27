import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { finishBindingRestoration, originalBindingAlreadyRestored } from './deployed-binding-restore.mjs';
import { runE2E } from './run-context.mjs';

test('cleanup completes a confirmed restoration without using the active-only artifact API', async () => {
  let runRoot, closed = 0;
  await assert.rejects(runE2E(import.meta.url, { testId: 'binding-restore-cleanup', tier: 'unit',
    modelPolicy: 'Owned local lifecycle fixture; no platform connection or send.' }, async context => {
    runRoot = context.runRoot;
    context.addCleanup('restore observed binding', () => finishBindingRestoration({
      context, dialog: {}, close: async () => { closed++; }, restored: { id: 'fixture' }, recordArtifact: false,
    }));
    throw new Error('synthetic primary failure');
  }), /synthetic primary failure/);
  assert.equal(closed, 1);
  const manifest = JSON.parse(await readFile(join(runRoot, 'manifest.json'), 'utf8'));
  const result = JSON.parse(await readFile(join(runRoot, 'artifacts/result.json'), 'utf8'));
  assert.equal(manifest.cleanupSteps.find(step => step.label === 'restore observed binding')?.status, 'completed');
  assert.deepEqual(result.cleanupErrors, []);
});

test('normal restoration closes the dialog first and propagates artifact failures', async () => {
  const steps = [];
  await assert.rejects(finishBindingRestoration({
    context: { writeArtifactJson: async () => { steps.push('artifact'); throw new Error('owned artifact failed'); } },
    dialog: {}, close: async () => { steps.push('close'); }, restored: { id: 'fixture' }, recordArtifact: true,
  }), /owned artifact failed/);
  assert.deepEqual(steps, ['close', 'artifact']);
});


test('a different existing binding is not treated as restored or overwritten', () => {
  const original = { id: 'original' };
  assert.equal(originalBindingAlreadyRestored(null, 'task-a', original), false);
  assert.equal(originalBindingAlreadyRestored({ id: 'original', task: { threadId: 'task-a' } }, 'task-a', original), true);
  assert.throws(() => originalBindingAlreadyRestored({ id: 'different', task: { threadId: 'task-a' } }, 'task-a', original), /manual reconciliation/);
  assert.throws(() => originalBindingAlreadyRestored({ id: 'original', task: { threadId: 'task-b' } }, 'task-a', original), /manual reconciliation/);
});
