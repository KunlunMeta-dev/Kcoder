import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import { AppServerStdioClient } from './app-server-stdio.mjs';
import { bindHostProbeStdio, runHostProbeLifecycle, runHostProbe } from './windows-keyring-host-probe.mjs';
import { runWindowsPrivateCredentialLifecycle, runWindowsPrivateCredentialRpcCase } from './windows-private-credential-rpc.mjs';
import { windowsPrivateNativeOwner } from './windows-private-credential-native.mjs';

const worker = fileURLToPath(new URL('../fixtures/credential-stdio-worker.mjs', import.meta.url));
const settled = promise => promise.then(value => ({ value }), error => ({ error }));
function privateError(secret, code = 'ERR_ASSERTION') {
  return Object.assign(new Error(secret), { code, actual: secret, expected: secret, cause: new Error(secret), stdout: secret });
}
function secretAbsent(value, secret) {
  assert.equal(inspect(value, { depth: 10, showHidden: true }).includes(secret), false, 'private error surface must be sanitized');
  assert.equal(JSON.stringify(value).includes(secret), false, 'private JSON surface must be sanitized');
}
async function treeText(path) {
  let text = '';
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const leaf = join(path, entry.name);
    if (entry.isDirectory()) text += await treeText(leaf);
    else if (entry.isFile()) text += await readFile(leaf, 'utf8');
  }
  return text;
}
async function ownedFixture(t, mode = 'normal') {
  const context = await RunContext.create(import.meta.url, { testId: 'credential-node-faults', retainSuccessLogs: true });
  const secret = randomBytes(32).toString('hex'); context.registerSecret(secret);
  const escaped = [...secret].map(value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  context.registerSecret(escaped);
  const child = context.spawnOwned('credential-json-worker', process.execPath, [worker], {
    stdin: 'pipe', cwd: context.stateDir,
    env: { KCODER_CREDENTIAL_FIXTURE_VALUE: secret, KCODER_CREDENTIAL_FIXTURE_MODE: mode },
  });
  t.after(async () => {
    if (!context.finished) await context.finish('passed', { modelIndependent: true, nativeAcceptance: false });
    const retained = await treeText(context.runRoot);
    assert.equal(retained.includes(secret) || retained.includes(escaped), false, 'owned artifacts and stream logs must contain no private fixture value');
  });
  return { context, secret, child };
}

test('actual owned Node JSONL worker closes normally and settles a host RPC', async t => {
  const { child, secret } = await ownedFixture(t);
  const actual = bindHostProbeStdio(child, [secret], { timeoutMs: 2000 });
  const frame = await actual.client.request('initialize');
  assert.equal(frame.result.capabilities.experimental.migrationCredentialsV1, true);
  assert.deepEqual(await actual.stop(), { closed: true, code: 0, signal: null });
  assert.equal(actual.client.pending.size, 0);
});

for (const mode of ['stdout-secret', 'stdout-secret-escaped', 'stderr-secret']) test(`actual host readline/stream ${mode} failure rejects waiters without throwing from listeners`, async t => {
  const { child, secret } = await ownedFixture(t, mode);
  const actual = bindHostProbeStdio(child, [secret], { timeoutMs: 2000 });
  const pending = settled(actual.client.request('initialize'));
  const notification = settled(actual.client.waitForNotification(() => true, 2000));
  const id = await actual.client.sendWithoutWaitingForResponse('migration/read');
  const discarded = settled(actual.client.waitForDiscardedResponse(id, 2000));
  for (const result of await Promise.all([pending, notification, discarded])) {
    assert.equal(Boolean(result.error), true, 'every outstanding waiter must reject');
    secretAbsent(result.error, secret);
  }
  assert.equal(actual.client.pending.size, 0);
  assert.equal(actual.client.notificationWaiters.size, 0);
  assert.equal(actual.client.discardWaiters.size, 0);
  assert.equal(actual.client.unmatched.size, 0, 'private frames must never enter the retained response map');
  const stop = await settled(actual.stop());
  assert.equal(Boolean(stop.error), true);
  assert.equal(stop.error.closeConfirmed, true);
  secretAbsent(stop.error, secret);
  assert.equal(child.exitCode === 0, true, 'the owned worker must still reach EOF and close');
});

test('an actual readline callback validation exception is sanitized and cannot escape its event listener', async t => {
  const { child, secret } = await ownedFixture(t);
  t.mock.method(AppServerStdioClient.prototype, 'onLine', () => { throw privateError(secret); });
  const actual = bindHostProbeStdio(child, [secret], { timeoutMs: 2000 });
  const result = await settled(actual.client.request('initialize'));
  assert.equal(Boolean(result.error), true);
  assert.equal(result.error.code === 'HOST_PROTOCOL_ERROR', true);
  secretAbsent(result.error, secret);
  const close = await settled(actual.stop());
  assert.equal(Boolean(close.error), true); secretAbsent(close.error, secret);
});

test('an owned stdin stream error settles pending host requests and preserves a confirmed worker close', async t => {
  const { child, secret } = await ownedFixture(t, 'stall');
  const actual = bindHostProbeStdio(child, [secret], { timeoutMs: 2000 });
  const pending = settled(actual.client.request('initialize'));
  child.stdin.destroy(privateError(secret, 'EPIPE'));
  const result = await pending;
  assert.equal(result.error?.code === 'HOST_STDIN_ERROR', true); secretAbsent(result.error, secret);
  const stop = await settled(actual.stop());
  assert.equal(Boolean(stop.error), true); secretAbsent(stop.error, secret);
  assert.equal(child.exitCode === 0, true);
});

test('write callback and stream error reentry settle one host request once without retaining raw errors', async t => {
  const { child, secret } = await ownedFixture(t, 'stall');
  t.mock.method(child.stdin, 'write', (_bytes, callback) => {
    callback(privateError(secret, 'EPIPE'));
    callback(privateError(secret, 'EPIPE'));
    child.stdin.emit('error', privateError(secret, 'EPIPE'));
    return false;
  });
  const actual = bindHostProbeStdio(child, [secret], { timeoutMs: 2000 });
  let settledCount = 0;
  const result = await actual.client.request('initialize').then(value => { settledCount++; return { value }; }, error => { settledCount++; return { error }; });
  assert.equal(settledCount, 1); secretAbsent(result.error, secret);
  assert.equal(actual.client.pending.size, 0);
  const stop = await settled(actual.stop());
  assert.equal(stop.error?.errors?.length === 1, true, 'reentrant notifications retain one failure category');
  assert.equal(stop.error.closeConfirmed, true);
});

test('an uncooperative real worker reports unknown close and remains owned until its exact run cleanup', async t => {
  const { child, secret, context } = await ownedFixture(t, 'hold-after-eof');
  const actual = bindHostProbeStdio(child, [secret], { timeoutMs: 1000 });
  await actual.client.request('initialize');
  const stop = await settled(actual.stop());
  assert.equal(stop.error?.closeConfirmed, false);
  assert.equal(stop.error?.message === 'host_process_close_unconfirmed', true);
  secretAbsent(stop.error, secret);
  await context.stopOwned('credential-json-worker');
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
});

test('an actual worker failure closes pending host RPCs and is retained as a cleanup category', async t => {
  const { child, secret } = await ownedFixture(t, 'exit-failure');
  const actual = bindHostProbeStdio(child, [secret], { timeoutMs: 2000 });
  const pending = await settled(actual.client.request('initialize'));
  assert.equal(Boolean(pending.error), true); secretAbsent(pending.error, secret);
  const stop = await settled(actual.stop());
  assert.equal(stop.error?.errors?.some(error => error.code === 'HOST_PROCESS_EXIT_ERROR'), true);
  secretAbsent(stop.error, secret);
});

test('host primary plus independent stop failure contain only safe categories and no raw assertion fields', async () => {
  const secret = randomBytes(32).toString('hex');
  const result = await settled(runHostProbeLifecycle(async () => { throw privateError(secret); }, async () => { throw privateError(secret, 'EPIPE'); }));
  assert.equal(result.error instanceof AggregateError, true);
  assert.equal(result.error.errors[0].code === 'HOST_PROBE_ASSERTION', true);
  assert.equal(result.error.errors[1].code === 'HOST_PROCESS_CLOSE_UNCONFIRMED', true);
  assert.equal(result.error.closeConfirmed, false);
  secretAbsent(result.error, secret);
  assert.equal(await runHostProbeLifecycle(async () => 'public-receipt', async () => {}), 'public-receipt');
});

test('private diagnostic EEXIST preserves old evidence, primary and every synchronous/asynchronous cleanup failure', async t => {
  const { child, secret, context } = await ownedFixture(t);
  const transport = bindHostProbeStdio(child, [secret], { timeoutMs: 2000 });
  await transport.client.request('initialize');
  const diagnostic = context.pathInState('private-diagnostic.json');
  await writeFile(diagnostic, 'original-evidence', { flag: 'wx' });
  const attempted = [];
  const result = await settled(runWindowsPrivateCredentialLifecycle({
    phase: () => 'private_prepare', exercise: async () => { throw privateError(secret); },
    diagnostic: value => writeFile(diagnostic, JSON.stringify(value), { flag: 'wx' }),
    cleanup: () => [
      () => { attempted.push('sync'); throw privateError(secret, 'EACCES'); },
      async () => { attempted.push('async'); throw privateError(secret, 'ENOENT'); },
      async () => { attempted.push('worker'); await transport.stop(); },
    ],
  }));
  assert.equal(result.error instanceof AggregateError, true);
  assert.deepEqual(result.error.errors.map(error => error.failureStage), ['primary', 'diagnostic', 'cleanup', 'cleanup']);
  assert.deepEqual(result.error.errors.map(error => error.errorCode), ['ERR_ASSERTION', 'unclassified', 'EACCES', 'ENOENT']);
  assert.deepEqual(attempted, ['sync', 'async', 'worker']);
  assert.equal(await readFile(diagnostic, 'utf8'), 'original-evidence');
  secretAbsent(result.error, secret);
  await context.writeArtifactJson('safe-private-lifecycle-result.json', { failureStages: result.error.errors.map(error => error.failureStage) });
  assert.equal(child.exitCode === 0, true);
});

test('private lifecycle writes only safe diagnostic classifications and settles successful cleanup before returning', async t => {
  const { child, secret, context } = await ownedFixture(t);
  const transport = bindHostProbeStdio(child, [secret], { timeoutMs: 2000 });
  await transport.client.request('initialize');
  const diagnostic = context.pathInState('private-diagnostic.json');
  const result = await settled(runWindowsPrivateCredentialLifecycle({
    phase: () => 'ordinary_apply', exercise: async () => { throw privateError(secret, 'EACCES'); },
    diagnostic: value => writeFile(diagnostic, JSON.stringify(value), { flag: 'wx' }),
    cleanup: () => [() => transport.stop()],
  }));
  assert.equal(result.error?.failureStage === 'primary', true); secretAbsent(result.error, secret);
  assert.deepEqual(JSON.parse(await readFile(diagnostic, 'utf8')), { phase: 'ordinary_apply', errorCode: 'EACCES', nativeRpcCode: null });
  assert.equal(await runWindowsPrivateCredentialLifecycle({ phase: () => 'setup', exercise: async () => 'public-receipt',
    diagnostic: () => assert.fail('successful cases do not write diagnostics'), cleanup: () => [] }), 'public-receipt');
});

for (const mode of ['normal', 'stdout-secret', 'stdout-secret-escaped', 'stderr-secret']) test(`actual private native owner ${mode} uses guarded JSONL and closes only its owned child`, async t => {
  const { context, child, secret } = await ownedFixture(t, mode);
  const actual = windowsPrivateNativeOwner({ root: context.stateDir, binary: process.execPath, environment: {}, values: [secret],
    spawnChild: () => child });
  const start = await settled(actual.start('owned-private-fixture', context.stateDir, context.stateDir));
  if (mode === 'normal') {
    assert.equal(Boolean(start.value), true);
    assert.equal((await start.value.rpc('migration/read')).publicReceipt, true);
    await start.value.stop();
  } else {
    assert.equal(Boolean(start.error), true); secretAbsent(start.error, secret);
    const close = await settled(actual.close());
    assert.equal(Boolean(close.error), true); secretAbsent(close.error, secret);
  }
  assert.equal(actual.processes.length, 1);
  assert.equal(actual.processes[0].closed, true);
  assert.equal(actual.processes[0].exitCode === 0, true);
});

test('Windows entry points retain the real platform guard before any fixture or credential access', async () => {
  if (process.platform === 'win32') return;
  const host = await settled(runHostProbe({ phase: 'write', root: '/never-read', owner: 'invalid', handoff: '/never-read' }));
  const rpc = await settled(runWindowsPrivateCredentialRpcCase({ root: '/never-read', owner: 'invalid' }));
  assert.equal(host.error?.code === 'ERR_ASSERTION', true);
  assert.equal(rpc.error?.code === 'ERR_ASSERTION', true);
});
