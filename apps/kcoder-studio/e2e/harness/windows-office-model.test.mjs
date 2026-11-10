import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import * as protocol from '../suites/office/native-download-model.mjs';
const {createOfficeResponder}=createRequire(import.meta.url)('./windows-office-model.cjs');
const body=(id,value)=>({messages:[{role:'user',content:protocol.claimPrompt},...(id?[{role:'tool',tool_call_id:id,content:JSON.stringify(value)}]:[])]});
test('Windows protocol selection reuses original Markdown discovery then actual generator receipt',()=>{
 const model=createOfficeResponder(protocol,'owned-windows-fixture');
 assert.equal(model.next({messages:[]}),null);
 assert.equal(model.next(body())[0].delta.tool_calls[0].function.name,'tool_search');
 const step=model.next(body(protocol.discoveryCall,{text:'```json\n{"tools":[{"name":"OfficeDocument"}]}\n```'}));
 const call=JSON.parse(step[0].delta.tool_calls[0].function.arguments);assert.equal(call.tool_name,'OfficeDocument');assert.ok(JSON.stringify(call.arguments.specification).length<1024*1024);
 const result={format:'docx',artifactRef:{id:'owned-docx',revision:'1'},sha256:'a'.repeat(64)};
 assert.equal(model.next(body(protocol.documentCall,result)).at(-1).finishReason,'stop');assert.deepEqual(model.metrics().generated,result);assert.equal(model.metrics().externalModelCalls,0);
});
test('bad discovery and unbounded Provider sequences stay failures',()=>{
 const model=createOfficeResponder(protocol,'owned-windows-negative');assert.throws(()=>model.next(body(protocol.discoveryCall,{text:'missing typed metadata'})));
 const bounded=createOfficeResponder(protocol,'owned-bound');for(let i=0;i<8;i++)bounded.next(body());assert.throws(()=>bounded.next(body()),/BUDGET_EXCEEDED/);
});

test('the owned HTTP protocol fixture emits real SSE frame delimiters',async()=>{
 const {runE2E,waitFor}=await import('./run-context.mjs');
 const {readFile}=await import('node:fs/promises');
 const {fileURLToPath}=await import('node:url');
 await runE2E(import.meta.url,{testId:'owned-windows-office-provider-http-protocol',tier:'model-independent',modelPolicy:'One bounded local deterministic HTTP fixture request only. No Native generation, model quality, Windows or platform claim.'},async context=>{
  await context.writeStateJson('office-http/.owner.json',{owner:'owned-office-http'});
  const ready=context.pathInState('office-http/ready.json');
  context.spawnOwned('owned-office-http',process.execPath,[fileURLToPath(new URL('./windows-installer-model.cjs',import.meta.url)),ready,'--office-native']);
  const address=await waitFor(async()=>{try{return JSON.parse(await readFile(ready,'utf8'))}catch{return null}},5000,'owned Office HTTP fixture ready');context.registerPort('owned-office-http',address.port);
  const previous=await fetch('http://127.0.0.1:'+address.port+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'INSTALL_LIFECYCLE_FIRST'}]})});
  assert.equal(previous.status,200);const legacy=await previous.text();assert.ok(legacy.includes('WINDOWS_HISTORY_REPLY'));assert.ok(legacy.includes('\n\n'),'Existing lifecycle responses retain real SSE framing');
  const response=await fetch('http://127.0.0.1:'+address.port+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body())});
  assert.equal(response.status,200);const text=await response.text();
  assert.ok(text.includes('\n\n'),'SSE must contain actual line delimiters');
  assert.ok(text.endsWith('data: [DONE]\n\n'));assert.ok(text.includes('tool_search'));
 });
});
