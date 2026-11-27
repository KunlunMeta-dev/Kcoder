import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { applyStorageInstallation, chooseStorageFirstLaunch, parseStorageInstallationArguments as parse,
  runStorageFirstLaunch, shouldOfferStorageFirstLaunch } from './storage-installation.mjs';

const entry = '--prepare-windows-startup';

test('ordinary startup and the historic no-argument installer call remain distinct', () => {
  assert.equal(parse(['kcoder-studio.exe', '--updated']), null);
  assert.deepEqual(parse(['kcoder-studio.exe', entry]), { silent: false });
});

test('installation forwards explicit roots without inventing an omitted selection', () => {
  const dataRoot = 'D:\\中文 数据\\配置';
  const cacheRoot = 'E:\\KCoder Cache';
  assert.deepEqual(parse([entry, '--data-root', dataRoot, '--cache-root', cacheRoot, '--storage-install-silent']),
    { silent: true, dataRoot, cacheRoot });
  assert.deepEqual(parse([entry, '--cache-root', cacheRoot]), { silent: false, cacheRoot });
  assert.deepEqual(parse([entry, '--data-root', dataRoot]), { silent: false, dataRoot });
  assert.ok(Object.isFrozen(parse([entry])));
});

test('quoted Windows arguments retain drive roots and trailing directory separators', () => {
  assert.deepEqual(parse([entry, '--data-root', 'D:\\.', '--cache-root', 'E:\\Cache\\.']),
    { silent: false, dataRoot: 'D:\\', cacheRoot: 'E:\\Cache' });
});

test('malformed install intent fails before any coordinator or filesystem work', () => {
  for (const args of [
    ['--data-root'], ['--data-root', ''], ['--cache-root', 'relative'], ['--data-root', 'D:relative'],
    ['--data-root', '\\relative-to-drive'], ['--cache-root', 'E:\\line\nfeed'],
    ['--data-root', 'D:\\embedded"quote'], ['--data-root', 'D:\\nul\0byte'],
    ['--data-root', 'D:\\' + 'x'.repeat(32768)],
  ]) assert.throws(() => parse([entry, ...args]), { code: 'STORAGE_PATH_INVALID' });
  for (const args of [
    [entry], ['--unknown'], ['--storage-install-silent', '--storage-install-silent'],
    ['--data-root', 'D:\\one', '--data-root', 'D:\\two'], ['--all-users'],
  ]) assert.throws(() => parse([entry, ...args]), { code: 'STORAGE_INSTALL_ARGUMENT_INVALID' });
});

test('the dialog-only variant of the existing prepare entry cannot also request a silent root change', () => {
  assert.deepEqual(parse([entry, '--storage-first-launch-user-data', 'C:\\Owned\\Dialog']),
    { silent: false, firstLaunchUserData: 'C:\\Owned\\Dialog' });
  for (const extra of [['--storage-install-silent'], ['--data-root', 'D:\\Data'], ['--cache-root', 'E:\\Cache']]) {
    assert.throws(() => parse([entry, '--storage-first-launch-user-data', 'C:\\Owned\\Dialog', ...extra]),
      { code: 'STORAGE_INSTALL_ARGUMENT_INVALID' });
  }
});

