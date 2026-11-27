import assert from 'node:assert/strict';
import { copyFile, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStorageOperationClient } from '../src/storage-operation-client.mjs';

const ENTRY = '--internal-storage-operation-v1';
const OWNER_RUNTIME_ENV = 'KCODER_STORAGE_OWNER_RUNTIME_V1';
const fixtureSource = new URL('./fixtures/storage-operation-client-child.mjs', import.meta.url);
const posixExecutable = { skip: process.platform === 'win32' && 'Direct shebang spawning is POSIX-only.' };

async function fixture(t, mode = 'ready') {
  const root = await mkdtemp(join(tmpdir(), 'owned-storage-operation-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const program = join(root, 'storage-operation-client-child.mjs');
  const pidFile = join(root, 'child.pid');
  const exitFile = join(root, 'child.exit');
  await copyFile(fixtureSource, program);
  await chmod(program, 0o755);
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
    KCODER_STORAGE_TEST_MODE: mode,
    KCODER_STORAGE_TEST_PID_FILE: pidFile,
    KCODER_STORAGE_TEST_EXIT_FILE: exitFile,
    KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE: join(root, 'owner-runtime.json'),
  };
  const ownerRuntime = { program: process.execPath, applicationRoot: root, runAsNode: true };
  return { root, program, pidFile, exitFile, env, ownerRuntime,
    client: createStorageOperationClient({ program, cwd: root, env, ownerRuntime }) };
}

async function waitForExitFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  assert.fail(`owned child did not write its exit receipt within ${timeoutMs}ms`);
}

async function waitForPidExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(20);
  }
  assert.fail(`owned child ${pid} remained alive after its exit receipt`);
}

test('paths, status, and preview use the one-shot CLI protocol in an isolated home', posixExecutable, async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.paths(), { layout: 'unified', cacheRoot: f.root });
  assert.equal(await readFile(f.env.KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE, 'utf8'), 'absent');
  assert.equal(await f.client.status(), null);
  assert.equal(await readFile(f.env.KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE, 'utf8'), 'absent');
  const request = { operationId: 'owned-operation-1', dataRoot: join(f.root, 'data'),
    cacheRoot: join(f.root, 'cache'), launchIntent: 'desktop' };
  assert.deepEqual(await f.client.preview(request), request);
  assert.deepEqual(JSON.parse(await readFile(f.env.KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE, 'utf8')), f.ownerRuntime);
});

test('business startup uses the same local worker and fixed owner runtime without a desktop relaunch', posixExecutable, async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.startup(), { phase: 'verified', disposition: 'complete', operationId: 'legacy-locations-v1' });
  assert.deepEqual(JSON.parse(await readFile(f.env.KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE, 'utf8')), f.ownerRuntime);
});

test('startup preserves migration contention without exposing private helper diagnostics', posixExecutable, async t => {
  const f = await fixture(t, 'startup-busy');
  await assert.rejects(f.client.startup(), {
    code: 'STORAGE_MIGRATION_BUSY', message: 'STORAGE_MIGRATION_BUSY',
  });
});

test('first installation sends only the chosen roots without owner runtime or relaunch authority', posixExecutable, async t => {
  const f = await fixture(t);
  const roots = { dataRoot: join(f.root, 'chosen-data'), cacheRoot: join(f.root, 'chosen-cache') };
  f.env.KCODER_STORAGE_DESKTOP_RELAUNCH_V1 = 'must not reach first installation';
  f.env[OWNER_RUNTIME_ENV] = 'must not reach first installation';
  f.env.KCODER_STORAGE_TEST_RELAUNCH_FILE = join(f.root, 'initialize-relaunch.json');
  const client = createStorageOperationClient({ program: f.program, cwd: f.root, env: f.env,
    ownerRuntime: f.ownerRuntime, relaunch: { program: process.execPath, cwd: f.root, args: [] } });
  assert.deepEqual(await client.initialize(roots), { version: 1, revision: 1, ...roots });
  assert.equal(await readFile(f.env.KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE, 'utf8'), 'absent');
  assert.equal(await readFile(f.env.KCODER_STORAGE_TEST_RELAUNCH_FILE, 'utf8'), 'absent');
});

