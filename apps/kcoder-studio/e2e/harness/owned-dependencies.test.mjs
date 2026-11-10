import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as pathApi from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import { materializeOwnedDependencies, ownedNativeBuildInputs, runOwnedNativePhase } from './owned-dependencies.mjs';

const mobileRoot = fileURLToPath(new URL('../../mobile/', import.meta.url));
const mobileRequire = createRequire(new URL('../../mobile/package.json', import.meta.url));

function loadMetroConfig(mobile, defaults) {
  const module = { exports: null };
  runInNewContext(ownedNativeBuildInputs(mobile).metroConfig, {
    module,
    __dirname: mobile,
    require: name => {
      if (name === 'expo/metro-config') return { getDefaultConfig: () => ({
        ...defaults,
        watchFolders: [...(defaults.watchFolders ?? [])],
        resolver: { assetExts: ['png', 'jpg'], ...defaults.resolver },
        server: { ...defaults.server },
      }) };
      if (name === 'node:path') return pathApi;
      if (name === 'metro-cache') return { FileStore: class { constructor(options) { this.root = options.root; } } };
      throw new Error(`unexpected import: ${name}`);
    },
  });
  return module.exports;
}

function metroResolverContext({ metroResolve, originModulePath, nodeModulesPaths }) {
  const fileSystemLookup = path => {
    try {
      const realPath = realpathSync(path);
      const info = statSync(realPath);
      return { exists: true, type: info.isDirectory() ? 'd' : 'f', realPath };
    } catch {
      return { exists: false };
    }
  };
  const doesFileExist = path => {
    try { return statSync(path).isFile(); } catch { return false; }
  };
  return {
    allowHaste: false,
    assetExts: new Set(),
    customResolverOptions: Object.create(null),
    disableHierarchicalLookup: true,
    doesFileExist,
    extraNodeModules: null,
    dev: false,
    getPackage: path => {
      try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
    },
    getPackageForModule: () => null,
    fileSystemLookup,
    mainFields: ['react-native', 'browser', 'main'],
    originModulePath,
    nodeModulesPaths,
    preferNativePlatform: false,
    resolveAsset: () => null,
    redirectModulePath: path => path,
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    resolveRequest: metroResolve,
    sourceExts: ['js', 'json', 'ts', 'tsx'],
    unstable_conditionNames: ['require'],
    unstable_conditionsByPlatform: {},
    unstable_enablePackageExports: false,
    unstable_logWarning: () => {},
  };
}

async function fixture(t) {
  const context = await RunContext.create(import.meta.url, { testId: t.name, retainSuccessLogs: true });
  t.after(() => context.finish('passed', { fixtureOnly: true }));
  const source = context.pathInState('input/node_modules');
  await mkdir(resolve(source, 'package/android'), { recursive: true });
  await mkdir(resolve(source, '.bin'));
  await writeFile(resolve(source, 'package/android/build.gradle'), 'original build input');
  await symlink('../package/android/build.gradle', resolve(source, '.bin/fixture'));
  return { context, source, destination: context.pathInState('owned-node_modules') };
}

async function snapshot(root) {
  const entries = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = resolve(directory, name);
      const info = await lstat(path);
      entries.push({ path: path.slice(root.length), mode: info.mode, mtime: info.mtimeMs,
        value: info.isSymbolicLink() ? await readlink(path) : info.isFile() ? await readFile(path, 'utf8') : null });
      if (info.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return entries;
}

test('native dependency build writes stay in an owned physical copy', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.source);
  const copied = await materializeOwnedDependencies(f.context, { sourceRoot: f.source, destination: f.destination });
  assert.equal(copied.entries, 5);
  assert.ok(copied.copierPid > 0);
  assert.equal((await lstat(resolve(copied.root, '.bin/fixture'))).isSymbolicLink(), false);
  const original = await lstat(resolve(f.source, 'package/android/build.gradle'));
  const owned = await lstat(resolve(copied.root, 'package/android/build.gradle'));
  assert.notDeepEqual([owned.dev, owned.ino], [original.dev, original.ino]);
  await mkdir(resolve(copied.root, 'package/android/build'));
  await writeFile(resolve(copied.root, 'package/android/build/output'), 'Gradle output');
  await writeFile(resolve(copied.root, 'package/android/build.gradle'), 'owned modification');
  assert.equal(await readFile(resolve(copied.root, 'package/android/build.gradle'), 'utf8'), 'owned modification');
  await writeFile(resolve(copied.root, '.bin/fixture'), 'owned dereferenced link modification');
  assert.deepEqual(await snapshot(f.source), before);
  assert.equal(await readFile(resolve(copied.root, '.bin/fixture'), 'utf8'), 'owned dereferenced link modification');
});

