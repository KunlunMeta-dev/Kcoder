import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, rename, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { spawnWindowsSupervised, stopSupervisedProcess } from './owned-process.mjs';
import { assertVhdImageIdentity, vhdReadyEvent } from './windows-storage-native-proof.mjs';
import { psLiteral } from './windows-owned-root.mjs';

const execute = promisify(execFile);
const delay = ms => new Promise(accept => setTimeout(accept, ms));

// Only the installer admin actor starts this bounded volume owner, after seed
// and normal quit. Its original stdin must remain open until product readback.
async function main() {
  assert.equal(process.platform, 'win32');
  const root = resolve(process.argv[2]);
  const marker = JSON.parse(await readFile(join(root, '.owner.json'), 'utf8'));
  const input = JSON.parse(await readFile(join(root, 'storage-volume-request.json'), 'utf8'));
  assert.equal(input.owner, marker.owner);
  assert.match(input.owner, /^[a-f0-9-]{36}$/);
  assert.match(input.qaSid, /^S-1-5-21-\d+-\d+-\d+-\d+$/);
  assert.match(input.fixtureSha256, /^[a-f0-9]{64}$/);
  const fixture = join(root, 'storage-vhd-tests.exe'), hash = createHash('sha256');
  const info = await lstat(fixture);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
  for await (const bytes of createReadStream(fixture)) hash.update(bytes);
  assert.equal(hash.digest('hex'), input.fixtureSha256);
  const authority = createInterface({ input: process.stdin });
  let disconnected = false;
  authority.on('close', () => { disconnected = true; });
  const first = await new Promise((accept, reject) => {
    authority.once('line', line => { try { accept(JSON.parse(line)); } catch { reject(Error('Invalid volume owner')); } });
    authority.once('close', () => reject(Error('Volume owner disconnected before start')));
  });
  assert.deepEqual(first, { owner: input.owner });
  const ps = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const powershell = async script => {
    const result = await execute(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 60000, maxBuffer: 128 * 1024,
      env: { ...process.env, KCODER_E2E_OWNED_VHDX_ROOT: root } });
    return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  };
  const publish = async (leaf, value) => {
    await writeFile(join(root, leaf + '.tmp'), JSON.stringify(value), { flag: 'wx' });
    await rename(join(root, leaf + '.tmp'), join(root, leaf));
  };
  process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = join(root, 'probe-supervisor.exe');
  await writeFile(join(root, 'vhdx-request.json'), JSON.stringify({ owner: input.owner,
    maximum_size_bytes: 64 * 1024 * 1024, budget_ms: 600000 }), { flag: 'wx' });
  const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']
    .filter(name => process.env[name]).map(name => [name, process.env[name]]));
  environment.KCODER_E2E_OWNED_VHDX_ROOT = root;
  assert.equal(disconnected, false, 'Original admin actor disconnected before volume start');
  const active = spawnWindowsSupervised(fixture,
    ['--ignored', '--exact', 'owned_vhdx_fixture', '--nocapture', '--test-threads=1'],
    { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] }, join(root, 'process-status'));
  let output = '', diagnostic = '', ready, image, failure, receipt, detached, jobExit;
  const collect = (field, bytes) => {
    if (field === 'stdout') output += bytes; else diagnostic += bytes;
    if (output.length + diagnostic.length > 128 * 1024) active.child.stdin.destroy();
    for (const line of output.split(/\r?\n/).slice(0, -1)) ready ??= vhdReadyEvent(line);
  };
  active.child.stdout.on('data', bytes => collect('stdout', bytes));
  active.child.stderr.on('data', bytes => collect('stderr', bytes));
  try {
    await active.identity.readyPromise;
    const deadline = Date.now() + 60000;
    while (!ready) {
      assert.ok(!disconnected && !active.identity.closed && Date.now() < deadline, 'Original volume owner or READY deadline lost');
      await delay(50);
    }
    assert.equal(ready.owner, input.owner);
    assert.equal(ready.image_path, join(root, 'cross-volume.vhdx'));
    image = await open(ready.image_path, 'r');
    assertVhdImageIdentity(ready, await lstat(ready.image_path, { bigint: true }), await image.stat({ bigint: true }));
    const births = await powershell(`$u=Get-LocalUser -Name ${psLiteral(marker.username)};if($u.SID.Value -cne ${psLiteral(input.qaSid)}){throw 'Original QA account changed'};@{helperCreationTicks=(Get-Process -Id ${active.identity.pid}).StartTime.ToUniversalTime().Ticks.ToString();targetCreationTicks=(Get-Process -Id ${active.identity.targetPid}).StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress`);
    await publish('vhdx-ready.json', { group: 'vhd-config-cross-volume', ready,
      job: { helperPid: active.identity.pid, targetPid: active.identity.targetPid, ...births } });
    const prepareScript = await readFile(join(root, 'storage-volume-prepare.ps1'), 'utf8');
    assert.ok(!disconnected && !active.identity.closed, 'Original volume authority lost before disk preparation');
    const prepared = await powershell(prepareScript);
    assert.match(prepared.parent, /^[D-Z]:\\$/);
    const destination = join(prepared.parent, 'kcoder-storage-' + input.owner);
    const setup = `$volume=Get-Volume -DriveLetter ${psLiteral(prepared.driveLetter)};if($volume.UniqueId -cne ${psLiteral(prepared.volumeUniqueId)}){throw 'Original volume changed'};` +
      `$p=${psLiteral(destination)};if(Test-Path -LiteralPath $p){throw 'Volume target collision'};[IO.Directory]::CreateDirectory($p)|Out-Null;` +
      `& icacls $p /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+':(OI)(CI)F') ${psLiteral('*' + input.qaSid + ':(OI)(CI)M')}|Out-Null;if($LASTEXITCODE -ne 0){throw 'Owned SID volume access failed'};` +
      `[IO.Directory]::CreateDirectory((Join-Path $p 'data'))|Out-Null;[IO.Directory]::CreateDirectory((Join-Path $p 'cache'))|Out-Null;` +
      `$logical=Get-CimInstance Win32_LogicalDisk -Filter ${psLiteral("DeviceID='" + prepared.driveLetter + ":'")};@{volumeSerialNumber=$logical.VolumeSerialNumber}|ConvertTo-Json -Compress`;
    assert.ok(!disconnected && !active.identity.closed, 'Original volume authority lost before target creation');
    const serial = await powershell(setup);
    assert.match(serial.volumeSerialNumber, /^[a-fA-F0-9]{8}$/);
    assert.ok(!disconnected && !active.identity.closed, 'Original owner must remain alive when admitting its volume');
    receipt = { version: 1, owner: input.owner, qaSid: input.qaSid, root: prepared.parent,
      dataRoot: join(destination, 'data'), cacheRoot: join(destination, 'cache'), volumeSerialNumber: serial.volumeSerialNumber };
    await publish('windows-storage-owned-volume.json', receipt);
    while (!disconnected) {
      assert.equal(active.identity.closed, false, 'Original volume Job exited before product readback');
      await delay(100);
    }
  } catch (error) { failure = error; }
  finally {
    try {
      if (ready) {
        assert.equal(active.identity.closed, false, 'Original VHD exited before its owned STOP');
        await publish('stop.json', { owner: input.owner, command: 'STOP' });
        const deadline = Date.now() + 20000;
        while (!active.identity.closed && Date.now() < deadline) await delay(50);
        assert.equal(active.identity.closed, true, 'Original VHD STOP did not complete');
      }
    } catch (error) { failure ??= error; }
    try {
      await stopSupervisedProcess(active.child, active.identity, { timeoutMs: 15000 });
      jobExit = await active.identity.closedPromise;
      assert.equal(jobExit.code, 0, diagnostic);
    }
    catch (error) { failure ??= error; }
    try {
      if (ready) {
        detached = await powershell(`$v=Get-DiskImage -ImagePath ${psLiteral(ready.image_path)};if($v.Attached){throw 'Original image still attached'};@{attached=[bool]$v.Attached;imagePath=$v.ImagePath}|ConvertTo-Json -Compress`);
        assertVhdImageIdentity(ready, await lstat(ready.image_path, { bigint: true }), await image.stat({ bigint: true }));
      }
    } catch (error) { failure ??= error; }
    finally { await image?.close(); authority.close(); }
    await publish('windows-storage-volume-result.json', { passed: !failure, ready: ready ?? null,
      selection: receipt ?? null, detached: detached ?? null, jobClosed: active.identity.closed, jobExit: jobExit ?? null,
      stdout: output, stderr: diagnostic, ...(failure ? { error: failure.message } : {}) });
  }
  if (failure) throw failure;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
