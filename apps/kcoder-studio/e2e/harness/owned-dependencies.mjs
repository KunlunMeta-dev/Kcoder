import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { waitFor } from './run-context.mjs';

export function ownedNativeBuildInputs(mobileRoot) {
  return {
    expoCli: resolve(mobileRoot, 'node_modules/expo/bin/cli'),
    gradleInitScript: 'gradle.beforeSettings { settings -> settings.pluginManagement.repositories.gradlePluginPortal() }\n',
    metroConfig: `const {getDefaultConfig}=require('expo/metro-config');
const {resolve,dirname,relative,sep,isAbsolute}=require('node:path');
const {FileStore}=require('metro-cache');
const c=getDefaultConfig(__dirname);
const ownedNodeModules=resolve(__dirname,'node_modules');
const expoResolveRequest=c.resolver.resolveRequest;
const isWithin=(root,path)=>{const rel=relative(root,path);return rel===''||(rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel));};
const ownedLookupPaths=origin=>{
  const paths=[];
  let directory=dirname(resolve(origin));
  while(directory!==ownedNodeModules&&isWithin(ownedNodeModules,directory)){
    paths.push(resolve(directory,'node_modules'));
    const parent=dirname(directory);
    if(parent===directory)break;
    directory=parent;
  }
  paths.push(ownedNodeModules);
  return [...new Set(paths)];
};
c.projectRoot=__dirname;
c.watchFolders=[resolve(__dirname,'../shared')];
c.resolver.assetExts=[...new Set([...c.resolver.assetExts,'txt'])];
c.resolver.nodeModulesPaths=[ownedNodeModules];
c.resolver.disableHierarchicalLookup=true;
c.resolver.resolveRequest=(context,moduleName,platform)=>{
  const delegate=expoResolveRequest||context.resolveRequest;
  if(typeof delegate!=='function')throw new Error('Metro default resolveRequest is required');
  const scopedContext={...context,disableHierarchicalLookup:true,nodeModulesPaths:ownedLookupPaths(context.originModulePath)};
  return delegate(scopedContext,moduleName,platform);
};
c.server={...c.server,unstable_serverRoot:__dirname};
c.cacheStores=[new FileStore({root:resolve(__dirname,'.metro-cache')})];
module.exports=c;`,
  };
}

export async function runOwnedNativePhase(context, {
  label, command, args, cwd, env, timeoutMs,
}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 900_000,
    'native phase timeout must be between 1 and 900000ms');
  let child;
  let spawnError;
  let phaseError;
  let cleanupError;
  try {
    child = context.spawnOwned(label, command, args, { cwd, env });
    child.once('error', error => { spawnError = error; });
    await waitFor(
      () => spawnError || child.exitCode !== null || child.signalCode !== null,
      timeoutMs,
      label,
      25,
      context.abortSignal,
    );
    if (spawnError) throw new Error(`${label} could not start: ${spawnError.message}`, { cause: spawnError });
    if (child.signalCode !== null) throw new Error(`${label} terminated by ${child.signalCode}`);
    if (child.exitCode !== 0) throw new Error(`${label} exited with code ${child.exitCode}`);
  } catch (error) {
    phaseError = error;
  } finally {
    if (child) {
      try {
        await context.stopOwned(label);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (phaseError && cleanupError) {
    throw new AggregateError([phaseError, cleanupError], `${label} failed and owned cleanup failed`, { cause: phaseError });
  }
  if (phaseError) throw phaseError;
  if (cleanupError) throw new AggregateError([cleanupError], `${label} owned cleanup failed`, { cause: cleanupError });
  return { pid: child.pid, exitCode: child.exitCode };
}

// Native autolinking lets Gradle write android/build inside dependency packages.
// A physical, dereferenced copy keeps those writes in this run, including .bin links.
export async function materializeOwnedDependencies(context, {
  sourceRoot, destination, label = 'native-dependencies-copy', timeoutMs = 600_000,
}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600_000);
  const deadline = Date.now() + timeoutMs;
  const current = () => {
    context.abortSignal?.throwIfAborted();
    assert.ok(Date.now() < deadline, 'dependency materialization deadline exceeded');
  };
  const source = await realpath(sourceRoot);
  const state = await realpath(context.stateDir);
  const parent = await realpath(dirname(destination));
  assert.ok(parent === state || parent.startsWith(`${state}${sep}`), 'dependency destination must be owned state');
  const target = resolve(parent, basename(destination));
  assert.ok(!target.startsWith(`${source}${sep}`) && target !== source, 'dependency copy cannot write inside source');
  assert.ok((await lstat(source)).isDirectory(), 'dependency source must be a directory');
  await inspect(source, true);
  current();
  // Exclusive mkdir refuses an existing destination, including a symlink.
  await mkdir(target, { mode: 0o700 });
  context.registerTemporaryDirectory(label, target);
  const child = context.spawnOwned(label, 'cp', ['-aL', '--reflink=auto', `${source}/.`, `${target}/`], {
    cwd: parent, env: context.isolatedEnvironment(),
  });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  try {
    await waitFor(() => spawnError || child.exitCode !== null || child.signalCode !== null,
      Math.max(1, deadline - Date.now()), label, 25, context.abortSignal);
    if (spawnError) throw new Error(`${label} could not start`);
    assert.equal(child.exitCode, 0, `${label} failed; see owned log`);
  } finally {
    await context.stopOwned(label);
  }
  const entries = await inspect(target, false);
  assert.ok(entries > 0, 'dependency copy must not be empty');
  return { root: target, entries, copierPid: child.pid };

  async function inspect(root, allowInternalLinks) {
    let entries = 0;
    const pending = [root];
    while (pending.length) {
      current();
      const directory = pending.pop();
      for (const name of await readdir(directory)) {
        current();
        assert.ok(++entries <= 200_000, 'dependency tree exceeds entry budget');
        const path = resolve(directory, name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
          assert.ok(allowInternalLinks, 'owned dependency copy contains a symlink');
          const linked = await realpath(path);
          assert.ok(linked.startsWith(`${root}${sep}`), 'dependency symlink escapes source root');
          const linkedInfo = await lstat(linked);
          assert.ok(linkedInfo.isFile() || linkedInfo.isDirectory(), 'dependency symlink targets a special file');
          assert.ok(!linkedInfo.isDirectory() || !directory.startsWith(`${linked}${sep}`) && directory !== linked,
            'dependency symlink points to an ancestor');
        } else if (info.isDirectory()) pending.push(path);
        else assert.ok(info.isFile(), 'dependency tree contains a special file');
      }
    }
    return entries;
  }
}
