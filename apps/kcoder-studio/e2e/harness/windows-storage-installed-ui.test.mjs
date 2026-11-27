import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import test from 'node:test';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RunContext } from './run-context.mjs';
import { projectWindowsStorageStartupFailure, windowsStorageProbeRoots } from './windows-storage-installed-ui.mjs';

test('fresh Windows storage probe expects the dedicated cache child and keeps explicit targets', () => {
  const root = 'C:\\owned\\storage-probe';
  const profile = { userProfile: 'C:\\Users\\owned', localAppData: 'C:\\Users\\owned\\AppData\\Local' };
  assert.deepEqual(windowsStorageProbeRoots({ root, profile, choice: 'defaults' }), {
    dataRoot: 'C:\\Users\\owned\\.config\\kcoder', cacheRoot: 'C:\\Users\\owned\\AppData\\Local\\kcoder\\cache',
  });
  const custom = windowsStorageProbeRoots({ root, profile, choice: 'custom' });
  assert.ok(custom.dataRoot.startsWith(root + '\\中文配置 数据\\'));
  assert.equal(custom.cacheRoot, root + '\\中文缓存 临时');
  const target = { dataRoot: 'D:\\existing-data', cacheRoot: 'C:\\Users\\owned\\AppData\\Local\\kcoder' };
  assert.deepEqual(windowsStorageProbeRoots({ root, profile, choice: 'defaults', moved: { target } }), target,
    'A saved migration target retains its original cache root instead of adopting a new default');
});

test('installed storage probe imports from the actual flat transfer layout', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'storage-probe-transfer-closure',
    variantId: 'flat-transfer-closure', tier: 'harness-unit', modelPolicy: 'owned module-load fixture only; no Windows host, installation or model' });
  let failure;
  try {
    const root = context.pathInState('bundle');
    await mkdir(root);
    for (const [source, target] of [['windows-storage-installed-ui.mjs', 'storage-probe.mjs'],
      ['windows-storage-upgrade.mjs', 'windows-storage-upgrade.mjs'], ['windows-storage-relocation.mjs', 'windows-storage-relocation.mjs']])
      await copyFile(new URL(source, import.meta.url), join(root, target));
    const transferred = await import(pathToFileURL(join(root, 'storage-probe.mjs')).href);
    assert.equal(typeof transferred.runWindowsInstalledStorageProbe, 'function');
    assert.deepEqual(transferred.windowsStorageProbeRoots({ root: 'C:\\owned',
      profile: { userProfile: 'C:\\Users\\owned', localAppData: 'C:\\Users\\owned\\AppData\\Local' }, choice: 'defaults' }),
    { dataRoot: 'C:\\Users\\owned\\.config\\kcoder', cacheRoot: 'C:\\Users\\owned\\AppData\\Local\\kcoder\\cache' });
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { moduleLoadOnly: true }, failure); }
});

const logged = fields => 'DESKTOP_STORAGE_STARTUP_FAILED ' + inspect(Object.assign(Error('STORAGE_FIRST_LAUNCH_UNCONFIRMED'), fields), { colors: false });

test('normal Node Error diagnostics retain typed child exit, signal and identity reason without raw values', () => {
  const fields = { childExitCode: 1, childKilled: false, childSignal: 'SIGTERM', childProcessError: 'ETIMEDOUT',
    childStdoutBytes: 0, childStderrBytes: 123, childStartupCode: 'WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE', childStartupReason: 'timeout' };
  const secret = 'DO_NOT_RETAIN_LOGIN_CODE_OR_COOKIE_abcdef';
  const projection = projectWindowsStorageStartupFailure(logged({ ...fields, rawStderr: secret, cookie: secret, path: 'C:\\private\\' + secret }));
  for (const [name, value] of Object.entries(fields)) assert.equal(projection[name], value);
  const retained = JSON.stringify(projection);
  assert.ok(!retained.includes(secret)); assert.equal(projection.rawStderr, undefined); assert.equal(projection.cookie, undefined); assert.equal(projection.path, undefined);
});

test('unknown child attributes cannot suppress valid neighbors or be promoted as trusted diagnostics', () => {
  const projection = projectWindowsStorageStartupFailure(logged({ childExitCode: 'not-a-code', childKilled: 'false', childStdoutBytes: -1,
    childStderrBytes: 0, childProcessError: 'SECRET_VALUE', childSignal: 'SIGCUSTOM', childStartupCode: 'UNKNOWN_IDENTITY', childStartupReason: 'timeout',
    futureField: { childExitCode: 99, unknownText: 'force nested console inspection onto separate lines '.repeat(4) } }));
  assert.equal(projection.childStderrBytes, 0);
  for (const name of ['childExitCode', 'childKilled', 'childStdoutBytes', 'childProcessError', 'childSignal', 'childStartupCode', 'childStartupReason', 'futureField'])
    assert.equal(projection[name], undefined);
});

test('old startup output retains its original bounded projection and never invents missing child facts', () => {
  const projection = projectWindowsStorageStartupFailure('DESKTOP_STORAGE_STARTUP_FAILED Error: STORAGE_CONTROL_UNAVAILABLE');
  assert.deepEqual(projection.startupCodes, ['DESKTOP_STORAGE_STARTUP_FAILED', 'STORAGE_CONTROL_UNAVAILABLE']);
  assert.equal(projection.childExitCode, undefined); assert.equal(projection.childKilled, undefined);
  assert.equal(projectWindowsStorageStartupFailure('childExitCode: 17').childExitCode, undefined);
});
