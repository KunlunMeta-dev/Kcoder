import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stageNativeConnectivityResources } from '../../../../kcoder-channel-host/scripts/stage-native-resources.mjs';
import { appServerEnvironment } from '../../server-config.js';
import { sha256 } from '../office/resource-verifier.mjs';
import { captureGatewayNativeConnectivityStartup, captureNativeConnectivityStartupConfiguration,
  nativeConnectivityEnvironmentKey as KEY, nativeConnectivitySpawnEnvironment, prepareNativeConnectivityLaunch,
  prepareSourceConnectivityLaunch, releaseSourceConnectivityLaunch, settleSourceConnectivityLaunch,
  preparePackagedConnectivityGatewayEnvironment, verifyNativeConnectivityBundle } from './resource-host.mjs';

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
test('a changed component fails complete verification and a claimed runtime mode never becomes a launch',async()=>{
  const path=join(observation.componentRoot,'src/applications/stdio.mjs'),original=await readFile(path);
  await writeFile(path,Buffer.concat([original,Buffer.from('\n// controlled identity mismatch\n')]));
  try{
    await assert.rejects(verifyNativeConnectivityBundle(observation.componentRoot,observation.manifestSha256),/OFFICE_RESOURCE_UNSAFE/);
    const same=Buffer.from(original);same[0]^=1;await writeFile(path,same);
    await assert.rejects(verifyNativeConnectivityBundle(observation.componentRoot,observation.manifestSha256),/CHANNEL_RESOURCE_IDENTITY_CHANGED/);
  }
  finally{await writeFile(path,original);}
  await verifyNativeConnectivityBundle(observation.componentRoot,observation.manifestSha256);
  const changed={...launch,nodeMode:'electron_as_node',electronVersion:'wrong-native-runtime'};
  await assert.rejects(captureNativeConnectivityStartupConfiguration(Buffer.from(JSON.stringify(changed)).toString('base64url')),/RUNTIME/);
  await assert.rejects(captureNativeConnectivityStartupConfiguration(Buffer.from(JSON.stringify({...launch,nodeSha256:'not-a-digest'})).toString('base64url')),/STARTUP_INVALID/);
});
test('Electron and Gateway check only the pin; complete verification checks each ancestor once',async t=>{
  const counts={open:0,lstat:0};
  const original={open:fs.open,lstat:fs.lstat};
  t.mock.method(fs,'open',(...args)=>{counts.open++;return original.open(...args);});
  t.mock.method(fs,'lstat',(...args)=>{counts.lstat++;return original.lstat(...args);});
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const manifest=JSON.parse(await readFile(join(observation.componentRoot,'channel-resource-manifest.json'),'utf8'));
  const packaged=await prepareNativeConnectivityLaunch({componentRoot:observation.componentRoot,expectedManifestSha256:observation.manifestSha256});
  await captureNativeConnectivityStartupConfiguration(nativeConnectivitySpawnEnvironment(packaged)[KEY]);
  // Warm startup path: one manifest read per check, no tree walk, no runtime image digest.
  assert.equal(packaged.nodeSha256,undefined);
  assert.equal(counts.open,2);
  assert.ok(counts.lstat<64,`pin checks used ${counts.lstat} lstat calls`);
  counts.open=0;counts.lstat=0;
  await verifyNativeConnectivityBundle(observation.componentRoot,observation.manifestSha256);
  // Complete verification: one walk lstat and one pre-open lstat per file, plus each directory a bounded number of times.
  assert.equal(counts.open,manifest.files.length+1);
  assert.ok(counts.lstat<3*manifest.files.length,`complete verification used ${counts.lstat} lstat calls for ${manifest.files.length} files`);
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
test('the real source Gateway reuses its leased sealed copy and always releases its own lease',async()=>{
  const parent=join(root,'source-cache');await fs.mkdir(parent,{mode:0o700});
  const leases=async component=>readdir(join(component,'..','leases'));
  const source=await prepareSourceConnectivityLaunch({parent});assert.ok(source);
  let second;
  try {
    assert.equal(source.nodeProgram,process.execPath);assert.equal(source.nodeMode,process.versions.electron?'electron_as_node':'standalone_node');
    assert.ok((await lstat(source.componentRoot)).isDirectory());
    assert.deepEqual(await captureNativeConnectivityStartupConfiguration(nativeConnectivitySpawnEnvironment(source)[KEY]),source);
    // The full byte proof of the reused copy belongs to the Native load boundary.
    await verifyNativeConnectivityBundle(source.componentRoot,source.manifestSha256);
    const staged=(await readdir(parent)).length;
    second=await prepareSourceConnectivityLaunch({parent});
    assert.equal(second.componentRoot,source.componentRoot);
    assert.equal(second.manifestSha256,source.manifestSha256);
    assert.equal((await readdir(parent)).length,staged,'a valid copy is reused, not staged again');
    assert.equal((await leases(source.componentRoot)).length,2);
  } finally {
    await releaseSourceConnectivityLaunch(source);
  }
  assert.equal((await leases(source.componentRoot)).length,1);
  // Timeout after shutdown's SIGKILL still releases this Gateway's lease.
  assert.equal(await settleSourceConnectivityLaunch(second,new Set([{}]),30),false);
  assert.deepEqual(await leases(source.componentRoot),[]);
  assert.ok((await lstat(source.componentRoot)).isDirectory(),'the shared copy stays for the next start');
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
