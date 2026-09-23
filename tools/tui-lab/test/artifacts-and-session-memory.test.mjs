import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { maxConsecutiveBlankLines, normalizeShellComposerText } from '../lib/assertions.mjs';
import { capturedArtifactPath } from '../lib/browser-evidence.mjs';
import { captureFailurePageEvidence, writeFailureArtifact } from '../lib/failure-artifact.mjs';
import {
  extractTuiSessionId,
  makeSessionMemoryCompactRecentPayload,
  preservedEntriesForBoundary,
  writeSessionMemoryCompactSettings,
} from '../lib/session-memory-evidence.mjs';

test('extracts the complete current-format TUI session id', () => {
  assert.equal(
    extractTuiSessionId('Session:   000000000000000018c740deea128160-001e3c94-0000000000000000'),
    '000000000000000018c740deea128160-001e3c94-0000000000000000',
  );
});

test('normalizes assertion inputs without owning browser state', () => {
  assert.equal(maxConsecutiveBlankLines('one\n\n\nthree'), 2);
  assert.equal(normalizeShellComposerText(' cargo   test\n-p core '), 'cargotest-pcore');
});

test('reports optional screenshots only after capture created the file', () => {
  assert.equal(
    capturedArtifactPath('/run/after-tool-expanded.png', () => false),
    null,
  );
  assert.equal(
    capturedArtifactPath('/run/after-tool-expanded.png', () => true),
    '/run/after-tool-expanded.png',
  );
});

test('writes captured page evidence and cleanup facts in one terminal failure artifact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-failure-'));
  const artifact = (name) => path.join(dir, name);
  const artifacts = {
    failure: artifact('failure.json'),
    meta: artifact('meta.json'),
    failureScreenshot: artifact('failure.png'),
    text: artifact('screen.txt'),
    ptyLog: artifact('pty.log'),
    browserConsoleLog: artifact('browser.log'),
    runId: 'run-1',
    dateStamp: '2026-07-29',
    timeStamp: '12-00-00-000',
    description: 'failure',
    dir,
    workspace: artifact('workspace'),
    workspaceTemplate: artifact('template'),
    requestsDir: artifact('requests'),
    configHome: dir,
    configDir: artifact('kcoder'),
    projectKey: 'project',
    projectDir: artifact('project'),
  };
  const expected = new Error('boom');
  expected.assertions = { ok: false, failed: ['probe'] };
  expected.cleanup = { steps: [{ name: 'browser', status: 'completed' }], ptyExitObserved: true };
  await writeFailureArtifact({
    artifacts,
    runOptions: { message: 'prompt', scenario: 'full-turn' },
    command: 'kcoder',
    mode: 'single',
    session: {
      getPtyLog: () => 'pty output',
      getExitInfo: () => ({ exitCode: 1 }),
      getDiagnostics: () => [{ type: 'exit' }],
    },
    page: null,
    browserConsole: [],
    trace: [],
    error: expected,
    pageEvidence: {
      text: 'final screen',
      dimensions: { cols: 100, rows: 30 },
      hasScrollbar: true,
      inputEvents: ['wheel'],
      screenshot: Buffer.from('png evidence'),
      screenshotCaptured: true,
    },
    repoRoot: '/repo',
    now: new Date('2026-07-29T12:00:00.000Z'),
  });
  const failure = JSON.parse(await readFile(artifacts.failure, 'utf8'));
  assert.equal(failure.ok, false);
  assert.equal(failure.error.message, 'boom');
  assert.deepEqual(failure.assertions.failed, ['probe']);
  assert.equal(failure.text, artifacts.text);
  assert.equal(failure.failureScreenshot, artifacts.failureScreenshot);
  assert.deepEqual(failure.dimensions, { cols: 100, rows: 30 });
  assert.deepEqual(failure.inputEvents, [Buffer.from('wheel').toString('hex')]);
  assert.equal(failure.cleanup.ptyExitObserved, true);
  const meta = JSON.parse(await readFile(artifacts.meta, 'utf8'));
  assert.equal(meta.ok, false);
  assert.equal(meta.error.message, 'boom');
  assert.equal(await readFile(artifacts.ptyLog, 'utf8'), 'pty output');
  assert.equal(await readFile(artifacts.text, 'utf8'), 'final screen');
  assert.deepEqual(await readFile(artifacts.failureScreenshot), Buffer.from('png evidence'));
});

test('bounds never-settling page evidence so cleanup can continue', async () => {
  const started = Date.now();
  const evidence = await captureFailurePageEvidence({
    page: {
      evaluate: () => new Promise(() => {}),
      screenshot: () => new Promise(() => {}),
    },
    failureScreenshot: '/unused/failure.png',
    timeoutMs: 15,
  });
  assert.equal(evidence.screenshotCaptured, false);
  assert.equal(evidence.captureError.code, undefined);
  assert.match(evidence.captureError.message, /timed out/);
  assert.ok(Date.now() - started < 500);
});

test('owns session-memory settings and compact boundary selection', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tui-lab-memory-'));
  const artifacts = { dir };
  await writeSessionMemoryCompactSettings(artifacts, dir);
  const settings = JSON.parse(await readFile(path.join(dir, 'kcoder', 'settings.json'), 'utf8'));
  assert.equal(settings.session_memory.compact_enabled, true);
  assert.match(makeSessionMemoryCompactRecentPayload('RECENT'), /RECENT/);
  assert.deepEqual(
    preservedEntriesForBoundary([{ uuid: 'one' }, { uuid: 'boundary' }, { uuid: 'three' }], {
      compactMetadata: {
        preservedSegment: { headUuid: 'one', tailUuid: 'boundary' },
      },
    }),
    [{ uuid: 'one' }, { uuid: 'boundary' }],
  );
});
