import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownNativeFixtureTree, stageApplicationComponent } from './application-component.mjs';

test('component and evidence names cannot escape the original fixture before staging', async () => {
  for (const option of [{ componentName: '../outside' }, { artifactName: '../outside' }]) {
    await assert.rejects(stageApplicationComponent({}, {}, option), /regular expression/);
  }
});

test('staging changes only its owned files and refuses a foreign path or symbolic link', {
  skip: process.platform === 'win32' ? 'The Linux Native fixture uses POSIX ownership and modes' : false,
}, async t => {
  const base = await mkdtemp(join(tmpdir(), 'kcoder-channel-component-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'owned');
  const component = join(root, 'component');
  await mkdir(component, { recursive: true });
  const outside = join(base, 'outside.mjs');
  await writeFile(outside, 'ORIGINAL_UNOWNED_BYTES', { mode: 0o644 });
  const before = (await stat(outside)).mode;
  const fixture = { root, uid: process.getuid(), gid: process.getgid() };
  await assert.rejects(ownNativeFixtureTree(fixture, outside), /inside its owned root/);
  assert.equal((await stat(outside)).mode, before);
  assert.equal(await readFile(outside, 'utf8'), 'ORIGINAL_UNOWNED_BYTES');
  const file = join(component, 'worker.mjs');
  await writeFile(file, 'CONTROLLED_WORKER_BYTES');
  await ownNativeFixtureTree(fixture, component);
  assert.equal((await stat(component)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await symlink(outside, join(component, 'foreign.mjs'));
  await assert.rejects(ownNativeFixtureTree(fixture, component));
  assert.equal((await stat(outside)).mode, before);
});
