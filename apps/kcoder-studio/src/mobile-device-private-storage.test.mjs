import { once } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rename, link, symlink, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsPrivateDeviceStorage, windowsPrivateStorageCommandLineLength } from './mobile-device-private-storage.js';

async function fixture(t, prefix = 'kcoder-private-device-') {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, 'private');
  await mkdir(directory);
  return { parent, directory };
}

const windows = { skip: process.platform !== 'win32' && 'Windows ACL and file identity require Windows', timeout: 30_000 };
const unavailable = reason => error => error.code === 'MOBILE_DEVICE_STORAGE_UNAVAILABLE' && error.reason === reason;
const encodedPowerShell = source => Buffer.from(source, 'utf16le').toString('base64');
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

async function inheritedFixture(t, prefix = 'kcoder-private-inherited-') {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(parent, { recursive: true, force: true }));
  execFileSync('icacls.exe', [parent, '/grant', '*S-1-1-0:(OI)(CI)(R)'], { windowsHide: true, stdio: 'pipe' });
  const directory = join(parent, 'private');
  await mkdir(directory);
  setCurrentUserOwner(directory);
  return { parent, directory };
}

function inspectAcl(paths) {
  const quoted = paths.map(psQuote).join(',');
  const source = `$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$paths=@(${quoted});$rows=@();foreach($path in $paths){$acl=Get-Acl -LiteralPath $path;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;$allowed=@($acl.Access|Where-Object{$_.AccessControlType -eq 'Allow'}|ForEach-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value});$rows+=,[pscustomobject]@{Path=$path;Owner=$owner;User=$user;Protected=$acl.AreAccessRulesProtected;Allowed=$allowed;Sddl=$acl.Sddl}};ConvertTo-Json -InputObject $rows -Compress -Depth 4`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(source)], { encoding: 'utf8', windowsHide: true });
  const value = JSON.parse(output);
  return Array.isArray(value) ? value : [value];
}

