import { randomUUID,createHash } from 'node:crypto';
import { ChannelError } from '../../../../kcoder-channel-host/src/errors.mjs';

const CHUNK_BYTES=64*1024;
function fail(code){throw new ChannelError(code,'reconcile_original');}
function need(value,code){if(!value)fail(code);}
function scopeKey(scope){return JSON.stringify([scope?.accountId,scope?.targetId,scope?.workspaceId,scope?.organizationId??null,scope?.identityGeneration,scope?.targetRevision]);}
function safeName(value){return typeof value==='string'&&value.length>0&&value.length<=200&&!/[\\/:*?"<>|\u0000-\u001f]/u.test(value)&&!['.','..'].includes(value);}

class InputQueue {
  constructor(){this.value=null;this.waiter=null;this.closed=false;this.error=null;}
  async push(value){
    need(!this.closed&&!this.value,'ASSET_INPUT_BACKPRESSURE');
    if(this.waiter){const resolve=this.waiter;this.waiter=null;resolve({done:false,value});return;}
    return new Promise((resolve,reject)=>{this.value={value,resolve,reject};});
  }
  next(){
    if(this.value){const item=this.value;this.value=null;item.resolve();return Promise.resolve({done:false,value:item.value});}
    if(this.error)return Promise.reject(this.error);
    if(this.closed)return Promise.resolve({done:true});
    need(!this.waiter,'ASSET_CONCURRENT_READ');
    return new Promise((resolve,reject)=>{this.waiter=result=>result.error?reject(result.error):resolve(result);});
  }
  end(error){
    this.closed=true;this.error=error??null;
    if(this.value){this.value.reject(error??new Error('ASSET_INPUT_CLOSED'));this.value=null;}
    if(this.waiter){this.waiter(error?{error}:{done:true});this.waiter=null;}
  }
  [Symbol.asyncIterator](){return this;}
}

/** Private IPC only. The provider validates native owner, policy and immutable revisions again. */
export function createChannelAssetStreams({assets,getHostContext,maxStreams=16,maxReservedBytes=200*1024*1024,streamTtlMs=60000,now=()=>Date.now()}){
  need(typeof getHostContext==='function'&&typeof assets?.prepareChannelInput==='function'&&typeof assets?.readExport==='function','ASSET_HOST_PROVIDER_REQUIRED');
  const streams=new Map();let reserved=0;
  async function context(scope){
    const current=await getHostContext();
    need(current?.scope&&typeof current.nativeConnectionId==='string'&&scopeKey(current.scope)===scopeKey(scope),'ASSET_SCOPE_CHANGED');
    return {...current,scope:{...current.scope}};
  }
  async function entry(params,kind){
    const current=await context(params?.scope),value=streams.get(params?.streamId);
    need(value&&value.scopeKey===scopeKey(current.scope)&&value.connectionId===current.nativeConnectionId,'ASSET_STREAM_NOT_FOUND');
    need(value.expiresAt>now()&&(!kind||value.kind===kind),'ASSET_STREAM_EXPIRED');
    return value;
  }
  function capacity(bytes){need(streams.size<maxStreams&&reserved+bytes<=maxReservedBytes,'ASSET_STREAM_CAPACITY');}
  async function close(id,error){
    const value=streams.get(id);if(!value)return;
    streams.delete(id);reserved-=value.reserved;
    if(value.kind==='input'){value.controller.abort();value.queue.end(error??new Error('ASSET_CANCELLED'));await value.result.catch(()=>{});}
    else await value.iterator.return?.().catch(()=>{});
  }
  async function reap(){for(const[id,value]of streams)if(value.expiresAt<=now())await close(id,new Error('ASSET_STREAM_EXPIRED'));}
  const methods={
    async 'private.assets.openInput'(params){
      await reap();const current=await context(params?.scope);
      need(typeof params.operationId==='string'&&params.operationId.length>0&&params.operationId.length<=256&&safeName(params.filename)&&Number.isSafeInteger(params.expectedBytes)&&params.expectedBytes>=0&&params.expectedBytes<=100*1024*1024&&/^[a-f0-9]{64}$/i.test(params.expectedSha256??''),'ASSET_INPUT_INVALID');
      capacity(params.expectedBytes);
      const streamId=randomUUID(),queue=new InputQueue(),controller=new AbortController();
      const value={kind:'input',scopeKey:scopeKey(current.scope),connectionId:current.nativeConnectionId,reserved:params.expectedBytes,expiresAt:now()+streamTtlMs,queue,controller,index:0,bytes:0,sha:createHash('sha256'),metadata:params,settled:false};
      value.result=Promise.resolve().then(()=>assets.prepareChannelInput({...params,expectedSha256:params.expectedSha256.toLowerCase(),byteStream:queue,signal:controller.signal}));
      value.result.then(receipt=>{value.receipt=receipt;value.settled=true;queue.end();},error=>{value.error=error;value.settled=true;queue.end(error);});
      streams.set(streamId,value);reserved+=value.reserved;return {streamId};
    },
    async 'private.assets.writeInput'(params){
      const value=await entry(params,'input');
      need(params.index===value.index&&typeof params.contentBase64==='string'&&params.contentBase64.length<=Math.ceil(CHUNK_BYTES/3)*4,'ASSET_CHUNK_INVALID');
      const bytes=Buffer.from(params.contentBase64,'base64');need(bytes.length>0&&bytes.length<=CHUNK_BYTES&&bytes.toString('base64')===params.contentBase64,'ASSET_CHUNK_INVALID');
      need(value.bytes+bytes.length<=value.reserved,'ASSET_SIZE_MISMATCH');
      if(value.error)throw value.error;
      value.sha.update(bytes);value.bytes+=bytes.length;value.index++;
      if(!value.settled)await value.queue.push(bytes);
      return {index:params.index,acceptedBytes:bytes.length};
    },
    async 'private.assets.finishInput'(params){
      const value=await entry(params,'input');need(params.chunks===value.index&&value.bytes===value.reserved,'ASSET_SIZE_MISMATCH');
      need(value.sha.digest('hex')===value.metadata.expectedSha256.toLowerCase(),'ASSET_HASH_MISMATCH');
      value.queue.end();
      try{
        const receipt=await value.result;await context(params.scope);
        need(receipt?.status==='accepted'&&receipt.bytes===value.bytes&&receipt.sha256===value.metadata.expectedSha256.toLowerCase(),'ASSET_RECEIPT_MISMATCH');
        return receipt;
      }finally{streams.delete(params.streamId);reserved-=value.reserved;}
    },
    async 'private.assets.openExport'(params){
      await reap();const current=await context(params?.scope);capacity(0);
      const source=await assets.readExport(params);
      need(safeName(source?.filename)&&typeof source.mediaType==='string'&&Number.isSafeInteger(source.expectedBytes)&&source.expectedBytes>=0&&source.expectedBytes<=100*1024*1024&&/^[a-f0-9]{64}$/i.test(source.sha256??'')&&source.byteStream?.[Symbol.asyncIterator],'ASSET_EXPORT_INVALID');
      capacity(source.expectedBytes);await context(params.scope);
      const streamId=randomUUID();streams.set(streamId,{kind:'export',scopeKey:scopeKey(current.scope),connectionId:current.nativeConnectionId,reserved:source.expectedBytes,expiresAt:now()+streamTtlMs,iterator:source.byteStream[Symbol.asyncIterator](),source,index:0,bytes:0,sha:createHash('sha256'),remainder:null,reading:false});reserved+=source.expectedBytes;
      return {streamId,filename:source.filename,mediaType:source.mediaType,expectedBytes:source.expectedBytes,sha256:source.sha256};
    },
    async 'private.assets.readExport'(params){
      const value=await entry(params,'export');need(!value.reading&&params.index===value.index,'ASSET_EXPORT_INDEX_CONFLICT');value.reading=true;
      try{
        const next=value.remainder?{done:false,value:value.remainder}:await value.iterator.next();
        if(next.done){
          need(value.bytes===value.reserved&&value.sha.digest('hex')===value.source.sha256.toLowerCase(),'ASSET_EXPORT_INTEGRITY_FAILED');
          await close(params.streamId);return {index:params.index,done:true};
        }
        need(next.value instanceof Uint8Array&&next.value.length<=1024*1024,'ASSET_EXPORT_CHUNK_INVALID');
        const bytes=Buffer.from(next.value.subarray(0,CHUNK_BYTES));value.remainder=next.value.length>CHUNK_BYTES?next.value.subarray(CHUNK_BYTES):null;
        value.bytes+=bytes.length;need(value.bytes<=value.reserved,'ASSET_SIZE_MISMATCH');value.sha.update(bytes);value.index++;
        return {index:params.index,done:false,contentBase64:bytes.toString('base64')};
      }finally{value.reading=false;}
    },
    async 'private.assets.cancelStream'(params){await entry(params);await close(params.streamId);return {closed:true};},
  };
  return {methods,async close(){await Promise.allSettled([...streams.keys()].map(id=>close(id,new Error('ASSET_HOST_CLOSED'))));},get pending(){return streams.size;}};
}