async function ownedFirstLaunch(t) {
  const home = await mkdtemp(join(tmpdir(), 'owned-storage-first-launch-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const selected = { context: { home, platformConfig: join(home, 'Platform'), record: null, development: false },
    paths: { dataRoot: join(home, '.config', 'kcoder'), gatewayRoot: join(home, 'Platform', 'kcoder-studio'),
      desktopRoot: join(home, 'Platform', 'kcoder-studio'), cacheRoot: join(home, '.cache', 'kcoder'), externallyConfigured: false } };
  return { home, selected };
}

test('first-launch eligibility only observes known roots and never initializes them', async t => {
  const f = await ownedFirstLaunch(t);
  assert.equal(await shouldOfferStorageFirstLaunch(f.selected), true);
  assert.deepEqual(await readdir(f.home), []);
  await mkdir(f.selected.paths.dataRoot, { recursive: true });
  const control = join(f.selected.paths.dataRoot, 'kcoder-storage-writers.lock');
  await writeFile(control, '');
  assert.equal(await shouldOfferStorageFirstLaunch(f.selected), true);
  await writeFile(control, 'unknown nonempty control');
  assert.equal(await shouldOfferStorageFirstLaunch(f.selected), false);
});

test('legacy Native or client business data takes normal startup instead of the new-install dialog', async t => {
  for (const domain of ['dataRoot', 'gatewayRoot', 'desktopRoot']) {
    const f = await ownedFirstLaunch(t);
    await mkdir(f.selected.paths[domain], { recursive: true });
    await writeFile(join(f.selected.paths[domain], 'unknown-state'), 'retain this legacy business state');
    assert.equal(await shouldOfferStorageFirstLaunch(f.selected), false);
    assert.equal(await readFile(join(f.selected.paths[domain], 'unknown-state'), 'utf8'), 'retain this legacy business state');
  }
});

test('an orphan operation without current.json cannot be treated as a fresh installation', async t => {
  const { home, selected } = await ownedFirstLaunch(t);
  const archive = join(home, '.config', 'kcoder-storage-migrations', 'legacy-locations-v1');
  await mkdir(archive, { recursive: true });
  const receipt = join(archive, 'receipt.json');
  await writeFile(receipt, 'retain original unfinished operation');
  assert.equal(await shouldOfferStorageFirstLaunch(selected), false);
  assert.equal(await readFile(receipt, 'utf8'), 'retain original unfinished operation');
  for (const path of [selected.paths.dataRoot, join(home, '.config', 'kcoder-storage.json')])
    await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('a valid legacy registration remains an existing installation when its root is currently missing', async t => {
  const { home, selected } = await ownedFirstLaunch(t);
  assert.equal(await shouldOfferStorageFirstLaunch(selected, {
    readRegistered: async () => ['Z:\\offline-registered-profile'],
  }), false);
  assert.deepEqual(await readdir(home), [], 'missing registered data is not permission to create an empty replacement');
});

test('saved, external, development, pending and unknown states never gain first-install eligibility', async t => {
  const f = await ownedFirstLaunch(t);
  for (const selected of [{ ...f.selected, context: { ...f.selected.context, record: { revision: 1 } } },
    { ...f.selected, context: { ...f.selected.context, development: true } },
    { ...f.selected, paths: { ...f.selected.paths, externallyConfigured: true } }]) {
    assert.equal(await shouldOfferStorageFirstLaunch(selected, { readOperation() { assert.fail('isolated or saved roots need no probe'); } }), false);
  }
  for (const disposition of ['active', 'deferred', 'complete']) {
    assert.equal(await shouldOfferStorageFirstLaunch(f.selected, { readOperation: async () => ({ disposition }) }), false);
  }
  assert.equal(await shouldOfferStorageFirstLaunch(f.selected, { readOperation: async () => { throw new Error('unreadable control'); } }), false);
});

test('native folder dialogs preserve each independent field and cancelled picks', async t => {
  const f = await ownedFirstLaunch(t);
  const original = structuredClone(f.selected), calls = [];
  const dataRoot = join(f.home, '中文 Data'), cacheRoot = join(f.home, 'Other Cache');
  const responses = [1, 2, 2, 0], picks = [{ canceled: false, filePaths: [dataRoot] },
    { canceled: true, filePaths: [] }, { canceled: false, filePaths: [cacheRoot] }];
  const intent = await chooseStorageFirstLaunch({ selected: f.selected, locale: 'zh-CN', dialog: {
    async showMessageBox(options) { calls.push(options); return { response: responses.shift() }; },
    async showOpenDialog(options) { assert.deepEqual(options.properties, ['openDirectory', 'createDirectory']); return picks.shift(); },
  } });
  assert.deepEqual(intent, { silent: false, dataRoot, cacheRoot });
  assert.deepEqual(f.selected, original, 'UI selection alone must not publish or mutate resolved paths');
  assert(calls.at(-1).detail.includes(dataRoot) && calls.at(-1).detail.includes(cacheRoot));
  assert.deepEqual(await readdir(f.home), []);
});

test('first-launch UI can retain defaults or exit without choosing a new root', async t => {
  const f = await ownedFirstLaunch(t);
  for (const response of [0, 3]) {
    assert.deepEqual(await chooseStorageFirstLaunch({ selected: f.selected, dialog: {
      async showMessageBox() { return { response }; },
      showOpenDialog() { assert.fail('no folder change requested'); },
    } }), response === 3 ? null : { silent: false, dataRoot: f.selected.paths.dataRoot, cacheRoot: f.selected.paths.cacheRoot });
  }
});

test('invalid native-dialog paths never reach an installation or migration request', async t => {
  const f = await ownedFirstLaunch(t);
  await assert.rejects(chooseStorageFirstLaunch({ selected: f.selected, dialog: {
    async showMessageBox() { return { response: 1 }; },
    async showOpenDialog() { return { canceled: false, filePaths: ['relative'] }; },
  } }), { code: 'STORAGE_PATH_INVALID' });
});

for (const [mode, code] of [['complete', null], ['cancelled', null], ['runtime-diagnostics', null],
  ['malformed', 'STORAGE_INSTALL_DIALOG_INVALID'], ['duplicate-reply', 'STORAGE_INSTALL_DIALOG_INVALID'],
  ['failure', 'STORAGE_FIRST_LAUNCH_UNCONFIRMED']]) {
  test(`the owned dialog child settles ${mode} and cleans only its exited temporary profile`, async t => {
    const f = await ownedFirstLaunch(t);
    const observed = join(f.home, 'observation.json');
    const request = runStorageFirstLaunch({ program: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/storage-installation-dialog-child.mjs', import.meta.url))], cwd: f.home,
      env: { PATH: process.env.PATH, HOME: f.home, ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1',
        KCODER_STORAGE_DIALOG_FIXTURE_MODE: mode, KCODER_STORAGE_DIALOG_FIXTURE_OBSERVATION: observed } });
    if (code) await assert.rejects(request, { code });
    else assert.deepEqual(await request, { version: 1, state: mode === 'runtime-diagnostics' ? 'complete' : mode });
    const observation = JSON.parse(await readFile(observed, 'utf8'));
    assert.equal(observation.runAsNode, undefined);
    assert.equal(observation.runAsNodePresent, false);
    await assert.rejects(lstat(observation.directory), { code: 'ENOENT' });
    assert.throws(() => process.kill(observation.pid, 0), { code: 'ESRCH' });
  });
}

test('dialog cleanup preserves a replaced directory instead of deleting another owner', async t => {
  const f = await ownedFirstLaunch(t);
  const observed = join(f.home, 'replacement.json');
  await assert.rejects(runStorageFirstLaunch({ program: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/storage-installation-dialog-child.mjs', import.meta.url))], cwd: f.home,
    env: { PATH: process.env.PATH, HOME: f.home, KCODER_STORAGE_DIALOG_FIXTURE_MODE: 'replace-owner',
      KCODER_STORAGE_DIALOG_FIXTURE_OBSERVATION: observed } }), { code: 'STORAGE_INSTALL_DIALOG_OWNER_CHANGED' });
  const { directory } = JSON.parse(await readFile(observed, 'utf8'));
  t.after(async () => { await rm(directory, { recursive: true }); await rm(`${directory}-original`, { recursive: true }); });
  assert.equal(await readFile(join(directory, 'unrelated'), 'utf8'), 'must remain');
  assert.equal(await readFile(join(`${directory}-original`, 'owned-dialog-state'), 'utf8'), 'only this chooser owns this state');
});

test('failed dialog startup retains exit facts and only known identity reasons', async t => {
  const f = await ownedFirstLaunch(t);
  for (const mode of ['failure', 'identity-failure', 'unrecognized-failure']) {
    await assert.rejects(runStorageFirstLaunch({ program: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/storage-installation-dialog-child.mjs', import.meta.url))], cwd: f.home,
      env: { PATH: process.env.PATH, HOME: f.home, KCODER_STORAGE_DIALOG_FIXTURE_MODE: mode,
        KCODER_STORAGE_DIALOG_FIXTURE_OBSERVATION: join(f.home, `${mode}.json`) } }), error => {
      assert.equal(error.code, 'STORAGE_FIRST_LAUNCH_UNCONFIRMED');
      assert.equal(error.childExitCode, 1);
      assert.equal(error.childKilled, false);
      assert.equal(error.childStdoutBytes, 0);
      assert.ok(error.childStderrBytes > 0);
      assert.equal(error.childStartupCode, mode === 'identity-failure' ? 'WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE' : undefined);
      assert.equal(error.childStartupReason, mode === 'identity-failure' ? 'execution_failed' : undefined);
      assert.doesNotMatch(JSON.stringify(error), /private|fixture|owned-storage|Command failed/);
      assert.equal(error.cause, undefined);
      assert.equal(error.stderr, undefined);
      return true;
    });
  }
});

test('Windows dialog reads the real parent pipe despite Electron synthetic stdin EOF', { timeout: 5000 }, async t => {
  const f = { home: await mkdtemp(join(tmpdir(), 'owned-storage-parent-pipe-')) };
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/storage-installation-dialog-child.mjs', import.meta.url)),
    entry, '--storage-first-launch-user-data', f.home], { cwd: f.home, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: f.home, KCODER_STORAGE_DIALOG_FIXTURE_MODE: 'parent-pipe',
      KCODER_STORAGE_DIALOG_FIXTURE_OBSERVATION: join(f.home, 'pipe-observation.json') } });
  const closed = once(child, 'close');
  t.after(async () => {
    try { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; }
    finally { await rm(f.home, { recursive: true, force: true }); }
  });
  const [ready] = await once(child.stdout, 'data');
  assert.equal(ready.toString(), 'parent-pipe-ready\n');
  await delay(50);
  assert.equal(child.exitCode, null, 'synthetic EOF cannot cancel a live parent');
  child.stdin.end();
  assert.deepEqual(await closed, [2, null], 'actual parent pipe EOF still cancels the dialog child');
});

