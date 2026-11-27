import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { loadStorageBusinessContext, prepareStorageBusinessStartup } from './storage-startup.mjs';

const home = await mkdtemp(join(tmpdir(), 'kcoder-business-startup-'));
after(() => rm(home, { recursive: true, force: true }));
const selected = (layout = 'legacy', { development = false, ...paths } = {}) => ({
  context: { home, development, overrides: {}, record: null },
  paths: { layout, selectionRevision: null, operationId: null, externallyConfigured: false,
    dataRoot: join(home, 'profile'), cacheRoot: join(home, 'profile', 'tmp'),
    gatewayRoot: join(home, 'client'), desktopRoot: join(home, 'client'), ...paths },
});

test('settled unified and explicit instances never launch a migration worker', async () => {
  for (const [value, receipt] of [[selected('unified'), undefined],
    [selected('custom', { externallyConfigured: true }), { disposition: 'active' }],
    [selected('development', { development: true, externallyConfigured: true }), { disposition: 'active' }]]) {
    assert.equal(await prepareStorageBusinessStartup({ selected: value,
      readOperation: async () => receipt, createClient() { assert.fail('must not create a worker'); },
      load() { assert.fail('must not reload a settled instance'); } }), value);
  }
});

test('a Unified deferred operation keeps its original selected roots without another migration', async () => {
  const value = selected('unified');
  const receipt = { disposition: 'deferred', plan: { from: value.paths } };
  assert.equal(await prepareStorageBusinessStartup({ selected: value,
    readOperation: async () => receipt, createClient() { assert.fail('Unified Deferred must keep its exact selected roots'); },
  }), value);
});

test('legacy startup reloads committed paths only after the original one-shot completes', async () => {
  const original = selected(), committed = selected('unified'), calls = [], options = {};
  assert.equal(await prepareStorageBusinessStartup({ selected: original, loadOptions: options,
    readOperation: async () => undefined, createClient: async value => {
      assert.equal(value, original);
      return { async startup() { calls.push('worker'); return { phase: 'verified', disposition: 'complete' }; } };
    }, load: async value => { assert.equal(value, options); calls.push('reload'); return committed; } }), committed);
  assert.deepEqual(calls, ['worker', 'reload']);
});

test('unsettled original operations use the worker rather than the business instance', async () => {
  let called = 0;
  const value = selected('unified');
  await prepareStorageBusinessStartup({ selected: value, readOperation: async () => ({ disposition: 'active' }),
    createClient: () => ({ async startup() { called++; return { phase: 'verified', disposition: 'complete' }; } }),
    load: async () => value });
  assert.equal(called, 1);
});

test('failed or unconfirmed startup cannot fall back to the old selection', async () => {
  for (const reply of [new Error('original worker failed'), undefined,
    { phase: 'committed', disposition: 'active' }, { phase: 'verified', disposition: 'deferred' }]) {
    await assert.rejects(prepareStorageBusinessStartup({ selected: selected(), readOperation: async () => undefined,
      createClient: () => ({ async startup() { if (reply instanceof Error) throw reply; return reply; } }),
      load() { assert.fail('must not reload or open business after an unconfirmed worker'); } }),
    reply instanceof Error ? error => error === reply : { code: 'STORAGE_STARTUP_UNCONFIRMED' });
  }
});

test('a late startup receipt for another Deferred operation is rejected before reload', async () => {
  const current = { disposition: 'deferred', plan: { operationId: 'installer-operation-a',
    original: null, from: { ...selected().paths, layout: 'legacy' } } };
  const late = { ...current, plan: { ...current.plan, operationId: 'installer-operation-b' } };
  let reloads = 0;
  await assert.rejects(prepareStorageBusinessStartup({ selected: selected(),
    readOperation: async () => current,
    createClient: () => ({ async startup() { return late; } }),
    load: async () => { reloads++; return selected(); },
  }), { code: 'STORAGE_SELECTION_CHANGED' });
  assert.equal(reloads, 0);
});

test('initial loader access denial is returned without starting a worker', async () => {
  const denied = Object.assign(new Error('record unavailable'), { code: 'STORAGE_RECORD_UNAVAILABLE',
    cause: Object.assign(new Error('permission denied'), { code: 'EACCES' }) });
  const options = {}, value = selected('unified');
  let loads = 0;
  await assert.rejects(loadStorageBusinessContext({ loadOptions: options,
    load: async received => {
      assert.equal(received, options);
      loads++;
      throw denied;
    },
    createClient() { assert.fail('an access error must not trigger storage startup or permission repair'); },
  }), error => error === denied);
  assert.equal(loads, 1);
});

test('storage read failures preserve their error and never launch a recovery worker', async () => {
  const failures = [
    Object.assign(new Error('read failed'), { code: 'STORAGE_RECORD_UNAVAILABLE',
      cause: Object.assign(new Error('I/O error'), { code: 'EIO' }) }),
    Object.assign(new Error('damaged record'), { code: 'STORAGE_RECORD_INVALID' }),
  ];
  for (const failure of failures) {
    let workers = 0;
    await assert.rejects(loadStorageBusinessContext({ load: async () => { throw failure; },
      createClient() { workers++; assert.fail('storage read failures must not launch a worker'); } }),
    error => error === failure);
    await assert.rejects(prepareStorageBusinessStartup({ selected: selected('unified'),
      readOperation: async () => { throw failure; },
      createClient() { workers++; assert.fail('storage read failures must not launch a worker'); } }),
    error => error === failure);
    assert.equal(workers, 0);
  }
});

test('permission errors preserve the original error without a retry', async () => {
  const denied = Object.assign(new Error('record unavailable'), { code: 'STORAGE_RECORD_UNAVAILABLE',
    cause: Object.assign(new Error('permission denied'), { code: 'EPERM' }) });
  let loads = 0;
  await assert.rejects(loadStorageBusinessContext({ load: async () => { loads++; throw denied; },
    createClient() { assert.fail('an access error must not trigger storage startup or permission repair'); } }),
  error => error === denied);
  assert.equal(loads, 1);
});

test('a null startup reply cannot admit an unchanged legacy selection without a deferred receipt', async () => {
  let workers = 0;
  await assert.rejects(prepareStorageBusinessStartup({ selected: selected(),
    readOperation: async () => undefined, load: async () => selected(),
    createClient: () => ({ async startup() { workers++; return null; } }),
  }), { code: 'STORAGE_STARTUP_UNCONFIRMED' });
  assert.equal(workers, 1);
});
