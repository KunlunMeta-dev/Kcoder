import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { win32, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { waitFor } from './run-context.mjs';
import { prepareWindowsHome } from './windows-user-profile.mjs';

const sources = ['windows-source-desktop.ps1', 'windows-source-desktop.cs']
  .map(name => fileURLToPath(new URL(name, import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function absoluteWindowsPath(value) {
  assert.ok(typeof value === 'string' && /^[A-Za-z]:\\/.test(value) && !/[\0\r\n]/.test(value), 'Explicit local Windows path required');
  return win32.normalize(value);
}

export function validateWindowsSourceReceipt(value, request, supervisorPid, { released = false } = {}) {
  assert.equal(value.version, 1);
  assert.equal(value.owner, request.owner, 'private desktop owner changed');
  assert.equal(value.phase, released ? 'released' : 'ready');
  assert.ok(Number.isSafeInteger(supervisorPid) && supervisorPid > 0, 'Windows supervisor PID is required');
  assert.equal(value.wrapper.parentPid, supervisorPid, 'private desktop wrapper must belong to this run supervisor');
  assert.ok(Number.isSafeInteger(value.wrapper.pid) && value.wrapper.pid > 0);
  const expectedSession = request.sessionId ?? 0;
  assert.ok(Number.isSafeInteger(expectedSession) && expectedSession >= 0, 'launching Windows session is required');
  assert.equal(value.wrapper.sessionId, expectedSession, 'source desktop must stay in its launching session');
  assert.equal(value.wrapper.inJob, true);
  const station = `KCoderSourceE2E_${request.owner.replaceAll('-', '')}`;
  if (expectedSession > 0) {
    assert.equal(value.inheritedWindowStation, true);
    assert.equal(value.inheritedStationVisible, true);
    assert.match(value.windowStation, /^[^\\/\x00\r\n]{1,256}$/);
    assert.equal(value.desktop, `${value.windowStation}\\${station}`);
  } else {
    assert.equal(Boolean(value.inheritedWindowStation), false);
    assert.equal(value.windowStation, station);
    assert.equal(value.desktop, `${station}\\Default`);
  }
  assert.equal(value.electron.sessionId, expectedSession);
  assert.equal(value.electron.inJob, true);
  assert.ok(Number.isSafeInteger(value.electron.pid) && value.electron.pid > 0 && value.electron.pid !== value.wrapper.pid);
  assert.match(value.electron.creationTicks, /^[1-9][0-9]+$/);
  assert.equal(absoluteWindowsPath(value.electron.imagePath).toLowerCase(), absoluteWindowsPath(request.executable).toLowerCase());
  assert.equal(value.nativeWindow.pid, value.electron.pid);
  assert.match(value.nativeWindow.hwnd, /^0x[1-9a-f][0-9a-f]*$/i);
  assert.equal(value.nativeWindow.className, 'Chrome_WidgetWin_1');
  assert.equal(value.nativeWindow.visible, true);
  assert.equal(value.handles.station, expectedSession === 0 && !released);
  assert.equal(value.handles.desktop, !released);
  assert.equal(value.handles.process, !released);
  return value;
}

export function windowsSourceLifecycle({ request, readReceipt, writeStop, archive, stopOwned, signal, timeoutMs = 60000, releaseTimeoutMs = 4000 }) {
  let readyReceipt;
  let closePromise;
  return {
    async ready(child) {
      const receipt = await waitFor(async () => {
        const row = await readReceipt();
        if (row?.phase === 'failed') throw new Error(`Private Windows desktop failed: ${row.error}`);
        if (child.exitCode != null || child.signalCode != null) throw new Error('Private Windows desktop exited before its window receipt');
        return row?.phase === 'ready' ? row : null;
      }, timeoutMs, 'owned Win32 Electron window', 50, signal);
      readyReceipt = validateWindowsSourceReceipt(receipt, request, child.pid);
      await archive(readyReceipt, false);
      return readyReceipt;
    },
    close(child) {
      closePromise ??= (async () => {
        let receipt;
        let failure;
        try {
          if (child.exitCode == null && child.signalCode == null) await writeStop();
          receipt = await waitFor(async () => {
            const row = await readReceipt();
            return row?.phase === 'released' || row?.phase === 'failed' ? row : null;
          }, releaseTimeoutMs, 'private Windows desktop handle release');
          if (readyReceipt) validateWindowsSourceReceipt(receipt, request, child.pid, { released: true });
          else {
            assert.equal(receipt.version, 1);
            assert.equal(receipt.owner, request.owner);
            assert.equal(receipt.phase, 'released', 'private desktop startup did not confirm handle release');
            assert.deepEqual(receipt.handles, { station: false, desktop: false, process: false });
          }
        } catch (error) { failure = error; }
        finally { try { await stopOwned(); } catch (error) { failure ??= error; } }
        await archive(receipt ?? { phase: 'release-unconfirmed', owner: request.owner }, true);
        if (failure) throw failure;
      })();
      return closePromise;
    },
  };
}

/** Prepare only run-owned files. The caller must launch through RunContext.spawnOwned. */
export async function prepareWindowsSourceDesktop(context, { label, electron, args, cwd, env, executable }) {
  assert.match(label, /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/);
  const supervisor = absoluteWindowsPath(process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN);
  await executable(supervisor, 'Windows process supervisor');
  const powershell = await executable(win32.join(absoluteWindowsPath(process.env.SystemRoot), 'System32/WindowsPowerShell/v1.0/powershell.exe'), 'Windows PowerShell');
  const observation = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${process.pid} -ErrorAction Stop).SessionId`], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const sessionId = Number(observation.stdout.trim());
  assert.ok(Number.isSafeInteger(sessionId) && sessionId >= 0, 'Unable to observe the launching Windows session');
  const owner = randomUUID();
  const root = context.pathInState(`${label}-windows-owner`);
  env = await prepareWindowsHome(context, env, { home: env.USERPROFILE, temporaryDirectory: env.TEMP });
  await mkdir(root, { recursive: false, mode: 0o700 });
  const receiptPath = win32.join(root, 'host-receipt.json');
  const stopPath = win32.join(root, 'stop.json');
  const inputSources = await Promise.all(sources.map(async path => ({ path, sha256: digest(await readFile(path)) })));
  const request = { version: 1, owner, sessionId, root: absoluteWindowsPath(root),
    executable: absoluteWindowsPath(electron), args, cwd: absoluteWindowsPath(cwd),
    receiptPath, stopPath, assemblyPath: win32.join(root, 'desktop-owner.dll'),
    sourcePath: absoluteWindowsPath(sources[1]), sourceSha256: inputSources[1].sha256 };
  const requestPath = await context.writeStateJson(`${label}-windows-owner/request.json`, request);
  const cleanupArtifact = context.pathInArtifacts(`${label}-windows-cleanup.json`);
  const readReceipt = async () => {
    try { return JSON.parse(await readFile(receiptPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const archive = async (receipt, cleanup) => {
    const after = await Promise.all(inputSources.map(async source => ({ ...source, unchanged: digest(await readFile(source.path)) === source.sha256 })));
    assert.ok(after.every(source => source.unchanged), 'Windows desktop helper source changed during the run');
    const data = { receipt, sources: after,
      launch: { executable: request.executable, args: request.args, cwd: request.cwd, sessionId: request.sessionId } };
    if (cleanup) await writeFile(cleanupArtifact, JSON.stringify(context.redactValue(data), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    else await context.writeArtifactJson(`${label}-windows-host.json`, data);
  };
  return {
    command: powershell,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(sources[0]), '-Request', requestPath],
    options: { cwd, env: { ...env, PSModulePath: win32.join(win32.dirname(powershell), 'Modules') } },
    ...windowsSourceLifecycle({ request, readReceipt, archive, signal: context.abortSignal,
      stopOwned: () => context.stopOwned(label),
      writeStop: async () => {
        const temporary = stopPath + '.tmp';
        await writeFile(temporary, JSON.stringify({ version: 1, owner }) + '\n', { flag: 'wx', mode: 0o600 });
        await rename(temporary, stopPath);
      },
    }),
  };
}
