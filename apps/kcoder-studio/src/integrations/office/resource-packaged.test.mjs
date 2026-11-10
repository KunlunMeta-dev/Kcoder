// Native packaged producer gates; no renderer/business JSON launch API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparePackagedOfficeGatewayEnvironment } from './resource-host.mjs';
import { digestResource } from './resource-verifier.mjs';
const program=process.env.KCODER_OFFICE_RESOURCE_TEST_ELECTRON;
const metadataPath=process.env.KCODER_OFFICE_PACKAGED_METADATA;
const resources=process.env.KCODER_OFFICE_PACKAGED_RESOURCES;
test('remote-thin and unpinned metadata do not inspect or guess an Office bundle',async()=>{
 assert.deepEqual(await preparePackagedOfficeGatewayEnvironment({remoteThin:true,resourcesPath:'/not-a-real-resource',appMetadata:{nativeOfficeResources:{untrusted:true}}}),{});
 assert.deepEqual(await preparePackagedOfficeGatewayEnvironment({resourcesPath:'/not-a-real-resource',appMetadata:{}}),{});
 await assert.rejects(preparePackagedOfficeGatewayEnvironment({resourcesPath:'/not-a-real-resource',appMetadata:{nativeOfficeResources:{schemaVersion:1,resourceDirectory:'../untrusted',manifestSha256:'a'.repeat(64),nodeMinimumMajor:22}}}),{code:'OFFICE_PACKAGED_PIN_INVALID'});
});
test('actual Electron native producer consumes actual app-metadata pin, rejects a changed hash and emits private Gateway configuration',{skip:!program||!metadataPath||!resources},async()=>{
 const facts=await digestResource(program,{maxBytes:1024*1024*1024,inspectFuses:true});assert.equal(facts.electronRunAsNodeEnabled,true);
 const helper=pathToFileURL(resolve('apps/kcoder-studio/src/integrations/office/resource-host.mjs')).href;
 const source=`import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {preparePackagedOfficeGatewayEnvironment} from ${JSON.stringify(helper)};
 const metadata=JSON.parse(await readFile(${JSON.stringify(metadataPath)},'utf8'));
 const env=await preparePackagedOfficeGatewayEnvironment({resourcesPath:${JSON.stringify(resources)},appMetadata:metadata});
 const observed=JSON.parse(Buffer.from(env.KCODER_NATIVE_OFFICE_BINDING_V1,'base64url').toString('utf8'));
 assert.equal(observed.manifestSha256,metadata.nativeOfficeResources.manifestSha256);assert.equal(observed.runtime.program,process.execPath);assert.equal(observed.runtime.mode,'electron_as_node');assert.equal(observed.runtime.electronVersion,process.versions.electron);
 const changed=structuredClone(metadata);changed.nativeOfficeResources.manifestSha256='0'.repeat(64);
 await assert.rejects(preparePackagedOfficeGatewayEnvironment({resourcesPath:${JSON.stringify(resources)},appMetadata:changed}),{code:'OFFICE_RESOURCE_IDENTITY_MISMATCH'});
 console.log(JSON.stringify({mode:observed.runtime.mode,electron:observed.runtime.electronVersion,node:observed.runtime.nodeVersion,pin:observed.manifestSha256,privateEnvPresent:true,changedPinRejected:true}));`;
 const observed=await new Promise((accept,reject)=>{
  const child=spawn(program,['--input-type=module','-'],{env:{LANG:'C.UTF-8',ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},30000);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>65536)child.kill('SIGTERM');});child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-2048));
  child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{clearTimeout(timer);if(timedOut||code!==0)reject(Error('owned packaged producer failed '+stderr));else{try{accept(JSON.parse(stdout));}catch(error){reject(error);}}});
  child.stdin.end(source);
 });
 assert.equal(observed.mode,'electron_as_node');assert.equal(observed.electron,'42.3.3');assert.equal(observed.privateEnvPresent,true);assert.equal(observed.changedPinRejected,true);
});
