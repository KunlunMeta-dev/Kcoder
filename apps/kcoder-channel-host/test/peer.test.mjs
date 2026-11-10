import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough,Writable } from 'node:stream';
import { PrivateParentPeer } from '../src/applications/private-peer.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(t,options={}){
 const input=new PassThrough();const frames=[];
 const output=new Writable({write(chunk,_encoding,callback){frames.push(JSON.parse(chunk.toString()));callback();}});
 const peer=new PrivateParentPeer(input,output,options);const run=peer.run();
 t.after(async()=>{input.end();await run;output.destroy();});
 return {peer,input,frames};
}
test('completion hints bypass occupied request slots, coalesce per operation and never receive a reply',async t=>{
 const method='integrations/runtime/taskStateChanged';
 const {peer,input,frames}=setup(t,{maxConcurrent:1,maxIncoming:2,notificationMethods:[method]});
 let release,started=false;const blocked=new Promise(resolve=>{release=resolve;});const seen=[];
 peer.handler=async(name,params)=>{if(name==='busy'){started=true;await blocked;}else seen.push(params.operationId);};
 input.write(JSON.stringify({jsonrpc:'2.0',id:'busy',method:'busy'})+'\n');await tick();assert.equal(started,true);
 try{
  input.write(JSON.stringify({jsonrpc:'2.0',method:'unregistered',params:{operationId:'ignored'}})+'\n');
  for(const operationId of ['first','second'])input.write(JSON.stringify({jsonrpc:'2.0',method,params:{operationId}})+'\n');
  await tick();await tick();assert.deepEqual(seen,['first','second']);assert.equal(frames.length,0);
 }finally{release();await tick();}
 assert.deepEqual(frames.map(frame=>frame.id),['busy']);
});
test('bounded completion hint lane coalesces only the same original operation',async t=>{
 const method='integrations/runtime/taskStateChanged';const {peer,input}=setup(t,{maxIncoming:2,notificationMethods:[method]});
 let release;const blocked=new Promise(resolve=>{release=resolve;});const seen=[];
 peer.handler=async(_name,params)=>{seen.push(params.operationId);if(params.operationId==='held')await blocked;};
 const send=operationId=>input.write(JSON.stringify({jsonrpc:'2.0',method,params:{operationId}})+'\n');
 send('held');await tick();
 try{for(const id of ['one','one','two','overflow'])send(id);await tick();assert.equal(peer.notifications.size,2);}
 finally{release();await tick();await tick();}
 assert.deepEqual(seen,['held','one','two']);
});
test('reverse responses bypass a saturated incoming request queue',async t=>{
 const {peer,input,frames}=setup(t,{maxConcurrent:1,maxIncoming:1});
 peer.handler=async(method)=>method==='first'?await peer.call('private.policy',{},1000):{second:true};
 input.write(JSON.stringify({jsonrpc:'2.0',id:'1',method:'first'})+'\n');await tick();
 const reverse=frames.find(frame=>frame.method==='private.policy');assert.ok(reverse);
 input.write(JSON.stringify({jsonrpc:'2.0',id:'2',method:'second'})+'\n');
 input.write(JSON.stringify({jsonrpc:'2.0',id:'3',method:'overload'})+'\n');
 input.write(JSON.stringify({jsonrpc:'2.0',id:reverse.id,result:{allowed:false}})+'\n');await tick();await tick();
 assert.equal(frames.find(frame=>frame.id==='3').error.message,'HOST_REQUEST_CAPACITY');
 assert.deepEqual(frames.find(frame=>frame.id==='1').result,{allowed:false});
 assert.deepEqual(frames.find(frame=>frame.id==='2').result,{second:true});
});