function trySetOwner(path, sid) {
  try {
    execFileSync('icacls.exe', [path, '/setowner', `*${sid}`], { windowsHide: true, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function setCurrentUserOwner(path) {
  const { Owner, User } = inspectAcl([path])[0];
  if (Owner !== User) {
    execFileSync('icacls.exe', [path, '/setowner', `*${User}`], { windowsHide: true, stdio: 'pipe' });
  }
}

async function writeCurrentUserOwned(path, contents) {
  await writeFile(path, contents);
  setCurrentUserOwner(path);
}

function storeLockPort(identity) {
  return 49_152 + (createHash('sha256').update(identity, 'utf8').digest().readUInt32BE(0) % 16_384);
}

async function listenForStore(identity, t) {
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      const listening = () => { server.off('error', failed); resolve(); };
      const failed = error => { server.off('listening', listening); reject(error); };
      server.once('error', failed);
      server.once('listening', listening);
      server.listen({ host: '127.0.0.1', port: storeLockPort(identity), exclusive: true });
    });
  } catch (error) {
    try { server.close(); } catch {}
    if (['EADDRINUSE', 'EACCES'].includes(error.code)) {
      t.skip('The fixture-derived loopback lease port is already occupied');
      return null;
    }
    throw error;
  }
  const close = () => server.listening ? new Promise(resolve => server.close(() => resolve())) : Promise.resolve();
  t.after(close);
  return { server, close };
}

async function inheritedLeaseFixture(t) {
  const { directory } = await inheritedFixture(t, 'kcoder-private-store-lease-');
  const identity = await windowsPrivateDeviceStorage(directory, true);
  execFileSync('icacls.exe', [directory, '/inheritance:e'], { windowsHide: true, stdio: 'pipe' });
  const keyPath = join(directory, '.key');
  const key = 'lease-fixture-preserved-key';
  await writeCurrentUserOwned(keyPath, key);
  const before = inspectAcl([directory, keyPath]);
  assert.equal(before[0].Protected, false, 'fixture root must inherit its parent ACL');
  assert.ok(before[0].Allowed.includes('S-1-1-0'), 'fixture root must have the inherited broad grant');
  assert.equal(before[1].Protected, false, 'fixture child must inherit the broad root ACL');
  assert.ok(before[1].Allowed.includes('S-1-1-0'), 'fixture child must carry the inherited broad grant');
  return { directory, identity, keyPath, key, before };
}

async function renameChildRepeatedly(file, temporary, settled) {
  let count = 0;
  const deadline = Date.now() + 900;
  while (Date.now() < deadline && !settled()) {
    await rename(file, temporary);
    try { await rename(temporary, file); }
    catch (error) { await rename(temporary, file).catch(() => {}); throw error; }
    count++;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  return count;
}

test('Windows guard bootstrap stays below the CreateProcess command-line budget', () => {
  assert.ok(windowsPrivateStorageCommandLineLength() < 30_000);
});

test('Windows accepts Node-created files with the token default owner and preserves identity and bytes', windows, async t => {
  const { directory } = await fixture(t);
  const identity = await windowsPrivateDeviceStorage(directory, true);
  const key = 'a'.repeat(64);
  await writeFile(join(directory, '.key'), key);
  assert.equal(await windowsPrivateDeviceStorage(directory, false), identity);
  await writeFile(join(directory, 'devices.json.tmp'), '{"version":1}');
  await rename(join(directory, 'devices.json.tmp'), join(directory, 'devices.json'));
  assert.equal(await windowsPrivateDeviceStorage(directory, false), identity);
  assert.equal(await readFile(join(directory, '.key'), 'utf8'), key);
  assert.equal(await readFile(join(directory, 'devices.json'), 'utf8'), '{"version":1}');
});

test('Windows private storage supports Unicode paths through UTF-8 stdin', windows, async t => {
  const { directory } = await fixture(t, 'kcoder-私有-');
  const identity = await windowsPrivateDeviceStorage(directory, true);
  await writeFile(join(directory, '.key'), 'b'.repeat(64));
  assert.equal(await windowsPrivateDeviceStorage(directory, false), identity);
});

test('Windows repairs inherited broad grants on owned storage and isolates the parent ACL', windows, async t => {
  const { parent, directory } = await inheritedFixture(t);
  const key = 'a'.repeat(64), devices = '{"version":1,"devices":[]}';
  const temporary = join(directory, `devices.json.${randomUUID()}.tmp`);
  await writeCurrentUserOwned(join(directory, '.key'), key);
  await writeCurrentUserOwned(join(directory, 'devices.json'), devices);
  await writeCurrentUserOwned(temporary, 'preserve stale device JSON');
  const before = inspectAcl([parent]);
  const identity = await windowsPrivateDeviceStorage(directory, false);
  assert.equal(await windowsPrivateDeviceStorage(directory, false), identity);
  assert.deepEqual(await readFile(join(directory, '.key'), 'utf8'), key);
  assert.deepEqual(await readFile(join(directory, 'devices.json'), 'utf8'), devices);
  assert.deepEqual(await readFile(temporary, 'utf8'), 'preserve stale device JSON');
  const after = inspectAcl([parent, directory, join(directory, '.key'), join(directory, 'devices.json'), temporary]);
  assert.equal(after[0].Sddl, before[0].Sddl, 'repair must not change the parent ACL');
  assert.ok(before[0].Allowed.includes('S-1-1-0'), 'fixture parent must carry the inherited Everyone grant');
  assert.equal(after[1].Owner, after[1].User, 'storage root must belong to the current user');
  const privateSids = new Set([after[1].Owner, 'S-1-5-18']);
  for (const row of after.slice(1)) {
    assert.equal(row.Protected, true, `${row.Path} must stop inheriting grants`);
    assert.deepEqual(new Set(row.Allowed), privateSids, `${row.Path} must allow only its owner and SYSTEM`);
  }
});

test('Windows storage repair waits for the Node lease before opening child handles', windows, async t => {
  const { directory, identity, keyPath, key, before } = await inheritedLeaseFixture(t);
  const lease = await listenForStore(identity, t);
  if (!lease) return;
  let settled = false;
  const repair = windowsPrivateDeviceStorage(directory, false).then(
    value => ({ value }), error => ({ error }),
  ).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(settled, false, 'guard must wait while the Node store lease is held');
  const temporary = join(directory, `devices.json.${randomUUID()}.tmp`);
  assert.ok(await renameChildRepeatedly(keyPath, temporary, () => settled), 'held store lease must not let the guard retain a child no-delete handle');
  assert.deepEqual(inspectAcl([directory, keyPath]).map(row => row.Sddl), before.map(row => row.Sddl), 'guard must not repair ACLs before acquiring the lease');
  await lease.close();
  const result = await repair;
  assert.equal(result.error, undefined);
  assert.equal(result.value, identity);
  assert.equal(await readFile(keyPath, 'utf8'), key);
  assert.ok(inspectAcl([directory, keyPath]).every(row => row.Protected));
});

test('Windows native exclusive bind blocks a Node listener on the same store lease', windows, async t => {
  const { directory } = await fixture(t, 'kcoder-private-native-lease-');
  const identity = await windowsPrivateDeviceStorage(directory, true);
  const port = storeLockPort(identity);
  const source = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System.Net;
using System.Net.Sockets;
public static class KcoderStoreLeaseFixture {
  public static Socket Bind(int port) {
    var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
    socket.ExclusiveAddressUse = true;
    try { socket.Bind(new IPEndPoint(IPAddress.Loopback, port)); return socket; }
    catch { socket.Dispose(); throw; }
  }
}
'@
try { $lease = [KcoderStoreLeaseFixture]::Bind(${port}) }
catch [System.Net.Sockets.SocketException] {
  [Console]::Out.WriteLine('LEASE_BUSY ' + [int]$_.Exception.SocketErrorCode)
  [Console]::Out.Flush()
  exit 0
}
[Console]::Out.WriteLine('LEASE_READY')
[Console]::Out.Flush()
[void][Console]::In.ReadLine()
$lease.Dispose()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(source)], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let stdout = '', stderr = '';
  let resolveMarker;
  const marker = new Promise(resolve => { resolveMarker = resolve; });
  child.stdout.on('data', chunk => {
    stdout = (stdout + chunk.toString('utf8')).slice(-4096);
    const line = stdout.split(/\r?\n/).find(value => value === 'LEASE_READY' || value.startsWith('LEASE_BUSY '));
    if (line) resolveMarker(line);
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
  child.once('error', error => resolveMarker({ error }));
  child.once('exit', (code, signal) => resolveMarker({ code, signal }));
  const closeLease = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.write('\n');
    let timeout;
    const closed = await Promise.race([
      exited.then(() => true),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), 1500); }),
    ]);
    clearTimeout(timeout);
    if (!closed) {
      child.kill('SIGKILL');
      await exited;
    }
  };
  t.after(closeLease);

  let ready;
  let markerTimeout;
  try {
    ready = await Promise.race([
      marker,
      new Promise((_, reject) => { markerTimeout = setTimeout(() => reject(new Error(`Native lease bind timed out: ${stderr}`)), 10_000); }),
    ]);
  } catch (error) {
    await closeLease();
    throw error;
  } finally {
    clearTimeout(markerTimeout);
  }
  if (typeof ready === 'string' && ready.startsWith('LEASE_BUSY ')) {
    await closeLease();
    t.skip(`Fixture-derived loopback lease port is occupied (Winsock ${ready.slice('LEASE_BUSY '.length)})`);
    return;
  }
  assert.equal(ready, 'LEASE_READY', `native lease bind failed: ${JSON.stringify(ready)}; ${stderr}`);

  const blocked = createServer();
  const bindResult = await new Promise(resolve => {
    const listening = () => { blocked.off('error', failed); resolve({ listening: true }); };
    const failed = error => { blocked.off('listening', listening); resolve({ error }); };
    blocked.once('listening', listening);
    blocked.once('error', failed);
    blocked.listen({ host: '127.0.0.1', port, exclusive: true });
  });
  if (bindResult.listening) await new Promise(resolve => blocked.close(resolve));
  assert.equal(bindResult.error?.code, 'EADDRINUSE', 'Node must not acquire a port held by the native exclusive bind');

  await closeLease();
  assert.equal(child.exitCode, 0, `native lease fixture did not exit cleanly: ${stderr}`);
  const available = createServer();
  await new Promise((resolve, reject) => {
    available.once('listening', resolve);
    available.once('error', reject);
    available.listen({ host: '127.0.0.1', port, exclusive: true });
  });
  await new Promise(resolve => available.close(resolve));
});

