import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOfficeNativeRepository } from './native-repository.mjs';
import { createOfficeAssetBridge } from './asset-bridge.mjs';
const scope={accountId:'a',targetId:'t',workspaceId:null,identityGeneration:'g',targetRevision:'r'};
const hash=value=>createHash('sha256').update(value).digest('hex');
async function* input(value){yield Buffer.from(value);}

test('protocol-only: Rust receipt shape is adapted without confusing native paths with opaque refs',async()=>{
 const records=new Map();const calls=[];
 const privateCall=async(method,payload)=>{
  calls.push(method);
  if(method==='office/input/begin'){
   const old=records.get(payload.inputId);if(old)return{existing:true,record:old};
   const record={receipt:{inputId:payload.inputId,revision:1,operationId:payload.operationId,owner:{accountId:'a',targetId:'t',workspaceId:null,organizationId:null},metadata:payload.metadata,status:'pending',bytes:null,sha256:null},intentSha256:'rust-canonical-intent',native:null};
   records.set(payload.inputId,record);return{existing:false,record};
  }
  if(method==='office/input/read')return{record:records.get(payload.inputId)};
  if(method==='office/input/complete'){const record=records.get(payload.inputId);record.receipt.status='accepted';record.receipt.bytes=payload.bytes;record.receipt.sha256=payload.sha256;record.native=payload.native;return{receipt:record.receipt};}
  if(method==='office/input/fail')return{receipt:records.get(payload.inputId).receipt};
  throw Error('private route not registered');
 };
 const repository=createOfficeNativeRepository({privateCall,getScope:()=>scope});
 const bridge=createOfficeAssetBridge({getHostContext:async()=>({scope,nativeConnectionId:'connection',nativeClient:{call:async method=>method.endsWith('/start')?{upload_id:'owned-upload'}:method.endsWith('/finish')?{path:'/owned-only/abc',stageRef:null}:{}}}),evaluateAction:async()=>({status:'completed',result:{decision:'allow'}}),...repository});
 const request={scope,operationId:'input-op',filename:'input.txt',mediaType:'text/plain',expectedBytes:3,expectedSha256:hash('abc'),byteStream:input('abc')};
 const first=await bridge.channel.prepareChannelInput(request);const duplicate=await bridge.channel.prepareChannelInput({...request,byteStream:input('abc')});
 assert.deepEqual(duplicate,first);assert.equal(first.status,'accepted');assert.equal('native' in first,false);assert.equal('path' in first,false);assert.equal(calls.filter(method=>method==='office/input/complete').length,1);
});

test('private export streams exact known bytes and never accepts paths or URLs',async()=>{
 const bytes=Buffer.from('real artifact bytes');
 const repository=createOfficeNativeRepository({getScope:()=>scope,privateCall:async(method,payload)=>method.endsWith('/read')?{manifest:{id:'A',revision:1,title:'safe report',format:'json',bytes:bytes.length,sha256:hash(bytes)}}:{contentBase64:bytes.subarray(payload.offset,payload.offset+payload.length).toString('base64'),totalBytes:bytes.length,offset:payload.offset}});
 const exported=await repository.exports.readExport({scope,artifactRef:{id:'A',revision:1}});const chunks=[];for await(const chunk of exported.byteStream)chunks.push(chunk);
 assert.deepEqual(Buffer.concat(chunks),bytes);assert.equal(exported.expectedBytes,bytes.length);assert.equal(exported.filename,'office_safe report.json');assert.equal('path' in exported,false);assert.equal('downloadUrl' in exported,false);
});