const selectedStorage = { context: { development: false }, paths: { dataRoot: resolve('/owned/data'), cacheRoot: resolve('/owned/cache'), externallyConfigured: false } };

for (const silent of [false, true]) test(`fresh ${silent ? 'silent' : 'interactive'} installation directly selects the requested roots once`, async t => {
  const { home, selected } = await ownedFirstLaunch(t);
  const dataRoot = join(home, 'Chosen Data');
  const calls = [];
  const result = await applyStorageInstallation({ intent: { silent, dataRoot }, initialSelection: selected,
    loadSelected() { assert.fail('fresh selection must not first commit default roots'); },
    confirm() { assert.fail('empty first installation has no migration to confirm'); },
    createClient: received => {
      assert.equal(received, selected);
      return { async initialize(roots) { calls.push(roots); return { version: 1, revision: 1, ...roots }; },
        preview() { assert.fail('fresh selection must not create an operation'); } };
    } });
  assert.deepEqual(calls, [{ dataRoot, cacheRoot: selected.paths.cacheRoot }]);
  assert.deepEqual(result, { version: 1, revision: 1, dataRoot, cacheRoot: selected.paths.cacheRoot });
});

test('an unconfirmed first-installation result never falls through to migration or replays initialization', async t => {
  const { home, selected } = await ownedFirstLaunch(t);
  let calls = 0;
  await assert.rejects(applyStorageInstallation({ intent: { silent: false, dataRoot: join(home, 'chosen') }, initialSelection: selected,
    loadSelected() { assert.fail('an unknown initialization result is not permission to migrate'); },
    createClient: () => ({ async initialize(roots) { calls++; return { version: 1, revision: 2, ...roots }; } }),
  }), { code: 'STORAGE_INSTALL_RESULT_UNCONFIRMED' });
  assert.equal(calls, 1);
});

