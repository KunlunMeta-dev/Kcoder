import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupOwnedBrowserSessions,
  runBrowserScenarioLifecycle,
  settleLifecycleStep,
} from '../lib/browser-lifecycle.mjs';

const completedCleanup = () => ({
  steps: [
    { name: 'browser', status: 'completed' },
    { name: 'session', status: 'completed' },
  ],
  ptyExitObserved: true,
});

test('cleans up once after a successful browser scenario', async () => {
  const events = [];
  const result = await runBrowserScenarioLifecycle({
    execute: async () => {
      events.push('execute');
      return 'done';
    },
    captureBeforeCleanup: async () => events.push('capture'),
    onFailure: async () => events.push('failure'),
    cleanup: async () => {
      events.push('cleanup');
      return completedCleanup();
    },
    onSuccess: async (value) => {
      events.push('success');
      return value;
    },
  });
  assert.equal(result, 'done');
  assert.deepEqual(events, ['execute', 'capture', 'cleanup', 'success']);
});

test('captures failure before cleanup, writes it once after cleanup, and rethrows the original error', async () => {
  const events = [];
  const expected = new Error('scenario failed');
  await assert.rejects(
    runBrowserScenarioLifecycle({
      execute: async () => {
        events.push('execute');
        throw expected;
      },
      captureBeforeCleanup: async () => {
        events.push('capture');
        return { text: 'last screen' };
      },
      onFailure: async (error, evidence) => events.push(`failure:${error.message}:${evidence.text}`),
      cleanup: async () => {
        events.push('cleanup');
        return completedCleanup();
      },
    }),
    (error) => error === expected,
  );
  assert.deepEqual(events, ['execute', 'capture', 'cleanup', 'failure:scenario failed:last screen']);
  assert.equal(expected.cleanup.ptyExitObserved, true);
});

test('invokes the terminal failure writer exactly once', async () => {
  let writes = 0;
  await assert.rejects(
    runBrowserScenarioLifecycle({
      execute: async () => {
        throw new Error('failed');
      },
      captureBeforeCleanup: async () => ({ text: 'captured' }),
      cleanup: async () => completedCleanup(),
      onFailure: async (error, evidence) => {
        writes += 1;
        assert.equal(error.cleanup.ptyExitObserved, true);
        assert.equal(evidence.text, 'captured');
      },
    }),
    /failed/,
  );
  assert.equal(writes, 1);
});

test('refuses success when browser cleanup rejects or PTY exit is not observed', async () => {
  const failures = [];
  await assert.rejects(
    runBrowserScenarioLifecycle({
      execute: async () => 'ready',
      captureBeforeCleanup: async () => ({ text: 'before cleanup' }),
      cleanup: async () => ({
        steps: [
          { name: 'browser', status: 'rejected', error: new Error('close failed') },
          { name: 'session', status: 'completed' },
        ],
        ptyExitObserved: false,
      }),
      onFailure: async (error, evidence) => failures.push(`${error.message}:${evidence.text}`),
      onSuccess: async () => assert.fail('success must not be committed'),
    }),
    /browser:rejected, pty-exit:not-observed/,
  );
  assert.deepEqual(failures, ['browser scenario cleanup incomplete: browser:rejected, pty-exit:not-observed:before cleanup']);
});

test('refuses success on cleanup timeout and invokes cleanup only once', async () => {
  let cleanups = 0;
  await assert.rejects(
    runBrowserScenarioLifecycle({
      execute: async () => 'ready',
      cleanup: async () => {
        cleanups += 1;
        return {
          steps: [{ name: 'browser', status: 'timed_out' }],
          ptyExitObserved: true,
        };
      },
      onFailure: async () => {},
    }),
    /browser:timed_out/,
  );
  assert.equal(cleanups, 1);
});

test('distinguishes completed, rejected, and timed-out lifecycle steps', async () => {
  assert.deepEqual(await settleLifecycleStep('done', async () => 7, 20), {
    name: 'done',
    status: 'completed',
    value: 7,
  });
  const rejected = await settleLifecycleStep('bad', async () => {
    throw new Error('no');
  }, 20);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.error.message, 'no');
  const timedOut = await settleLifecycleStep('slow', () => new Promise(() => {}), 5);
  assert.deepEqual(timedOut, { name: 'slow', status: 'timed_out' });
});


test('resume cleanup failure retains private state and never commits success or closes peers', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const profile = await mkdtemp(join(tmpdir(), 'tui-resume-cleanup-'));
  const state = join(profile, 'owned-state');
  await writeFile(state, 'original');
  const stopped = [];
  let observed;
  let committed = false;
  const peer = { stop: () => assert.fail('peer must remain untouched') };
  try {
    await assert.rejects(runBrowserScenarioLifecycle({
      execute: async () => 'functional assertions passed',
      cleanup: () => cleanupOwnedBrowserSessions({
        browser: { close: async () => {} },
        sessions: [
          { stop: async () => stopped.push('first'), exitPromise: Promise.resolve({ exitCode: 0 }) },
          { stop: async () => { stopped.push('resumed'); throw new Error('owned stop rejected'); }, exitPromise: new Promise(() => {}) },
        ],
        timeoutMs: 20,
        exitTimeoutMs: 5,
      }),
      onFailure: async error => { observed = error.cleanup; },
      onSuccess: async () => { committed = true; await rm(profile, { recursive: true }); },
    }), /session-2:rejected.*pty-exit-2:timed_out/);
    assert.equal(committed, false);
    assert.deepEqual(stopped, ['first', 'resumed']);
    assert.equal(observed.ptyExitObserved, false);
    assert.equal(observed.profileRetained, true);
    assert.equal(observed.steps.find(step => step.name === 'session-2').error.message, 'owned stop rejected');
    assert.equal(JSON.stringify(observed).includes('owned stop rejected'), true);
    assert.equal(await readFile(state, 'utf8'), 'original');
    assert.ok(peer);
  } finally { await rm(profile, { recursive: true, force: true }); }
});

test('resume lifecycle commits success only after both original PTY exits and browser closure', async () => {
  const events = [];
  const result = await runBrowserScenarioLifecycle({
    execute: async () => 'passed',
    cleanup: () => cleanupOwnedBrowserSessions({
      browser: { close: async () => events.push('browser') },
      sessions: [1, 2].map(id => ({ stop: async () => events.push(`stop-${id}`), exitPromise: Promise.resolve({ exitCode: 0, id }) })),
    }),
    onFailure: async () => assert.fail('unexpected cleanup failure'),
    onSuccess: async (value, report) => {
      assert.equal(report.ptyExitObserved, true);
      assert.equal(report.ptyExits.length, 2);
      events.push('commit');
      return value;
    },
  });
  assert.equal(result, 'passed');
  assert.deepEqual(events, ['browser', 'stop-1', 'stop-2', 'commit']);
});
