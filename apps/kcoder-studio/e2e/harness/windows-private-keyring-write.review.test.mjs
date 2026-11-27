import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import { runPrivateKeyringWrite, runPrivateKeyringWriteLifecycle } from './windows-private-keyring-write.mjs';

// These tests exercise the real write lifecycle with filesystem faults, never a mock keyring.
const settled = promise => promise.then(value => ({ value }), error => ({ error }));
function privateError(secret, code = 'ERR_ASSERTION') {
  return Object.assign(new Error(secret), { code, actual: secret, expected: secret,
    stdout: secret, cause: new Error(secret), nativeRpcCode: -32047 });
}
function safeSurface(value, secret) {
  assert.equal(inspect(value, { showHidden: true, depth: 10 }).includes(secret), false, 'private error properties must not escape');
  assert.equal(JSON.stringify(value).includes(secret), false, 'private structured fields must not escape');
}
async function treeText(path) {
  let value = '';
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) value += await treeText(child);
    else if (entry.isFile()) value += await readFile(child, 'utf8');
  }
  return value;
}
async function ownedState(t) {
  const context = await RunContext.create(import.meta.url, { testId: 'private-keyring-write-node-faults', retainSuccessLogs: true });
  const secret = randomBytes(32).toString('hex'); context.registerSecret(secret);
  t.after(async () => {
    if (!context.finished) await context.finish('passed', { modelIndependent: true, keyringAcceptance: false });
    assert.equal((await treeText(context.runRoot)).includes(secret), false, 'retained artifacts must not contain the fixture value');
  });
  return { context, secret };
}

test('actual keyring write lifecycle returns only after ordered asynchronous cleanup completes', async () => {
  const order = [];
  const result = await runPrivateKeyringWriteLifecycle({
    phase: () => 'setup', exercise: async () => { order.push('body'); return 'public-receipt'; },
    diagnostic: () => assert.fail('a successful write must not create a failure diagnostic'),
    cleanup: () => [
      async () => { order.push('new-owner-start'); await new Promise(resolve => setImmediate(resolve)); order.push('new-owner-closed'); },
      () => { order.push('older-owner-closed'); },
    ],
  });
  assert.equal(result, 'public-receipt');
  assert.deepEqual(order, ['body', 'new-owner-start', 'new-owner-closed', 'older-owner-closed']);
});

test('real diagnostic EEXIST preserves original bytes and primary plus diagnostic plus all ordered cleanup failures', async t => {
  const { context, secret } = await ownedState(t);
  const path = context.pathInState('private-diagnostic.json');
  await writeFile(path, 'original-retained-evidence', { flag: 'wx', mode: 0o600 });
  const order = [];
  const result = await settled(runPrivateKeyringWriteLifecycle({
    phase: () => 'private_prepare', exercise: async () => { throw privateError(secret); },
    diagnostic: value => writeFile(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 }),
    cleanup: () => [
      () => { order.push('sync-failed'); throw privateError(secret, 'EACCES'); },
      async () => { order.push('async-start'); await new Promise(resolve => setImmediate(resolve)); order.push('async-failed'); throw privateError(secret, 'ENOENT'); },
      () => { order.push('last-owner-closed'); },
    ],
  }));
  assert.equal(result.error instanceof AggregateError, true);
  assert.deepEqual(result.error.errors.map(error => error.failureStage), ['primary', 'diagnostic', 'cleanup', 'cleanup']);
  assert.deepEqual(result.error.errors.map(error => error.errorCode), ['ERR_ASSERTION', 'unclassified', 'EACCES', 'ENOENT']);
  assert.deepEqual(order, ['sync-failed', 'async-start', 'async-failed', 'last-owner-closed']);
  assert.equal(await readFile(path, 'utf8'), 'original-retained-evidence');
  safeSurface(result.error, secret);
  await context.writeArtifactJson('safe-keyring-failure-stages.json', { stages: result.error.errors.map(error => error.failureStage) });
});

test('a successful exclusive diagnostic retains only safe phase and error classifications', async t => {
  const { context, secret } = await ownedState(t);
  const path = context.pathInState('private-diagnostic.json');
  let closed = false;
  const result = await settled(runPrivateKeyringWriteLifecycle({
    phase: () => 'ordinary_apply', exercise: async () => { throw privateError(secret, 'EACCES'); },
    diagnostic: value => writeFile(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 }),
    cleanup: () => [() => { closed = true; }],
  }));
  assert.equal(result.error?.failureStage === 'primary', true);
  assert.equal(result.error?.errorCode === 'EACCES', true);
  assert.equal(closed, true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { phase: 'ordinary_apply', errorCode: 'EACCES', nativeRpcCode: -32047 });
  safeSurface(result.error, secret);
});

test('real missing diagnostic directory keeps the primary and still closes subsequent owners', async t => {
  const { context, secret } = await ownedState(t);
  let closed = 0;
  const result = await settled(runPrivateKeyringWriteLifecycle({
    phase: () => 'private_receive', exercise: async () => { throw privateError(secret); },
    diagnostic: value => writeFile(context.pathInState('missing', 'private-diagnostic.json'), JSON.stringify(value), { flag: 'wx', mode: 0o600 }),
    cleanup: () => [() => { closed++; }, () => { closed++; }],
  }));
  assert.equal(result.error instanceof AggregateError, true);
  assert.deepEqual(result.error.errors.map(error => error.failureStage), ['primary', 'diagnostic']);
  assert.deepEqual(result.error.errors.map(error => error.errorCode), ['ERR_ASSERTION', 'ENOENT']);
  assert.equal(closed, 2);
  safeSurface(result.error, secret);
});

test('cleanup-only failure cannot turn a completed write into success or retain raw assertion data', async () => {
  const secret = randomBytes(32).toString('hex');
  let lastOwnerClosed = false;
  const result = await settled(runPrivateKeyringWriteLifecycle({
    phase: () => 'ordinary_apply', exercise: async () => 'public-receipt', diagnostic: () => assert.fail(),
    cleanup: () => [() => { throw privateError(secret); }, () => { lastOwnerClosed = true; }],
  }));
  assert.equal(result.error?.failureStage === 'cleanup', true);
  assert.equal(lastOwnerClosed, true);
  safeSurface(result.error, secret);
});

test('arbitrary phase/code/messages in nested primary and diagnostic errors never reach retained classifications', async () => {
  const secret = randomBytes(32).toString('hex');
  let diagnostic;
  const result = await settled(runPrivateKeyringWriteLifecycle({
    phase: () => secret,
    exercise: async () => { throw new AggregateError([privateError(secret, secret)], secret, { cause: privateError(secret) }); },
    diagnostic: value => { diagnostic = value; throw privateError(secret, secret); }, cleanup: () => [],
  }));
  assert.deepEqual(diagnostic, { phase: 'unknown', errorCode: 'unclassified', nativeRpcCode: null });
  assert.deepEqual(result.error.errors.map(error => error.failureStage), ['primary', 'diagnostic']);
  safeSurface(result.error, secret); safeSurface(diagnostic, secret);
});

test('the original keyring write entry retains its real Windows guard before any source or credential access', async () => {
  if (process.platform === 'win32') return;
  let auditCalled = false;
  const result = await settled(runPrivateKeyringWrite({ root: '/never-read', owner: 'invalid', audit: () => { auditCalled = true; } }));
  assert.equal(result.error?.code === 'ERR_ASSERTION', true);
  assert.equal(auditCalled, false);
});