test('installation without root arguments does not load or modify a personal selection', async () => {
  assert.equal(await applyStorageInstallation({ intent: { silent: true }, loadSelected() { assert.fail('not requested'); } }), null);
});

test('interactive installation binds preview and execute to one ID, preserving the omitted root', async () => {
  const calls = [], plan = { operationId: 'installer-owned', from: {}, target: {} };
  const result = { phase: 'verified', disposition: 'complete', plan };
  const actual = await applyStorageInstallation({ intent: { silent: false, dataRoot: resolve('/owned/other-data') },
    loadSelected: async () => selectedStorage, operationId: () => 'installer-owned',
    createClient: () => ({ async status() { return null; }, async preview(input) {
      calls.push('preview');
      assert.deepEqual(input, { operationId: 'installer-owned', launchIntent: 'verifyOnly', dataRoot: resolve('/owned/other-data'), cacheRoot: resolve('/owned/cache') });
      return plan;
    }, async execute(value) { assert.equal(value, plan); calls.push('execute'); return result; } }),
    confirm: async value => { assert.equal(value, plan); calls.push('confirm'); return true; } });
  assert.equal(actual, result);
  assert.deepEqual(calls, ['preview', 'confirm', 'execute']);
});

test('installer-selected roots migrate an existing legacy profile directly instead of through startup defaults', async t => {
  const { home, selected } = await ownedFirstLaunch(t);
  const legacy = { ...selected, context: { ...selected.context, overrides: {} },
    paths: { ...selected.paths, layout: 'legacy', selectionRevision: null,
      cacheRoot: join(selected.paths.dataRoot, 'tmp') } };
  const planned = { ...legacy, paths: { ...legacy.paths, cacheRoot: join(home, '.cache', 'kcoder') } };
  const data = join(home, 'Chosen Data');
  await mkdir(legacy.paths.gatewayRoot, { recursive: true });
  await writeFile(join(legacy.paths.gatewayRoot, 'servers.json'), 'existing legacy Gateway state');
  const calls = [];
  const plan = { operationId: 'installer-legacy-to-chosen', from: legacy.paths,
    target: { dataRoot: data, cacheRoot: planned.paths.cacheRoot } };
  const result = { phase: 'verified', disposition: 'complete', plan };
  await applyStorageInstallation({ intent: { silent: false, dataRoot: data },
    operationId: () => plan.operationId,
    loadSelected: async () => {
      calls.push('load-legacy');
      assert.equal(planned.context, legacy.context, 'legacy target projection retains the selected context');
      assert.equal(legacy.paths.cacheRoot, join(legacy.paths.dataRoot, 'tmp'), 'legacy cache remains at its source');
      return planned;
    },
    createClient: selected => ({ async status() { return null; }, async preview(input) {
      calls.push(`preview:${selected.paths.layout}`);
      assert.deepEqual(input, { operationId: plan.operationId, launchIntent: 'verifyOnly', dataRoot: data,
        cacheRoot: planned.paths.cacheRoot }, 'omitted cache uses the projected new-layout default');
      return plan;
    }, async execute(received) { assert.equal(received, plan); calls.push('execute'); return result; } }),
    confirm: async received => { assert.equal(received, plan); calls.push('confirm'); return true; } });

  assert.deepEqual(calls, ['load-legacy', 'preview:legacy', 'confirm', 'execute']);
});

