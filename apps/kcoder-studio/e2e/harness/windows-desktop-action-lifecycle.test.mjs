import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { awaitOwnedDesktopActor } from './windows-desktop-action-entry.cjs';
import { runE2E, waitFor } from './run-context.mjs';

function memoryChild({ destroy = () => {}, kill } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, stdin: { destroy }, kills: 0 });
  child.close = code => { child.exitCode = code; child.emit('close', code); };
  child.kill = () => {
    child.kills++;
    if (kill) return kill(child);
    child.close(1);
    return true;
  };
  return child;
}

function registerHeldChildFallback(context, child, label) {
  context.addCleanup(`drain original fixture handle ${label}`, async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Original fixture close remains unconfirmed')), 3000);
      })]);
    } finally { clearTimeout(timer); }
  });
}

test('a supervisor error does not certify close before its real close receipt', async () => {
  const child = memoryChild();
  const primary = new Error('Owned supervisor channel failure');
  let closeObserved = false;
  const pending = awaitOwnedDesktopActor(child, { readyPromise: Promise.resolve() }, { exitTimeoutMs: 100 });
  child.emit('error', primary);
  const timer = setTimeout(() => { closeObserved = true; child.close(1); }, 10);
  try {
    await assert.rejects(pending, error => error === primary);
    assert.equal(closeObserved, true, 'The original close receipt must settle cleanup');
    assert.equal(child.kills, 0);
  } finally { clearTimeout(timer); }
});

test('an error from a still-running supervisor revokes input and stops only that child', async () => {
  let revoked = 0;
  const child = memoryChild({ destroy: () => { revoked++; } });
  const primary = new Error('Owned supervisor error without close');
  const pending = awaitOwnedDesktopActor(child, { readyPromise: Promise.resolve() }, { exitTimeoutMs: 5 });
  child.emit('error', primary);
  await assert.rejects(pending, error => error === primary);
  assert.equal(revoked, 1);
  assert.equal(child.kills, 1, 'An error alone must not skip exact child termination');
  assert.equal(child.exitCode, 1);
});

test('lease revocation failure retains the primary error and still stops its child', async () => {
  const primary = new Error('Original desktop READY failure');
  const revocation = new Error('Owned lease stream destroy failed');
  const child = memoryChild({ destroy: () => { throw revocation; } });
  await assert.rejects(awaitOwnedDesktopActor(child, { readyPromise: Promise.reject(primary) }, { exitTimeoutMs: 5 }), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /cleanup failed/);
    assert.ok(error.errors.includes(primary));
    assert.ok(error.errors.includes(revocation));
    return true;
  });
  assert.equal(child.kills, 1);
  assert.equal(child.exitCode, 1);
});

test('a kill failure retains primary and cleanup failures instead of reporting closed', async () => {
  const primary = new Error('Original owned actor failure');
  const termination = new Error('Exact child termination failed');
  const child = memoryChild({ kill: () => { throw termination; } });
  await assert.rejects(awaitOwnedDesktopActor(child, { readyPromise: Promise.reject(primary) }, { exitTimeoutMs: 5 }), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /cleanup unconfirmed/);
    assert.ok(error.errors.includes(primary));
    assert.ok(error.errors.includes(termination));
    assert.ok(error.errors.some(value => /exit unconfirmed/.test(value.message)));
    return true;
  });
  assert.equal(child.exitCode, null);
  assert.equal(child.kills, 1);
});

test('normal close after READY preserves the exit code', async () => {
  const child = memoryChild();
  const pending = awaitOwnedDesktopActor(child, { readyPromise: Promise.resolve() }, { exitTimeoutMs: 50 });
  await Promise.resolve();
  await Promise.resolve();
  child.close(0);
  assert.equal(await pending, 0);
  assert.equal(child.kills, 0);
});

test('close before READY remains a failure with a confirmed terminal receipt', async () => {
  const child = memoryChild();
  const pending = awaitOwnedDesktopActor(child, { readyPromise: new Promise(() => {}) }, { exitTimeoutMs: 50 });
  child.close(1);
  await assert.rejects(pending, /exited before READY/);
  assert.equal(child.kills, 0);
});

