import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { RunContext, waitFor } from './run-context.mjs';
import { assertStorageGroupObserved, assertStorageGroupOwned, createStorageNativeInput, observeDesktopStorageHandoff, pauseStorageVerifier, quitStorageDesktop, storageProcessStat, startStorageCliProbe, waitForStorageNativeWindow } from './desktop-storage-operation.mjs';

const receipt = { pid: 123, group: 123, session: 123, started: '1000' };
const member = { pid: 124, group: 123, session: 123, started: '1001', uid: 1000, home: '/owned/home' };
test('original handoff and its restarted child share an owned process group', () => {
  assert.doesNotThrow(() => assertStorageGroupOwned(receipt, [member], '/owned/home', 1000));
  assert.doesNotThrow(() => assertStorageGroupOwned(receipt, [], '/owned/home', 1000));
});
test('cleanup rejects peers, reused leaders and unconfirmed group members', () => {
  for (const patch of [{ home: '/peer/home' }, { uid: 1001 }, { group: 321 }, { session: 321 },
    { started: '999' }, { pid: receipt.pid, started: '1001' }, { home: undefined }]) {
    assert.throws(() => assertStorageGroupOwned(receipt, [{ ...member, ...patch }], '/owned/home', 1000));
  }
});
test('Linux process identities preserve spaces and parentheses in command names', () => {
  const values = ['S', '10', '123', '123', ...Array(15).fill('0'), '1000'];
  assert.deepEqual(storageProcessStat(123, `123 (owned (worker)) ${values.join(' ')}`),
    { pid: 123, state: 'S', parent: 10, group: 123, session: 123, started: '1000' });
});

test('verifier observation refuses a direct CLI parent already exited after its lease release', { skip: process.platform !== 'linux' }, async () => {
  const parent = { pid: process.pid, isRunning: () => false, exitCode: null, signalCode: null };
  await assert.rejects(pauseStorageVerifier({}, { parent, cli: '/owned/kcoder', home: '/owned/home', operationId: 'owned-operation' }),
    /STORAGE_PROBE_PARENT_EXITED_BEFORE_VERIFIER/);
});

test('an exiting observed process without HOME never becomes signal authority', () => {
  const exiting = { ...member, home: undefined };
  assert.doesNotThrow(() => assertStorageGroupObserved(receipt, [exiting], 1000));
  assert.throws(() => assertStorageGroupOwned(receipt, [exiting], '/owned/home', 1000));
  assert.throws(() => assertStorageGroupObserved(receipt, [{ ...exiting, started: '999' }], 1000));
});

test('native window lookup observes a later title without replaying native actions', async () => {
  let calls = 0;
  const found = await waitForStorageNativeWindow(async args => {
    assert.deepEqual(args, ['search', '--onlyvisible', '--name', '^Configuration and data folder$']);
    if (++calls === 1) throw Object.assign(new Error('no matching window'), { nativeWindowNotFound: true });
    return '701';
  }, '^Configuration and data folder$');
  assert.equal(found, '701');
  assert.equal(calls, 2);
});

for (const [mode, error] of [['input timeout', new Error('original input timeout')],
  ['query exit 1 with diagnostics', new assert.AssertionError({ actual: 1, expected: 0, operator: 'strictEqual' })],
  ['query exit 2', new assert.AssertionError({ actual: 2, expected: 0, operator: 'strictEqual' })]]) {
  test(`native window lookup preserves ${mode} as its failure cause`, async () => {
    let calls = 0;
    await assert.rejects(waitForStorageNativeWindow(async () => { calls++; throw error; }, '^owned$'), value => value.cause === error);
    assert.equal(calls, 1);
  });
}

for (const diagnostic of ['', 'Cannot open display']) {
  test(`native search exit 1 ${diagnostic ? 'with diagnostics stays a failure' : 'with empty stderr means not-found'}`, async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
    const context = { isolatedEnvironment: value => value, spawnOwned: () => {
      setImmediate(() => {
        child.exitCode = 1;
        setTimeout(() => { child.stderr.end(diagnostic); child.emit('close', 1); }, diagnostic ? 75 : 0);
      });
      return child;
    } };
    const input = createStorageNativeInput(context, { display: { display: ':owned', authority: '/owned/auth' }, xdotool: '/owned/xdotool', label: 'lookup' });
    await assert.rejects(input(['search', '--onlyvisible', '--name', '^owned$']), error => error.nativeWindowNotFound === !diagnostic);
  });
}

