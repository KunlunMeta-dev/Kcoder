import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativeWebModelFixture} from './windows-native-web-model.mjs';
const options={query:'owned public fixture query',searchCallId:'owned-search',fetchCallId:'owned-fetch',fetchUrl:'https://docs.python.org/3/library/asyncio.html'};
const message={model:'fixture',tools:[{type:'function',function:{name:'WebSearch'}}],messages:[]};
async function ownedFixture(bundled,body){
 const fixture=createNativeWebModelFixture({...options,bundled});
 await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+fixture.server.address().port;
 try{await body(fixture,base)}finally{fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve))}
}
for(const bundled of [false,true])test('loopback model directory GET keeps the '+(bundled?'two':'three')+' bounded chat responses distinct',async()=>{
 await ownedFixture(bundled,async(fixture,base)=>{
  const warmup=await fetch(base+'/v1/chat/completions',{method:'HEAD'});assert.equal(warmup.status,200);assert.equal(await warmup.text(),'');assert.equal(fixture.requests,0);
  for(const path of ['/v1/models','/models']){
   const response=await fetch(base+path);assert.equal(response.status,200);
   assert.deepEqual(await response.json(),{object:'list',data:[{id:'fixture',object:'model'}]});
  }
  assert.equal(fixture.requests,0);
  const count=bundled?2:3;
  for(let index=0;index<count;index++){
   const response=await fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify(message)});
   assert.equal(response.status,200);const stream=await response.text();
   assert.match(stream,/data: \[DONE\]/);
   if(index===0)assert.match(stream,/owned-search/);
   if(index===1&&!bundled)assert.match(stream,/owned-fetch/);
  }
  assert.equal(fixture.requests,count);assert.equal(fixture.failure,undefined);
  assert.deepEqual(fixture.observations.slice(0,3),[{method:'HEAD',path:'/v1/chat/completions',bytes:0},{method:'GET',path:'/v1/models',bytes:0},{method:'GET',path:'/models',bytes:0}]);
  const extra=await fetch(base+'/v1/chat/completions',{method:'POST',body:JSON.stringify(message)});
  assert.equal(extra.status,400);assert.ok(fixture.failure);
 });
});
test('other methods/paths fail closed and observations never include query/body data',async()=>{
 await ownedFixture(false,async(fixture,base)=>{
  const response=await fetch(base+'/private-path?credential=private-fixture-marker');
  assert.equal(response.status,400);assert.equal(fixture.requests,0);
  assert.deepEqual(fixture.observations,[{method:'GET',path:'other',bytes:0}]);
  assert.ok(!JSON.stringify(fixture.observations).includes('private-fixture-marker'));
  assert.equal(fixture.failure.message,'Unsupported owned fixture method or path');
 });
});