test('model-independent actual child error waits for termination and preserves the peer', {
  timeout: 15000, skip: process.platform === 'win32' ? 'POSIX Node fixture; real Windows Job acceptance remains separate' : false,
}, async () => {
  await runE2E(import.meta.url, { testId: 'owned-desktop-error-is-not-exit', tier: 'harness-unit',
    modelPolicy: 'Actual owned Node processes only; no Windows Job, desktop action, scheduled task or model.' }, async context => {
    const fixture = fileURLToPath(new URL('./fixtures/owned-desktop-supervisor.mjs', import.meta.url));
    const child = context.spawnOwned('errored-supervisor', process.execPath, [fixture], { stdin: 'pipe', env: context.isolatedEnvironment() });
    const peer = context.spawnOwned('independent-supervisor-peer', process.execPath, [fixture], { stdin: 'pipe', env: context.isolatedEnvironment() });
    registerHeldChildFallback(context, child, 'errored-supervisor');
    registerHeldChildFallback(context, peer, 'independent-supervisor-peer');
    let childOutput = '', peerOutput = '';
    child.stdout.on('data', bytes => { childOutput += bytes; });
    peer.stdout.on('data', bytes => { peerOutput += bytes; });
    await waitFor(() => childOutput.includes('OWNED_DESKTOP_SUPERVISOR_READY') && peerOutput.includes('OWNED_DESKTOP_SUPERVISOR_READY'), 10000, 'owned supervisor readiness');
    const primary = new Error('Injected nonterminal ChildProcess error');
    const pending = awaitOwnedDesktopActor(child, { readyPromise: Promise.resolve() }, { exitTimeoutMs: 100 });
    child.emit('error', primary);
    await assert.rejects(pending, error => error === primary);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'The errored original child must actually exit');
    assert.equal(peer.exitCode, null);
    assert.equal(peer.signalCode, null);
    await context.writeArtifactJson('lifecycle-outcome.json', { originalErrorPreserved: true, originalExited: true,
      peerStillAlive: true, nativeWindowsAcceptance: false });
    return { originalExited: true, peerStillAlive: true, windowsJobAcceptance: false };
  });
});

test('RunContext stops an existing owned process after a nonterminal child error', {
  timeout: 15000, skip: process.platform === 'win32' ? 'POSIX Node fixture; real Windows Job acceptance remains separate' : false,
}, async () => {
  await runE2E(import.meta.url, { testId: 'run-context-error-after-spawn', tier: 'harness-unit',
    modelPolicy: 'Actual owned Node fixture only; validates harness cleanup, without desktop or model actions.' }, async context => {
    const fixture = fileURLToPath(new URL('./fixtures/owned-desktop-supervisor.mjs', import.meta.url));
    const child = context.spawnOwned('post-spawn-error', process.execPath, [fixture], { stdin: 'pipe', env: context.isolatedEnvironment() });
    registerHeldChildFallback(context, child, 'post-spawn-error');
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    await waitFor(() => output.includes('OWNED_DESKTOP_SUPERVISOR_READY'), 10000, 'original fixture readiness');
    child.emit('error', new Error('Injected error after successful spawn'));
    await context.stopOwned('post-spawn-error');
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'An error must not skip stopping an already owned process');
    return { originalPid: child.pid, actualExitConfirmed: true, windowsJobAcceptance: false };
  });
});

test('RunContext handles an actual spawn failure without inventing a process identity', {
  timeout: 15000, skip: process.platform === 'win32' ? 'POSIX direct spawn fixture' : false,
}, async () => {
  await runE2E(import.meta.url, { testId: 'run-context-spawn-no-pid', tier: 'harness-unit',
    modelPolicy: 'A missing executable inside this run state; no model or native platform action.' }, async context => {
    const child = context.spawnOwned('never-started', context.pathInState('missing-executable'), [], { env: context.isolatedEnvironment() });
    const failure = await new Promise(resolve => child.once('error', resolve));
    assert.equal(failure.code, 'ENOENT');
    assert.equal(child.pid, undefined);
    await context.stopOwned('never-started');
    return { spawnFailure: 'ENOENT', processIdentityCreated: false };
  });
});
