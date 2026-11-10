import assert from 'node:assert/strict';
import {createHash}from'node:crypto';
import {mkdir,readdir,readFile}from'node:fs/promises';
import {isAbsolute,join}from'node:path';
import {runE2E,waitFor}from'../../harness/run-context.mjs';
import {generateOffice}from'../../../../kcoder-office-components/src/index.mjs';
import {sample}from'../../../../kcoder-office-components/test/fixtures.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

await runE2E(import.meta.url,{testId:'office-owned-read-worker',tier:'manual-live',modelPolicy:'model-independent actual-host byte extraction; explicit Native reader prerequisite, no native authorization claim'},async context=>{
 const binary=process.env.KCODER_OFFICE_READER_TEST_BIN;assert.ok(binary&&isAbsolute(binary),'Explicit current KCoder binary required');assert.equal(process.platform,'linux','This actual process-tree case uses the Linux command owner');
 async function launch(kind,bytes,{badHash=false,cancelLarge=false,fontProbe=false}={}){
  const directory=context.pathInState('worker-'+kind);await mkdir(directory,{mode:0o700});
  const env=context.isolatedEnvironment({LANG:'C.UTF-8',KCODER_CONFIG_DIR:join(directory,'config')});
  const child=context.spawnOwned('read-'+kind,binary,['--internal-command-owner-v1',String(process.pid),binary,'--internal-office-read-worker'],{cwd:directory,env,stdin:'pipe'});
  let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8');assert.ok(stdout.length<=70*1024);});
  const header={schemaVersion:1,...(fontProbe?{operation:'probe_fonts'}:{}),reference:{id:'synthetic-input-'+kind,revision:1},filename:'material.'+(kind.startsWith('large')?'txt':kind),byteLength:bytes.length,sha256:badHash?'f'.repeat(64):sha(bytes),scopeSha256:'a'.repeat(64),limit:2};
  const result=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  child.stdin.write(JSON.stringify(header)+'\n');child.stdin.end(bytes);
  if(cancelLarge){
   await waitFor(async()=>{const entries=await readdir(directory);return entries.some(name=>name.startsWith('extract-'));},10_000,'actual large material copied by worker',5);
   const started=Date.now();child.kill('SIGTERM');const terminal=await result;assert.ok(Date.now()-started<5000);assert.notEqual(terminal.code,0);return{kind,cancelled:true,cleanup:'owned command owner exited',sourceBytes:bytes.length};
  }
  const terminal=await result;const value=JSON.parse(stdout);if(badHash){assert.notEqual(terminal.code,0);assert.deepEqual(value,{ok:false,error:{code:'OFFICE_READ_FAILED'}});assert.equal(stdout.includes(directory),false);return{kind,corruptIdentityRejected:true};}
  assert.equal(terminal.code,0);assert.equal(value.ok,true);if(fontProbe){assert.equal(value.result.requestedFamily,'Noto Sans SC');assert.ok(['available','fallback_only','unavailable'].includes(value.result.status));return{kind,fontObservation:value.result,cleanup:'owned command owner exited'};}assert.equal(value.result.sha256,sha(bytes));assert.equal(value.result.ocrPerformed,false);assert.ok(value.result.chunks.map(chunk=>chunk.text).join('\n').includes('1234.56'));assert.equal(stdout.includes(directory),false);return{kind,format:value.result.report.format,sourceBytes:bytes.length,extracted:value.result.report.textBytes,warnings:value.result.report.warnings,cleanup:'owned command owner exited'};
 }
 const cases=[];
 cases.push(await launch('txt',Buffer.from('会议决议：试点A；金额1234.56元，责任人待确认。')));
 for(const kind of ['docx','xlsx','pptx']){const generated=await generateOffice(sample(kind));cases.push(await launch(kind,Buffer.from(generated.bytes)));}
 cases.push(await launch('bad',Buffer.from('1234.56'),{badHash:true}));
 cases.push(await launch('font-probe',Buffer.alloc(0),{fontProbe:true}));
 const large=Buffer.alloc(32*1024*1024,0x61);cases.push(await launch('large-txt',large,{cancelLarge:true}));
 await context.writeArtifactJson('office-owned-reader-evidence.json',{schemaVersion:1,cases,modelCalls:0,limitations:['Pure-bytes component/owned Linux process-tree acceptance. Production input authorization, real target leases, Windows Job and full assistant/model business flow are separate gates.']});return{passed:true,cases:cases.length};
});
