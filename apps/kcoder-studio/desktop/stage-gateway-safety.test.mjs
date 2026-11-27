import assert from 'node:assert/strict';
import test from 'node:test';
import filesystem, { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { stageGatewayDependencies } from './stage-gateway-dependencies.mjs';

async function put(root, name, contents = 'module.exports={}', dependencies = {}, version = '1.0.0') {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.cjs', dependencies }));
  await writeFile(join(directory, 'index.cjs'), contents);
  return directory;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-gateway-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'repo', 'apps', 'studio'), modules = join(sourceRoot, 'node_modules');
  await mkdir(modules, { recursive: true });
  await writeFile(join(sourceRoot, 'package.json'), '{"private":true}');
  for (const name of ['ssh2', 'ws', 'jsonc-parser', 'compression']) await put(modules, name);
  return { root, sourceRoot, modules, destination: join(root, 'stage', 'node_modules'),
    targetPlatform: process.platform === 'win32' ? 'linux' : 'win32' };
}

for (const kind of ['source', 'ancestor', 'inside-source', 'parent-alias', 'dependency-source']) {
  test(`rejects an owned fake live dependency destination before replacement (${kind})`, async t => {
    const f = await fixture(t);
    let destination;
    if (kind === 'source') destination = f.modules;
    if (kind === 'ancestor') destination = join(f.root, 'repo', 'node_modules');
    if (kind === 'inside-source') destination = join(f.sourceRoot, 'build-stage', 'node_modules');
    if (kind === 'parent-alias') {
      await symlink(f.sourceRoot, join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      destination = join(f.root, 'alias', 'node_modules');
    }
    if (kind === 'dependency-source') {
      destination = join(f.root, 'linked', 'node_modules');
      const packageRoot = await put(destination, 'ssh2');
      await rm(join(f.modules, 'ssh2'), { recursive: true });
      await symlink(packageRoot, join(f.modules, 'ssh2'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    await mkdir(destination, { recursive: true });
    const marker = join(destination, 'owned-live-marker');
    await writeFile(marker, 'must remain');
    await assert.rejects(stageGatewayDependencies({ ...f, destination }), /dedicated|source|staging/i);
    assert.equal(await readFile(marker, 'utf8'), 'must remain');
  });
}

test('a canonical dedicated stage remains usable through a safe parent alias', async t => {
  const f = await fixture(t);
  const stage = join(f.root, 'real-stage'); await mkdir(stage);
  await symlink(stage, join(f.root, 'stage-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await stageGatewayDependencies({ ...f, destination: join(f.root, 'stage-alias', 'node_modules') });
  assert.equal(JSON.parse(await readFile(join(result.output, 'ws', 'package.json'), 'utf8')).name, 'ws');
});

test('same package version from different real sources retains the correct parent source', async t => {
  const f = await fixture(t);
  await put(f.modules, 'ssh2', "module.exports=require('shared-fixture')", { 'shared-fixture': '1.0.0' });
  await put(f.modules, 'shared-fixture', 'module.exports=1');
  await put(f.modules, 'compression', "module.exports=require('shared-fixture')", { 'shared-fixture': '1.0.0' });
  await put(join(f.modules, 'compression', 'node_modules'), 'shared-fixture', 'module.exports=2');
  const { output } = await stageGatewayDependencies(f);
  const require = createRequire(join(output, '..', 'entry.cjs'));
  assert.equal(require('ssh2'), 1);
  assert.equal(require('compression'), 2);
});

test('rejects traversal dependency names and package-internal links without publishing', async t => {
  for (const kind of ['name', 'link']) {
    const f = await fixture(t);
    if (kind === 'name') {
      await put(f.modules, 'ssh2', 'module.exports={}', { '../escape': '1.0.0' });
      await put(f.modules, 'escape');
    } else {
      await writeFile(join(f.root, 'private-fixture'), 'must remain');
      await symlink(join(f.root, 'private-fixture'), join(f.modules, 'ssh2', 'linked-data'));
    }
    await assert.rejects(stageGatewayDependencies(f), /name|link|source|staging/i);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  }
});


test('a failed publish and restore retains the owned previous stage and both error causes', async t => {
  const f = await fixture(t);
  await mkdir(f.destination, { recursive: true });
  await writeFile(join(f.destination, 'previous-marker'), 'must remain');
  const original = filesystem.rename;
  const publishFailure = Object.assign(new Error('controlled publish'), { code: 'EXDEV' });
  const restoreFailure = Object.assign(new Error('controlled restore'), { code: 'EACCES' });
  const mock = t.mock.method(filesystem, 'rename', async (source, target) => {
    if (source.includes('.gateway-dependencies-') && source.endsWith('node_modules')) throw publishFailure;
    if (source.endsWith('previous')) throw restoreFailure;
    return original(source, target);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(stageGatewayDependencies(f), error => error.cause === publishFailure && error.restoreError === restoreFailure);
  const parent = join(f.root, 'stage');
  const retained = (await readdir(parent)).find(name => name.startsWith('.gateway-dependencies-'));
  assert.ok(retained);
  assert.equal(await readFile(join(parent, retained, 'previous', 'previous-marker'), 'utf8'), 'must remain');
});

test('a dedicated stage on a different owned filesystem copies sources without renaming live dependencies', async t => {
  const f = await fixture(t);
  if (process.platform !== 'linux') { t.skip('The local cross-filesystem fixture requires Linux /dev/shm'); return; }
  const other = await mkdtemp('/dev/shm/kcoder-gateway-stage-');
  t.after(() => rm(other, { recursive: true, force: true }));
  assert.notEqual((await lstat(other)).dev, (await lstat(f.sourceRoot)).dev);
  const result = await stageGatewayDependencies({ ...f, destination: join(other, 'node_modules') });
  assert.equal(JSON.parse(await readFile(join(result.output, 'ssh2', 'package.json'), 'utf8')).name, 'ssh2');
  assert.equal(JSON.parse(await readFile(join(f.modules, 'ssh2', 'package.json'), 'utf8')).name, 'ssh2');
});
