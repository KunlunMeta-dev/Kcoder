import { join, posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, opendir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Socket } from 'node:net';
import { readStorageMigration } from '../src/storage-startup.mjs';
import { readWindowsRegisteredStorageRoots } from '../src/migrations/windows-registered-sources.mjs';
import { assertDesktopProfilePath } from './storage-browser-cache.mjs';

const ENTRY = '--prepare-windows-startup';
export const STORAGE_FIRST_LAUNCH_REPLY = 'KCODER_STORAGE_FIRST_LAUNCH_RESULT_V1 ';
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Parse installation intent only. The storage coordinator owns validation and publication. */
export function parseStorageInstallationArguments(argv, { platform = 'win32' } = {}) {
  const start = argv.indexOf(ENTRY);
  if (start < 0) return null;
  const result = { silent: false };
  const paths = platform === 'win32' ? win32 : posix;
  const seen = new Set();
  for (let index = start + 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--data-root', '--cache-root', '--storage-install-silent', '--storage-first-launch-user-data'].includes(flag) || seen.has(flag)) {
      fail('STORAGE_INSTALL_ARGUMENT_INVALID');
    }
    seen.add(flag);
    if (flag === '--storage-install-silent') { result.silent = true; continue; }
    const value = argv[++index];
    if (typeof value !== 'string' || !paths.isAbsolute(value) ||
      paths === win32 && paths.parse(value).root.length === 1 ||
      Buffer.byteLength(value) > 32767 || /[\0\r\n"]/.test(value)) fail('STORAGE_PATH_INVALID');
    // Omitted fields stay omitted so a one-field request preserves the other root.
    result[flag === '--data-root' ? 'dataRoot' : flag === '--cache-root' ? 'cacheRoot' : 'firstLaunchUserData'] = paths.normalize(value);
  }
  if (result.firstLaunchUserData && (result.dataRoot || result.cacheRoot || result.silent)) fail('STORAGE_INSTALL_ARGUMENT_INVALID');
  return Object.freeze(result);
}

/** This observation decides whether to show UI, never whether a migration is authorized. */
export async function shouldOfferStorageFirstLaunch(selected, { readOperation = readStorageMigration,
  readRegistered = readWindowsRegisteredStorageRoots, platform = process.platform } = {}) {
  if (selected.context.development || selected.paths.externallyConfigured || selected.context.record) return false;
  const paths = platform === 'win32' ? win32 : posix;
  try {
    if (await readOperation(selected.context.home)) return false;
    if ((await readRegistered({ selected, platform })).length) return false;
    const controls = new Set(['kcoder-storage-writers.lock', 'kcoder-storage-instances.lock']);
    const roots = new Set([selected.paths.dataRoot, selected.paths.gatewayRoot, selected.paths.desktopRoot,
      paths.join(selected.context.home, '.config', 'kcoder-studio'),
      paths.join(selected.context.home, '.config', 'kcoder-storage-migrations'),
      paths.join(selected.context.platformConfig, 'kcoder-studio')]);
    for (const root of roots) {
      const entry = await lstat(root).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!entry) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
      const directory = await opendir(root);
      for await (const child of directory) {
        if (!controls.has(child.name)) return false;
        const file = await lstat(paths.join(root, child.name));
        if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size !== 0) return false;
      }
    }
    return true;
  } catch { return false; }
}