test('Windows busy store lease times out without ACL changes and allows an explicit retry', windows, async t => {
  const { directory, identity, keyPath, key, before } = await inheritedLeaseFixture(t);
  const lease = await listenForStore(identity, t);
  if (!lease) return;
  let settled = false;
  const outcome = windowsPrivateDeviceStorage(directory, false).then(
    value => ({ value }), error => ({ error }),
  ).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(settled, false, 'guard must wait while the Node store lease is held');
  const temporary = join(directory, `devices.json.${randomUUID()}.tmp`);
  assert.ok(await renameChildRepeatedly(keyPath, temporary, () => settled), 'guard must not hold child handles while waiting for the lease');
  const result = await outcome;
  assert.equal(result.error?.code, 'MOBILE_DEVICE_STORAGE_UNAVAILABLE');
  assert.equal(result.error?.reason, 'store_busy');
  assert.equal(lease.server.listening, true, 'failed lock acquisition must leave the Node lease untouched');
  assert.deepEqual(inspectAcl([directory, keyPath]).map(row => row.Sddl), before.map(row => row.Sddl), 'busy timeout must leave ACLs unchanged');
  assert.equal(await readFile(keyPath, 'utf8'), key);
  await lease.close();
  assert.equal(await windowsPrivateDeviceStorage(directory, false), identity, 'only a later explicit request may retry repair');
  assert.equal(await readFile(keyPath, 'utf8'), key);
});

