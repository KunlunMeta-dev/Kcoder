import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { appRoot, requireExecutable, runIntegration } from '../e2e/harness/run-context.mjs';
import { createShortChromiumTemp } from '../e2e/harness/short-chromium-temp.mjs';

const windows = process.platform === 'win32';
await runIntegration(import.meta.url, { testId: windows ? 'storage-installation-native-dialog-windows-cancel' : 'storage-installation-native-dialog-linux', tier: 'manual-live',
  variantId: windows ? 'windows-interactive-cancel' : 'default',
  modelPolicy: 'model-independent actual Electron native folder-choice component and owned child cleanup; no Rust, Gateway, installed startup or model',
  retainSuccessEvidence: true, evidenceReason: 'Record early temporary profile identity, actual native dialog and parent cleanup' }, async context => {
  assert.ok(windows || process.platform === 'linux', 'UNMET_PREREQUISITE: Windows or Linux native host required');
  if (!windows) assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1', 'UNMET_PREREQUISITE: owned VM no-sandbox opt-in required');
  const electron = await requireExecutable(windows ? process.env.KCODER_E2E_ELECTRON_BIN
    : resolve(appRoot, 'node_modules/electron/dist/electron'), 'Electron');
  const xvfb = windows ? null : await requireExecutable('/usr/bin/xvfb-run', 'Xvfb');
  const xdotool = windows ? null : await requireExecutable('/usr/bin/xdotool', 'Owned X11 dialog control');
  const ffmpeg = windows ? null : await requireExecutable('/usr/bin/ffmpeg', 'Owned X11 screenshot capture');
  const home = context.pathInState('home');
  await mkdir(home, { recursive: true });
  const temporary = windows ? { path: context.pathInState('tmp') } : await createShortChromiumTemp(context);
  if (windows) await mkdir(temporary.path, { recursive: true });
  const config = { electron, xvfb, xdotool, ffmpeg, home,
    earlyUserData: context.pathInState('early-user-data'),
    powershell: windows ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : null,
    nativeDriver: resolve(appRoot, 'e2e/harness/windows-storage-native-dialog.ps1'),
    nativeReport: context.pathInState('native-dialog.json'), ownerReport: context.pathInState('owner-result.json'),
    diagnostics: context.pathInState('dialog-stdio.json'),
    screenshot: context.pathInState('native-dialog.png'),
    roots: { dataRoot: join(home, '配置与数据'), cacheRoot: join(home, 'Temporary Cache') } };
  if (windows) {
    const fixtureRoot = process.env.KCODER_E2E_STORAGE_DIALOG_FIXTURE_ROOT;
    const marker = JSON.parse((await readFile(join(fixtureRoot, '.owner.json'), 'utf8')).replace(/^\uFEFF/, ''));
    assert.match(marker.owner, /^[a-f0-9-]{36}$/);
    assert.equal(fixtureRoot.toLowerCase(), resolve('C:/kcoder-widget-'+marker.owner).toLowerCase());
    assert.equal(electron.toLowerCase(), join(fixtureRoot, 'electron/electron.exe').toLowerCase());
    const sid = process.env.KCODER_E2E_STORAGE_DIALOG_SID;
    assert.match(sid, /^S-1-5-21-/);
    await writeFile(join(home, '.owner.json'), JSON.stringify({ owner: marker.owner, sid, fixtureRoot,
      scope: 'storage-native-dialog-qualification' }), { flag: 'wx' });
  }
  if (windows) {
    for (const name of ['windows-storage-native-qualification-cancel.json', 'windows-storage-native-timeout.json']) {
      const source = join(home, name), target = context.pathInArtifacts(`original-${name}`);
      // Keep the original action intent even when cancellation or its receipt is unknown.
      context.addCleanup(`retain original native dialog evidence ${name}`, async () => {
        const entry = await lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!entry) return;
        assert.ok(entry.isFile() && !entry.isSymbolicLink() && entry.size <= 65536);
        const bytes = await readFile(source);
        assert.equal(context.redactText(bytes.toString('utf8')), bytes.toString('utf8'));
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      });
    }
  }
  const configFile = context.pathInState('dialog-config.json');
  await writeFile(configFile, JSON.stringify(config));
  const child = context.spawnOwned('storage-dialog-owner', process.execPath,
    [resolve(appRoot, 'desktop/fixtures/storage-installation-dialog-native.mjs')], { cwd: appRoot,
      env: context.isolatedEnvironment({ ...(!windows ? { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache') } : Object.fromEntries(
          ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH','SystemDrive'].map(name => [name, process.env[name]]))), TMPDIR: temporary.path, TEMP: temporary.path, TMP: temporary.path,
        KCODER_STORAGE_DIALOG_FIXTURE_CONFIG: configFile }) });
  const exit = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned native dialog did not settle within 60 seconds')), 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); accept({ code, signal }); });
  });
  await context.stopOwned('storage-dialog-owner');
  await context.writeArtifactJson('controlled-dialog-stdio.json', JSON.parse(await readFile(config.diagnostics, 'utf8')));
  assert.equal(exit.code, 0);
  const report = JSON.parse(await readFile(config.nativeReport, 'utf8'));
  const owner = JSON.parse(await readFile(config.ownerReport, 'utf8'));
  assert.equal(report.beforeReady, false);
  assert.equal(report.configuredBeforeReady, true);
  assert.equal(report.readyAtDialog, true);
  if (!windows) assert.equal(report.home, home);
  assert.equal(report.userData, report.sessionData);
  assert.equal(report.nativeDialogAccepted, !windows);
  assert.equal(report.nativeDialogCancelled, windows);
  assert.deepEqual(owner, { result: { version: 1, state: windows ? 'cancelled' : 'complete' }, temporaryProfileRemoved: true });
  if (windows) {
    assert.match(report.systemDrive ?? '', /^[A-Za-z]:$/);
    assert.equal(report.systemDrive, process.env.SystemDrive);
    const input = await readFile(join(home, 'windows-storage-native-qualification-cancel.json'));
    assert.deepEqual(JSON.parse(input.toString('utf8')), report.window);
  }
  const homeEntries = await readdir(home);
  const systemCacheEntries = homeEntries.includes('.cache') ? await readdir(join(home, '.cache')) : [];
  const unexpectedDirectories = {};
  if (windows) {
    for (const name of homeEntries.filter(name => !['.owner.json', 'windows-storage-native-qualification-cancel.json'].includes(name))) {
      const entry = await lstat(join(home, name));
      if (entry.isDirectory() && !entry.isSymbolicLink()) unexpectedDirectories[name] = (await readdir(join(home, name))).slice(0, 32);
    }
  }
  await context.writeArtifactJson('dialog-home-observation.json', { homeEntries, systemCacheEntries, unexpectedDirectories });
  assert(homeEntries.every(name => windows
    ? ['.owner.json', 'windows-storage-native-qualification-cancel.json'].includes(name) : name === '.cache'),
  'Native dialog must not initialize production Home or data');
  assert(systemCacheEntries.every(name => ['fontconfig', 'mesa_shader_cache'].includes(name)),
    'Only native toolkit/graphics driver caches may be outside the temporary Electron profile');
  for (const root of Object.values(config.roots)) await assert.rejects(lstat(root), { code: 'ENOENT' });
  if (!windows) assert.equal((await lstat(config.screenshot)).isFile(), true);
  await context.writeArtifactJson('native-dialog-receipt.json', { exit, report, owner,
    verificationBoundary: 'Actual native dialog component and temporary child lifetime only; no planner/worker/installed startup claims' });
  if (!windows) await writeFile(context.pathInArtifacts('native-dialog.png'), await readFile(config.screenshot));
  return { nativeDialogCancelled: windows, temporaryProfileRemoved: true, installedStartupAcceptance: false };
});
