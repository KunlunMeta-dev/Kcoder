import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { appRoot, requireExecutable, runIntegration, waitFor } from '../e2e/harness/run-context.mjs';
import { hashHistoryFile } from '../e2e/harness/migration-large-history.mjs';

await runIntegration(import.meta.url, {
  testId: 'storage-account-paths-electron', tier: 'manual-live', variantId: process.platform,
  modelPolicy: 'actual Electron OS-path ownership preflight only; no product startup, GUI input, Native, Gateway or model',
  retainSuccessLogs: true,
}, async context => {
  assert.ok(['linux', 'darwin'].includes(process.platform), 'UNMET_PREREQUISITE: POSIX Electron required');
  assert.match(process.env.KCODER_E2E_ELECTRON_BIN_SHA256 ?? '', /^[a-f0-9]{64}$/, 'Explicit Electron executable SHA256 required');
  const electron = await requireExecutable(process.env.KCODER_E2E_ELECTRON_BIN, 'Pinned source Electron');
  const before = await hashHistoryFile(electron);
  assert.equal(before, process.env.KCODER_E2E_ELECTRON_BIN_SHA256);
  const root = context.pathInState('account'), home = join(root, 'home');
  await mkdir(join(root, 'electron'), { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = join(root, 'temporary');
  await mkdir(temporary, { mode: 0o700 });
  const report = context.pathInState('account/paths.json');
  const source = resolve(appRoot, 'e2e/harness/fixtures/storage-account-paths-electron.mjs');
  const sourceBefore = await hashHistoryFile(source);
  await context.writeArtifactJson('inputs.json', { electron, sha256: before, source, sourceSha256: sourceBefore });
  const args = [source];
  let command = electron, commandArgs = args;
  if (process.platform === 'linux') {
    assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1', 'UNMET_PREREQUISITE: isolated VM sandbox opt-in required');
    command = await requireExecutable('/usr/bin/xvfb-run', 'Owned X display');
    commandArgs = ['-a', '-s', '-screen 0 800x600x24 -nolisten tcp', electron, '--no-sandbox', source];
  }
  const child = context.spawnOwned('electron-account-paths', command, commandArgs, { cwd: root,
    env: context.isolatedEnvironment({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'), ELECTRON_RUN_AS_NODE: '',
      TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      KCODER_E2E_STORAGE_ACCOUNT_ROOT: root, KCODER_E2E_STORAGE_ACCOUNT_REPORT: report }) });
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 30_000,
    'owned Electron account-path observation', 50, context.abortSignal);
  await context.stopOwned('electron-account-paths');
  const observed = JSON.parse(await readFile(report, 'utf8'));
  await context.writeArtifactJson('observed-paths.json', observed);
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  assert.equal(observed.beforeReady, true);
  assert.equal(observed.platform, process.platform);
  for (const field of ['home', 'nodeHome']) assert.equal(observed[field], home, `${field} must use the owned account home`);
  const appDataRelative = relative(home, observed.appData);
  assert.ok(isAbsolute(observed.appData) && appDataRelative && appDataRelative !== '..'
    && !appDataRelative.startsWith(`..${sep}`) && !isAbsolute(appDataRelative),
  'UNMET_PREREQUISITE: Electron appData is outside the owned Home; use an authorized independent OS QA account');
  assert.equal(observed.userData, join(root, 'electron'));
  assert.equal(observed.sessionData, observed.userData);
  assert.equal(await hashHistoryFile(electron), before);
  assert.equal(await hashHistoryFile(source), sourceBefore);
  return { ownedPaths: true, productStartupVerified: false, nativeInputVerified: false };
});