test('Windows rejects explicit shared root ACLs without changing the root', windows, async t => {
  const { directory } = await fixture(t);
  setCurrentUserOwner(directory);
  execFileSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(R)'], { windowsHide: true, stdio: 'pipe' });
  const before = inspectAcl([directory])[0].Sddl;
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('acl_not_private'));
  assert.equal(inspectAcl([directory])[0].Sddl, before);
});

test('Windows default child ownership never permits a broader child ACL', windows, async t => {
  const { directory } = await fixture(t);
  await windowsPrivateDeviceStorage(directory, true);
  const file = join(directory, '.key');
  await writeCurrentUserOwned(file, 'c'.repeat(64));
  execFileSync('icacls.exe', [file, '/grant', '*S-1-1-0:(R)'], { windowsHide: true, stdio: 'pipe' });
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('acl_not_private'));
});

test('Windows administrator ownership never grants the Administrators group access', windows, async t => {
  const { directory } = await fixture(t);
  await windowsPrivateDeviceStorage(directory, true);
  const file = join(directory, '.key');
  await writeCurrentUserOwned(file, 'd'.repeat(64));
  execFileSync('icacls.exe', [file, '/grant', '*S-1-5-32-544:(R)'], { windowsHide: true, stdio: 'pipe' });
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('acl_not_private'));
});

test('Windows rejects a hard-linked child without changing the external file', windows, async t => {
  const { parent, directory } = await fixture(t);
  await windowsPrivateDeviceStorage(directory, true);
  const external = join(parent, 'external');
  await writeFile(external, 'unchanged');
  await link(external, join(directory, '.key'));
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('unsafe_file'));
  assert.equal(await readFile(external, 'utf8'), 'unchanged');
});

