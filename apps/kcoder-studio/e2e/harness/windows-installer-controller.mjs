import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { spawnWindowsSupervised, stopSupervisedProcess } from './owned-process.mjs';

// This adapter only joins the existing installer account actor to the existing
// supervisor's control pipe. It owns no alternate process or account manager.
assert.equal(process.platform, 'win32');
const root = process.argv[2];
const interactive = process.argv[3] === '--interactive-descriptor';
const authority = interactive ? null : createInterface({ input: process.stdin });
let active, finished = false;
authority?.on('close', () => { if (!finished) active?.child.stdin.destroy(); });
let request;
if (interactive) {
  const descriptor = JSON.parse((await readFile(process.argv[4], 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(descriptor.mode, 'installer-storage');
  assert.equal(descriptor.root, root);
  assert.equal(descriptor.request.directory, root);
  assert.ok(Number.isSafeInteger(descriptor.sessionId) && descriptor.sessionId > 0);
  assert.ok(descriptor.request.profileQualificationOnly || descriptor.request.storageOnly || descriptor.request.storageUpgrade);
  assert.ok(!descriptor.request.exerciseUI && !descriptor.request.nativeComponents && !('password' in descriptor.request));
  const temporary = join(root, 'interactive-temp');
  await mkdir(temporary, { recursive: false });
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = temporary;
  const probe = '$i=[Security.Principal.WindowsIdentity]::GetCurrent();@{sid=$i.User.Value;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;interactive=[Environment]::UserInteractive;admin=([Security.Principal.WindowsPrincipal]::new($i)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress';
  const caller = JSON.parse((await promisify(execFile)(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 })).stdout);
  assert.equal(caller.sid, descriptor.sid); assert.equal(caller.sessionId, descriptor.sessionId);
  assert.equal(caller.interactive, true); assert.equal(caller.admin, true);
  await writeFile(join(root, 'windows-interactive-caller.json'), JSON.stringify(caller), { flag: 'wx' });
  // The Task owns this mode's lifetime; its exit closes the original Job control pipe.
  // No QA password is persisted in its descriptor or Task arguments.
  request = { ...descriptor.request, password: randomBytes(32).toString('hex') + 'aA9!', interactiveSession: descriptor.sessionId };
} else {
  request = await new Promise((accept, reject) => {
    authority.once('line', line => { try { accept(JSON.parse(line)); } catch { reject(Error('Invalid installer request')); } });
    authority.once('close', () => reject(Error('Installer authority disconnected before request')));
  });
}
assert.equal(root, request.directory);
assert.match(request.owner, /^[a-f0-9-]{36}$/);
const marker = JSON.parse(await readFile(join(root, '.owner.json'), 'utf8'));
assert.equal(marker.owner, request.owner); assert.equal(marker.username, request.username);
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = join(root, 'probe-supervisor.exe');
const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'COMPUTERNAME', 'COMSPEC', 'PATHEXT', ...(interactive ? ['TEMP', 'TMP', 'TMPDIR', 'SystemDrive'] : [])]
  .filter(name => process.env[name]).map(name => [name, process.env[name]]));
environment.KCODER_E2E_INSTALLER_REQUEST = JSON.stringify(request);
const waitFor = async (predicate, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; if (active?.identity.closed) { const ended = await active.identity.closedPromise; throw Error(`Owned normal-logon session exited before qualification (${ended.code}): ${errorOutput.slice(-2500)}`); } await new Promise(accept => setTimeout(accept, 50)); }
  throw Error('Installer qualification deadline');
};
const json = async leaf => { try { return JSON.parse(await readFile(join(root, leaf), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const actorEvents = async step => (await readFile(join(root, `actor-${step}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
const exactActorGone = async event => {
  assert.ok(Number.isSafeInteger(event.pid) && event.pid > 0); assert.match(event.creationFileTime, /^\d+$/);
  const script = `$p=Get-Process -Id ${event.pid} -ErrorAction SilentlyContinue;if($p -and $p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ceq '${event.creationFileTime}'){throw 'Original normal-logon actor is still alive'};@{originalActorGone=$true}|ConvertTo-Json -Compress`;
  const result = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10000, windowsHide: true });
  return JSON.parse(result.stdout.trim()).originalActorGone;
};
let output = '', errorOutput = '', failure, result;
try {
  active = spawnWindowsSupervised(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'session.ps1'), '-RunRoot', root],
    { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }, join(root, 'process-status'));
  active.child.stdout.setEncoding('utf8'); active.child.stderr.setEncoding('utf8');
  active.child.stdout.on('data', bytes => { output += bytes; });
  active.child.stderr.on('data', bytes => { errorOutput = (errorOutput + bytes).slice(-8192); });
  const ready = await active.identity.readyPromise;
  if (request.profileQualificationOnly) {
    const profileWait = await waitFor(() => json('qualification-wait-ready.json'));
    if (interactive) { assert.equal(profileWait.profile.userInteractive, true); assert.equal(profileWait.profile.sessionId, request.interactiveSession); assert.equal(profileWait.profile.isAdmin, false); }
    const normal = await actorEvents(1), waiting = await actorEvents(2);
    assert.deepEqual(normal.map(event => event.event), ['born', 'exited']);
    assert.equal(normal[1].exitCode, 0); assert.equal(normal[1].exitAuthority, 'original-process-handle');
    assert.equal(waiting[0].event, 'born'); assert.equal(waiting[0].inJob, true);
    // Deliberately exercise EOF, rather than a replacement KILL request.
    active.child.stdin.destroy();
    let eofTimer;
    try { await Promise.race([active.identity.closedPromise, new Promise((_, reject) => { eofTimer = setTimeout(() => reject(Error('Original supervisor EOF exit unconfirmed')), 15000); })]); }
    finally { clearTimeout(eofTimer); }
    assert.equal(await exactActorGone(waiting[0]), true);
    assert.equal(await exactActorGone(normal[0]), true);
    result = { passed: true, verificationScope: 'owned_windows_os_profile_qualification', profile: profileWait.profile,
      modelCalls: 0, installersInvoked: 0, personalHkcuRead: false,
      actors: { normal, interrupted: waiting },
      supervision: { helperPid: active.child.pid, targetPid: ready.pid, nonce: active.identity.nonce,
        controlEofExercised: true, helperClosed: true, originalActorsGone: true, exitAuthority: 'original-supervisor-job-and-process-birth' } };
  } else {
    const closed = await active.identity.closedPromise;
    if (closed.code !== 0) throw Error(`Owned installer session failed (${closed.code}): ${errorOutput.slice(-2500)}`);
    result = JSON.parse(output.trim());
    result.supervision = { helperPid: active.child.pid, targetPid: ready.pid, nonce: active.identity.nonce,
      helperClosed: true, exitAuthority: 'original-supervisor-job-empty' };
  }
  finished = true; authority?.close();
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) { failure = error; throw error; }
finally {
  finished = true; authority?.close();
  try { if (active) await stopSupervisedProcess(active.child, active.identity, { timeoutMs: 15000 }); }
  catch (error) { failure = error; throw error; }
  finally {
    if (interactive) {
      const safeFailure = failure ? String(failure.stack ?? failure).split(request.password).join('[REDACTED]') : null;
      await writeFile(join(root, 'windows-interactive-installer-result.json'), JSON.stringify({ result, failure: safeFailure }), { flag: 'wx' });
      await writeFile(join(root, 'channel-scope-result.json'), JSON.stringify({ passed: !failure, failure: safeFailure }), { flag: 'wx' });
    }
  }
}
