import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeServer,launchSpec} from '../../src/server-config.js';
import {physicalWindowsServer,physicalWebCleanupScript} from './physical-web-windows.mjs';
import {startPhysicalWebModel,PHYSICAL_FETCH_URL,physicalSharedCapabilities} from './physical-web-protocol.mjs';
test('physical Windows target uses the product SSH launchSpec and an explicit native executable',()=>{
 const value=physicalWindowsServer('D:\\kcoder-package-owned','ssh-owner','win-hc','Administrator');
 const server=normalizeServer(value,{platform:"linux"});const spec=launchSpec(server);
 assert.equal(spec.command,'ssh');assert.ok(spec.args.includes('Administrator@win-hc'));assert.ok(spec.args.includes('powershell.exe'));
 const script=Buffer.from(spec.args.at(-1),'base64').toString('utf16le');
 assert.match(script,/launcher\.exe/);assert.match(script,/app-server/);assert.match(script,/--cwd/);
 assert.equal(server.remotePlatform,'windows');assert.throws(()=>physicalWindowsServer('D:\\owned','other','win-hc','Administrator'));
});
test('cleanup invokes only the versioned owner-checked remote cleanup source',()=>{
 const command=physicalWebCleanupScript('D:\\owned','12345678-1234-1234-1234-123456789abc');
 assert.match(command,/cleanup\.ps1/);assert.match(command,/-Owner/);assert.doesNotMatch(command,/taskkill.*\/IM|Stop-Process.*-Name/);
});
test('zero-public preflight model cannot emit WebFetch and keeps profile identities distinct',async()=>{
 const cleanups=[];const fixture=await startPhysicalWebModel({addCleanup:(_label,action)=>cleanups.push(action),registerPort(){},registerSecret(){}},{executeWeb:false});
 try{for(const id of ['ssh-owner','ssh-peer','http-owner','http-peer']){
  const response=await fetch(fixture.baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify({model:id,messages:[{role:'user',content:'OWNED'}]})});const text=await response.text();assert.ok(text.includes('OWNED_ACK_'+id));assert.ok(!text.includes('tool_calls'));
 }}finally{for(const action of cleanups.reverse())await action()}
});
test('the explicitly gated fetch model emits one fixed URL and holds final ACK for disconnect observation',async()=>{
 const cleanups=[];const fixture=await startPhysicalWebModel({addCleanup:(_label,action)=>cleanups.push(action),registerPort(){},registerSecret(){}},{executeWeb:true});
 try{const send=messages=>fetch(fixture.baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify({model:'ssh-owner',messages})});
  const first=await(await send([{role:'user',content:'OWNER'}])).text();assert.ok(first.includes('physical-ssh-owner-fetch'));assert.ok(first.includes(PHYSICAL_FETCH_URL));
  let ended=false;const body=send([{role:'user',content:'OWNER'},{role:'tool',content:'Owned public response'}]).then(response=>response.text()).then(text=>{ended=true;return text});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(ended,false);fixture.release('ssh-owner');assert.match(await body,/OWNED_FETCH_ACK_ssh-owner/);assert.equal(fixture.stats()['ssh-owner'].requests,2);
 }finally{fixture.release('ssh-owner');for(const action of cleanups.reverse())await action()}
});


test('actual workspace Gateway capabilities do not request a dedicated native transport',async()=>{const{requestsDedicatedCapabilities}=await import('../../src/broker-native-session-capabilities.js');assert.equal(requestsDedicatedCapabilities({capabilities:physicalSharedCapabilities()}),false);assert.equal(physicalSharedCapabilities().experimental.interactionBindingV1,true)});
