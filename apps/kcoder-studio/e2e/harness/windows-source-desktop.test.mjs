import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { validateWindowsSourceReceipt, windowsSourceLifecycle } from './windows-source-desktop.mjs';

const request = { owner: '12345678-1234-1234-1234-123456789abc', executable: 'D:\\owned\\electron.exe' };
const station = 'KCoderSourceE2E_12345678123412341234123456789abc';
const child = { pid: 101, exitCode: null, signalCode: null };
test('actual Windows PowerShell atomically publishes consecutive private desktop receipts', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-receipt-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('windows-source-receipt.verify.ps1', import.meta.url)),
    '-SourcePath', fileURLToPath(new URL('windows-source-desktop.ps1', import.meta.url)), '-Root', root,
  ], { timeout: 30000 });
  assert.match(stdout, /PASS: actual PowerShell receipt/);
});
function receipt(released = false) {
  return { version: 1, owner: request.owner, phase: released ? 'released' : 'ready',
    windowStation: station, desktop: `${station}\\Default`,
    wrapper: { pid: 102, parentPid: 101, sessionId: 0, inJob: true },
    electron: { pid: 103, sessionId: 0, inJob: true, imagePath: request.executable, creationTicks: '133333333333333333' },
    nativeWindow: { hwnd: '0xabc', pid: 103, className: 'Chrome_WidgetWin_1', visible: true },
    handles: { station: !released, desktop: !released, process: !released } };
}

test('receipt binds a real native window to the exact run, supervisor, session, Job and image', () => {
  assert.equal(validateWindowsSourceReceipt(receipt(), request, child.pid).nativeWindow.hwnd, '0xabc');
  assert.equal(validateWindowsSourceReceipt(receipt(true), request, child.pid, { released: true }).phase, 'released');
  const mutations = [
    value => { value.owner = 'other'; },
    value => { value.wrapper.parentPid++; },
    value => { value.wrapper.sessionId = 1; },
    value => { value.wrapper.inJob = false; },
    value => { value.windowStation = 'unowned'; },
    value => { value.desktop = 'unowned\\Default'; },
    value => { value.electron.sessionId = 1; },
    value => { value.electron.inJob = false; },
    value => { value.electron.imagePath = 'C:\\personal\\electron.exe'; },
    value => { value.electron.creationTicks = ''; },
    value => { value.nativeWindow.hwnd = '0x0'; },
    value => { value.nativeWindow.pid++; },
    value => { value.nativeWindow.className = 'fake-browser'; },
    value => { value.nativeWindow.visible = false; },
    value => { value.handles.desktop = false; },
  ];
  for (const mutate of mutations) { const value = receipt(); mutate(value); assert.throws(() => validateWindowsSourceReceipt(value, request, child.pid)); }
  const retained = receipt(true); retained.handles.station = true;
  assert.throws(() => validateWindowsSourceReceipt(retained, request, child.pid, { released: true }));
});

test('private desktop receipts remain bound to a nonzero launching session', () => {
  const value = receipt();
  value.wrapper.sessionId = 3; value.electron.sessionId = 3;
  value.inheritedWindowStation = true; value.inheritedStationVisible = true;
  value.windowStation = 'inherited-fixture-station'; value.desktop = `${value.windowStation}\\${station}`;
  value.handles.station = false;
  assert.equal(validateWindowsSourceReceipt(value, { ...request, sessionId: 3 }, child.pid).wrapper.sessionId, 3);
  assert.throws(() => validateWindowsSourceReceipt(value, { ...request, sessionId: 4 }, child.pid));
  value.electron.sessionId = 4;
  assert.throws(() => validateWindowsSourceReceipt(value, { ...request, sessionId: 3 }, child.pid));
  value.electron.sessionId = 3; value.handles.station = true;
  assert.throws(() => validateWindowsSourceReceipt(value, { ...request, sessionId: 3 }, child.pid));
  value.handles.station = false; value.inheritedStationVisible = false;
  assert.throws(() => validateWindowsSourceReceipt(value, { ...request, sessionId: 3 }, child.pid));
});