test('native Quit cleanup uses cleanup-owned input despite the aborted test signal', async () => {
  const aborted = new AbortController();
  const child = Object.assign(new EventEmitter(), { exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
  let cleanupSpawns = 0;
  const context = { finishing: false, abortSignal: aborted.signal,
    isolatedEnvironment(value) { assert.equal(this.finishing, false); return value; },
    spawnOwned: () => assert.fail('cleanup cannot create an active-run process'),
    spawnCleanupOwned: () => {
      cleanupSpawns++;
      setImmediate(() => { child.exitCode = 0; child.emit('close', 0); });
      return child;
    } };
  const input = createStorageNativeInput(context, { display: { display: ':owned', authority: '/owned/auth' }, xdotool: '/owned/xdotool', label: 'cleanup' });
  context.finishing = true; aborted.abort(new Error('original failure'));
  await input(['key', '--clearmodifiers', 'ctrl+q']);
  assert.equal(cleanupSpawns, 1);
});

for (const mode of ['quit', 'window-missing', 'unknown-input', 'quit-timeout', 'peer-home', 'strict-stop']) {
  test(`handoff cleanup ${mode} preserves original window and signal authority`, { skip: process.platform !== 'linux' }, async () => {
    const home = '/owned/home', calls = [], uid = process.getuid();
    let current = [
      { ...receipt, uid, home },
      { ...member, uid, home },
      ...(mode === 'strict-stop' ? [] : [{ ...member, pid: 125, uid, home: mode === 'peer-home' ? '/peer/home' : undefined }]),
    ];
    const nativeInput = async args => {
      calls.push(args);
      if (args[0] === 'search') {
        if (args.at(-1) === '123' || mode === 'window-missing')
          throw Object.assign(new Error('no matching window'), { nativeWindowNotFound: true });
        assert.equal(args.at(-1), '124', 'only the confirmed HOME main may receive input');
        return '701';
      }
      if (args[0] === 'getwindowname') return 'KCoder Studio';
      if (args[0] === 'key') {
        if (mode === 'unknown-input') throw new Error('native input outcome unknown');
        if (mode !== 'quit-timeout') current = [];
      }
      return '';
    };
    const observer = await observeDesktopStorageHandoff({ pathInState: () => '/owned/receipt.json', addCleanup: () => {} }, {
      evaluateMain: async () => true, cli: '/owned/kcoder', home, hostPid: 10,
      ...(mode === 'strict-stop' ? {} : { nativeInput }),
    }, {
      read: async path => path.startsWith('/proc/')
        ? `10 (electron) ${['S', '1', '10', '10', ...Array(15).fill('0'), '900'].join(' ')}`
        : JSON.stringify({ ...receipt, parent: 10 }),
      groupMembers: async () => current,
      signal: async (_child, identity, signal) => {
        calls.push(['signal', identity, signal]); current = [];
      },
      wait: async predicate => assert.equal(await predicate(), true),
    });
    if (['quit', 'strict-stop'].includes(mode)) await observer.stop();
    else {
      await assert.rejects(observer.stop(), /never signal a peer or unconfirmed storage process/);
      if (['unknown-input', 'quit-timeout'].includes(mode)) await assert.rejects(observer.stop());
    }
    assert.equal(calls.filter(args => args[0] === 'key').length, ['quit', 'unknown-input', 'quit-timeout'].includes(mode) ? 1 : 0);
    assert.equal(calls.filter(args => args[0] === 'signal').length, mode === 'strict-stop' ? 1 : 0);
    if (mode === 'peer-home') assert.equal(calls.length, 0);
  });
}

test('normal storage Quit owns the main window while only observing a utility child without HOME', { skip: process.platform !== 'linux' }, async () => {
  const calls = [], child = { pid: 123, exitCode: null, signalCode: null };
  const values = ['S', '10', '123', '123', ...Array(15).fill('0'), '1000'];
  const observation = {
    nativeInput: async args => {
      calls.push(args[0]);
      if (args[0] === 'search') return '701';
      if (args[0] === 'getwindowname') return 'KCoder Studio';
      if (args[0] === 'key') child.exitCode = 0;
      return '';
    },
    close: () => calls.push('inspector-close'),
  };
  const result = await quitStorageDesktop({}, { desktop: { child, stop: async () => calls.push('cdp-stop') },
    observation, home: '/owned/home', label: 'seed' }, {
    read: async () => `123 (electron) ${values.join(' ')}`,
    members: async (_group, options) => options ? [] : [
      { ...member, pid: receipt.pid, started: receipt.started, uid: process.getuid() },
      { ...member, uid: process.getuid(), home: undefined },
    ],
    wait: async predicate => { calls.push('wait'); assert.equal(await predicate(), true); },
  });
  assert.equal(result.remaining, 0);
  assert.deepEqual(calls, ['search', 'getwindowname', 'windowfocus', 'key', 'inspector-close', 'wait', 'cdp-stop']);
});

test('storage Quit refuses to address a window when a process group contains a peer Home', { skip: process.platform !== 'linux' }, async () => {
  const values = ['S', '10', '123', '123', ...Array(15).fill('0'), '1000'];
  await assert.rejects(quitStorageDesktop({}, {
    desktop: { child: { pid: 123 } }, home: '/owned/home', label: 'foreign',
    observation: { nativeInput: async () => assert.fail('never input into an unowned host') },
  }, { read: async () => `123 (electron) ${values.join(' ')}`,
    members: async () => [
      { ...member, pid: receipt.pid, started: receipt.started, uid: process.getuid() },
      { ...member, uid: process.getuid(), home: '/peer/home' },
    ],
  }), /never signal a peer or unconfirmed storage process/);
});

for (const [mode, main] of [
  ['missing', null],
  ['without HOME', { home: undefined }],
  ['with a peer HOME', { home: '/peer/home' }],
]) {
  test(`storage Quit refuses an original main ${mode}`, { skip: process.platform !== 'linux' }, async () => {
    const values = ['S', '10', '123', '123', ...Array(15).fill('0'), '1000'];
    await assert.rejects(quitStorageDesktop({}, {
      desktop: { child: { pid: receipt.pid } }, home: '/owned/home', label: 'unconfirmed-main',
      observation: { nativeInput: async () => assert.fail('never input into an unconfirmed main') },
    }, { read: async () => `123 (electron) ${values.join(' ')}`,
      members: async () => [
        ...(main ? [{ ...member, pid: receipt.pid, started: receipt.started, uid: process.getuid(), ...main }] : []),
        { ...member, uid: process.getuid(), home: undefined },
      ],
    }));
  });
}

for (const mode of ['ready', 'not-ready']) {
  test(`owned CLI probe ${mode} retains its original pipe and process cleanup`, { skip: process.platform !== 'linux' }, async () => {
    const context = await RunContext.create(import.meta.url, { testId: 'storage-cli-probe-ownership', variantId: mode });
    let failure, pid;
    try {
      const home = context.pathInState('home'), program = context.pathInState('original-worker.mjs');
      await mkdir(home, { recursive: true, mode: 0o700 });
      await copyFile(new URL('../../desktop/fixtures/storage-operation-client-child.mjs', import.meta.url), program);
      await chmod(program, 0o700);
      const pidFile = join(home, 'child.pid');
      const probe = startStorageCliProbe(context, { label: 'probe', cli: program,
        args: ['--internal-storage-operation-v1', 'handoff'], input: { operationId: 'owned-probe' }, home,
        env: context.isolatedEnvironment({ HOME: home, USERPROFILE: home, KCODER_STORAGE_TEST_MODE: mode,
          KCODER_STORAGE_TEST_PID_FILE: pidFile, KCODER_STORAGE_TEST_EXIT_FILE: join(home, 'child.exit') }) });
      pid = await waitFor(async () => {
        try { return Number(await readFile(pidFile, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      }, 3000, 'original owned probe starts');
      assert.equal(probe.child.pid, pid);
      if (mode === 'ready') {
        assert.deepEqual(await waitFor(() => probe.first(), 3000, 'original ready frame'), { state: 'ready', operationId: 'owned-probe' });
        assert.equal((await probe.finish(3000)).exitCode, 0);
      } else {
        await assert.rejects(probe.finish(50), /Timed out/);
        assert.equal(probe.first(), null);
      }
    } catch (error) { failure = error; }
    await context.finish(failure ? 'failed' : 'passed', { mode }, failure);
    if (failure) throw failure;
    assert.equal(context.processes.get('probe').stopped, true);
    await assert.rejects(stat(context.stateDir), { code: 'ENOENT' });
    await assert.rejects(stat(`/proc/${pid}`), { code: 'ENOENT' });
  });
}
