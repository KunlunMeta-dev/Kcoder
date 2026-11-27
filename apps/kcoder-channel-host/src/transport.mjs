import { ChannelError, requireValue } from './errors.mjs';
import { httpsUrl } from './validation.mjs';

export async function boundedJson(response, maxBytes = 256 * 1024, parseJson = JSON.parse) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(()=>{});
    throw new ChannelError('PLATFORM_RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader(); const chunks = []; let size = 0;
  if (reader) {
    try {
      while (true) {
        const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;
        requireValue(size<=maxBytes,'PLATFORM_RESPONSE_TOO_LARGE');chunks.push(value);
      }
    } catch(error) {await reader.cancel().catch(()=>{});throw error;}
    finally {reader.releaseLock();}
  }
  try { return parseJson(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ChannelError('PLATFORM_INVALID_JSON'); }
}
export async function platformJson(url, { method='GET', headers={}, body, signal, hosts, fetchImpl=fetch, allowLoopback=false, maxBytes=256*1024, parseJson=JSON.parse } = {}) {
  const target=httpsUrl(url,{allowedHosts:hosts,allowLoopback});
  let requestHeaders=headers;
  if(body!==undefined){const values=new Headers(headers);if(!values.has('content-type')){values.set('content-type','application/json');requestHeaders=values;}}
  const response=await fetchImpl(target,{method,headers:requestHeaders,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:signal??AbortSignal.timeout(30000)});
  if(!response.ok){await response.body?.cancel().catch(()=>{});const error=new ChannelError(response.status===401||response.status===403?'PLATFORM_AUTHORIZATION_FAILED':response.status===429?'PLATFORM_RATE_LIMIT':'PLATFORM_HTTP_REJECTED','repair_configuration');error.externalOutcome=response.status>=400&&response.status<500?'failed':'unknown';throw error;}
  return boundedJson(response,maxBytes,parseJson);
}
export async function platformBinary(url,{headers={},signal,hosts,maxBytes=100*1024*1024,fetchImpl=fetch}={}){
  const target=httpsUrl(url,{allowedHosts:hosts});
  const response=await fetchImpl(target,{headers,signal:signal??AbortSignal.timeout(30000),redirect:'error'});
  let size;
  try{
    requireValue(response.ok,'MEDIA_DOWNLOAD_REJECTED');
    const declared=response.headers.get('content-length');size=declared===null?undefined:Number(declared);
    requireValue(size===undefined||Number.isSafeInteger(size)&&size>=0&&size<=maxBytes,'INPUT_TOO_LARGE');
    requireValue(response.body,'MEDIA_DOWNLOAD_EMPTY');
  }catch(error){await response.body?.cancel().catch(()=>{});error.httpStatus=response.status;throw error;}
  const reader=response.body.getReader();let ended=false,bytes=0,controller;
  const release=()=>{try{reader.releaseLock();}catch{}};
  const cancel=async reason=>{
    if(ended)return;ended=true;
    await reader.cancel(reason).catch(()=>{});release();
    try{controller.close();}catch{}
  };
  const byteStream=new ReadableStream({
    start(value){controller=value;},
    async pull(value){
      try{
        const next=await reader.read();if(ended)return;
        if(next.done){ended=true;release();value.close();return;}
        bytes+=next.value.byteLength;requireValue(bytes<=maxBytes,'INPUT_TOO_LARGE');value.enqueue(next.value);
      }catch(error){if(!ended){ended=true;value.error(error);await reader.cancel(error).catch(()=>{});release();}}
    },
    cancel,
  });
  return {byteStream,expectedBytes:size,mediaType:response.headers.get('content-type')??'application/octet-stream',filename:'attachment',dispose:cancel};
}
export class EphemeralSecretStore {
  #values=new Map();
  constructor({now=()=>Date.now(),maxEntries=1000}={}) {this.now=now;this.maxEntries=maxEntries;}
  async put(key,value,ttlMs=3600000) {
    for(const[k,v]of this.#values)if(v.expiresAt<=this.now())this.#values.delete(k);
    requireValue(this.#values.size<this.maxEntries||this.#values.has(key),'SECRET_CONTEXT_CAPACITY');
    requireValue(ttlMs>0&&ttlMs<=24*3600000,'INVALID_SECRET_CONTEXT_TTL');
    this.#values.set(key,{value,expiresAt:this.now()+ttlMs});return key;
  }
  async get(key) {const v=this.#values.get(key);if(!v||v.expiresAt<=this.now()){this.#values.delete(key);throw new ChannelError('PLATFORM_CONTEXT_EXPIRED','request_authorization');}return v.value;}
  async remove(key){this.#values.delete(key);}
  clear(){this.#values.clear();}
}
export const silentSdkLogger=Object.freeze({debug(){},info(){},warn(){},error(){}});