/** Native dialogs only; the caller supplies the actual account's resolved roots. */
export async function chooseStorageFirstLaunch({ dialog, selected, locale = 'en', platform = process.platform }) {
  const chinese = locale.toLowerCase().startsWith('zh');
  const paths = platform === 'win32' ? win32 : posix;
  const intent = { silent: false, dataRoot: selected.paths.dataRoot, cacheRoot: selected.paths.cacheRoot };
  for (;;) {
    const answer = await dialog.showMessageBox({ type: 'question', noLink: true, defaultId: 0, cancelId: 3,
      title: chinese ? 'KCoder 数据位置' : 'KCoder storage folders',
      message: chinese ? '选择配置与数据、临时与缓存目录' : 'Choose configuration/data and temporary/cache folders',
      detail: (chinese ? '模型设置、会话和草稿保存在数据目录。软件和项目目录不受影响。' : 'Model settings, conversations and drafts stay in the data folder. Application and project folders stay separate.')
        + `\n\n${chinese ? '配置与数据' : 'Configuration and data'}: ${intent.dataRoot}\n${chinese ? '临时与缓存' : 'Temporary files and cache'}: ${intent.cacheRoot}`,
      buttons: chinese ? ['使用这些目录', '更改数据目录…', '更改缓存目录…', '退出']
        : ['Use these folders', 'Change data folder…', 'Change cache folder…', 'Exit'] });
    if (answer.response === 3) return null;
    if (answer.response === 0) return intent;
    if (![1, 2].includes(answer.response)) fail('STORAGE_INSTALL_DIALOG_INVALID');
    const field = answer.response === 1 ? 'dataRoot' : 'cacheRoot';
    const chosen = await dialog.showOpenDialog({ title: answer.response === 1
      ? chinese ? '配置与数据目录' : 'Configuration and data folder'
      : chinese ? '临时与缓存目录' : 'Temporary files and cache folder',
      defaultPath: intent[field], properties: ['openDirectory', 'createDirectory'] });
    if (chosen.canceled) continue;
    const [value] = chosen.filePaths ?? [];
    if (chosen.filePaths?.length !== 1 || typeof value !== 'string' || !paths.isAbsolute(value) ||
      paths === win32 && paths.parse(value).root.length === 1 || /[\0\r\n]/.test(value) || Buffer.byteLength(value) > 32767) {
      fail('STORAGE_PATH_INVALID');
    }
    intent[field] = paths.normalize(value);
  }
}

/** Only the dialog-only child becomes ready here; parent pipe loss cancels its authority. */
export function configureStorageFirstLaunchDialog({ app, userData, input, platform = process.platform }) {
  if (app.isReady()) fail('STORAGE_INSTALL_DIALOG_ALREADY_READY');
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  // Windows Electron replaces process.stdin with synthetic EOF. Read the actual owner pipe.
  let ownedInput;
  if (input === undefined) input = platform === 'win32'
    ? (ownedInput = new Socket({ fd: 0, readable: true, writable: false })) : process.stdin;
  // A Linux dialog-only host has no BrowserWindow driving Node's event loop.
  // Keep native chooser completions responsive while awaiting the parent pipe.
  const dialogWake = platform === 'linux' ? setInterval(() => {}, 100) : null;
  dialogWake?.unref();
  const release = () => { if (dialogWake) clearInterval(dialogWake); ownedInput?.destroy(); };
  app.once('quit', release);
  const parentGone = () => { release(); app.exit(2); };
  input.once('end', parentGone);
  input.once('error', parentGone);
  input.resume();
}

/** A child of this same desktop entry may become ready without opening the production profile. */
export async function runStorageFirstLaunch({ program, args = [], cwd, env = process.env }) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-storage-choice-'));
  const owner = await lstat(directory, { bigint: true });
  const childEnv = { ...env };
  // Windows Electron treats even an empty value as Node mode; remove the key.
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete childEnv[key];
  let result, failure;
  try {
    result = await new Promise((accept, reject) => {
      const child = execFile(program, [...args, ENTRY, '--storage-first-launch-user-data', directory],
        // This is a GUI child: SW_HIDE would also hide its native folder chooser.
        { cwd, env: childEnv, windowsHide: false, maxBuffer: 64 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            // Preserve process facts without leaking child arguments, paths or raw diagnostics.
            const failure = Object.assign(new Error('STORAGE_FIRST_LAUNCH_UNCONFIRMED'), {
              code: 'STORAGE_FIRST_LAUNCH_UNCONFIRMED', childKilled: error.killed === true,
              ...(Number.isInteger(error.code) ? { childExitCode: error.code } : {}),
              ...(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error.code)
                ? { childProcessError: error.code } : {}),
              ...(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGILL', 'SIGBUS'].includes(error.signal)
                ? { childSignal: error.signal } : {}),
              childStdoutBytes: Buffer.byteLength(stdout ?? ''), childStderrBytes: Buffer.byteLength(stderr ?? ''),
            });
            const identityFailure = stderr?.match(/^KCODER_INSTALL_PROFILE_PREPARATION_FAILED WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE(?: (system_directory_unavailable|timeout|execution_failed|invalid_identity|powershell_unavailable|unsupported_platform))?\r?$/m);
            if (identityFailure) {
              failure.childStartupCode = 'WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE';
              if (identityFailure[1]) failure.childStartupReason = identityFailure[1];
            }
            reject(failure);
            return;
          }
          // Electron may send Chromium diagnostics to stdout. Only this one
          // bounded, tagged frame is the dialog's authoritative completion.
          const frames = stdout.split(/\r?\n/).filter(line => line.startsWith(STORAGE_FIRST_LAUNCH_REPLY));
          let reply;
          try {
            if (frames.length !== 1) throw new Error('reply count');
            reply = JSON.parse(frames[0].slice(STORAGE_FIRST_LAUNCH_REPLY.length));
          } catch { reject(Object.assign(new Error('STORAGE_INSTALL_DIALOG_INVALID'), { code: 'STORAGE_INSTALL_DIALOG_INVALID' })); return; }
          if (!reply || reply.version !== 1 || !['complete', 'cancelled'].includes(reply.state) ||
            Object.keys(reply).some(key => !['version', 'state'].includes(key))) {
            reject(Object.assign(new Error('STORAGE_INSTALL_DIALOG_INVALID'), { code: 'STORAGE_INSTALL_DIALOG_INVALID' })); return;
          }
          accept(reply);
        });
      // Keep stdin open: the chooser exits if this owner disappears before it finishes.
      child.stdin.on('error', () => {});
    });
  } catch (error) { failure = error; }
  try {
    const named = await lstat(directory, { bigint: true });
    if (!named.isDirectory() || named.isSymbolicLink() || named.dev !== owner.dev || named.ino !== owner.ino) {
      fail('STORAGE_INSTALL_DIALOG_OWNER_CHANGED');
    }
    await rm(directory, { recursive: true });
  } catch (error) {
    if (!failure) throw error;
    failure.cleanupError = error;
    failure.cleanupUnconfirmed = true;
  }
  if (failure) throw failure;
  return result;
}