test('release closes the exact owner once, waits for its handle receipt, then stops the Job', async () => {
  const calls = []; let row = receipt();
  const lifecycle = windowsSourceLifecycle({ request, readReceipt: async () => row,
    writeStop: async () => { calls.push('stop-owner'); row = receipt(true); },
    archive: async (value, cleanup) => calls.push([cleanup ? 'cleanup' : 'host', value.phase]),
    stopOwned: async () => calls.push('stop-job'),
  });
  await lifecycle.ready(child);
  await Promise.all([lifecycle.close(child), lifecycle.close(child)]);
  assert.deepEqual(calls, [['host', 'ready'], 'stop-owner', 'stop-job', ['cleanup', 'released']]);
});

test('missing or failed window receipts reject startup without a default desktop retry', async () => {
  for (const row of [null, { phase: 'failed', error: 'CreateDesktop denied' }]) {
    let stops = 0;
    const lifecycle = windowsSourceLifecycle({ request, timeoutMs: 1, releaseTimeoutMs: 1,
      readReceipt: async () => row, writeStop: async () => {}, archive: async () => {}, stopOwned: async () => { stops++; },
    });
    await assert.rejects(lifecycle.ready(child), row ? /CreateDesktop denied/ : /Timed out/);
    await assert.rejects(lifecycle.close(child));
    assert.equal(stops, 1, 'failed startup must still revoke the owned Job');
  }
  const exited = windowsSourceLifecycle({ request, readReceipt: async () => receipt(), archive: async () => {} });
  await assert.rejects(exited.ready({ ...child, exitCode: 1 }), /exited before/);
});

test('missing, wrong-owner or incomplete release stays failed even after Job cleanup', async () => {
  for (const failureKind of ['missing', 'wrong-owner', 'open-handle', 'stop-write']) {
    let row = receipt(); const calls = [];
    const lifecycle = windowsSourceLifecycle({ request, releaseTimeoutMs: 1,
      readReceipt: async () => row,
      writeStop: async () => {
        if (failureKind === 'stop-write') throw new Error('stop write failed');
        row = failureKind === 'missing' ? null : receipt(true);
        if (failureKind === 'wrong-owner') row.owner = 'other';
        if (failureKind === 'open-handle') row.handles.process = true;
      },
      stopOwned: async () => calls.push('job-stopped'), archive: async (_value, cleanup) => { if (cleanup) calls.push('cleanup-retained'); },
    });
    await lifecycle.ready(child);
    await assert.rejects(lifecycle.close(child));
    assert.deepEqual(calls, ['job-stopped', 'cleanup-retained']);
  }
});

test('Windows source adapters cannot change users, select an input desktop or emit compilation outside the run', async () => {
  const code = await readFile(new URL('windows-source-desktop.cs', import.meta.url), 'utf8');
  const script = await readFile(new URL('windows-source-desktop.ps1', import.meta.url), 'utf8');
  assert.doesNotMatch(code + script, /WinSta0|SwitchDesktop|OpenInputDesktop|SetThreadDesktop|CreateProcessWithLogon|WTSQueryUserToken|SendInput|ScheduledTask|New-LocalUser|reg\.exe/i);
  assert.match(code, /Desktop=desktopName/);
  assert.match(code, /CreateWindowStation\(stationName,1,/);
  assert.match(code, /Session\(wrapperPid\)!=ownerSession\|\|!InJob/);
  assert.match(code, /electronSession=Session\(electronPid\)/);
  assert.match(code, /electronSession!=ownerSession\|\|!electronInJob/);
  assert.match(code, /GetWindowThreadProcessId\(candidate,out currentOwner\)!=0&&currentOwner==electronPid/);
  assert.match(code, /windowRestoreRequested=true;[\s\S]*ShowWindowAsync\(candidate,1\)/);
  assert.match(code, /new IntPtr\(0x20002\)/, 'stdio inheritance must use an explicit handle allowlist');
  for (const name of ['CloseDesktop', 'CloseWindowStation', 'CloseHandle']) assert.match(code, new RegExp(name + '\\('));
  assert.match(script, /\$assembly=Assert-OwnedPath/);
  assert.match(script, /Add-Type[^\n]+-OutputAssembly \$assembly/);
  assert.match(script, /\$desktopOwner\.Dispose\(\)/);
  assert.match(script, /\$authority\.owner -cne \$configuration\.owner/);
});
