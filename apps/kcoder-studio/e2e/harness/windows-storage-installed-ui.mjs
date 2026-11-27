import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { prepareWindowsStorageHistory, runWindowsStorageRelocation, verifyWindowsStorageRelocatedRead } from './windows-storage-relocation.mjs';

const execute = promisify(execFile);
const delay = ms => new Promise(accept => setTimeout(accept, ms));
const same = (left, right) => left.toLowerCase() === right.toLowerCase();

export function windowsStorageProbeRoots({ root, profile, choice, moved }) {
  return {
    dataRoot: moved?.target.dataRoot ?? (choice === 'custom'
      ? win32.join(root, '中文配置 数据', '选择目录 '.repeat(8).trim()) : win32.join(profile.userProfile, '.config/kcoder')),
    cacheRoot: moved?.target.cacheRoot ?? (choice === 'custom'
      ? win32.join(root, '中文缓存 临时') : win32.join(profile.localAppData, 'kcoder', 'cache')),
  };
}

/** Project only the product's closed child diagnostics from its normal console Error record. */
export function projectWindowsStorageStartupFailure(output) {
  const result = { originalChildStdioObserved: output.length > 0, desktopReady: output.includes('KCoder Studio desktop ready:'),
    startupCodes: [...new Set(output.match(/\b(?:STORAGE|DESKTOP|KCODER|ERR|CREDENTIAL|COMPONENT|NATIVE)_[A-Z0-9_]{2,80}\b/g) ?? [])],
    errorTypes: ['SyntaxError', 'TypeError', 'ReferenceError'].filter(type => output.includes(type + ':')) };
  const start = output.lastIndexOf('DESKTOP_STORAGE_STARTUP_FAILED');
  if (start < 0) return result;
  const failure = output.slice(start);
  const scalar = name => failure.match(new RegExp(`^ {2}${name}:\\s*([^\\r\\n]+)`, 'm'))?.[1].trim().replace(/,$/, '');
  for (const name of ['childExitCode', 'childStdoutBytes', 'childStderrBytes']) {
    const token = scalar(name);
    if (token && /^-?\d+$/.test(token)) {
      const value = Number(token);
      if (Number.isSafeInteger(value) && (name === 'childExitCode' || value >= 0)) result[name] = value;
    }
  }
  const killed = scalar('childKilled');
  if (killed === 'true' || killed === 'false') result.childKilled = killed === 'true';
  for (const [name, allowed] of [
    ['childProcessError', ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']],
    ['childSignal', ['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGILL', 'SIGBUS']],
    ['childStartupCode', ['WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE']],
    ['childStartupReason', ['system_directory_unavailable', 'timeout', 'execution_failed', 'invalid_identity', 'powershell_unavailable', 'unsupported_platform']],
  ]) {
    const value = scalar(name)?.match(/^['"]([A-Za-z_]+)['"]$/)?.[1];
    if (allowed.includes(value) && (name !== 'childStartupReason' || result.childStartupCode === 'WINDOWS_ACCOUNT_IDENTITY_UNAVAILABLE')) result[name] = value;
  }
  return result;
}

/** Installed storage entry only: no substitute backend, Provider, key or model. */
export async function runWindowsInstalledStorageProbe(request) {
  assert.equal(process.platform, 'win32');
  const upgrade = request.storageUpgrade === true, upgradeSeed = request.action === 'storageUpgradeSeed';
  const upgradeModule = upgrade ? await import('./windows-storage-upgrade.mjs') : null;
  const root = request.runRoot, installation = request.installDirectory;
  const marker = JSON.parse(await readFile(join(root, '.owner.json'), 'utf8'));
  assert.equal(marker.owner, request.owner); assert.equal(marker.username, request.username);
  const profile = JSON.parse(await readFile(join(root, 'windows-os-profile-current.json'), 'utf8'));
  assert.equal(profile.sid, request.sid); assert.equal(profile.realOsProfile, true);
  assert.equal(profile.environmentOverridden, false); assert.equal(profile.isAdmin, false);
  const { verifyInstalledDesktop } = await import(pathToFileURL(join(root, 'acceptance/apps/kcoder-studio/e2e/harness/installed-desktop-identity.mjs')).href);
  const identity = await verifyInstalledDesktop(installation, { manifestSha256: request.expectedManifestSha256,
    hostSha256: request.expectedHostSha256, expectedCommit: request.expectedCommit });
  assert.equal(identity.nativeSha256, request.expectedCliSha256);
  const manifest = JSON.parse(await readFile(join(installation, 'resources/kcoder-release-manifest.json'), 'utf8'));
  assert.equal(manifest.versions.studio, request.expectedVersion);
  if (!upgradeSeed) assert.ok(manifest.resources.some(item => /kcoder[-_]native[-_]storage\.(?:node|dll)$/.test(item.path)), 'Installed storage addon must be manifest-bound');
  const { createCdpClient, isCommittedLoopbackDocument } = createRequire(import.meta.url)('./windows-cdp-document.cjs');
  const choice = request.storageFirstChoice ?? 'custom'; assert.ok(['cancel', 'defaults', 'custom'].includes(choice));
  const cold = request.action !== 'storageUI', relocating = request.action === 'storageRelocate';
  const relocatedRead = request.action === 'storageRelocatedRead';
  const moved = relocatedRead ? JSON.parse(await readFile(join(root, 'windows-storage-relocation-private.json'), 'utf8')) : null;
  if (moved) assert.equal(moved.owner, request.owner);
  const location = join(profile.userProfile, '.config/kcoder-storage.json');
  const defaults = join(profile.userProfile, '.config/kcoder');
  const migrations = join(profile.userProfile, '.config/kcoder-storage-migrations');
  let { dataRoot, cacheRoot } = windowsStorageProbeRoots({ root, profile, choice, moved });
  const absent = async path => assert.rejects(lstat(path), { code: 'ENOENT' });
  const recordBefore = cold && !upgrade ? await readFile(location) : null;
  if (!cold && !upgrade) {
    for (const path of [location, defaults, migrations]) await absent(path);
    if (choice === 'custom') for (const path of [dataRoot, cacheRoot]) { await mkdir(path, { recursive: true }); assert.deepEqual(await readdir(path), []); }
  }
  const workspace = join(root, 'storage-workspace'), temporary = join(root, 'storage-temp');
  await mkdir(workspace, { recursive: true }); await mkdir(temporary, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^KCODER_|^ELECTRON_RUN_AS_NODE$/i.test(name)));
  Object.assign(env, { KCODER_INCLUDE_BUNDLED_PROFILES: '0', KCODER_TRAINING_UPLOAD_URL: 'disabled-for-test',
    KCODER_STUDIO_WORKSPACE: workspace, TEMP: temporary, TMP: temporary });
  for (const [key, value] of [['USERPROFILE', profile.userProfile], ['APPDATA', profile.roamingAppData], ['LOCALAPPDATA', profile.localAppData]])
    assert.ok(same(env[key], value), 'Use the real normal-logon environment without Home overrides');
  if (relocating) {
    await prepareWindowsStorageHistory({ request, profile, workspace });
    try { await readFile(join(dataRoot, 'settings.json')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const input = join(root, 'storage-empty-provider-settings.json');
      await writeFile(input, JSON.stringify({ providers: {}, max_retries: 2 }), { flag: 'wx', mode: 0o600 });
      await execute(identity.nativePath, ['config', 'import', '--file', input, '--scope', 'user'], { cwd: workspace, env, timeout: 30000, windowsHide: true });
    }
  }
  const upgradeSetup = upgrade ? await upgradeModule.prepareWindowsStorageUpgrade({ request, root, profile, identity, workspace, env, execute }) : null;
  if (upgradeSetup) { dataRoot = upgradeSetup.dataRoot; cacheRoot = upgradeSetup.cacheRoot; }
  const powershell = join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  let output = '', main, renderer, turnStarts = 0;
  const app = spawn(identity.hostPath, ['--disable-gpu', '--inspect=127.0.0.1:0', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
    { cwd: installation, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((accept, reject) => { app.once('close', (code, signal) => accept({ code, signal })); app.once('error', reject); });
  const waitClosed = async (timeout, message) => {
    let timer;
    try { return await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), timeout); })]); }
    finally { clearTimeout(timer); }
  };
  for (const stream of [app.stdout, app.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-32768); });
  const until = async (predicate, timeout = 120000, allowOriginalExit = false) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await predicate(); if (value) return value; if (!allowOriginalExit && app.exitCode !== null) throw Error('Original installed storage host exited before readiness'); await delay(100); }
    throw Error('Installed storage entry deadline');
  };
  const processBirth = async () => {
    const result = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${app.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`], { timeout: 10000, windowsHide: true });
    assert.match(result.stdout.trim(), /^\d+$/); return result.stdout.trim();
  };
  const born = await processBirth();
  const native = async (operation, title, action, button, folder, original = { pid: app.pid, creationFileTime: born }) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'storage-dialog.ps1'),
      '-OwnedRoot', root, '-ProcessId', String(original.pid), '-StartedFileTime', original.creationFileTime, '-ExpectedTitle', title, '-Action', action];
    if (operation) args.push('-OperationId', operation);
    if (button) args.push('-ButtonText', button);
    if (folder) args.push('-Folder', folder);
    const result = await execute(powershell, args, { timeout: 40000, windowsHide: true, env, encoding: 'utf8', maxBuffer: 65536 });
    return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  };
  const evaluate = async (client, expression) => {
    const value = await client.request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(value.exceptionDetails, undefined); return value.result?.value;
  };
  const dialogs = [];
  let result, normalExit = false;
  try {
    if (!cold && !upgrade) {
      // The first selector is a program-owned native child, before any business window.
      const choiceTitle = 'KCoder storage folders|KCoder 数据位置';
      dialogs.push(await native(null, choiceTitle, 'observe'));
      for (const path of [location, defaults, migrations]) await absent(path);
      if (choice === 'custom') {
        for (const [kind, path, title] of [['data', dataRoot, 'Configuration and data folder|配置与数据目录'], ['cache', cacheRoot, 'Temporary files and cache folder|临时与缓存目录']]) {
          dialogs.push(await native(`first-change-${kind}`, choiceTitle, 'button', `Change ${kind} folder…`));
          dialogs.push(await native(`first-select-${kind}`, title, 'folder', undefined, path));
        }
        for (const path of [location, defaults, migrations]) await absent(path);
      }
      dialogs.push(await native('first-confirm', choiceTitle, 'button', choice === 'cancel' ? 'Exit' : 'Use these folders'));
    }
    if (choice === 'cancel' && !upgrade) {
      const exit = await waitClosed(15000, 'Cancelled installed storage host did not exit');
      assert.deepEqual(exit, { code: 0, signal: null }); normalExit = true;
      for (const path of [location, defaults, migrations, join(profile.roamingAppData, 'kcoder-studio')]) await absent(path);
      result = { passed: true, choice, actualInstalledElectron: true, actualNativeDialog: true, normalExit: exit,
        locationAbsent: true, businessRootsAbsent: true, modelCalls: 0, observedTurnStarts: 0, dialogs };
    } else {
      const selected = upgrade ? null : await until(async () => { try { return JSON.parse(await readFile(location, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } });
      if (!upgrade) {
        assert.ok(same(selected.dataRoot, dataRoot)); assert.ok(same(selected.cacheRoot, cacheRoot));
        assert.equal(selected.revision, relocatedRead ? 2 : 1); assert.equal(selected.operationId ?? null, moved?.operationId ?? null);
        if (cold) assert.deepEqual(await readFile(location), recordBefore, 'Reinstallation and cold startup retain the exact selection');
        if (!relocatedRead) await absent(join(migrations, 'current.json'));
        if (choice === 'custom') await absent(defaults);
      }
      const inspectorUrl = await until(() => output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1]);
      main = createCdpClient(inspectorUrl); await main.ready;
      const userData = await evaluate(main, "process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron').app.getPath('userData')");
      assert.ok(same(userData, upgradeSetup?.expectedUserData ?? join(dataRoot, 'studio/desktop')));
      const debuggerUrl = new URL(await until(() => output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/)?.[1]));
      assert.equal(await processBirth(), born, 'CDP receipt belongs to the original installed host birth');
      const port = Number(debuggerUrl.port); assert.ok(Number.isInteger(port) && port > 0);
      await until(async () => {
        try { const [savedPort, savedPath] = (await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
          return savedPort === String(port) && savedPath === debuggerUrl.pathname;
        } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      });
      const cdpReceipt = { source: 'original-child-stdio', hostPid: app.pid, creationFileTime: born, browserUrl: debuggerUrl.href, profilePortFileMatched: true };
      // Match the product Gateway startup deadline only for its first committed page.
      const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url)), 300000);
      renderer = createCdpClient(target.webSocketDebuggerUrl, { onEvent: message => {
        if (message.method === 'Network.webSocketFrameSent') {
          try { if (JSON.parse(message.params.response.payloadData).method === 'turn/start') turnStarts++; } catch {}
        }
      } }); await renderer.ready; await renderer.request('Network.enable');
      await until(async () => {
        const frame = (await renderer.request('Page.getFrameTree')).frameTree.frame;
        const document = (await renderer.request('DOM.getDocument', { depth: 3 })).root;
        return isCommittedLoopbackDocument(frame, document);
      });
      await until(() => evaluate(renderer, 'Boolean(document.querySelector(\'[data-testid="desktop-sidebar"]\'))'));
      const cli = upgradeSeed ? null : await execute(identity.nativePath, ['config', 'storage-paths'], { cwd: workspace, env, timeout: 30000, windowsHide: true, maxBuffer: 128 * 1024 });
      const paths = cli ? JSON.parse(cli.stdout) : null;
      if (paths) {
        assert.ok(same(paths.dataRoot, dataRoot)); assert.equal(paths.layout, 'unified');
        const expectedCache = upgrade ? JSON.parse(await readFile(location, 'utf8')).cacheRoot : cacheRoot;
        assert.ok(same(paths.cacheRoot, expectedCache));
      }
      const doctor = await execute(identity.nativePath, ['doctor'], { cwd: workspace, env, timeout: 60000, windowsHide: true, maxBuffer: 256 * 1024 });
      const field = name => doctor.stdout.match(new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'm'))?.[1];
      assert.equal(field('build dirty'), 'false');
      const buildIdentity = { build_commit: field('build commit'), build_dirty: false, executable_sha256: field('executable sha256') };
      assert.equal(manifest.nativeBuild.dirty, false); assert.equal(manifest.packagingSource.dirty, false);
      assert.deepEqual(buildIdentity, { build_commit: manifest.nativeBuild.commit, build_dirty: false, executable_sha256: request.expectedCliSha256 });
      const releaseCommit = field('release commit'); assert.equal(releaseCommit, request.expectedCommit);
      const flow = { request, root, profile, identity, workspace, env, app, born, renderer, main, evaluate, native, until, waitClosed, execute, powershell,
        actualUserData: userData, selected, paths, cdpReceipt };
      if (relocating) {
        const relocation = await runWindowsStorageRelocation(flow); normalExit = true;
        assert.equal(turnStarts, 0);
        return { ...relocation, choice, actualInstalledElectron: true, actualNativeDialog: true, buildIdentity, releaseCommit, cdpReceipt,
          observedTurnStarts: turnStarts, verificationScope: 'installed_storage_settings_offline_relocation' };
      }
      const upgradeOutcome = upgrade ? await (upgradeSeed ? upgradeModule.seedWindowsStorageUpgrade(flow) : upgradeModule.verifyWindowsStorageUpgrade(flow)) : null;
      const restored = relocatedRead ? await verifyWindowsStorageRelocatedRead(flow) : null;
      const markerKey = 'kcoder-owned-storage-first-launch';
      if (!upgrade) {
        if (cold) assert.equal(await evaluate(renderer, `localStorage.getItem(${JSON.stringify(markerKey)})`), request.owner, 'Cold installed profile retains localStorage');
        else await evaluate(renderer, `localStorage.setItem(${JSON.stringify(markerKey)},${JSON.stringify(request.owner)});true`);
      }
      const screenshot = await renderer.request('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(root, `windows-storage-${upgrade ? request.action : relocatedRead ? 'relocated-read' : cold ? 'retained' : 'first-launch'}.png`), Buffer.from(screenshot.data, 'base64'));
      await evaluate(renderer, `(async()=>{const menus=await window.kcoderDesktopMenu.list('en');for(const menu of menus){const quit=menu.entries?.find(row=>row.id==='quit');if(quit){void window.kcoderDesktopMenu.invoke(menu.index,quit.position);return true}}throw Error('Actual installed Quit menu unavailable')})()`);
      const exit = await waitClosed(30000, 'Installed storage normal quit unconfirmed');
      assert.deepEqual(exit, { code: 0, signal: null }); normalExit = true;
      assert.equal(turnStarts, 0, 'Storage acceptance must never submit a model turn');
      if (upgrade) return { ...await upgradeModule.afterWindowsStorageUpgradeQuit(flow, upgradeOutcome, exit), buildIdentity, releaseCommit,
        actualInstalledElectron: true, cdpReceipt, observedTurnStarts: turnStarts, version: manifest.versions.studio };
      result = { passed: true, choice, cold, actualInstalledElectron: true, actualNativeDialog: !cold,
        selection: selected, paths, actualUserData: userData, normalExit: exit,
        localStorageRetained: cold, exactSelectionRetained: cold, modelCalls: 0, observedTurnStarts: turnStarts, dialogs, buildIdentity, releaseCommit,
        ...(restored ? { relocationRestored: restored } : {}), installedIdentity: identity, cdpReceipt, version: manifest.versions.studio,
        verificationScope: relocatedRead ? 'installed_storage_relocated_cold_read' : cold ? 'installed_storage_cold_profile' : 'installed_storage_native_first_launch' };
    }
    return result;
  } finally {
    renderer?.close(); main?.close();
    // A failure remains failed. Only this original process tree may be stopped.
    if (!normalExit && app.exitCode === null) await execute('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }).catch(() => {});
    // Project only closed diagnostic codes; URLs, login codes, tokens and Cookie values stay in memory.
    await writeFile(join(root, `windows-storage-host-${request.action}.json`), JSON.stringify({ owner: request.owner,
      pid: app.pid, creationFileTime: born, exitCode: app.exitCode, signal: app.signalCode,
      ...projectWindowsStorageStartupFailure(output) }), { mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const request = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''));
  process.stdout.write(JSON.stringify(await runWindowsInstalledStorageProbe(request)) + '\n');
}
