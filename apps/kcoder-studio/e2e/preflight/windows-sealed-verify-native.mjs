import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runE2E} from '../harness/run-context.mjs';
import {runWindowsNativeLibtest} from '../harness/windows-native-libtest.mjs';
import {windowsNativeCaseContext} from '../harness/windows-native-case.mjs';

const sourceCommit='af149440b35d0f5121f2c415653eeda7e2934cf1';
const junctionSourceCommit='314eba3570fb0d0e67bdfcfd49311775c32eac6e';
const junctionCase='private_files::readonly_handles::tests::symlink_leaf_and_junction_ancestor_are_not_followed';
const rosterSha256='1bb2cdd4e25908e3ac2ba5cb9b22cea8c64b07450753f551f5ce4fe1984b940a';
const cliSha256='db260746a81579d3e067e7a8a3110773c16df35e7f84397f1639a6b989fb0c2c';

export function validateSealedNativeInputs(inputs,roster,component){
 assert.ok(component===undefined||['kcoder_config','kcoder_mcp'].includes(component));
 if(inputs.sourceCommit===junctionSourceCommit){assert.equal(component,'kcoder_config');assert.equal(inputs.selectedTest,junctionCase)}else{assert.equal(inputs.sourceCommit,sourceCommit);assert.equal(inputs.selectedTest,undefined)}
 assert.equal(inputs.sourceClean,true);assert.equal(inputs.buildExitCode,0);
 assert.equal(inputs.cliBeforeSha256,cliSha256);assert.equal(inputs.cliAfterSha256,cliSha256);
 assert.match(inputs.sourceTreeSha256??'',/^[a-f0-9]{64}$/);assert.equal(inputs.rosterSha256,rosterSha256);
 assert.equal(roster.schemaVersion,1);assert.equal(roster.externalRequests,0);assert.equal(roster.expectedIgnored,0);
 assert.deepEqual(roster.components.map(value=>value.crate),['kcoder_config','kcoder_mcp']);
 for(const [index,entry]of roster.components.entries()){
  assert.equal(entry.filter,index===0?'private_files::readonly_handles::tests::':'searxng_runtime::windows_verify::tests::');
  assert.equal(entry.names.length,index===0?6:11);assert.equal(new Set(entry.names).size,entry.names.length);
  assert.ok(entry.names.every(name=>name.startsWith(entry.filter)&&/^[A-Za-z0-9_:]+$/.test(name)));
  if(component===undefined||component===entry.crate){const binary=inputs.binaries[entry.crate];assert.ok(binary.path);assert.match(binary.sha256??'',/^[a-f0-9]{64}$/);}
 }
}

export async function runSealedNativeVerification({component}={}){
 assert.equal(process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST,'1','Explicit native platform consent required');
 assert.notEqual(process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK,'1','This finite roster has no external-network lane');
 const inputPath=process.env.KCODER_E2E_WINDOWS_SEALED_INPUTS;assert.ok(inputPath);
 const stat=await lstat(inputPath);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<65536);
 const inputs=JSON.parse(await readFile(inputPath,'utf8'));const bytes=await readFile(inputs.rosterPath);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),rosterSha256);
 const roster=JSON.parse(bytes);validateSealedNativeInputs(inputs,roster,component);
 const selected=roster.components.filter(value=>component===undefined||component===value.crate).map(entry=>inputs.selectedTest?{...entry,names:[inputs.selectedTest],exactTest:inputs.selectedTest}:entry);const expected=selected.reduce((count,entry)=>count+entry.names.length,0);
 return runE2E(import.meta.url,{testId:'windows-sealed-verify-native-'+(component??'all'),tier:'manual-live',cleanupTimeoutMs:120000,
  modelPolicy:'Only the frozen '+(component??'Config6 and MCP11')+' native filesystem, pinned-handle, bounded-pool and original Job-exit tests; no Python, model, DNS, HTTP, query, personal settings or Registry writes.'},async context=>{
  await context.writeArtifactJson('sealed-native-source.json',{...inputs,roster});
  const results=[];
  for(const entry of selected){
   const binary=inputs.binaries[entry.crate];const child=windowsNativeCaseContext(context,entry.crate);
   const result=await runWindowsNativeLibtest(child,{consent:'1',target:process.env.KCODER_E2E_WINDOWS_SSH_TARGET,parent:process.env.KCODER_E2E_WINDOWS_PROBE_PARENT,node:process.env.KCODER_E2E_WINDOWS_NODE,
    testBinary:binary.path,testSha256:binary.sha256,sourceTreeSha256:inputs.sourceTreeSha256,expectedCommit:inputs.sourceCommit,
    supervisor:process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_BIN,supervisorSha256:process.env.KCODER_E2E_WINDOWS_NATIVE_SUPERVISOR_SHA256,
    ...(entry.exactTest?{exactTest:entry.exactTest}:{testFilter:entry.filter}),expectedTests:entry.names});
   assert.equal(result.summary.passed,entry.names.length);assert.equal(result.summary.failed,0);assert.equal(result.summary.ignored,0);results.push(result);
  }
  return{passed:true,nativeTests:expected,component:component??'all',ignored:0,externalRequests:0,pythonStarts:0,results};
 });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runSealedNativeVerification({component:process.argv.find(value=>value.startsWith('--component='))?.slice('--component='.length)});