test('old-copy cleanup uses the original id and confirmation without business owners or relaunch', posixExecutable, async t => {
  const f = await fixture(t);
  const operationId = 'original-complete-operation';
  const preview = await f.client.cleanupPreview({ operationId });
  assert.equal(preview.operationId, operationId);
  assert.equal(preview.confirmation, 'c'.repeat(64));
  assert.equal(await readFile(f.env.KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE, 'utf8'), 'absent');
  const result = await f.client.cleanupConfirm({ operationId, confirmation: preview.confirmation });
  assert.deepEqual(result, { operationId, confirmation: preview.confirmation, entries: [] });
  assert.equal(await readFile(f.env.KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE, 'utf8'), 'absent');
  assert.deepEqual(await f.client.status(operationId), { plan: { operationId } });
});

test('execute sends the original plan to the local worker with fixed owner runtime and no desktop relaunch', posixExecutable, async t => {
  const f = await fixture(t);
  const observed = join(f.root, 'execute-relaunch-context.json');
  f.env.KCODER_STORAGE_TEST_RELAUNCH_FILE = observed;
  f.env.KCODER_STORAGE_DESKTOP_RELAUNCH_V1 = 'inherited relaunch must not reach execute';
  f.env[OWNER_RUNTIME_ENV] = JSON.stringify({ program: '/untrusted/program', applicationRoot: '/untrusted/root', runAsNode: true });
  const expectedOwner = structuredClone(f.ownerRuntime);
  const client = createStorageOperationClient({ program: f.program, cwd: f.root, env: f.env,
    ownerRuntime: f.ownerRuntime, relaunch: { program: process.execPath, args: [], cwd: f.root } });
  f.ownerRuntime.applicationRoot = join(f.root, 'later-mutation');
  const plan = { operationId: 'owned-install-execute', launchIntent: 'verifyOnly',
    from: { dataRoot: join(f.root, 'original-data'), cacheRoot: join(f.root, 'original-cache') },
    target: { dataRoot: join(f.root, 'selected-data'), cacheRoot: join(f.root, 'selected-cache') } };
  assert.deepEqual(await client.execute(plan), { phase: 'verified', disposition: 'complete', plan });
  assert.deepEqual(JSON.parse(await readFile(f.env.KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE, 'utf8')), expectedOwner);
  assert.equal(await readFile(observed, 'utf8'), 'absent');
  assert.equal(await waitForExitFile(f.exitFile), 'exited');
  await waitForPidExit(Number(await readFile(f.pidFile, 'utf8')));
});

for (const [mode, code] of [
  ['plan-native-code-unsupported', 'SERVICE_LEASE_NATIVE_CODE_RELOCATION_UNSUPPORTED'],
  ['plan-legacy-host-unsupported', 'SERVICE_LEASE_LEGACY_HOST_RELOCATION_UNSUPPORTED'],
  ['plan-reference-cause', 'STORAGE_MANAGED_WORKTREE_INTERNAL_ALIAS_UNSUPPORTED'],
  ...['STORAGE_MANAGED_WORKTREE_INTERNAL_ALIAS_UNSUPPORTED', 'STORAGE_GATEWAY_INTERNAL_REFERENCE_UNSUPPORTED', 'STORAGE_GATEWAY_REFERENCE_METADATA_INVALID',
    'STORAGE_GATEWAY_REFERENCE_METADATA_TOO_LARGE', 'STORAGE_BROWSER_PROFILE_PATH_TOO_LONG'].map(code => [`plan-reference:${code}`, code]),
]) {
  test(`preview preserves the safe helper code ${code}`, posixExecutable, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(f.client.preview({ dataRoot: join(f.root, 'data'), cacheRoot: join(f.root, 'cache') }), error => {
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      assert.equal(error.message.includes(f.root), false);
      return true;
    });
  });
}

