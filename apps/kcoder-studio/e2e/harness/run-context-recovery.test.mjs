import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunContext } from './run-context.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'kcoder-scratch-confirmation-'));
  const context = await RunContext.create(import.meta.url, { testId: 'scratch-cleanup-confirmation' });
  t.after(async () => { if (!context.finished) await context.finish('failed', { offline: true }).catch(() => {}); await rm(base, { recursive: true, force: true }); });
  return { context, base };
}

test('scratch cleanup confirmation is disabled by default', async t => {
  const { context, base } = await fixture(t);
  const scratch = await context.createOwnedScratchDirectory('default-confirmation', { baseDirectory: base });
  assert.equal(scratch.requireCleanupConfirmation, false);
  await context.finish('passed', { offline: true });
  await assert.rejects(access(scratch.path), { code: 'ENOENT' });
});

test('unconfirmed external cleanup retains scratch while state is removed and records failure', async t => {
  const { context, base } = await fixture(t);
  const scratch = await context.createOwnedScratchDirectory('requires-confirmation', { baseDirectory: base, requireCleanupConfirmation: true });
  await assert.rejects(context.finish('failed', { offline: true }), /retained until original external cleanup is confirmed/);
  await assert.rejects(access(context.stateDir), { code: 'ENOENT' });
  assert.equal((await lstat(scratch.path)).isDirectory(), true);
  const manifest = JSON.parse(await readFile(join(context.runRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.scratchDirectories[0].cleanupConfirmed, false);
  assert.equal(manifest.scratchDirectories[0].cleanupStatus, 'retained-unconfirmed');
});

test('scratch recovery verifies original native identity and requires a new explicit cleanup confirmation', async t => {
  const { context: first, base } = await fixture(t);
  const scratch = await first.createOwnedScratchDirectory('original-proof', { baseDirectory: base, requireCleanupConfirmation: true });
  await assert.rejects(first.finish('failed', { offline: true }), /retained/);
  const second = await RunContext.create(import.meta.url, { testId: 'scratch-resume-original' });
  t.after(async () => { if (!second.finished) await second.finish('failed', { offline: true }).catch(() => {}); });
  const held = scratch.path + '.held';
  await rename(scratch.path, held); await mkdir(scratch.path, { mode: 0o700 });
  await assert.rejects(second.resumeOwnedScratchDirectory(scratch), /identity changed/);
  await rm(scratch.path, { recursive: true }); await rename(held, scratch.path);
  const resumed = await second.resumeOwnedScratchDirectory(scratch);
  assert.equal(resumed.cleanupConfirmed, false);
  await second.confirmOwnedScratchCleanup(resumed);
  await second.finish('passed', { offline: true });
  await assert.rejects(access(scratch.path), { code: 'ENOENT' });
});
