import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stageNativeConnectivityResources } from '../../../../kcoder-channel-host/scripts/stage-native-resources.mjs';
import { appServerEnvironment } from '../../server-config.js';
import { sha256 } from '../office/resource-verifier.mjs';
import { captureGatewayNativeConnectivityStartup, captureNativeConnectivityStartupConfiguration,
  nativeConnectivityEnvironmentKey as KEY, nativeConnectivitySpawnEnvironment, prepareNativeConnectivityLaunch,
  prepareSourceConnectivityLaunch, releaseSourceConnectivityLaunch, preparePackagedConnectivityGatewayEnvironment } from './resource-host.mjs';

let root, observation, launch;
test.before(async()=>{
  root=await realpath(await mkdtemp(join(tmpdir(),'owned-connectivity-native-resource-')));
  observation=await stageNativeConnectivityResources({output:join(root,'component'),nodeProgram:process.execPath});
  launch=await prepareNativeConnectivityLaunch({componentRoot:observation.componentRoot,expectedManifestSha256:observation.manifestSha256});
});
test.after(async()=>{await rm(root,{recursive:true,force:true});});
test('actual sealed launch is reverified and only its native brand can cross existing parent spawn',async()=>{
  const env=nativeConnectivitySpawnEnvironment(launch);
  const roundtrip=await captureNativeConnectivityStartupConfiguration(env[KEY]);
  assert.deepEqual(roundtrip,launch);
  assert.throws(()=>nativeConnectivitySpawnEnvironment(JSON.parse(JSON.stringify(launch))),/NATIVE_LAUNCH/);
  const verifier={version:1,gatewayNamespaceId:'a'.repeat(64),key:'b'.repeat(64)};
  assert.throws(()=>appServerEnvironment({}, {},undefined,undefined,undefined,launch),/verified native parent/);
  assert.throws(()=>appServerEnvironment({}, {},'localOs',undefined,undefined,launch),/verified native parent/);
  const child=appServerEnvironment({[KEY]:'ambient'}, {[KEY]:'target-override'},'localOs',verifier,undefined,launch);
  assert.equal(child[KEY],env[KEY]);
  assert.equal(appServerEnvironment({[KEY]:'ambient',kcoder_native_connectivity_binding_v1:'case-alias'}, {[KEY]:'target-override'})[KEY],undefined);
});
test('Gateway consumes all reserved aliases before the first async verifier and cannot reread forged input',async t=>{
  const warning=t.mock.method(console,'warn',()=>{});
  const env={[KEY]:'not-valid',kcoder_native_connectivity_binding_v1:'forgery',PATH:'/controlled'};
  const pending=captureGatewayNativeConnectivityStartup(env);
  assert.deepEqual(env,{PATH:'/controlled'});assert.equal(await pending,null);
  assert.equal(warning.mock.calls.length,1);
});
test('a changed component or claimed runtime mode never becomes an actual launch',async()=>{
  const path=join(observation.componentRoot,'src/applications/stdio.mjs'),original=await readFile(path);
  await writeFile(path,Buffer.concat([original,Buffer.from('\n// controlled identity mismatch\n')]));
  try{await assert.rejects(prepareNativeConnectivityLaunch({componentRoot:observation.componentRoot,expectedManifestSha256:observation.manifestSha256}));}
  finally{await writeFile(path,original);}
  const changed={...launch,nodeMode:'electron_as_node',electronVersion:'wrong-native-runtime'};
  await assert.rejects(captureNativeConnectivityStartupConfiguration(Buffer.from(JSON.stringify(changed)).toString('base64url')),/RUNTIME/);
});
test('the manifest lock digest must match the verified lockfile entry', async () => {
  const path = join(observation.componentRoot, 'channel-resource-manifest.json');
  const original = await readFile(path);
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(original), lockSha256: '0'.repeat(64) }));
  await writeFile(path, changed);
  try {
    await assert.rejects(prepareNativeConnectivityLaunch({ componentRoot: observation.componentRoot,
      expectedManifestSha256: sha256(changed) }), /CHANNEL_RESOURCE_IDENTITY_CHANGED/);
  } finally { await writeFile(path, original); }
});
test('the real source Gateway creates and releases only its owned sealed component without user env',async()=>{
  const source=await prepareSourceConnectivityLaunch();assert.ok(source);
  try {
    assert.equal(source.nodeProgram,process.execPath);assert.equal(source.nodeMode,process.versions.electron?'electron_as_node':'standalone_node');
    assert.ok((await lstat(source.componentRoot)).isDirectory());
    assert.deepEqual(await captureNativeConnectivityStartupConfiguration(nativeConnectivitySpawnEnvironment(source)[KEY]),source);
  } finally {
    await releaseSourceConnectivityLaunch(source);
  }
  await assert.rejects(lstat(source.componentRoot),{code:'ENOENT'});
  await releaseSourceConnectivityLaunch(source);
});
test('remote thin and unsupported package pins do not guess a local native resource path',async()=>{
  assert.deepEqual(await preparePackagedConnectivityGatewayEnvironment({remoteThin:true,resourcesPath:resolve(root,'absent'),appMetadata:{nativeConnectivityResources:{invalid:true}}}),{});
  await assert.rejects(preparePackagedConnectivityGatewayEnvironment({resourcesPath:root,appMetadata:{nativeConnectivityResources:{schemaVersion:1,resourceDirectory:'../other',manifestSha256:'a'.repeat(64),nodeMinimumMajor:22}}}),/PIN_INVALID/);
});
test('macOS channel packages use their sealed standalone Node, including its license', {skip:process.platform!=='darwin'}, async()=>{
  const stage=await stageNativeConnectivityResources({output:join(root,'mac-node'),nodeProgram:process.execPath,bundleNode:true});
  const manifest=JSON.parse(await readFile(join(stage.componentRoot,'channel-resource-manifest.json'),'utf8'));
  assert.ok(manifest.files.some(file=>file.path==='runtime/node'));
  assert.ok(manifest.files.some(file=>file.path==='licenses/node-LICENSE.txt'));
  const bundled=await prepareNativeConnectivityLaunch({componentRoot:stage.componentRoot,expectedManifestSha256:stage.manifestSha256});
  assert.equal(bundled.nodeProgram,join(stage.componentRoot,'runtime/node'));
  assert.equal(bundled.nodeMode,'standalone_node');
  assert.equal(bundled.electronVersion,null);
  assert.equal((await promisify(execFile)(bundled.nodeProgram,['--version'])).stdout.trim(),process.version);
  assert.deepEqual(await captureNativeConnectivityStartupConfiguration(nativeConnectivitySpawnEnvironment(bundled)[KEY]),bundled);
  const forged={...bundled,nodeProgram:process.execPath};
  await assert.rejects(captureNativeConnectivityStartupConfiguration(Buffer.from(JSON.stringify(forged)).toString('base64url')),/RUNTIME/);
});
