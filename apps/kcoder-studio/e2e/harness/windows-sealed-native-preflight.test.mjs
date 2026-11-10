import assert from 'node:assert/strict';
import test from 'node:test';
import {validateSealedNativeInputs,runSealedNativeVerification} from '../preflight/windows-sealed-verify-native.mjs';

function fixture(){
 const components=[['kcoder_config','private_files::readonly_handles::tests::',6],['kcoder_mcp','searxng_runtime::windows_verify::tests::',11]]
  .map(([crate,filter,count])=>({crate,filter,names:Array.from({length:count},(_,index)=>filter+'case_'+index)}));
 return{inputs:{sourceCommit:'af149440b35d0f5121f2c415653eeda7e2934cf1',sourceClean:true,buildExitCode:0,cliBeforeSha256:'db260746a81579d3e067e7a8a3110773c16df35e7f84397f1639a6b989fb0c2c',cliAfterSha256:'db260746a81579d3e067e7a8a3110773c16df35e7f84397f1639a6b989fb0c2c',sourceTreeSha256:'a'.repeat(64),rosterSha256:'1bb2cdd4e25908e3ac2ba5cb9b22cea8c64b07450753f551f5ce4fe1984b940a',binaries:Object.fromEntries(components.map(({crate})=>[crate,{path:'/owned/'+crate+'.exe',sha256:'b'.repeat(64)}]))},roster:{schemaVersion:1,externalRequests:0,expectedIgnored:0,components}};
}
test('sealed native preflight cannot widen the frozen source, crates, roster or zero-ignore policy',()=>{
 const{inputs,roster}=fixture();assert.doesNotThrow(()=>validateSealedNativeInputs(inputs,roster));
 for(const patch of [{sourceCommit:'c'.repeat(40)},{sourceClean:false},{buildExitCode:1},{cliAfterSha256:'d'.repeat(64)},{rosterSha256:'e'.repeat(64)},{binaries:{}}])assert.throws(()=>validateSealedNativeInputs({...inputs,...patch},roster));
 for(const patch of [{externalRequests:1},{expectedIgnored:1},{components:roster.components.slice(1)}])assert.throws(()=>validateSealedNativeInputs(inputs,{...roster,...patch}));
 const configOnly={...inputs,binaries:{kcoder_config:inputs.binaries.kcoder_config}};assert.doesNotThrow(()=>validateSealedNativeInputs(configOnly,roster,'kcoder_config'));assert.throws(()=>validateSealedNativeInputs(configOnly,roster));assert.throws(()=>validateSealedNativeInputs(inputs,roster,'unknown'));
 const fixed={...configOnly,sourceCommit:'314eba3570fb0d0e67bdfcfd49311775c32eac6e',selectedTest:'private_files::readonly_handles::tests::symlink_leaf_and_junction_ancestor_are_not_followed'};assert.doesNotThrow(()=>validateSealedNativeInputs(fixed,roster,'kcoder_config'));assert.throws(()=>validateSealedNativeInputs({...fixed,selectedTest:'other'},roster,'kcoder_config'));assert.throws(()=>validateSealedNativeInputs(fixed,roster,'kcoder_mcp'));
 const changed=structuredClone(roster);changed.components[0].names[1]=changed.components[0].names[0];assert.throws(()=>validateSealedNativeInputs(inputs,changed));
});
test('sealed native execution requires platform consent before reading files or contacting a host',async()=>{
 const previous=process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST;delete process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST;
 try{await assert.rejects(runSealedNativeVerification(),/Explicit native platform consent/)}finally{if(previous!==undefined)process.env.KCODER_E2E_WINDOWS_NATIVE_LIBTEST=previous}
});