/** Only the installing user's local preparation entry calls this function.
 * Silent intent is not confirmation of a migration plan. Without an interactive
 * confirmation, an unattended installer may only keep the current selection. */
export async function applyStorageInstallation({ intent, loadSelected, createClient, confirm,
  initialSelection, operationId = randomUUID }) {
  if (!intent.dataRoot && !intent.cacheRoot) return null;
  // A confirmed first installation has nothing to migrate. Select its actual
  // empty roots once instead of committing defaults and moving them again.
  if (initialSelection && await shouldOfferStorageFirstLaunch(initialSelection)) {
    const roots = { dataRoot: intent.dataRoot ?? initialSelection.paths.dataRoot,
      cacheRoot: intent.cacheRoot ?? initialSelection.paths.cacheRoot };
    assertDesktopProfilePath(join(roots.dataRoot, 'studio', 'desktop'));
    const selected = await createClient(initialSelection).initialize(roots);
    if (selected?.version !== 1 || selected.revision !== 1 || selected.operationId != null ||
      selected.dataRoot !== roots.dataRoot || selected.cacheRoot !== roots.cacheRoot) {
      fail('STORAGE_INSTALL_RESULT_UNCONFIRMED');
    }
    return selected;
  }
  // The requested target belongs to this one plan. Ordinary startup would first
  // migrate legacy data to defaults, requiring a second copy to the chosen disk.
  const selected = await loadSelected();
  if (selected.context.development || selected.paths.externallyConfigured) fail('STORAGE_EXTERNAL_INSTANCE_READ_ONLY');
  const client = createClient(selected);
  // A committed location can already equal the requested roots while its
  // original verifier is unfinished. No-op preview is not a completion receipt.
  if ((await client.status())?.disposition === 'active') fail('STORAGE_INSTALL_RESULT_UNCONFIRMED');
  assertDesktopProfilePath(join(intent.dataRoot ?? selected.paths.dataRoot, 'studio', 'desktop'));
  const plan = await client.preview({ operationId: operationId(), launchIntent: 'verifyOnly',
    dataRoot: intent.dataRoot ?? selected.paths.dataRoot,
    cacheRoot: intent.cacheRoot ?? selected.paths.cacheRoot });
  if (!plan) {
    // Another installer may have committed these roots since the first status.
    if ((await client.status())?.disposition === 'active') fail('STORAGE_INSTALL_RESULT_UNCONFIRMED');
    return null;
  }
  if (intent.silent) fail('STORAGE_INSTALL_CONFIRMATION_REQUIRED');
  if (!await confirm(plan)) return { operationId: plan.operationId, state: 'cancelled' };
  const result = await client.execute(plan);
  if (result?.phase !== 'verified' || result.disposition !== 'complete' || result.plan?.operationId !== plan.operationId) {
    fail('STORAGE_INSTALL_RESULT_UNCONFIRMED');
  }
  return result;
}
