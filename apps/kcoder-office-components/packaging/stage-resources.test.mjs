// Actual local package resources; no installed-platform or live-model claim.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, lstat, rm, readFile, writeFile, rename, symlink, link, unlink } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { containsPath, stageOfficeResources } from './stage-resources.mjs';
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
 assert.ok(!result.manifest.files.some(file=>/stage-lock|authority\.sqlite|office-stage/.test(file.path)),'build mutex is not copied into the runtime');
 await assert.rejects(stageOfficeResources({destination:receipt.root}),{code:'OFFICE_RESOURCE_STAGE_EXISTS'});
});
test('missing or changed bytes, extra files, false digest and unsafe relative paths fail closed',async()=>{
 await assert.rejects(verifyOfficeResourceBundle(receipt.root,'0'.repeat(64)),{code:'OFFICE_RESOURCE_IDENTITY_MISMATCH'});
 for(const value of ['../outside','/outside','C:/outside','components/../outside','components\\x'])assert.throws(()=>resourceRelative(value));
 const file=join(receipt.componentRoot,'src/cli.mjs');const original=await readFile(file);
 try{await writeFile(file,Buffer.concat([original,Buffer.from('\n// changed')]));await assert.rejects(verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256),{code:'OFFICE_RESOURCE_IDENTITY_MISMATCH'});}finally{await writeFile(file,original);}
 const missing=join(root,'missing-original');await rename(file,missing);try{await assert.rejects(verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256),{code:'OFFICE_RESOURCE_IDENTITY_MISMATCH'});}finally{await rename(missing,file);}
 const extra=join(receipt.componentRoot,'unlisted.js');try{await writeFile(extra,'unsealed');await assert.rejects(verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256),{code:'OFFICE_RESOURCE_IDENTITY_MISMATCH'});}finally{await rm(extra);}
 for(const hard of [false,true]){const held=join(root,'held-entry');await rename(file,held);try{if(hard)await link(held,file);else await symlink(held,file);await assert.rejects(verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256),{code:'OFFICE_RESOURCE_UNSAFE'});}finally{try{await unlink(file);}catch(error){if(error.code!=='ENOENT')throw error;}finally{await rename(held,file);}}}
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
 const destination=join(root,'legacy-peer'),lock=join(root,'.legacy-peer.office-stage.lock');await writeFile(lock,'owned-peer');try{await assert.rejects(stageOfficeResources({destination,replace:true}),{code:'OFFICE_RESOURCE_STAGE_BUSY'});assert.equal(await readFile(lock,'utf8'),'owned-peer');}finally{await rm(lock);}
 receipt=await stageOfficeResources({destination:receipt.root,replace:true});assert.equal((await verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256)).manifest.componentName,'@kcoder/office-components');
});
test('an interrupted owned stager retains a complete notice and can reacquire its kernel mutex',async()=>{
 const destination=join(root,'interrupted'),lock=join(root,'.interrupted.office-stage.lock');
 const module=new URL('./stage-resources.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['-e',`import(${JSON.stringify(module)}).then(m=>m.stageOfficeResources({destination:process.argv[1]})).catch(()=>process.exitCode=1)`,destination],{stdio:['ignore','pipe','pipe']});
 child.stdout.resume();child.stderr.resume();
 const closed=new Promise((accept,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>accept({code,signal}));});
 try{
  const deadline=Date.now()+5000;
  while(!(await lstat(lock).catch(error=>{if(error.code==='ENOENT')return null;throw error;}))){if(Date.now()>deadline)throw Error('owned stager did not acquire its lock');await delay(10);}
  assert.equal(child.kill('SIGKILL'),true);const result=await closed;assert.equal(result.signal,'SIGKILL');
  const recovered=await stageOfficeResources({destination});assert.equal(recovered.root,destination);
  assert.equal((await lstat(lock)).isFile(),true);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}
});
test('containment uses the host path dialect and accepts cross-volume Windows destinations',()=>{
 for(const paths of [win32,posix]){
  const source=paths.resolve(paths===win32?'C:/source/office':'/source/office');
  assert.equal(containsPath(source,source,paths),true);
  assert.equal(containsPath(source,paths.join(source,'nested'),paths),true);
  assert.equal(containsPath(source,paths.resolve(source,'../office-other'),paths),false);
  assert.equal(containsPath(source,paths.resolve(source,'../..sibling'),paths),false);
 }
 assert.equal(containsPath('C:\\source\\office','D:\\bundle\\office',win32),false);
 assert.equal(containsPath('C:\\source\\office','c:\\SOURCE\\office\\nested',win32),true);
});
test('replacement stops on the original missing manifest and does not create a fresh tree',async()=>{
 const destination=join(root,'unsealed');await mkdir(destination);await writeFile(join(destination,'preserve.txt'),'owned fixture');
 const before=await readdir(root);
 await assert.rejects(stageOfficeResources({destination,replace:true}),{code:'ENOENT'});
 assert.equal(await readFile(join(destination,'preserve.txt'),'utf8'),'owned fixture');
 assert.deepEqual((await readdir(root)).filter(name=>!name.startsWith('.unsealed.office-stage.')),before);
});
test('a failed lock stat still closes its descriptor without deleting an unidentified lock',async t=>{
 const original=fs.open;let closed=false;
 const mocked=t.mock.method(fs,'open',async(path,...args)=>{
  const handle=await original(path,...args);
  if(path!==join(root,'.failed-stat.office-stage.v1','authority.sqlite'))return handle;
  return{stat:async()=>{throw Object.assign(Error('injected stat failure'),{code:'EIO'});},close:async()=>{closed=true;await handle.close();}};
 });
 syncBuiltinESMExports();
 try{await assert.rejects(stageOfficeResources({destination:join(root,'failed-stat')}),{code:'EIO'});assert.equal(closed,true);}
 finally{mocked.mock.restore();syncBuiltinESMExports();}
});
test('a published replacement retains its receipt and owned recovery path when backup cleanup fails',async t=>{
 const original=fs.rm;
 const mocked=t.mock.method(fs,'rm',async(path,options)=>{
  if(String(path).startsWith(join(root,'.office-resource-stage-')))throw Object.assign(Error('injected busy cleanup'),{code:'EBUSY'});
  return original(path,options);
 });
 syncBuiltinESMExports();
 try{
  receipt=await stageOfficeResources({destination:receipt.root,replace:true});
  assert.equal(receipt.cleanup.status,'unconfirmed');
  assert.ok(receipt.cleanup.recoveryRoot.startsWith(join(root,'.office-resource-stage-')));
  assert.ok((await readdir(receipt.cleanup.recoveryRoot)).includes('previous'));
  assert.equal((await verifyOfficeResourceBundle(receipt.root,receipt.manifestSha256)).manifest.componentName,'@kcoder/office-components');
 }finally{mocked.mock.restore();syncBuiltinESMExports();}
});
test('cancelling after work creation cleans only owned staging and retains the cancellation outcome',async t=>{
 const controller=new AbortController(),destination=join(root,'cancelled-stage');
 const before=(await readdir(root)).filter(name=>name.startsWith('.office-resource-stage-')).sort();
 const original=fs.mkdtemp;let work;
 const mocked=t.mock.method(fs,'mkdtemp',async(...args)=>{
  const path=await original(...args);
  if(String(args[0]).startsWith(join(root,'.office-resource-stage-'))){work=path;controller.abort();}
  return path;
 });
 syncBuiltinESMExports();
 try{
  await assert.rejects(stageOfficeResources({destination,signal:controller.signal}),{code:'OFFICE_CANCELLED'});
  assert.ok(work);await assert.rejects(lstat(work),{code:'ENOENT'});
  assert.deepEqual((await readdir(root)).filter(name=>name.startsWith('.office-resource-stage-')).sort(),before);
  await assert.rejects(lstat(destination),{code:'ENOENT'});
 }finally{mocked.mock.restore();syncBuiltinESMExports();}
 const recovered=await stageOfficeResources({destination});assert.equal(recovered.root,destination);
});
test('cancellation does not authorize cleanup after the authority notice was replaced',async t=>{
 const controller=new AbortController(),destination=join(root,'cancelled-revoked');
 const notice=join(root,'.cancelled-revoked.office-stage.lock'),original=fs.mkdtemp;let work;
 const mocked=t.mock.method(fs,'mkdtemp',async(...args)=>{
  const path=await original(...args);
  if(String(args[0]).startsWith(join(root,'.office-resource-stage-'))){
   work=path;await rename(notice,notice+'.held');await writeFile(notice,'independent owned fixture',{mode:0o600});controller.abort();
  }
  return path;
 });
 syncBuiltinESMExports();
 try{
  await assert.rejects(stageOfficeResources({destination,signal:controller.signal}),{code:'OFFICE_RESOURCE_STAGE_RECOVERY_REQUIRED'});
  assert.ok((await lstat(work)).isDirectory());
  assert.equal(await readFile(notice,'utf8'),'independent owned fixture');
  await assert.rejects(lstat(destination),{code:'ENOENT'});
 }finally{mocked.mock.restore();syncBuiltinESMExports();}
});
async function electronProbe(program,script){
 return new Promise((accept,reject)=>{
  const child=spawn(program,['--input-type=module','-'],{env:{LANG:'C.UTF-8',ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']});let out='',err='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):accept(value);};
  const timer=setTimeout(()=>{child.kill();finish(Error('owned Electron probe timeout'));},30000);
  child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err=(err+chunk).slice(-1024));
  child.once('error',error=>finish(error));child.stdin.once('error',error=>{child.kill();finish(error);});
  child.once('close',code=>{if(code!==0){finish(Error('owned Electron mode unavailable '+err));return;}try{finish(null,JSON.parse(out));}catch(error){finish(error);}});
  child.stdin.end(script);
 });
}
test('the owned Electron probe settles failed spawning without retaining its timeout',async()=>{
 await assert.rejects(electronProbe(join(root,'missing-electron'),'fixture'),{code:'ENOENT'});
});
test('actual existing Electron runs the private launcher as Node after enabled fuse observation',{skip:!process.env.KCODER_OFFICE_RESOURCE_TEST_ELECTRON},async()=>{
 const program=process.env.KCODER_OFFICE_RESOURCE_TEST_ELECTRON;
 const facts=await digestResource(program,{maxBytes:1024*1024*1024,inspectFuses:true});assert.equal(facts.electronRunAsNodeEnabled,true);
 const module=new URL('../../kcoder-studio/src/integrations/office/resource-host.mjs',import.meta.url).href;
 const script=`import {prepareNativeOfficeLaunch} from ${JSON.stringify(module)}; const result=await prepareNativeOfficeLaunch({componentRoot:${JSON.stringify(receipt.root)},expectedManifestSha256:${JSON.stringify(receipt.manifestSha256)},expectedMode:'electron_as_node'}); console.log(JSON.stringify(result.runtime));`;
 const result=await electronProbe(program,script);
 assert.equal(result.mode,'electron_as_node');assert.equal(result.sha256,facts.sha256);assert.match(result.electronVersion,/^\d+\.\d+\.\d+/);assert.ok(Number(result.nodeVersion.split('.')[0])>=22);
});