test('a worker that never announces readiness reaches the real deadline and is reaped', { ...posixExecutable, timeout: 20000 }, async t => {
  const f = await fixture(t, 'not-ready');
  await assert.rejects(f.client.handoff({ operationId: 'owned-not-ready' }), { code: 'STORAGE_HANDOFF_TIMEOUT' });
  const pid = Number(await readFile(f.pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  await waitForPidExit(pid);
  await assert.rejects(readFile(f.exitFile), { code: 'ENOENT' });
});

test('a missing worker fails before creating any owned child receipt', posixExecutable, async t => {
  const f = await fixture(t);
  const client = createStorageOperationClient({ program: join(f.root, 'not-installed-worker'), cwd: f.root,
    env: f.env, ownerRuntime: f.ownerRuntime });
  await assert.rejects(client.handoff({ operationId: 'owned-missing-worker' }), { code: 'STORAGE_HANDOFF_START_FAILED' });
  await assert.rejects(readFile(f.pidFile), { code: 'ENOENT' });
});

test('preview hides untrusted helper stderr and paths', posixExecutable, async t => {
  const f = await fixture(t, 'plan-untrusted-stderr');
  await assert.rejects(f.client.preview({ dataRoot: join(f.root, 'data'), cacheRoot: join(f.root, 'cache') }), error => {
    assert.equal(error.code, 'STORAGE_HELPER_FAILED');
    assert.equal(error.message, 'STORAGE_HELPER_FAILED');
    assert.equal(error.message.includes(f.root), false);
    return true;
  });
});

for (const code of [
  'CREDENTIAL_RELOCATION_KEYRING_UNAVAILABLE',
  'CREDENTIAL_RELOCATION_KEYRING_ENTRY_MISSING',
  'CREDENTIAL_RELOCATION_KEYRING_POLICY_BLOCKED',
]) {
  test(`credential preview preserves ${code} without disclosing diagnostic details`, posixExecutable, async t => {
    const f = await fixture(t, `plan-credential:${code}: private-account: private-credential-detail`);
    await assert.rejects(f.client.preview({ dataRoot: join(f.root, 'data'), cacheRoot: join(f.root, 'cache') }), error => {
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      return true;
    });
  });
}

for (const diagnostic of [
  'CREDENTIAL_RELOCATION_KEYRING_UNKNOWN: private-credential-detail',
  'CREDENTIAL_RELOCATION_KEYRING_UNAVAILABLE_EXTRA: private-credential-detail',
  'prefix CREDENTIAL_RELOCATION_KEYRING_UNAVAILABLE: private-credential-detail',
]) {
  test(`credential preview hides an unrecognized diagnostic: ${diagnostic.split(':')[0]}`, posixExecutable, async t => {
    const f = await fixture(t, `plan-credential:${diagnostic}`);
    await assert.rejects(f.client.preview({ dataRoot: join(f.root, 'data'), cacheRoot: join(f.root, 'cache') }),
      { code: 'STORAGE_HELPER_FAILED', message: 'STORAGE_HELPER_FAILED' });
  });
}

test('operation calls replace inherited owner runtime with the fixed host context', posixExecutable, async t => {
  const f = await fixture(t);
  const observed = f.env.KCODER_STORAGE_TEST_OWNER_RUNTIME_FILE;
  f.env[OWNER_RUNTIME_ENV] = JSON.stringify({ program: '/renderer/selected', applicationRoot: '/untrusted', runAsNode: true });
  const client = createStorageOperationClient({ program: f.program, cwd: f.root, env: f.env, ownerRuntime: f.ownerRuntime });

  await client.paths();
  assert.equal(await readFile(observed, 'utf8'), 'absent');
  await client.status();
  assert.equal(await readFile(observed, 'utf8'), 'absent');
  await client.preview({ operationId: 'fixed-owner-runtime' });
  assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), f.ownerRuntime);
  await client.handoff({ operationId: 'fixed-owner-runtime' });
  assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), f.ownerRuntime);
  const pid = Number(await readFile(f.pidFile, 'utf8'));
  await waitForExitFile(f.exitFile);
  await waitForPidExit(pid);
});

test('rejects non-absolute, incomplete, or non-Node owner runtimes', () => {
  const common = { program: process.execPath, applicationRoot: process.cwd(), runAsNode: true };
  for (const ownerRuntime of [
    { program: process.execPath, applicationRoot: process.cwd() },
    { ...common, program: 'node' },
    { ...common, applicationRoot: 'apps/kcoder-studio' },
    { ...common, runAsNode: false },
    { ...common, entry: '/renderer/selected.mjs' },
  ]) {
    assert.throws(() => createStorageOperationClient({ program: process.execPath, cwd: process.cwd(), ownerRuntime }),
      { code: 'STORAGE_OWNER_RUNTIME_INVALID' });
  }
});