test('Windows preflights unsafe children before initialize can repair an inherited root ACL', windows, async t => {
  const { parent, directory } = await inheritedFixture(t);
  const external = join(parent, 'external');
  await writeFile(external, 'preserve this hard-linked secret');
  await link(external, join(directory, '.key'));
  const before = inspectAcl([parent, directory]).map(row => row.Sddl);
  await assert.rejects(windowsPrivateDeviceStorage(directory, true), unavailable('unsafe_file'));
  assert.deepEqual(inspectAcl([parent, directory]).map(row => row.Sddl), before, 'preflight failure must leave parent and root ACLs untouched');
  assert.equal(await readFile(external, 'utf8'), 'preserve this hard-linked secret');
});

test('Windows rejects unknown direct children before repairing the inherited root ACL', windows, async t => {
  const { parent, directory } = await inheritedFixture(t);
  const unknown = join(directory, 'unexpected');
  await writeCurrentUserOwned(unknown, 'preserve unknown child');
  const before = inspectAcl([parent, directory, unknown]).map(row => row.Sddl);
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('unsafe_file'));
  assert.deepEqual(inspectAcl([parent, directory, unknown]).map(row => row.Sddl), before);
  assert.equal(await readFile(unknown, 'utf8'), 'preserve unknown child');
});

test('Windows rejects an explicitly shared stale device JSON temp before root repair', windows, async t => {
  const { parent, directory } = await inheritedFixture(t);
  const temporary = join(directory, `devices.json.${randomUUID()}.tmp`);
  await writeCurrentUserOwned(temporary, 'preserve stale temp');
  execFileSync('icacls.exe', [temporary, '/grant', '*S-1-5-32-545:(R)'], { windowsHide: true, stdio: 'pipe' });
  const before = inspectAcl([parent, directory, temporary]).map(row => row.Sddl);
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('acl_not_private'));
  assert.deepEqual(inspectAcl([parent, directory, temporary]).map(row => row.Sddl), before);
  assert.equal(await readFile(temporary, 'utf8'), 'preserve stale temp');
});

test('Windows rejects a reparse-point device JSON temp before root repair', windows, async t => {
  const { parent, directory } = await inheritedFixture(t);
  const target = join(parent, 'temp-target');
  const temporary = join(directory, `devices.json.${randomUUID()}.tmp`);
  await writeFile(target, 'preserve symlink target');
  try { await symlink(target, temporary, 'file'); }
  catch { t.skip('Creating a Windows file symlink requires Developer Mode or an elevated token'); return; }
  const before = inspectAcl([parent, directory]).map(row => row.Sddl);
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('reparse_point'));
  assert.deepEqual(inspectAcl([parent, directory]).map(row => row.Sddl), before);
  assert.equal(await readFile(target, 'utf8'), 'preserve symlink target');
});

test('Windows rejects a hard-linked device JSON temp before root repair', windows, async t => {
  const { parent, directory } = await inheritedFixture(t);
  const target = join(parent, 'temp-target');
  const temporary = join(directory, `devices.json.${randomUUID()}.tmp`);
  await writeCurrentUserOwned(target, 'preserve hard-linked target');
  await link(target, temporary);
  const before = inspectAcl([parent, directory, target, temporary]).map(row => row.Sddl);
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('unsafe_file'));
  assert.deepEqual(inspectAcl([parent, directory, target, temporary]).map(row => row.Sddl), before);
  assert.equal(await readFile(target, 'utf8'), 'preserve hard-linked target');
});

test('Windows rejects a directory at a reserved child path before repairing the root', windows, async t => {
  const { parent, directory } = await inheritedFixture(t);
  await mkdir(join(directory, '.key'));
  const before = inspectAcl([parent, directory]).map(row => row.Sddl);
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('unsafe_file'));
  assert.deepEqual(inspectAcl([parent, directory]).map(row => row.Sddl), before);
});

