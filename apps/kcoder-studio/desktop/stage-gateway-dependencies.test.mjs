import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stageGatewayDependencies } from './stage-gateway-dependencies.mjs';

test('stages portable Gateway dependencies without cross-platform native binaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-ssh-packaging-'));
  try {
    await mkdir(join(directory, 'node_modules', 'retired-native-addon'), { recursive: true });
    await writeFile(join(directory, 'node_modules', 'retired-native-addon', 'stale.node'), 'fixture');
    const targetPlatform = process.platform === 'win32' ? 'linux' : 'win32';
    const { output, packages, p2pNative } = await stageGatewayDependencies({
      destination: join(directory, 'node_modules'),
      targetPlatform,
      targetArch: process.arch,
    });
    assert.ok(packages.ssh2);
    assert.ok(packages['jsonc-parser']);
    assert.ok(packages.ws);
    assert.ok(packages.compression);
    assert.ok(!packages['cpu-features']);
    assert.ok(!packages['node-datachannel']);
    assert.equal(p2pNative.status, 'omitted');
    assert.equal(p2pNative.reason, 'target-does-not-match-build-host');
    const require = createRequire(join(directory, 'entry.cjs'));
    assert.equal(typeof require('ssh2').Client, 'function');
    assert.equal(typeof require('ws').WebSocketServer, 'function');
    assert.equal(typeof require('compression'), 'function');
    assert.deepEqual(require('jsonc-parser').parse('{ /* fixture */ "ok": true }'), { ok: true });
    const files = await readdir(output, { recursive: true });
    assert.ok(!files.some(file => file.endsWith('.node')));
    assert.ok(!files.some(file => file.includes('retired-native-addon')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stages the native Gateway peer transport only for the matching host target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-gateway-native-'));
  try {
    const { output, packages, p2pNative } = await stageGatewayDependencies({
      destination: join(directory, 'node_modules'),
      targetPlatform: process.platform,
      targetArch: process.arch,
    });
    assert.deepEqual({ targetPlatform: p2pNative.targetPlatform, targetArch: p2pNative.targetArch }, {
      targetPlatform: process.platform,
      targetArch: process.arch,
    });
    if (p2pNative.status === 'included') {
      assert.ok(packages['node-datachannel']);
      const require = createRequire(join(directory, 'entry.cjs'));
      assert.equal(typeof require('node-datachannel').getLibraryVersion(), 'string');
      const files = await readdir(join(output, 'node-datachannel', 'build', 'Release'));
      assert.deepEqual(files.filter(file => file.endsWith('.node')), ['node_datachannel.node']);
    } else {
      assert.equal(p2pNative.status, 'omitted');
      assert.ok(['optional-package-not-installed', 'native-addon-missing'].includes(p2pNative.reason));
      assert.ok(!packages['node-datachannel']);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps Gateway Relay packaging usable when the optional native package is absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-gateway-no-native-'));
  const sourceRoot = join(directory, 'project');
  const modules = join(sourceRoot, 'node_modules');
  try {
    await mkdir(modules, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ private: true }));
    for (const dependency of ['ssh2', 'jsonc-parser', 'ws', 'compression']) {
      await symlink(await realpath(join(fileURLToPath(new URL('..', import.meta.url)), 'node_modules', dependency)), join(modules, dependency), process.platform === 'win32' ? 'junction' : 'dir');
    }
    const { output, packages, p2pNative } = await stageGatewayDependencies({
      sourceRoot,
      destination: join(directory, 'stage', 'node_modules'),
      targetPlatform: process.platform,
      targetArch: process.arch,
    });
    assert.ok(packages.ws);
    assert.equal(p2pNative.status, 'omitted');
    assert.equal(p2pNative.reason, 'optional-package-not-installed');
    assert.ok(!packages['node-datachannel']);
    assert.ok(!((await readdir(output, { recursive: true })).some(file => file.endsWith('.node'))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves each parent dependency version when standalone packages conflict', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-gateway-package-versions-'));
  const sourceRoot = join(directory, 'source');
  const modules = join(sourceRoot, 'node_modules');
  const put = async (root, name, version, source, dependencies = {}) => {
    const folder = join(root, name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'package.json'), JSON.stringify({ name, version, main: 'index.cjs', dependencies }));
    await writeFile(join(folder, 'index.cjs'), source);
  };
  try {
    await mkdir(modules, { recursive: true });
    await writeFile(join(sourceRoot, 'package.json'), '{"private":true}');
    await put(modules, 'ssh2', '1.0.0', "module.exports=require('shared-fixture')", { 'shared-fixture': '1.0.0' });
    await put(modules, 'shared-fixture', '1.0.0', 'module.exports=1');
    await put(modules, 'compression', '1.0.0', "module.exports=require('shared-fixture')", { 'shared-fixture': '2.0.0' });
    await put(join(modules, 'compression', 'node_modules'), 'shared-fixture', '2.0.0', 'module.exports=2');
    for (const name of ['jsonc-parser', 'ws']) await put(modules, name, '1.0.0', 'module.exports={}');
    const { output } = await stageGatewayDependencies({ sourceRoot,
      destination: join(directory, 'stage', 'node_modules'),
      targetPlatform: process.platform === 'win32' ? 'linux' : 'win32',
    });
    const require = createRequire(join(output, '..', 'entry.cjs'));
    assert.equal(require('ssh2'), 1);
    assert.equal(require('compression'), 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