test('only handoff receives the original host restart context', posixExecutable, async t => {
  const f = await fixture(t);
  const observed = join(f.root, 'relaunch-context.json');
  f.env.KCODER_STORAGE_TEST_RELAUNCH_FILE = observed;
  f.env.KCODER_STORAGE_DESKTOP_RELAUNCH_V1 = 'inherited context must not be forwarded';
  const relaunch = { program: process.execPath, args: [fixtureSource.pathname], cwd: f.root };
  const expected = structuredClone(relaunch);
  const client = createStorageOperationClient({ program: f.program, cwd: f.root, env: f.env, relaunch,
    ownerRuntime: f.ownerRuntime });
  relaunch.args.push('later mutation must not change the host launch');
  await client.status();
  assert.equal(await readFile(observed, 'utf8'), 'absent');
  await client.preview({ operationId: 'owned-desktop-relaunch', launchIntent: 'desktop' });
  assert.equal(await readFile(observed, 'utf8'), 'absent');
  await client.handoff({ operationId: 'owned-desktop-relaunch', launchIntent: 'desktop' });
  assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), expected);
  const pid = Number(await readFile(f.pidFile, 'utf8'));
  await waitForExitFile(f.exitFile);
  await waitForPidExit(pid);
});

test('a matching ready transfers only readiness and lets the owned child finish', posixExecutable, async t => {
  const f = await fixture(t);
  const observed = join(f.root, 'handoff-input.json');
  f.env.KCODER_STORAGE_TEST_HANDOFF_FILE = observed;
  const client = createStorageOperationClient({ program: f.program, cwd: f.root, env: f.env,
    ownerRuntime: f.ownerRuntime });
  const plan = { operationId: 'owned-operation-ready' };
  const ready = await client.handoff(plan);
  assert.deepEqual(ready, { operationId: plan.operationId, state: 'ready' });
  assert.notEqual(ready.state, 'complete');
  assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), { mode: 'handoff', plan });
  const pid = Number(await readFile(f.pidFile, 'utf8'));
  assert(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(await waitForExitFile(f.exitFile), 'exited');
  await waitForPidExit(pid);
});

test('retry handoff uses the explicit original-id mode and passes the receipt plan unchanged', posixExecutable, async t => {
  const f = await fixture(t);
  const observed = join(f.root, 'handoff-input.json');
  f.env.KCODER_STORAGE_TEST_HANDOFF_FILE = observed;
  const client = createStorageOperationClient({ program: f.program, cwd: f.root, env: f.env,
    ownerRuntime: f.ownerRuntime });
  const plan = {
    version: 1,
    operationId: 'original-deferred-operation',
    original: { version: 1, revision: 4, dataRoot: join(f.root, 'original-data'), cacheRoot: join(f.root, 'original-cache') },
    from: { layout: 'legacy', dataRoot: join(f.root, 'original-data'), cacheRoot: join(f.root, 'original-cache') },
    target: { version: 1, revision: 5, dataRoot: join(f.root, 'selected-data'), cacheRoot: join(f.root, 'selected-cache'), operationId: 'original-deferred-operation' },
    components: [],
    targetBindings: [],
    launchIntent: 'desktop',
  };
  const reply = await client.handoff(plan, { retry: true });
  assert.deepEqual(reply, { operationId: plan.operationId, state: 'ready' });
  assert.deepEqual(JSON.parse(await readFile(observed, 'utf8')), { mode: 'retry-handoff', plan });
  await waitForExitFile(f.exitFile);
  await waitForPidExit(Number(await readFile(f.pidFile, 'utf8')));
});

for (const [mode, code] of [
  ['early-exit', 'STORAGE_HANDOFF_UNCONFIRMED'],
  ['malformed', 'STORAGE_HELPER_REPLY_INVALID'],
  ['unknown-operation', 'STORAGE_HANDOFF_UNCONFIRMED'],
  ['unknown-field', 'STORAGE_HANDOFF_UNCONFIRMED'],
  ['oversized-stdout', 'STORAGE_HELPER_REPLY_TOO_LARGE'],
  ['oversized-stderr', 'STORAGE_HELPER_REPLY_TOO_LARGE'],
]) {
  test(`handoff rejects ${mode} and reaps only its owned child promptly`, posixExecutable, async t => {
    const f = await fixture(t, mode);
    const started = Date.now();
    await assert.rejects(f.client.handoff({ operationId: `owned-${mode}` }), { code });
    assert(Date.now() - started < 5000, 'failure handling must not wait for the 15-second helper timeout');
    const pid = Number(await readFile(f.pidFile, 'utf8'));
    assert(Number.isSafeInteger(pid) && pid > 0);
    await waitForPidExit(pid);
  });
}