test('private result packets coalesce by nested scope and original operation',async t=>{
 const method='connectivity.taskCompleted';const {peer,input}=setup(t,{maxIncoming:3,notificationMethods:[method]});
 let release;const blocked=new Promise(resolve=>{release=resolve;});const seen=[];
 peer.handler=async(_method,packet)=>{seen.push(packet.observation.operationId);if(packet.observation.operationId==='held')await blocked;};
 const send=operationId=>input.write(JSON.stringify({jsonrpc:'2.0',method,params:{observation:{scope:{accountId:'owner'},operationId},task:{output:operationId}}})+'\n');
 send('held');await tick();
 try{send('first');send('second');await tick();assert.equal(peer.notifications.size,2);}
 finally{release();await tick();await tick();}
 assert.deepEqual(seen,['held','first','second']);
});
test('malformed matching reverse response cannot become a successful result',async t=>{
 const {peer,input,frames}=setup(t);
 const waiting=peer.call('private.policy',{},1000);await tick();
 const id=frames[0].id;input.write(JSON.stringify({jsonrpc:'1.0',id,result:{decision:'allow'}})+'\n');
 await assert.rejects(waiting,/PARENT_REPLY_INVALID/);
});
test('matching response with both result and error is rejected',async t=>{
 const {peer,input,frames}=setup(t);
 const waiting=peer.call('private.policy',{},1000);await tick();
 input.write(JSON.stringify({jsonrpc:'2.0',id:frames[0].id,result:true,error:{code:1,message:'synthetic'}})+'\n');
 await assert.rejects(waiting,/PARENT_REPLY_INVALID/);
});
test('matching response with a method is rejected rather than executed',async t=>{
 const {peer,input,frames}=setup(t);let ran=false;peer.handler=async()=>{ran=true;};
 const waiting=peer.call('private.policy',{},1000);await tick();
 input.write(JSON.stringify({jsonrpc:'2.0',id:frames[0].id,method:'injected',result:true})+'\n');
 await assert.rejects(waiting,/PARENT_REPLY_INVALID/);assert.equal(ran,false);
});
test('oversized or malformed UTF-8 frame is discarded without swallowing the next frame',async t=>{
 const {peer,input,frames}=setup(t,{maxFrameBytes:160});peer.handler=async()=>({valid:true});
 input.write('x'.repeat(200));input.write('\n');input.write(Buffer.from([0xff,10]));
 input.write(JSON.stringify({jsonrpc:'2.0',id:'good',method:'read'})+'\n');await tick();await tick();
 assert.deepEqual(frames.find(f=>f.id==='good').result,{valid:true});
});
test('slow output has bounded queued frames and bytes',async t=>{
 const input=new PassThrough();let release;const output=new Writable({highWaterMark:1,write(_chunk,_encoding,callback){release=callback;}});
 const peer=new PrivateParentPeer(input,output,{maxWriteFrames:1,maxWriteBytes:256,writeTimeoutMs:1000});const run=peer.run();
 t.after(async()=>{release?.();input.end();await run;output.destroy();});
 const first=peer.write({jsonrpc:'2.0',id:'a',result:'1'});await tick();
 const second=peer.write({jsonrpc:'2.0',id:'b',result:'2'});
 await assert.rejects(peer.write({jsonrpc:'2.0',id:'c',result:'3'}),/PARENT_OUTPUT_CAPACITY/);
 assert.ok(peer.writeBytes<=256);release();await first;await tick();release();await second;
});
test('disconnect rejects all reverse requests without reporting success',async t=>{
 const {peer,input}=setup(t);const waiting=peer.call('private.policy',{},1000);await tick();
 input.end();await assert.rejects(waiting,/PARENT_DISCONNECTED/);assert.equal(peer.pending.size,0);
});
test('fixed private metadata requests have a bounded lane when all business handlers wait on their parent',async t=>{
 const toChild=new PassThrough(),toParent=new PassThrough();const child=new PrivateParentPeer(toChild,toParent,{maxConcurrent:4,controlMethods:['metadata'],maxControlConcurrent:1,maxControlIncoming:8}),parent=new PrivateParentPeer(toParent,toChild,{maxConcurrent:4});
 child.handler=async method=>method==='metadata'?{actual:true}:await child.call('private.inspect',{},1000);parent.handler=async()=>parent.call('metadata',{},1000);
 const childRun=child.run(),parentRun=parent.run();t.after(async()=>{child.close();parent.close();await Promise.allSettled([childRun,parentRun]);});
 const results=await Promise.all(Array.from({length:4},()=>parent.call('business',{},1000)));assert.ok(results.every(value=>value.actual===true));
 assert.ok(child.controlActive<=1);assert.equal(child.controlIncoming.length,0);
});


test('fixed SDK event callbacks and metadata responses bypass occupied public handlers independently',async()=>{
 const { PassThrough }=await import('node:stream');
 const input=new PassThrough(),output=new PassThrough();const peer=new PrivateParentPeer(input,output,{controlMethods:['metadata.fact'],eventMethods:['worker.event']});
 let release;const blocked=new Promise(resolve=>{release=resolve;});let started=0;
 peer.handler=async(method)=>{if(method==='public.wait'){started++;await blocked;return {finished:true};}if(method==='worker.event')return {durable:true};return {verified:true};};
 const frames=[];output.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n'))if(line)frames.push(JSON.parse(line));});
 const running=peer.run();
 for(let i=0;i<4;i++)input.write(JSON.stringify({jsonrpc:'2.0',id:'busy-'+i,method:'public.wait',params:{}})+'\n');
 for(let i=0;i<100&&started<4;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(started,4);
 input.write(JSON.stringify({jsonrpc:'2.0',id:'event',method:'worker.event',params:{}})+'\n');input.write(JSON.stringify({jsonrpc:'2.0',id:'metadata',method:'metadata.fact',params:{}})+'\n');
 for(let i=0;i<100&&frames.length<2;i++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.equal(frames.find(frame=>frame.id==='event')?.result.durable,true);assert.equal(frames.find(frame=>frame.id==='metadata')?.result.verified,true);
 release();input.end();await running;
});
