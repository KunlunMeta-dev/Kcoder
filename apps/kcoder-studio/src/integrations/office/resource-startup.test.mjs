// Actual native-host configuration remains separate from existing parent authorization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { captureNativeOfficeStartupConfiguration, nativeOfficeEnvironmentKey } from './resource-host.mjs';
import { appServerEnvironment, captureGatewayNativeOfficeStartup } from '../../server-config.js';
const fixturePath=process.env.KCODER_OFFICE_NATIVE_NODE_LAUNCH;
test('Gateway consumes reserved launch values before asynchronous verification and never rereads them',async t=>{
 const warning=t.mock.method(console,'warn',()=>{});
 const env={[nativeOfficeEnvironmentKey]:'invalid-startup-value',kcoder_private_retention_parent_v1:'untrusted-parent',KCODER_PRIVATE_RETENTION_VERIFIER_V1:'untrusted-verifier',PATH:'/controlled'};
 const observation=captureGatewayNativeOfficeStartup(env);
 assert.deepEqual(env,{PATH:'/controlled'});
 assert.equal(await observation,null);
 assert.equal(warning.mock.calls.length,1);
 assert.deepEqual(warning.mock.calls[0].arguments,['OFFICE_NATIVE_UNAVAILABLE']);
 assert.equal(await captureGatewayNativeOfficeStartup(env),null);
 assert.equal(warning.mock.calls.length,1);
});
test('ordinary inherited/target overrides never become private Office startup input',()=>{
 const inherited={[nativeOfficeEnvironmentKey]:'ambient-forgery',PATH:'/controlled'};
 const target={[nativeOfficeEnvironmentKey]:'target-forgery'};
 assert.equal(Object.hasOwn(appServerEnvironment(inherited,target),nativeOfficeEnvironmentKey),false);
 assert.equal(Object.hasOwn(appServerEnvironment(inherited,target,'localOs'),nativeOfficeEnvironmentKey),false);
 assert.equal(appServerEnvironment(inherited,target).PATH,'/controlled');
});
test('actual native observation is injected only behind existing trusted local parent guard',{skip:!fixturePath},async()=>{
 const raw=await readFile(fixturePath,'utf8');const launch=await captureNativeOfficeStartupConfiguration(Buffer.from(raw).toString('base64url'));
 const verifier={version:1,gatewayNamespaceId:'a'.repeat(64),key:'b'.repeat(64)};
 assert.throws(()=>appServerEnvironment({}, {},undefined,undefined,launch));
 assert.throws(()=>appServerEnvironment({}, {},'localOs',undefined,launch));
 assert.throws(()=>appServerEnvironment({}, {},'localOs',verifier,JSON.parse(JSON.stringify(launch))));
 const env=appServerEnvironment({[nativeOfficeEnvironmentKey]:'ambient'}, {[nativeOfficeEnvironmentKey]:'target'},'localOs',verifier,launch);
 const value=JSON.parse(Buffer.from(env[nativeOfficeEnvironmentKey],'base64url').toString('utf8'));
 assert.equal(value.schemaVersion,1);assert.equal(value.runtime.program,process.execPath);assert.equal(value.runtime.mode,'standalone_node');
 assert.notEqual(env[nativeOfficeEnvironmentKey],'ambient');assert.notEqual(env[nativeOfficeEnvironmentKey],'target');
});
test('startup observations cannot redirect execution to a different path/hash/mode',{skip:!fixturePath},async()=>{
 const original=JSON.parse(await readFile(fixturePath,'utf8'));
 for(const field of ['program','sha256','mode','nodeVersion']) {
  const value=structuredClone(original);value.runtime[field]=field==='sha256'?'0'.repeat(64):'different-native-observation';
  await assert.rejects(captureNativeOfficeStartupConfiguration(Buffer.from(JSON.stringify(value)).toString('base64url')));
 }
});