test('native gate resolves Expo and Metro roots only from its owned build tree', async () => {
  const mobile = '/owned/state/source/apps/kcoder-studio/mobile';
  const inputs = ownedNativeBuildInputs(mobile);
  assert.equal(inputs.gradleInitScript,
    'gradle.beforeSettings { settings -> settings.pluginManagement.repositories.gradlePluginPortal() }\n');
  assert.doesNotMatch(inputs.gradleInitScript, /repositories\s*=|\.clear\s*\(|\.remove\s*\(/);
  const resolverCalls = [];
  const defaults = { projectRoot: '/shared/mobile', watchFolders: ['/shared/mobile', '/shared/shared'],
    resolver: {
      nodeModulesPaths: ['/shared/node_modules'],
      resolveRequest: (context, moduleName, platform) => {
        resolverCalls.push({ moduleName, platform, nodeModulesPaths: Array.from(context.nodeModulesPaths) });
        return context.resolveRequest(context, moduleName, platform);
      },
    },
    server: { unstable_serverRoot: '/shared' } };
  const generatedConfig = loadMetroConfig(mobile, defaults);
  const config = JSON.parse(JSON.stringify(generatedConfig));
  assert.equal(inputs.expoCli, resolve(mobile, 'node_modules/expo/bin/cli'));
  assert.equal(config.projectRoot, mobile);
  assert.deepEqual(config.watchFolders, [resolve(mobile, '../shared')]);
  assert.deepEqual(config.resolver.assetExts, ['png', 'jpg', 'txt']);
  assert.deepEqual(config.resolver.nodeModulesPaths, [resolve(mobile, 'node_modules')]);
  assert.equal(config.resolver.disableHierarchicalLookup, true);
  assert.equal(config.server.unstable_serverRoot, mobile);
  assert.equal(config.cacheStores[0].root, resolve(mobile, '.metro-cache'));
  const gate = await readFile(new URL('../suites/build/mobile-native-build.e2e.mjs', import.meta.url), 'utf8');
  assert.match(gate, /ownedNativeBuildInputs\(mobile\)/);
  assert.match(gate, /runOwnedNativePhase\(context/);
  assert.doesNotMatch(gate, /waitFor\(\(\)=>child\.exitCode!==null/);
  assert.match(gate, /writeFile\(resolve\(mobile,'metro.config.cjs'\),nativeInputs.metroConfig\)/);
  assert.match(gate, /const expo=nativeInputs.expoCli/);
  assert.doesNotMatch(gate, /await symlink\(|resolve\(appRoot,'mobile\/node_modules\/expo/);

  const defaultResolution = generatedConfig.resolver.resolveRequest({
    originModulePath: resolve(mobile, 'node_modules/expo/src/Expo.fx.tsx'),
    nodeModulesPaths: [resolve(mobile, 'node_modules')],
    resolveRequest: (context, moduleName, platform) => ({
      moduleName,
      platform,
      nodeModulesPaths: Array.from(context.nodeModulesPaths),
    }),
  }, 'expo-asset', 'ios');
  assert.equal(resolverCalls.length, 1, 'the original Expo resolver must receive the request');
  assert.deepEqual(resolverCalls[0], {
    moduleName: 'expo-asset',
    platform: 'ios',
    nodeModulesPaths: [
      resolve(mobile, 'node_modules/expo/src/node_modules'),
      resolve(mobile, 'node_modules/expo/node_modules'),
      resolve(mobile, 'node_modules'),
    ],
  });
  assert.deepEqual(defaultResolution, {
    moduleName: 'expo-asset',
    platform: 'ios',
    nodeModulesPaths: resolverCalls[0].nodeModulesPaths,
  });
});

test('owned Metro resolver finds Expo asset and cannot reach an ancestor decoy', async t => {
  const { resolve: metroResolve } = mobileRequire('metro-resolver');
  const resolverCalls = [];
  const defaults = {
    resolver: {
      resolveRequest: (context, moduleName, platform) => {
        resolverCalls.push({ moduleName, platform, nodeModulesPaths: Array.from(context.nodeModulesPaths) });
        return context.resolveRequest(context, moduleName, platform);
      },
    },
  };
  const config = loadMetroConfig(mobileRoot, defaults);
  const ownedNodeModules = resolve(mobileRoot, 'node_modules');
  const expoOrigin = resolve(ownedNodeModules, 'expo/src/Expo.fx.tsx');
  const expoRequire = createRequire(resolve(ownedNodeModules, 'expo/package.json'));
  const metroContext = metroResolverContext({
    metroResolve,
    originModulePath: expoOrigin,
    nodeModulesPaths: [ownedNodeModules],
  });
  const expoAssetPath = realpathSync(expoRequire.resolve('expo-asset'));
  const expoAssetResolution = config.resolver.resolveRequest(metroContext, 'expo-asset', 'ios');
  assert.equal(expoAssetResolution.type, 'sourceFile');
  assert.equal(expoAssetResolution.filePath, expoAssetPath);
  assert.deepEqual(resolverCalls[0].nodeModulesPaths, [
    resolve(ownedNodeModules, 'expo/src/node_modules'),
    resolve(ownedNodeModules, 'expo/node_modules'),
    ownedNodeModules,
  ]);

  const f = await fixture(t);
  const isolatedMobile = f.context.pathInState('owned-source/apps/kcoder-studio/mobile');
  const isolatedNodeModules = resolve(isolatedMobile, 'node_modules');
  const isolatedOrigin = resolve(isolatedNodeModules, 'expo/src/Expo.fx.tsx');
  const ancestorNodeModules = resolve(isolatedMobile, '../node_modules');
  const ancestorPackage = resolve(ancestorNodeModules, 'ancestor-only');
  await mkdir(resolve(isolatedNodeModules, 'expo/src'), { recursive: true });
  await writeFile(isolatedOrigin, '');
  await mkdir(ancestorPackage, { recursive: true });
  await writeFile(resolve(ancestorPackage, 'package.json'), JSON.stringify({ name: 'ancestor-only', main: 'index.js' }));
  await writeFile(resolve(ancestorPackage, 'index.js'), 'module.exports = true;');

  const isolatedConfig = loadMetroConfig(isolatedMobile, defaults);
  const isolatedContext = metroResolverContext({
    metroResolve,
    originModulePath: isolatedOrigin,
    nodeModulesPaths: [isolatedNodeModules],
  });
  const ancestorResolution = metroResolve({
    ...isolatedContext,
    disableHierarchicalLookup: false,
    nodeModulesPaths: [],
  }, 'ancestor-only', null);
  assert.equal(ancestorResolution.filePath, realpathSync(resolve(ancestorPackage, 'index.js')),
    'the fixture decoy must be reachable through an unbounded Metro hierarchy');
  let boundedResolutionError;
  try {
    isolatedConfig.resolver.resolveRequest(isolatedContext, 'ancestor-only', null);
  } catch (error) {
    boundedResolutionError = error;
  }
  assert.ok(boundedResolutionError, 'the owned resolver must not reach the ancestor decoy');
  assert.deepEqual(resolverCalls[1].nodeModulesPaths, [
    resolve(isolatedNodeModules, 'expo/src/node_modules'),
    resolve(isolatedNodeModules, 'expo/node_modules'),
    isolatedNodeModules,
  ]);
  assert.match(boundedResolutionError.message, /Module does not exist/);
  assert.doesNotMatch(boundedResolutionError.message, new RegExp(ancestorNodeModules.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(resolverCalls.length, 2, 'the original Expo resolver must receive both requests');
});

test('dependency materializer rejects external links before creating a destination or child', async t => {
  const f = await fixture(t);
  const outside = f.context.pathInState('outside');
  await writeFile(outside, 'must not be copied');
  await symlink(outside, resolve(f.source, 'escape'));
  await assert.rejects(materializeOwnedDependencies(f.context, { sourceRoot: f.source, destination: f.destination }), /escapes source root/);
  await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  assert.equal(f.context.processes.size, 0);
});

test('dependency materializer refuses destination overwrite', async t => {
  const f = await fixture(t);
  await mkdir(f.destination);
  await writeFile(resolve(f.destination, 'sentinel'), 'preserve');
  await assert.rejects(materializeOwnedDependencies(f.context, { sourceRoot: f.source, destination: f.destination }), { code: 'EEXIST' });
  assert.equal(await readFile(resolve(f.destination, 'sentinel'), 'utf8'), 'preserve');
  assert.equal(f.context.processes.size, 0);
});

test('failed dependency copier is stopped through the owned process lifecycle', async t => {
  const f = await fixture(t);
  const spawn = f.context.spawnOwned.bind(f.context);
  const stop = f.context.stopOwned.bind(f.context);
  let child, stops = 0;
  f.context.spawnOwned = (label, _command, _args, options) =>
    (child = spawn(label, process.execPath, ['-e', 'process.exit(7)'], options));
  f.context.stopOwned = async label => { stops++; await stop(label); };
  await assert.rejects(materializeOwnedDependencies(f.context, { sourceRoot: f.source, destination: f.destination }), /failed; see owned log/);
  assert.equal(stops, 1);
  assert.equal(child.exitCode, 7);
  assert.equal(await readFile(resolve(f.source, 'package/android/build.gradle'), 'utf8'), 'original build input');
});

test('cancelled dependency copier is stopped before materialization rejects', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.context.abortSignal = controller.signal;
  const spawn = f.context.spawnOwned.bind(f.context);
  const stop = f.context.stopOwned.bind(f.context);
  let child, stopped = false;
  f.context.spawnOwned = (label, _command, _args, options) => {
    child = spawn(label, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    controller.abort(new Error('fixture cancellation'));
    return child;
  };
  f.context.stopOwned = async label => { await stop(label); stopped = true; };
  await assert.rejects(materializeOwnedDependencies(f.context, { sourceRoot: f.source, destination: f.destination }), /fixture cancellation/);
  assert.ok(stopped);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('native phase returns nonzero exit promptly and stops its owned process', async t => {
  const f = await fixture(t);
  const started = Date.now();
  await assert.rejects(runOwnedNativePhase(f.context, {
    label: 'native-exit-seven', command: process.execPath,
    args: ['-e', 'process.exit(7)'], cwd: f.context.stateDir,
    env: f.context.isolatedEnvironment(), timeoutMs: 10_000,
  }), /native-exit-seven exited with code 7/);
  assert.ok(Date.now() - started < 5_000, 'nonzero exit should not wait for the stage timeout');
  assert.equal(f.context.processes.get('native-exit-seven').child.exitCode, 7);
  assert.equal(f.context.processes.get('native-exit-seven').stopped, true);
});

test('native phase reports signal termination promptly and stops its owned process', async t => {
  if (process.platform === 'win32') return t.skip('POSIX child signal contract');
  const f = await fixture(t);
  const started = Date.now();
  await assert.rejects(runOwnedNativePhase(f.context, {
    label: 'native-signal', command: process.execPath,
    args: ['-e', "process.kill(process.pid, 'SIGTERM')"], cwd: f.context.stateDir,
    env: f.context.isolatedEnvironment(), timeoutMs: 10_000,
  }), /native-signal terminated by SIGTERM/);
  assert.ok(Date.now() - started < 5_000, 'signal termination should not wait for the stage timeout');
  assert.equal(f.context.processes.get('native-signal').child.signalCode, 'SIGTERM');
  assert.equal(f.context.processes.get('native-signal').stopped, true);
});

test('native phase reports spawn errors promptly and runs owned cleanup', async t => {
  const f = await fixture(t);
  const started = Date.now();
  await assert.rejects(runOwnedNativePhase(f.context, {
    label: 'native-spawn-error', command: `/missing/native-phase-command-${process.pid}`,
    args: [], cwd: f.context.stateDir, env: f.context.isolatedEnvironment(), timeoutMs: 10_000,
  }), /native-spawn-error could not start/);
  assert.ok(Date.now() - started < 5_000, 'spawn errors should not wait for the stage timeout');
  assert.equal(f.context.processes.get('native-spawn-error').stopped, true);
});

test('native phase timeout and cancellation both stop only the owned process', async t => {
  const timed = await fixture(t);
  const started = Date.now();
  await assert.rejects(runOwnedNativePhase(timed.context, {
    label: 'native-timeout', command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], cwd: timed.context.stateDir,
    env: timed.context.isolatedEnvironment(), timeoutMs: 100,
  }), /Timed out waiting for native-timeout/);
  assert.ok(Date.now() - started < 5_000, 'phase timeout should remain bounded');
  assert.equal(timed.context.processes.get('native-timeout').stopped, true);

  const cancelled = await fixture(t);
  const controller = new AbortController();
  cancelled.context.abortSignal = controller.signal;
  const abortTimer = setTimeout(() => controller.abort(new Error('native phase fixture cancellation')), 50);
  try {
    await assert.rejects(runOwnedNativePhase(cancelled.context, {
      label: 'native-cancelled', command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], cwd: cancelled.context.stateDir,
      env: cancelled.context.isolatedEnvironment(), timeoutMs: 10_000,
    }), /native phase fixture cancellation/);
  } finally {
    clearTimeout(abortTimer);
  }
  const record = cancelled.context.processes.get('native-cancelled');
  assert.equal(record.stopped, true);
  assert.ok(record.child.exitCode !== null || record.child.signalCode !== null);
});
