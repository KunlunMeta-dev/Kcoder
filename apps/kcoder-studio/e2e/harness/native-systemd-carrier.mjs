import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitForStdioChildClose } from './app-server-stdio.mjs';
import { pollNative } from './native-code-service.mjs';

/** Stop the original unit before closing its held tree observer in LIFO cleanup. */
export function registerOriginalTaskTreeCleanup(context, fixture, carrier, tree, label) {
  context.addCleanup(`confirm exact original task host ${label} before its observer closes`, async () => {
    await originalUserUnit(context, fixture, carrier, 'stop', `${label}-tree-stop`, { cleanup: true });
    await pollNative(async () => {
      const value = await tree.read();
      return !value.rootAlive && [...value.processes, ...(value.keepers ?? [])].every(item => !item.alive) ? value : null;
    }, `the exact original ${label} manager/Core/SDK to end`, 60_000);
  });
}

export async function originalSystemdCarrier(fixture) {
  const directories = (await readdir(fixture.profile)).filter(name => /^native-channel-carrier-[a-f0-9]{64}$/.test(name));
  assert.equal(directories.length, 1, 'Exactly one original profile-owned carrier is required');
  const directory = resolve(fixture.profile, directories[0]);
  const parent = await lstat(directory);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === fixture.uid);
  const files = (await readdir(directory)).filter(name => name.endsWith('.service'));
  assert.equal(files.length, 1);
  const unit = files[0];
  assert.match(unit, new RegExp(`^kcoder-native-user-${fixture.uid}-[a-f0-9]{64}\\.service$`));
  const path = resolve(directory, unit);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === fixture.uid && info.nlink === 1);
  assert.ok(info.size <= 16_384);
  return { unit, path, definition: await readFile(path, 'utf8') };
}

/** Fixed systemctl operations on this fixture's original unit, under its real UID. */
export async function originalUserUnit(context, fixture, carrier, action, label, { cleanup = false } = {}) {
  assert.ok(['show', 'start', 'stop', 'is-enabled', 'retire-runtime', 'retire-persistent'].includes(action));
  assert.equal((await originalSystemdCarrier(fixture)).path, carrier.path);
  const arguments_ = ['--user', '--no-pager', ...(action === 'retire-runtime'
    ? ['disable', '--runtime', carrier.unit] : action === 'retire-persistent'
      ? ['disable', carrier.unit] : [action, carrier.unit])];
  if (action === 'show') arguments_.push('--property=MainPID,ActiveState,FragmentPath,Transient,Restart,UnitFileState');
  const spawn = cleanup ? context.spawnCleanupOwned.bind(context) : context.spawnOwned.bind(context);
  const child = spawn(label, '/usr/bin/systemctl', arguments_, {
    uid: fixture.uid, gid: fixture.gid, env: fixture.env, cwd: fixture.workspace,
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  const exit = await waitForStdioChildClose(child, 35_000, label);
  await context.stopOwned(label);
  assert.equal(exit.code, 0, `Original owned unit ${action} must have an authoritative OS receipt`);
  assert.ok(Buffer.byteLength(output) <= 16_384);
  if (action !== 'show') return output.trim();
  return Object.fromEntries(output.trim().split('\n').map(line => {
    const separator = line.indexOf('=');
    assert.ok(separator > 0);
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

/** Register before any RPC can create a durable user-manager process. */
export function registerOriginalCarrierCleanup(context, fixture, label, { unitCommand = originalUserUnit } = {}) {
  assert.ok(fixture.activeManagers instanceof Set && !fixture.activeManagers.has(label));
  fixture.activeManagers.add(label);
  context.addCleanup(`retire only ${label} before its profile`, async () => {
    const directories = (await readdir(fixture.profile)).filter(name => /^native-channel-carrier-[a-f0-9]{64}$/.test(name));
    if (!directories.length) { fixture.activeManagers.delete(label); return; }
    const carrier = await originalSystemdCarrier(fixture);
    const alias = resolve(fixture.env.XDG_RUNTIME_DIR, 'systemd/user', carrier.unit);
    let linked = false;
    try {
      const info = await lstat(alias);
      assert.ok(info.isSymbolicLink() && info.uid === fixture.uid);
      assert.equal(await realpath(alias), await realpath(carrier.path), 'Never stop or unlink another profile after inode reuse');
      linked = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let status;
    if (linked) {
      await unitCommand(context, fixture, carrier, 'stop', `${label}-stop`, { cleanup: true });
    } else {
      status = await unitCommand(context, fixture, carrier, 'show', `${label}-before-stop`, { cleanup: true });
      if (status.MainPID !== '0') {
        await verifyOwnedFragment(fixture, carrier, status.FragmentPath);
        await unitCommand(context, fixture, carrier, 'stop', `${label}-stop`, { cleanup: true });
        status = undefined;
      }
    }
    status ??= await unitCommand(context, fixture, carrier, 'show', `${label}-final`, { cleanup: true });
    assert.equal(status.MainPID, '0');
    assert.ok(['inactive', 'failed'].includes(status.ActiveState));
    if (['enabled', 'linked', 'alias'].includes(status.UnitFileState)) {
      await verifyOwnedFragment(fixture, carrier, status.FragmentPath);
      await unitCommand(context, fixture, carrier, 'retire-persistent', `${label}-persistent-unlink`, { cleanup: true });
      const observed = await unitCommand(context, fixture, carrier, 'show', `${label}-after-unlink`, { cleanup: true });
      assert.ok(!['enabled', 'linked', 'alias'].includes(observed.UnitFileState), 'Retain the profile while its owned persistent unit remains enabled');
    }
    if (linked && await lstat(alias).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
      await unitCommand(context, fixture, carrier, 'retire-runtime', `${label}-unlink`, { cleanup: true });
      await assert.rejects(lstat(alias), { code: 'ENOENT' });
    }
    fixture.activeManagers.delete(label);
  });
}

async function verifyOwnedFragment(fixture, carrier, fragment) {
  assert.equal(typeof fragment, 'string');
  assert.ok(fragment.length > 0 && fragment.startsWith('/') && fragment.endsWith('/' + carrier.unit));
  if (fragment !== carrier.path) {
    const link = await lstat(fragment);
    assert.ok(link.isSymbolicLink() && link.uid === fixture.uid);
  }
  assert.equal(await realpath(fragment), await realpath(carrier.path), 'Never adopt another profile through an OS unit fragment');
  const [actual, original] = await Promise.all([stat(fragment), stat(carrier.path)]);
  assert.equal(actual.dev, original.dev); assert.equal(actual.ino, original.ino);
  assert.ok(actual.uid === fixture.uid && actual.nlink === 1);
}
