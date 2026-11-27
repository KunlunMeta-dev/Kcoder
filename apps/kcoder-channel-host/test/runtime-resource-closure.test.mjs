import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { registerHooks } from 'node:module';
import { importedDingtalkModules, isProductionDependencyEntry, isRuntimeDependencyPath, stageNativeConnectivityBundle } from '../scripts/stage-native-resources.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tracer = join(packageRoot, 'test/fixtures/runtime-import-trace.mjs');
const trace = async root => JSON.parse((await promisify(execFile)(process.execPath, [tracer, root],
  { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 })).stdout);

test('staging drops declarations, sources, maps and docs but keeps legal notices', () => {
  for (const name of ['index.d.ts', 'types.d.mts', 'client.ts', 'client.js.map', 'README.md', 'CHANGELOG.markdown', '.eslintrc', '.nycrc.json'])
    assert.equal(isProductionDependencyEntry(name), false, name);
  for (const name of ['LICENSE', 'LICENSE.md', 'license.txt', 'NOTICE.md', 'COPYING', 'index.js', 'data.json', 'proto.proto', 'data.map'])
    assert.equal(isProductionDependencyEntry(name), true, name);
  const dingtalkModules = new Set(['robot_1_0']);
  assert.equal(isRuntimeDependencyPath('node_modules/@types', { isDirectory: true }), false);
  assert.equal(isRuntimeDependencyPath('node_modules/x/node_modules/@types', { isDirectory: true }), false);
  assert.equal(isRuntimeDependencyPath('node_modules/@larksuiteoapi/node-sdk/es', { isDirectory: true }), false);
  assert.equal(isRuntimeDependencyPath('node_modules/@larksuiteoapi/node-sdk/lib', { isDirectory: true }), true);
  assert.equal(isRuntimeDependencyPath('node_modules/@alicloud/dingtalk/dist/robot_1_0', { isDirectory: true, dingtalkModules }), true);
  assert.equal(isRuntimeDependencyPath('node_modules/@alicloud/dingtalk/dist/robot_1_0/client.js', { dingtalkModules }), true);
  assert.equal(isRuntimeDependencyPath('node_modules/@alicloud/dingtalk/dist/im_1_0', { isDirectory: true, dingtalkModules }), false);
  assert.equal(isRuntimeDependencyPath('node_modules/@alicloud/dingtalk/dist/index.js', { dingtalkModules }), false);
  assert.equal(isRuntimeDependencyPath('node_modules/@alicloud/dingtalk/src', { isDirectory: true, dingtalkModules }), false);
  assert.equal(isRuntimeDependencyPath('node_modules/@alicloud/dingtalk/LICENSE', { dingtalkModules }), true);
  assert.equal(isRuntimeDependencyPath('node_modules/agent-base/README.md', { keepReadme: true }), true);
  assert.equal(isRuntimeDependencyPath('node_modules/agent-base/README.md'), false);
});

test('every module the host, channel runtime and lazy SDK paths resolve is staged', { skip: typeof registerHooks !== 'function' && 'module.registerHooks is unavailable in this Node' }, async t => {
  const source = await trace(packageRoot);
  assert.deepEqual(source.failures, []);
  assert.ok(source.files.includes('src/applications/stdio.mjs'));
  for (const sdk of ['@larksuiteoapi/node-sdk', 'dingtalk-stream', '@wecom/aibot-node-sdk', '@tencent-connect/qqbot-connector', '@octokit/rest'])
    assert.ok(source.files.some(file => file.startsWith(`node_modules/${sdk}/`)), sdk);
  for (const module of await importedDingtalkModules())
    assert.ok(source.files.includes(`node_modules/@alicloud/dingtalk/dist/${module}/client.js`), module);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kcoder-channel-closure-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staged = await stageNativeConnectivityBundle({ output: join(root, 'component'), nodeProgram: process.execPath });
  const manifest = JSON.parse(await readFile(join(staged.componentRoot, 'channel-resource-manifest.json'), 'utf8'));
  const present = new Set(manifest.files.map(file => file.path));
  assert.deepEqual(source.files.filter(file => !present.has(file)), []);
  // The pruned copy itself resolves the same runtime graph without any failure.
  const copy = await trace(staged.componentRoot);
  assert.deepEqual(copy.failures, []);
  assert.deepEqual(copy.files, source.files);
  for (const file of manifest.files) {
    assert.doesNotMatch(file.path, /\.d\.[cm]?ts$|\.(?:[cm]?[jt]sx?|css)\.map$|\/@types\/|@larksuiteoapi\/node-sdk\/es\//, file.path);
    if (file.path.startsWith('node_modules/@alicloud/dingtalk/dist/'))
      assert.ok((await importedDingtalkModules()).has(file.path.split('/')[4]), file.path);
  }
  // A staged package keeps every license-like notice its installed copy has;
  // one without such a file keeps its README, which then carries the notice.
  const notice = /^(?:licen[cs]e|notice|copying)/i;
  const packages = manifest.files.filter(file => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file.path));
  for (const pkg of packages) {
    const directory = pkg.path.slice(0, -'package.json'.length);
    const installed = await readdir(join(packageRoot, directory));
    const legal = installed.filter(name => notice.test(name));
    const expected = legal.length ? legal : installed.filter(name => /^readme(?:\.|$)/i.test(name));
    for (const name of expected) assert.ok(present.has(directory + name), directory + name);
  }
  assert.ok(manifest.totalBytes < 64 * 1024 * 1024, `staged bytes ${manifest.totalBytes}`);
});
