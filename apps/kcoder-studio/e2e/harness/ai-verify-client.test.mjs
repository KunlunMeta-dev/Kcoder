import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RunContext } from './run-context.mjs';
import { assertOwnedControllerRequest, startOwnedAiVerify, stopOwnedAiVerifyController } from './ai-verify-client.mjs';

test('a stopped or signaled controller cannot receive credentials, including shutdown requests', () => {
  const live = { exitCode: null, signalCode: null };
  assert.doesNotThrow(() => assertOwnedControllerRequest(live, false, '/command'));
  assert.doesNotThrow(() => assertOwnedControllerRequest(live, true, '/shutdown'));
  assert.throws(() => assertOwnedControllerRequest(live, true, '/command'), /closed|stopping/);
  assert.throws(() => assertOwnedControllerRequest(live, true, '/status'), /closed|stopping/);
  for (const child of [
    { exitCode: 0, signalCode: null },
    { exitCode: 1, signalCode: null },
    { exitCode: null, signalCode: 'SIGTERM' },
    { exitCode: null, signalCode: 'SIGKILL' },
  ]) for (const path of ['/command', '/status', '/shutdown']) {
    assert.throws(() => assertOwnedControllerRequest(child, false, path), /closed/);
    assert.throws(() => assertOwnedControllerRequest(child, true, path), /closed/);
  }
});

test('failed Gateway startup is cleaned before the suite returns (no UI/runtime claim)', {
  skip: process.platform !== 'linux' ? 'Owned-display verification requires the Linux host' : false,
}, async t => {
  try { await Promise.all(['/usr/bin/Xvfb', '/usr/bin/git', '/usr/bin/false'].map(path => access(path))); }
  catch { t.skip('UNMET_PREREQUISITE: Xvfb, Git and the controlled failure executable are required'); return; }
  const context = await RunContext.create(import.meta.url, { testId: 'owned-electron-startup-failure' });
  let failure;
  context.addCleanup('verify the original nested startup run was finalized', async () => {
    const { runRoot } = JSON.parse(await readFile(resolve(context.artifactsDir, 'electron-run.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(resolve(runRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'failed');
    assert.ok(manifest.processes.some(process => process.label === 'electron-gateway' && process.command === 'node'));
    assert.ok(manifest.cleanupSteps.every(step => step.status === 'completed'));
    await assert.rejects(access(resolve(runRoot, 'state')));
  });
  try {
  const rendererRoot = context.pathInState('failure-renderer');
  await mkdir(rendererRoot);
  await writeFile(resolve(rendererRoot, 'index.html'), '<!doctype html><html><head><title>Startup failure fixture</title></head><body></body></html>');
  await assert.rejects(startOwnedAiVerify(context, {
    electronBin: '/usr/bin/false', kcoderBin: '/usr/bin/false', rendererRoot, timeoutMs: 10_000,
  }), /Electron|Verification|WebView/);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { expectedNativeStartupFailure: true }, failure); }
});

const pollImmediately = async callback => {
  const value = await callback();
  if (!value) throw new Error('Owned test receipt is not settled');
  return value;
};
test('shutdown transport failure still stops its owner and reconciles the original terminal receipt', async () => {
  const child = { exitCode: null, signalCode: null };
  let session = { status: 'running', controlUrl: 'http://127.0.0.1:12345' }, stopped = 0;
  const result = await stopOwnedAiVerifyController({
    run: { runRoot: 'owned-test-run' }, child,
    readSessionFile: async () => session,
    requestShutdown: async () => { throw new Error('Owned lost shutdown response'); },
    stopController: async () => { stopped++; child.exitCode = 0; session = { status: 'stopped' }; },
    finalizeUnpublished: async () => assert.fail('Published runs cannot be finalized by an empty context'),
    readResultFile: async () => ({ status: 'passed', cleanupErrors: [] }), stateExists: async () => false, poll: pollImmediately,
  });
  assert.equal(stopped, 1); assert.equal(result.cleaned, true); assert.equal(result.shutdownRequestUnconfirmed, true);
});
test('a dead published controller preserves unknown nested authority instead of claiming cleanup', async () => {
  let stopped = 0;
  await assert.rejects(stopOwnedAiVerifyController({
    run: { runRoot: 'owned-unknown-run' }, child: { exitCode: 1, signalCode: null },
    readSessionFile: async () => ({ status: 'running', controlUrl: 'http://127.0.0.1:12345' }),
    requestShutdown: async () => { throw new Error('Original controller closed'); },
    stopController: async () => { stopped++; },
    finalizeUnpublished: async () => assert.fail('Unknown published authority must be retained'),
    readResultFile: async () => assert.fail('Unknown nested cleanup has no terminal receipt'),
    stateExists: async () => true, poll: pollImmediately,
  }), error => error instanceof AggregateError && error.errors.some(item => item.message.includes('preserve the original run')));
  assert.equal(stopped, 1);
});
test('unpublished fallback is attempted only after the original controller is stopped', async () => {
  const child = { exitCode: null, signalCode: null };
  const initialSession = { version: 1, directory: 'owned-unpublished-run', gateway: {}, token: 'owned-token', status: 'starting' };
  let session = initialSession, stops = 0;
  const result = await stopOwnedAiVerifyController({
    run: { runRoot: 'owned-unpublished-run' }, child, initialSession, readSessionFile: async () => session,
    requestShutdown: async () => assert.fail('Unpublished controller has no request origin'),
    stopController: async () => { stops++; child.exitCode = 0; },
    finalizeUnpublished: async () => { assert.equal(stops, 1); session = { status: 'stopped', verificationError: 'startup failed' }; },
    readResultFile: async () => ({ status: 'failed', cleanupErrors: [] }), stateExists: async () => false, poll: pollImmediately,
  });
  assert.equal(result.cleaned, true); assert.equal(result.verificationFailed, true);
});

test('an incomplete post-stop session cannot authorize the empty unpublished fallback', async () => {
  const initialSession = { version: 1, directory: 'owned-incomplete-run', gateway: {}, token: 'owned-token', status: 'starting' };
  for (const current of [null, {}, [], { status: 'starting' }, { ...initialSession, directory: 'peer-run' },
    { ...initialSession, token: 'peer-token' }, { ...initialSession, controlUrl: null }]) {
    const child = { exitCode: null, signalCode: null };
    let stopped = false;
    await assert.rejects(stopOwnedAiVerifyController({
      run: { runRoot: initialSession.directory }, child, initialSession,
      readSessionFile: async () => stopped ? current : initialSession,
      requestShutdown: async () => assert.fail('The original session is unpublished'),
      stopController: async () => { stopped = true; child.exitCode = 1; },
      finalizeUnpublished: async () => assert.fail('Incomplete identity cannot authorize nested state deletion'),
      readResultFile: async () => assert.fail('Unknown cleanup cannot consume a result'),
      stateExists: async () => true, poll: pollImmediately,
    }), error => error instanceof AggregateError && error.errors.some(item => /identity is unconfirmed/.test(item.message)));
    assert.equal(stopped, true);
  }
});

test('a stopped session still requires a valid original cleanup result', async () => {
  for (const result of [null, {}, { status: 'passed' }, { status: 'running', cleanupErrors: [] },
    { status: 'passed', cleanupErrors: null }]) {
    let stops = 0;
    await assert.rejects(stopOwnedAiVerifyController({
      run: { runRoot: 'owned-terminal-run' }, child: { exitCode: 0, signalCode: null },
      readSessionFile: async () => ({ status: 'stopped' }),
      requestShutdown: async () => assert.fail('Terminal cleanup cannot be replayed'),
      stopController: async () => { stops++; },
      finalizeUnpublished: async () => assert.fail('Terminal cleanup cannot be recreated'),
      readResultFile: async () => result, stateExists: async () => false, poll: pollImmediately,
    }), error => error instanceof AggregateError && error.errors.some(item => /cleanup receipt is invalid/.test(item.message)));
    assert.equal(stops, 1);
  }
});

test('a state inspection error cannot be interpreted as confirmed absence', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'controller-state-inspection-failure' });
  let failure;
  try {
    const regularFile = await context.writeStateJson('not-a-directory', {});
    await assert.rejects(stopOwnedAiVerifyController({
      run: { runRoot: context.runRoot, stateDir: resolve(regularFile, 'child') },
      child: { exitCode: 0, signalCode: null },
      readSessionFile: async () => ({ status: 'stopped' }),
      requestShutdown: async () => assert.fail('The controller is already stopped'),
      stopController: async () => {},
      finalizeUnpublished: async () => assert.fail('State observation errors cannot authorize finalization'),
      readResultFile: async () => ({ status: 'passed', cleanupErrors: [] }), poll: pollImmediately,
    }), error => error instanceof AggregateError && error.errors.some(item => item.code === 'ENOTDIR'));
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { modelIndependent: true }, failure); }
});

