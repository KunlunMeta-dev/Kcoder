// Actual local package resources; no installed-platform or live-model claim.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, rename, symlink, link, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stageOfficeResources } from './stage-resources.mjs';
import { digestResource, officeResourceManifestName, resourceRelative, sha256, verifyOfficeResourceBundle } from '../../kcoder-studio/src/integrations/office/resource-verifier.mjs';
import { nativeOfficeSpawnEnvironment, nativeOfficeLaunchValues, prepareNativeOfficeLaunch } from '../../kcoder-studio/src/integrations/office/resource-host.mjs';
let root,receipt;
before(async()=>{root=await mkdtemp(join(tmpdir(),'owned-office-resource-stage-'));receipt=await stageOfficeResources({destination:join(root,'office')});});
after(async()=>{if(root)await rm(root,{recursive:true,force:true});});
test('stages exact real dependencies and retained legal files without bundling or inventing a runtime',async()=>{
 const result=await verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256);
 assert.equal(result.manifest.entry,'components/src/cli.mjs');assert.equal(result.manifest.nodeMinimumMajor,22);assert.equal(receipt.runtimeIncluded,false);
 assert.equal(result.manifest.dependencies.find(dep=>dep.path==='node_modules/docx').version,'9.5.1');
 assert.ok(result.manifest.files.some(file=>file.path==='licenses/kcoder-office/LICENSE.txt'));
 for(const direct of ['docx','exceljs','pptxgenjs','fflate'])assert.ok(result.manifest.files.some(file=>file.path.startsWith('components/node_modules/'+direct+'/')&&file.legal),'dependency legal files retained: '+direct);
 assert.ok(!result.manifest.files.some(file=>/\.test\.[cm]?[jt]sx?$/.test(file.path)));
 assert.ok(result.manifest.files.some(file=>file.path==='licenses/saxes/LICENSE.txt'&&file.legal));
 await assert.rejects(stageOfficeResources({destination:receipt.root}),{code:'OFFICE_RESOURCE_STAGE_EXISTS'});
});
test('missing or changed bytes, extra files, false digest and unsafe relative paths fail closed',async()=>{
 await assert.rejects(verifyOfficeResourceBundle(receipt.root,'0'.repeat(64)),{code:'OFFICE_RESOURCE_IDENTITY_MISMATCH'});
 for(const value of ['../outside','/outside','C:/outside','components/../outside','components\\x'])assert.throws(()=>resourceRelative(value));
 const file=join(receipt.componentRoot,'src/cli.mjs');const original=await readFile(file);
 try{await writeFile(file,Buffer.concat([original,Buffer.from('\n// changed')]));await assert.rejects(verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256));}finally{await writeFile(file,original);}
 const missing=join(root,'missing-original');await rename(file,missing);try{await assert.rejects(verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256));}finally{await rename(missing,file);}
 const extra=join(receipt.componentRoot,'unlisted.js');try{await writeFile(extra,'unsealed');await assert.rejects(verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256));}finally{await rm(extra);}
 for(const hard of [false,true]){const held=join(root,'held-entry');await rename(file,held);try{if(hard)await link(held,file);else await symlink(held,file);await assert.rejects(verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256));}finally{await unlink(file);await rename(held,file);}}
});
test('native launcher observes its actual runtime; copied JSON is not a launch authority',async()=>{
 const launch=await prepareNativeOfficeLaunch({componentRoot:receipt.root,expectedManifestSha256:receipt.manifestSha256,expectedMode:'standalone_node'});
 assert.equal(launch.runtime.program,process.execPath);assert.equal(launch.runtime.nodeVersion,process.versions.node);assert.equal(launch.runtime.mode,'standalone_node');
 assert.ok(nativeOfficeSpawnEnvironment(launch).KCODER_NATIVE_OFFICE_BINDING_V1);
 assert.equal(nativeOfficeLaunchValues(launch),launch);
 assert.throws(()=>nativeOfficeSpawnEnvironment(JSON.parse(JSON.stringify(launch))),{code:'OFFICE_NATIVE_LAUNCH_REQUIRED'});
 await assert.rejects(prepareNativeOfficeLaunch({componentRoot:receipt.root,expectedManifestSha256:receipt.manifestSha256,expectedMode:'electron_as_node'}),{code:'OFFICE_RUNTIME_MODE_UNAVAILABLE'});
});
test('changed lock/dependency declaration is not accepted by merely resealing a manifest',async()=>{
 const path=join(receipt.root,officeResourceManifestName);const bytes=await readFile(path);const value=JSON.parse(bytes);value.dependencies.pop();const changed=Buffer.from(JSON.stringify(value)+'\n');
 try{await writeFile(path,changed);await assert.rejects(verifyOfficeResourceBundle(receipt.root,sha256(changed)),{code:'OFFICE_DEPENDENCY_UNAVAILABLE'});}finally{await writeFile(path,bytes);}
});
test('replacement is explicit and a peer stage lock is never removed or ignored',async()=>{
 const lock=join(root,'.office.office-stage.lock');await writeFile(lock,'owned-peer');try{await assert.rejects(stageOfficeResources({destination:receipt.root,replace:true}),{code:'OFFICE_RESOURCE_STAGE_BUSY'});assert.equal(await readFile(lock,'utf8'),'owned-peer');}finally{await rm(lock);}
 receipt=await stageOfficeResources({destination:receipt.root,replace:true});assert.equal((await verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256)).manifest.componentName,'@kcoder/office-components');
});
test('actual existing Electron runs the private launcher as Node after enabled fuse observation',{skip:!process.env.KCODER_OFFICE_RESOURCE_TEST_ELECTRON},async()=>{
 const program=process.env.KCODER_OFFICE_RESOURCE_TEST_ELECTRON;
 const facts=await digestResource(program,{maxBytes:1024*1024*1024,inspectFuses:true});assert.equal(facts.electronRunAsNodeEnabled,true);
 const module=pathToFileURL(resolve('apps/kcoder-studio/src/integrations/office/resource-host.mjs')).href;
 const script=`import {prepareNativeOfficeLaunch} from ${JSON.stringify(module)}; const result=await prepareNativeOfficeLaunch({componentRoot:${JSON.stringify(receipt.root)},expectedManifestSha256:${JSON.stringify(receipt.manifestSha256)},expectedMode:'electron_as_node'}); console.log(JSON.stringify(result.runtime));`;
 const result=await new Promise((accept,reject)=>{const child=spawn(program,['--input-type=module','-'],{env:{LANG:'C.UTF-8',ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{child.kill();reject(Error('owned Electron probe timeout'));},30000);child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err=(err+chunk).slice(-1024));child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?accept(JSON.parse(out)):reject(Error('owned Electron mode unavailable '+err));});child.stdin.end(script);});
 assert.equal(result.mode,'electron_as_node');assert.equal(result.sha256,facts.sha256);assert.equal(result.electronVersion,'42.3.3');assert.ok(Number(result.nodeVersion.split('.')[0])>=22);
});