test('cancelled or unchanged installation never executes a move', async () => {
  for (const plan of [null, { operationId: 'cancelled-install' }]) {
    const result = await applyStorageInstallation({ intent: { silent: false, cacheRoot: resolve('/owned/new-cache') },
      loadSelected: async () => selectedStorage,
      createClient: () => ({ status: async () => null, preview: async () => plan, execute() { assert.fail('must preserve the current choice'); } }),
      confirm: async () => false });
    assert.deepEqual(result, plan ? { operationId: plan.operationId, state: 'cancelled' } : null);
  }
});

test('unattended root arguments cannot confirm a migration or wait for a hidden dialog', async () => {
  const plan = { operationId: 'silent-owned' };
  await assert.rejects(applyStorageInstallation({ intent: { silent: true, cacheRoot: resolve('/owned/new-cache') },
    loadSelected: async () => selectedStorage,
    createClient: () => ({ status: async () => null, preview: async () => plan, execute() { assert.fail('a plan still needs confirmation'); } }),
    confirm() { assert.fail('silent installation must not wait for an invisible dialog'); } }),
  { code: 'STORAGE_INSTALL_CONFIRMATION_REQUIRED' });
});

test('unconfirmed installation result is reported without a fallback or another operation', async () => {
  let executions = 0;
  await assert.rejects(applyStorageInstallation({ intent: { silent: false, dataRoot: resolve('/owned/new') },
    loadSelected: async () => selectedStorage,
    confirm: async () => true,
    createClient: () => ({ status: async () => null, preview: async () => ({ operationId: 'original-install' }),
      execute: async () => { executions++; return { phase: 'committed', disposition: 'active', plan: { operationId: 'original-install' } }; } }) }),
  { code: 'STORAGE_INSTALL_RESULT_UNCONFIRMED' });
  assert.equal(executions, 1);
});