test('a truncated on-disk session retains the original state and never manufactures a terminal receipt', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'controller-truncated-session' });
  let failure;
  try {
    const token = 'owned-truncated-session-token';
    context.registerSecret(token);
    const initialSession = { version: 1, directory: context.runRoot, gateway: {}, token, status: 'starting' };
    const sessionPath = resolve(context.runRoot, 'session.json');
    const intentPath = await context.writeStateJson('original-intent.json', { requestId: 'original-owned-request' });
    for (const damagedDocument of ['{"version":1,', 'null', '{}', '[]']) {
      const child = { exitCode: null, signalCode: null };
      await writeFile(sessionPath, JSON.stringify(initialSession), { mode: 0o600 });
      await assert.rejects(stopOwnedAiVerifyController({
        run: context, sessionPath, child, initialSession,
        requestShutdown: async () => assert.fail('The original document has no published origin'),
        stopController: async () => {
          child.exitCode = 1;
          await writeFile(sessionPath, damagedDocument, { mode: 0o600 });
        },
        finalizeUnpublished: async () => assert.fail('Damaged on-disk state cannot authorize empty-context cleanup'),
        poll: pollImmediately,
      }), error => error instanceof AggregateError && error.errors.some(item => /identity is unconfirmed/.test(item.message)));
      assert.equal(await readFile(sessionPath, 'utf8'), damagedDocument);
      assert.deepEqual(JSON.parse(await readFile(intentPath, 'utf8')), { requestId: 'original-owned-request' });
      await assert.rejects(access(resolve(context.artifactsDir, 'result.json')), { code: 'ENOENT' });
    }
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { modelIndependent: true }, failure); }
});

test('a dangling state symlink still counts as surviving owned state', {
  skip: process.platform !== 'linux' ? 'POSIX symlink fixture requires Linux' : false,
}, async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'controller-dangling-state-symlink' });
  let failure;
  try {
    const stateDir = context.pathInState('unresolved-state');
    await symlink('missing-owned-state', stateDir);
    await assert.rejects(stopOwnedAiVerifyController({
      run: { runRoot: context.runRoot, stateDir }, child: { exitCode: 0, signalCode: null },
      readSessionFile: async () => ({ status: 'stopped' }),
      requestShutdown: async () => assert.fail('The controller is already stopped'),
      stopController: async () => {},
      readResultFile: async () => ({ status: 'passed', cleanupErrors: [] }), poll: pollImmediately,
    }), error => error instanceof AggregateError && error.errors.some(item => /state survived cleanup/.test(item.message)));
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { modelIndependent: true }, failure); }
});