test('Windows preserves a previously private Administrators-owned child', windows, async t => {
  const { directory } = await fixture(t);
  await windowsPrivateDeviceStorage(directory, true);
  const file = join(directory, '.key');
  await writeCurrentUserOwned(file, 'e'.repeat(64));
  if (!trySetOwner(file, 'S-1-5-32-544')) { t.skip('Changing the file owner requires an elevated Windows token'); return; }
  const identity = await windowsPrivateDeviceStorage(directory, false);
  assert.equal(await windowsPrivateDeviceStorage(directory, false), identity);
  assert.equal(inspectAcl([file])[0].Owner, 'S-1-5-32-544');
  assert.equal(await readFile(file, 'utf8'), 'e'.repeat(64));
});

test('Windows refuses a shared Administrators-owned child before changing the root', windows, async t => {
  const { parent, directory } = await inheritedFixture(t);
  const file = join(directory, '.key');
  await writeCurrentUserOwned(file, 'f'.repeat(64));
  if (!trySetOwner(file, 'S-1-5-32-544')) { t.skip('Changing the file owner requires an elevated Windows token'); return; }
  const before = inspectAcl([parent, directory]).map(row => row.Sddl);
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('owner_mismatch'));
  assert.deepEqual(inspectAcl([parent, directory]).map(row => row.Sddl), before, 'shared admin-owned child must block every repair');
  assert.equal(await readFile(file, 'utf8'), 'f'.repeat(64));
});

test('Windows refuses a foreign-owned child before changing the root', windows, async t => {
  const { parent, directory } = await inheritedFixture(t);
  const file = join(directory, '.key');
  await writeCurrentUserOwned(file, 'g'.repeat(64));
  if (!trySetOwner(file, 'S-1-5-32-545')) { t.skip('Changing the file owner requires an elevated Windows token'); return; }
  const before = inspectAcl([parent, directory]).map(row => row.Sddl);
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('owner_mismatch'));
  assert.deepEqual(inspectAcl([parent, directory]).map(row => row.Sddl), before, 'foreign-owned child must block every repair');
  assert.equal(await readFile(file, 'utf8'), 'g'.repeat(64));
});

test('Windows rejects an unknown-owner root without changing its inherited ACL', windows, async t => {
  const { directory } = await inheritedFixture(t);
  if (!trySetOwner(directory, 'S-1-5-32-545')) { t.skip('Changing the directory owner requires an elevated Windows token'); return; }
  const before = inspectAcl([directory])[0].Sddl;
  await assert.rejects(windowsPrivateDeviceStorage(directory, false), unavailable('owner_mismatch'));
  assert.equal(inspectAcl([directory])[0].Sddl, before);
});

test('Windows assigns a newly elevated Administrators-owned empty root to the current user', windows, async t => {
  const { parent, directory } = await fixture(t);
  const identity = inspectAcl([directory])[0];
  if (identity.Owner !== 'S-1-5-32-544') {
    t.skip('The current Windows token does not create directories with Administrators as owner');
    return;
  }
  assert.match(await windowsPrivateDeviceStorage(directory, true), /^windows-volume-file:[A-F0-9]{8}:[A-F0-9]{16}$/);
  const after = inspectAcl([directory])[0];
  assert.equal(after.Owner, after.User);
  assert.equal(after.Protected, true);
});

test('Windows refuses to initialize a nonempty Administrators-owned root', windows, async t => {
  const { directory } = await fixture(t);
  await writeFile(join(directory, 'unexpected'), 'preserve');
  if (!trySetOwner(directory, 'S-1-5-32-544')) { t.skip('Changing the directory owner requires an elevated Windows token'); return; }
  const before = inspectAcl([directory])[0].Sddl;
  await assert.rejects(windowsPrivateDeviceStorage(directory, true), unavailable('unsafe_file'));
  assert.equal(inspectAcl([directory])[0].Sddl, before, 'nonempty admin-owned roots must not be repaired');
  assert.equal(await readFile(join(directory, 'unexpected'), 'utf8'), 'preserve');
});