test('matching installer roots do not report an active original operation as complete', async () => {
  for (const phase of ['stopping', 'copying', 'committed', 'verified']) {
    const receipt = { phase, disposition: 'active', plan: { operationId: 'original-unknown-install' } };
    let reads = 0;
    await assert.rejects(applyStorageInstallation({ intent: { silent: true, dataRoot: selectedStorage.paths.dataRoot,
      cacheRoot: selectedStorage.paths.cacheRoot }, loadSelected: async () => selectedStorage,
      operationId() { assert.fail('an unresolved original operation cannot acquire a new ID'); },
      createClient: () => ({ async status() { reads++; return receipt; },
        preview() { assert.fail('equal paths are not proof of original verification'); },
        execute() { assert.fail('unknown operation must not be replayed'); } }),
      confirm() { assert.fail('a second confirmation cannot settle the original result'); } }),
    { code: 'STORAGE_INSTALL_RESULT_UNCONFIRMED' });
    assert.equal(reads, 1);
    assert.equal(receipt.disposition, 'active');
  }
});

test('matching roots remain a no-op after the original operation has completed', async () => {
  const calls = [];
  assert.equal(await applyStorageInstallation({ intent: { silent: true, dataRoot: selectedStorage.paths.dataRoot },
    loadSelected: async () => selectedStorage,
    createClient: () => ({ async status() { calls.push('status');
      return { phase: 'verified', disposition: 'complete', plan: { operationId: 'original-complete' } }; },
    async preview() { calls.push('preview'); return null; },
    execute() { assert.fail('completed operation cannot be replayed'); } }) }), null);
  assert.deepEqual(calls, ['status', 'preview', 'status']);
});

test('a matching-root preview cannot hide an operation committed during installer preparation', async () => {
  let reads = 0;
  await assert.rejects(applyStorageInstallation({ intent: { silent: true, dataRoot: selectedStorage.paths.dataRoot },
    loadSelected: async () => selectedStorage,
    createClient: () => ({ async status() { return ++reads === 1 ? null
      : { phase: 'committed', disposition: 'active', plan: { operationId: 'concurrent-original' } }; },
    preview: async () => null,
    execute() { assert.fail('a lost receipt cannot authorize another execution'); } }) }),
  { code: 'STORAGE_INSTALL_RESULT_UNCONFIRMED' });
  assert.equal(reads, 2);
});

test('Windows fresh and existing installation reject deep Desktop paths before initialization or preview',
  { skip: process.platform !== 'win32' }, async t => {
    const { home, selected } = await ownedFirstLaunch(t);
    const dataRoot = join(home, 'deep'.repeat(50));
    for (const fresh of [true, false]) {
      const calls = [];
      await assert.rejects(applyStorageInstallation({ intent: { dataRoot, silent: false },
        initialSelection: fresh ? selected : undefined, loadSelected: async () => selected,
        createClient: () => ({ status: async () => null, initialize: async () => calls.push('initialize'),
          preview: async () => calls.push('preview') }), confirm: async () => { calls.push('confirm'); return true; },
      }), { code: 'STORAGE_BROWSER_PROFILE_PATH_TOO_LONG' });
      assert.deepEqual(calls, []);
      await assert.rejects(lstat(dataRoot), { code: 'ENOENT' });
    }
    assert.deepEqual(await readdir(home), []);
  });
