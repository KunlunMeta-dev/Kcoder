import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chooseStorageFirstLaunch, configureStorageFirstLaunchDialog,
  parseStorageInstallationArguments, runStorageFirstLaunch, STORAGE_FIRST_LAUNCH_REPLY } from '../storage-installation.mjs';

const config = JSON.parse(await readFile(process.env.KCODER_STORAGE_DIALOG_FIXTURE_CONFIG, 'utf8'));
const windows = process.platform === 'win32';
const intent = parseStorageInstallationArguments(process.argv, { platform: process.platform });
if (!intent) {
  const originalExecFile = childProcess.execFile;
  childProcess.execFile = (...args) => {
    const callback = args.pop();
    return originalExecFile(...args, (error, stdout, stderr) => {
      writeFileSync(config.diagnostics, JSON.stringify({ stdout, stderr }));
      callback(error, stdout, stderr);
    });
  };
  syncBuiltinESMExports();
  const result = await runStorageFirstLaunch({ program: windows ? config.electron : config.xvfb,
    args: windows ? ['--disable-gpu', `--user-data-dir=${config.earlyUserData}`, fileURLToPath(import.meta.url)]
      : ['-a', '-s', '-screen 0 1280x1024x24 -nolisten tcp',
        config.electron, '--no-sandbox', '--disable-setuid-sandbox', fileURLToPath(import.meta.url)], cwd: config.home });
  const report = JSON.parse(await readFile(config.nativeReport, 'utf8'));
  await assert.rejects(lstat(report.userData), { code: 'ENOENT' });
  await writeFile(config.ownerReport, JSON.stringify({ result, temporaryProfileRemoved: true }));
} else {
  const { app, dialog } = await import('electron');
  const beforeReady = app.isReady();
  configureStorageFirstLaunchDialog({ app, userData: intent.firstLaunchUserData });
  const configuredBeforeReady = !app.isReady();
  app.whenReady().then(async () => {
    const run = promisify(execFile);
    const automate = (async () => {
      if (windows) {
        const birth = await run(config.powershell, ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`], { windowsHide: true, timeout: 10000 });
        const native = await run(config.powershell, ['-NoProfile', '-NonInteractive', '-File', config.nativeDriver,
          '-OwnedRoot', config.home, '-ProcessId', String(process.pid), '-StartedFileTime', birth.stdout.trim(),
          '-ExpectedTitle', 'KCoder storage folders', '-Action', 'button', '-ButtonText', 'Exit',
          '-OperationId', 'qualification-cancel'], { windowsHide: true, timeout: 40000 });
        const receipt = JSON.parse(native.stdout.replace(/^\uFEFF/, '').trim());
        assert.equal(receipt.pid, process.pid);
        assert.equal(receipt.invoked, true);
        return receipt;
      }
      const { stdout } = await run(config.xdotool, ['search', '--sync', '--onlyvisible', '--name', '^KCoder storage folders$'], { timeout: 15000 });
      const windowIds = stdout.trim().split(/\s+/);
      assert.equal(windowIds.length, 1, 'Only this owned display dialog may be selected');
      assert.match(windowIds[0], /^\d+$/);
      await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1280x1024',
        '-i', process.env.DISPLAY, '-frames:v', '1', '-update', '1', config.screenshot], { timeout: 15000 });
      await run(config.xdotool, ['windowfocus', '--sync', windowIds[0], 'key', 'Return'], { timeout: 10000 });
      return windowIds[0];
    })();
    const [choice, window] = await Promise.all([chooseStorageFirstLaunch({ dialog,
      selected: { paths: config.roots }, locale: 'en' }), automate]);
    assert.deepEqual(choice, windows ? null : { silent: false, ...config.roots });
    await writeFile(config.nativeReport, JSON.stringify({ beforeReady, configuredBeforeReady,
      readyAtDialog: app.isReady(), ...(windows ? { systemDrive: process.env.SystemDrive } : {}), home: app.getPath('home'), userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'), choice, window, nativeDialogAccepted: !windows,
      nativeDialogCancelled: windows }));
    process.stdout.write(`${STORAGE_FIRST_LAUNCH_REPLY}${JSON.stringify({ version: 1, state: windows ? 'cancelled' : 'complete' })}\n`, () => app.exit(0));
  }).catch(error => { console.error(error); app.exit(1); });
}
