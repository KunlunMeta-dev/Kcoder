import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nodeModulePaths, stageSkillRuntimeDependencies } from './stage-skill-runtime-dependencies.mjs';

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-skill-stage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writePackage(directory, manifest, files = { 'index.js': `module.exports = ${JSON.stringify(manifest.version)};` }) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(directory, name, '..'), { recursive: true });
    await writeFile(join(directory, name), content);
  }
}

/**
 * Installed fixture: alpha -> shared@1 + peer-lib (peer), beta -> shared@2,
 * plus a `.node` addon and pnpm-style package-local `.bin` shims.
 */
async function fixture(root, { pins = { alpha: '1.0.0', beta: '2.0.0' }, lock = 'lockfileVersion: 9.0\n', installedLock = lock } = {}) {
  const source = join(root, 'source');
  const modules = join(source, 'node_modules');
  await writePackage(source, { name: '@kcoder/studio-skill-runtime', version: '1.0.0', private: true, dependencies: pins }, {});
  await writeFile(join(source, 'pnpm-lock.yaml'), lock);
  if (installedLock !== null) {
    await mkdir(join(modules, '.pnpm'), { recursive: true });
    await writeFile(join(modules, '.pnpm', 'lock.yaml'), installedLock);
  }
  await writePackage(join(modules, 'alpha'), { name: 'alpha', version: '1.0.0', main: 'index.js',
    dependencies: { shared: '^1.0.0' }, peerDependencies: { 'peer-lib': '*' }, optionalDependencies: { 'absent-optional': '*' } },
  { 'index.js': "module.exports = { shared: require('shared'), peer: require('peer-lib') };", 'build/Release/addon.node': 'binary',
    'index.d.ts': 'export {};', 'index.js.map': '{}', 'data.map': 'kept' });
  await mkdir(join(modules, 'alpha', 'node_modules', '.bin'), { recursive: true });
  await writePackage(join(modules, 'beta'), { name: 'beta', version: '2.0.0', main: 'index.js', dependencies: { shared: '^2.0.0' } },
    { 'index.js': "module.exports = require('shared');" });
  await writePackage(join(modules, 'shared'), { name: 'shared', version: '1.0.0', dependencies: { 'peer-lib': '*' } });
  await writePackage(join(modules, 'beta', 'node_modules', 'shared'), { name: 'shared', version: '2.0.0' });
  await writePackage(join(modules, 'peer-lib'), { name: 'peer-lib', version: '3.0.0' });
  return source;
}

test('node_modules lookup mirrors Node, including builtin-named packages', () => {
  assert.deepEqual(nodeModulePaths('/a/node_modules/b').slice(0, 3), ['/a/node_modules/b/node_modules', '/a/node_modules', '/node_modules']);
});

test('stages each pinned package as a self-contained subtree with nested conflicts', async t => {
  const root = await scratch(t);
  const sourceRoot = await fixture(root);
  const destination = join(root, 'out', 'skill-runtime', 'node_modules');
  const result = await stageSkillRuntimeDependencies({ sourceRoot, destination });
  assert.deepEqual(result.packages, { alpha: '1.0.0', beta: '2.0.0' });
  assert.equal(result.nativeAddonsOmitted, 1);
  assert.equal(result.developmentFilesOmitted, 2);
  assert.deepEqual((await readdir(join(result.output, 'alpha'))).sort(), ['build', 'data.map', 'index.js', 'node_modules', 'package.json']);
  assert.deepEqual((await readdir(result.output)).sort(), ['alpha', 'beta'], 'NODE_PATH exposes only pinned packages');
  assert.deepEqual((await readdir(join(result.output, 'alpha', 'node_modules'))).sort(), ['peer-lib', 'shared']);
  assert.equal(JSON.parse(await readFile(join(result.output, 'beta', 'node_modules', 'shared', 'package.json'), 'utf8')).version, '2.0.0');
  await assert.rejects(lstat(join(result.output, 'alpha', 'build', 'Release', 'addon.node')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(result.output, 'alpha', 'node_modules', '.bin')), { code: 'ENOENT' });
  const load = createRequire(join(root, 'consumer.js'));
  const alpha = load(join(result.output, 'alpha'));
  assert.deepEqual(alpha, { shared: '1.0.0', peer: '3.0.0' });
  assert.equal(load(join(result.output, 'beta')), '2.0.0');
  assert.equal(result.packageCount, 5, 'peer-lib is reused inside the alpha subtree, not duplicated');
});

test('republishing replaces the previous stage atomically', async t => {
  const root = await scratch(t);
  const sourceRoot = await fixture(root);
  const destination = join(root, 'out', 'node_modules');
  await mkdir(join(destination, 'stale'), { recursive: true });
  await stageSkillRuntimeDependencies({ sourceRoot, destination });
  assert.deepEqual((await readdir(destination)).sort(), ['alpha', 'beta']);
  assert.deepEqual((await readdir(join(root, 'out'))), ['node_modules'], 'temporary staging directories are removed');
});

test('pins, lockfile state and package identities fail closed', async t => {
  const root = await scratch(t);
  const out = join(root, 'out', 'node_modules');
  await assert.rejects(stageSkillRuntimeDependencies({ sourceRoot: await fixture(join(root, 'range'), { pins: { alpha: '^1.0.0' } }), destination: out }), /exact version/);
  await assert.rejects(stageSkillRuntimeDependencies({ sourceRoot: await fixture(join(root, 'pin'), { pins: { alpha: '1.0.1' } }), destination: out }), /alpha is 1\.0\.0, expected 1\.0\.1/);
  await assert.rejects(stageSkillRuntimeDependencies({ sourceRoot: await fixture(join(root, 'stale'), { installedLock: 'older\n' }), destination: out }), /do not match pnpm-lock\.yaml/);
  await assert.rejects(stageSkillRuntimeDependencies({ sourceRoot: await fixture(join(root, 'absent'), { installedLock: null }), destination: out }), /not installed; run pnpm --dir apps\/kcoder-studio\/skill-runtime install/);
  await assert.rejects(stageSkillRuntimeDependencies({ sourceRoot: await fixture(join(root, 'missing'), { pins: { gamma: '1.0.0' } }), destination: out }), /gamma is not installed/);
  const foreign = await fixture(join(root, 'foreign'));
  await writeFile(join(foreign, 'package.json'), JSON.stringify({ name: 'other', private: true, dependencies: { alpha: '1.0.0' } }));
  await assert.rejects(stageSkillRuntimeDependencies({ sourceRoot: foreign, destination: out }), /identity/);
  await assert.rejects(lstat(out), { code: 'ENOENT' }, 'failed stages publish nothing');
});

test('links inside packages and unsafe destinations are rejected', async t => {
  const root = await scratch(t);
  const sourceRoot = await fixture(root);
  await assert.rejects(stageSkillRuntimeDependencies({ sourceRoot, destination: join(sourceRoot, 'out', 'node_modules') }), /outside the source tree/);
  await assert.rejects(stageSkillRuntimeDependencies({ sourceRoot, destination: join(root, 'out', 'modules') }), /dedicated node_modules/);
  await symlink('/etc/hostname', join(sourceRoot, 'node_modules', 'beta', 'linked.txt'));
  await assert.rejects(stageSkillRuntimeDependencies({ sourceRoot, destination: join(root, 'out', 'node_modules') }), /unsafe link/);
  await assert.rejects(lstat(join(root, 'out', 'node_modules')), { code: 'ENOENT' });
});
