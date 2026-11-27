import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { stageGatewayDependencies } from './stage-gateway-dependencies.mjs';
import { stageDesktopResources } from './stage-desktop-resources.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'gateway-stage-parent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source'), destination = join(root, 'offline', 'node_modules');
  await fs.mkdir(join(sourceRoot, 'node_modules'), { recursive: true });
  await fs.writeFile(join(sourceRoot, 'package.json'), '{"private":true}');
  for (const name of ['ssh2', 'jsonc-parser', 'ws', 'compression']) {
    const packageRoot = join(sourceRoot, 'node_modules', name); await fs.mkdir(packageRoot);
    await fs.writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    await fs.writeFile(join(packageRoot, 'index.js'), 'module.exports={}');
  }
  return { root, sourceRoot, destination, targetPlatform: process.platform === 'win32' ? 'linux' : 'win32' };
}
const stagingPath = path => basename(path).startsWith('.gateway-dependencies-');

test('stager cleanup cannot replace the original metadata failure', async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.sourceRoot, 'node_modules/ssh2/package.json'), JSON.stringify({ name: 'ssh2', version: '1.0.0', dependencies: { '../escape': '1' } }));
  const rm = fs.rm, cleanup = Object.assign(new Error('CONTROLLED_CLEANUP_FAILURE'), { code: 'EACCES' });
  const mocked = t.mock.method(fs, 'rm', async (path, options) => { if (stagingPath(path)) throw cleanup; return rm(path, options); });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(stageGatewayDependencies(f), error => {
    assert.match(error.message, /Gateway dependency name is invalid/);
    assert.equal(error.cleanupError, cleanup); assert.equal(error.cleanupUnconfirmed, true); return true;
  });
});

test('a fresh staging mkdir failure still removes its owned temporary directory', async t => {
  const f = await fixture(t), mkdir = fs.mkdir;
  const mocked = t.mock.method(fs, 'mkdir', async (path, options) => {
    if (basename(path) === 'node_modules' && stagingPath(dirname(path))) throw Object.assign(new Error('CONTROLLED_FRESH_MKDIR_FAILURE'), { code: 'ENOSPC' });
    return mkdir(path, options);
  });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(stageGatewayDependencies(f), { code: 'ENOSPC' });
  assert.deepEqual(await fs.readdir(dirname(f.destination)), []);
});

test('cleanup after successful publication reports the published state and retains the previous copy', async t => {
  const f = await fixture(t), rm = fs.rm;
  await fs.mkdir(f.destination, { recursive: true }); await fs.writeFile(join(f.destination, 'previous-marker'), 'original');
  const cleanup = Object.assign(new Error('CONTROLLED_POST_PUBLISH_CLEANUP_FAILURE'), { code: 'EACCES' });
  const mocked = t.mock.method(fs, 'rm', async (path, options) => { if (stagingPath(path)) throw cleanup; return rm(path, options); });
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(stageGatewayDependencies(f), error => {
    assert.equal(error.code, 'GATEWAY_DEPENDENCIES_CLEANUP_UNCONFIRMED');
    assert.equal(error.published, true); assert.equal(error.cleanupUnconfirmed, true);
    assert.equal(error.externalOutcome, undefined); assert.equal(error.cause, cleanup); return true;
  });
  assert.equal(JSON.parse(await fs.readFile(join(f.destination, 'ssh2/package.json'))).name, 'ssh2');
  const retained = (await fs.readdir(dirname(f.destination))).find(stagingPath);
  assert.equal(await fs.readFile(join(dirname(f.destination), retained, 'previous/previous-marker'), 'utf8'), 'original');
});

test('the packaging consumer preserves cleanup status and does not retry publication or prepare later resources', async () => {
  const failure = Object.assign(new Error('CONTROLLED_CLEANUP_UNCONFIRMED'), {
    code: 'GATEWAY_DEPENDENCIES_CLEANUP_UNCONFIRMED', published: true, cleanupUnconfirmed: true,
  });
  let attempts = 0, later = 0;
  await assert.rejects(stageDesktopResources({}, {
    stageDependencies: async () => { attempts++; throw failure; },
    prepareBrowser: async () => { later++; }, prepareMobileWeb: async () => { later++; },
  }), error => error === failure);
  assert.equal(attempts, 1); assert.equal(later, 0);
});

test('physical hardlink aliases in source packages are copied without linking or moving live bytes', async t => {
  const f = await fixture(t), original = join(f.sourceRoot, 'node_modules/ssh2/index.js'), peer = join(f.root, 'source-peer.js');
  await fs.link(original, peer);
  const before = await fs.lstat(original), bytes = await fs.readFile(original, 'utf8');
  const result = await stageGatewayDependencies(f), staged = join(result.output, 'ssh2/index.js');
  const copied = await fs.lstat(staged);
  assert.notDeepEqual([copied.dev, copied.ino], [before.dev, before.ino]); assert.equal(copied.nlink, 1);
  await fs.writeFile(staged, 'module.exports={staged:true}');
  assert.equal(await fs.readFile(original, 'utf8'), bytes); assert.equal(await fs.readFile(peer, 'utf8'), bytes);
  const after = await fs.lstat(original); assert.deepEqual([after.dev, after.ino, after.nlink], [before.dev, before.ino, 2]);
});