test('Windows rejects a junction before initialization can modify its target ACL', windows, async t => {
  const { parent, directory } = await fixture(t);
  const target = join(parent, 'external-directory');
  await mkdir(target);
  await rm(directory, { recursive: true });
  await symlink(target, directory, 'junction');
  await assert.rejects(windowsPrivateDeviceStorage(directory, true), unavailable('reparse_point'));
});

for (const mode of ['normal-exit', 'parent-crash']) {
  test(`Windows guard follows its exact Node parent on ${mode}`, windows, async t => {
    const { directory } = await fixture(t);
    const query = owner => `$ProgressPreference='SilentlyContinue';$expected=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';$items=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${owner}'|Where-Object{$_.ProcessId -ne $PID}|Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath);$owned=@($items|Where-Object{$_.ExecutablePath -ieq $expected});[pscustomobject]@{candidateCount=$items.Count;expectedExecutablePath=$expected;candidates=$items;matches=$owned}|ConvertTo-Json -Compress -Depth 4`;
    const encoded = source => Buffer.from(source, 'utf16le').toString('base64');
    const source = `import {windowsPrivateDeviceStorage} from ${JSON.stringify(new URL('./mobile-device-private-storage.js', import.meta.url).href)};
      import {execFileSync} from 'node:child_process';
      await windowsPrivateDeviceStorage(${JSON.stringify(directory)},true);
      const script=${JSON.stringify(query('__OWNER__'))}.replace('__OWNER__',String(process.pid));
      const observation=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true}));
      console.log('GUARD_QUERY '+JSON.stringify(observation));
      const rows=Array.isArray(observation.matches)?observation.matches:observation.matches&&typeof observation.matches==='object'?[observation.matches]:[];
      if(rows.length!==1)throw new Error('Expected exactly one exact-path owned guard child');
      console.log('GUARD_OWNER '+JSON.stringify(rows[0]));
      ${mode === 'parent-crash' ? 'setInterval(()=>{},1000);' : ''}`;
    const child = spawn(process.execPath, ['--input-type=module','-e',source], {windowsHide:true,stdio:['ignore','pipe','pipe']});
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let output = '', stderr = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-4096); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    const exited = once(child,'exit');
    const deadline = Date.now() + 15_000;
    while (!output.includes('GUARD_OWNER ') && child.exitCode === null && Date.now() < deadline) await new Promise(done=>setTimeout(done,25));
    const queryLine = output.split('\n').find(value=>value.startsWith('GUARD_QUERY '));
    if (queryLine) {
      const observation = JSON.parse(queryLine.slice('GUARD_QUERY '.length));
      t.diagnostic(JSON.stringify({candidateCount:observation.candidateCount,
        matchesShape:Array.isArray(observation.matches)?'array':observation.matches===null?'null':typeof observation.matches,
        expectedExecutablePath:observation.expectedExecutablePath,candidates:observation.candidates}));
    }
    const line = output.split('\n').find(value=>value.startsWith('GUARD_OWNER '));
    assert.ok(line, `owned guard startup failed: ${stderr}`);
    const guard = JSON.parse(line.slice('GUARD_OWNER '.length));
    assert.ok(Number.isSafeInteger(guard.ProcessId) && guard.ProcessId > 0);
    if (mode === 'parent-crash') child.kill('SIGKILL');
    const [code] = await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned Node parent did not exit')),5000);timer.unref();})]);
    if (mode === 'normal-exit') assert.equal(code,0,'idle guard must not pin a normal Gateway exit');
    let gone = false;
    for (let attempt=0; attempt<10 && !gone; attempt++) {
      const script = `$item=Get-CimInstance Win32_Process -Filter 'ProcessId = ${guard.ProcessId}';if($item){$item|Select-Object CreationDate|ConvertTo-Json -Compress}else{'null'}`;
      const observed = JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded(script)],{encoding:'utf8',windowsHide:true}));
      gone = observed === null || observed.CreationDate !== guard.CreationDate;
      if (!gone) await new Promise(done=>setTimeout(done,100));
    }
    assert.ok(gone,'the held exact-parent guard must exit without PID/name cleanup');
  });
}
