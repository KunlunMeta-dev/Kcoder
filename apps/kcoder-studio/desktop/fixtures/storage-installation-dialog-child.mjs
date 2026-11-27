import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { configureStorageFirstLaunchDialog, parseStorageInstallationArguments, STORAGE_FIRST_LAUNCH_REPLY } from '../storage-installation.mjs';

const intent = parseStorageInstallationArguments(process.argv, { platform: process.platform });
const directory = intent.firstLaunchUserData;
const mode = process.env.KCODER_STORAGE_DIALOG_FIXTURE_MODE;
writeFileSync(join(directory, 'owned-dialog-state'), 'only this chooser owns this state');
writeFileSync(process.env.KCODER_STORAGE_DIALOG_FIXTURE_OBSERVATION, JSON.stringify({ directory,
  pid: process.pid, runAsNode: process.env.ELECTRON_RUN_AS_NODE,
  runAsNodePresent: Object.keys(process.env).some(key => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') }));
if (mode === 'parent-pipe') {
  const synthetic = new Readable({ read() {} });
  synthetic.push(null);
  Object.defineProperty(process, 'stdin', { get: () => synthetic });
  configureStorageFirstLaunchDialog({ platform: 'win32', userData: directory,
    app: { isReady: () => false, setPath() {}, once() {}, exit: code => process.exit(code) } });
  process.stdout.write('parent-pipe-ready\n');
  await new Promise(() => {});
}
if (mode === 'replace-owner') {
  renameSync(directory, `${directory}-original`);
  mkdirSync(directory);
  writeFileSync(join(directory, 'unrelated'), 'must remain');
}
if (['failure', 'identity-failure', 'unrecognized-failure'].includes(mode)) {
  if (mode === 'identity-failure') process.stderr.write('KCODER_INSTALL_PROFILE_PREPARATION_FAILED WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE execution_failed\n');
  if (mode === 'unrecognized-failure') process.stderr.write('KCODER_INSTALL_PROFILE_PREPARATION_FAILED WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE private_fixture_reason\n');
  process.stderr.write('Do not expose private fixture diagnostics');
  process.exit(1);
}
const reply = mode === 'malformed' ? 'not a receipt' : JSON.stringify({ version: 1,
  state: mode === 'cancelled' ? 'cancelled' : 'complete' });
if (mode === 'runtime-diagnostics') process.stdout.write('[Electron diagnostic on stdout]\n');
if (mode === 'duplicate-reply') process.stdout.write(`${STORAGE_FIRST_LAUNCH_REPLY}${reply}\n`);
process.stdout.write(`${STORAGE_FIRST_LAUNCH_REPLY}${reply}\n`, () => process.exit(0));
