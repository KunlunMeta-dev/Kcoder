import { randomUUID,createHash } from 'node:crypto';
import { requireValue } from './errors.mjs';

const CHUNK=64*1024;
/** Private byte tickets are bound to one actual IPC owner; they are never paths or public download URLs. */
export class StreamTickets {
 constructor({maxStreams=16,maxReservedBytes=200*1024*1024,ttlMs=60000,now=()=>Date.now()}={}){Object.assign(this,{maxStreams,maxReservedBytes,ttlMs,now});this.items=new Map();this.reserved=0;}
 async open(owner,source){
  requireValue(typeof owner==='string'&&owner.length>0&&source?.byteStream?.[Symbol.asyncIterator]&&typeof source.filename==='string','WORKER_STREAM_INVALID');
  const reservation=source.expectedBytes??100*1024*1024;
  requireValue(Number.isSafeInteger(reservation)&&reservation>=0&&reservation<=100*1024*1024&&this.items.size<this.maxStreams&&this.reserved+reservation<=this.maxReservedBytes,'MEDIA_CAPACITY_EXCEEDED');
  const id=randomUUID(),item={owner,source,iterator:source.byteStream[Symbol.asyncIterator](),reservation,expiresAt:this.now()+this.ttlMs,index:0,remainder:null,bytes:0,hash:createHash('sha256'),reading:false,last:null};
  this.items.set(id,item);this.reserved+=reservation;
  return {streamId:id,filename:source.filename,mediaType:source.mediaType??'application/octet-stream',expectedBytes:source.expectedBytes??null,sha256:source.sha256??null};
 }
 get(owner,id){const item=this.items.get(id);requireValue(item&&item.owner===owner,'WORKER_STREAM_NOT_FOUND');requireValue(item.expiresAt>this.now(),'WORKER_STREAM_EXPIRED');return item;}
 async read(owner,id,index){
  const item=this.get(owner,id);item.expiresAt=this.now()+this.ttlMs;if(item.last?.index===index)return item.last;
  requireValue(!item.reading&&index===item.index,'WORKER_STREAM_INDEX_CONFLICT');item.reading=true;
  try{
   const next=item.remainder?{done:false,value:item.remainder}:await item.iterator.next();
   if(next.done){
    requireValue(item.source.expectedBytes===undefined||item.bytes===item.source.expectedBytes,'WORKER_STREAM_LENGTH_MISMATCH');
    const sha256=item.hash.digest('hex');requireValue(item.source.sha256===undefined||item.source.sha256.toLowerCase()===sha256,'WORKER_STREAM_HASH_MISMATCH');
    item.last={streamId:id,index,done:true,bytes:item.bytes,sha256};item.index++;
    await item.source.dispose?.();return item.last;
   }
   requireValue(next.value instanceof Uint8Array&&next.value.length>0&&next.value.length<=100*1024*1024,'WORKER_STREAM_CHUNK_INVALID');
   const chunk=next.value.subarray(0,CHUNK);item.remainder=next.value.length>CHUNK?next.value.subarray(CHUNK):null;
   item.bytes+=chunk.length;requireValue(item.bytes<=item.reservation,'WORKER_STREAM_LENGTH_MISMATCH');item.hash.update(chunk);item.index++;
   item.last={streamId:id,index,done:false,contentBase64:Buffer.from(chunk).toString('base64')};return item.last;
  }finally{item.reading=false;}
 }
 async close(owner,id){const item=this.items.get(id);if(!item)return {closed:true};requireValue(item.owner===owner,'WORKER_STREAM_NOT_FOUND');this.items.delete(id);this.reserved-=item.reservation;await item.source.dispose?.();await item.iterator.return?.();return {closed:true};}
 async reap(){for(const[id,item]of this.items)if(item.expiresAt<=this.now())await this.close(item.owner,id);}
 async closeAll(){await Promise.allSettled([...this.items].map(([id,item])=>this.close(item.owner,id)));}
}

export function privateTicketSource(call,{owner,ticket,signal}){
 requireValue(typeof ticket?.streamId==='string'&&typeof ticket.filename==='string','WORKER_STREAM_INVALID');
 async function* byteStream(){let index=0;const hash=createHash('sha256');let bytes=0;
  try{while(true){signal?.throwIfAborted();const chunk=await call('read',{owner,streamId:ticket.streamId,index});requireValue(chunk?.streamId===ticket.streamId&&chunk.index===index&&typeof chunk.done==='boolean','WORKER_STREAM_RECEIPT_INVALID');
   if(chunk.done){const actual=hash.digest('hex');requireValue(chunk.bytes===bytes&&chunk.sha256===actual&&(ticket.expectedBytes==null||ticket.expectedBytes===bytes)&&(ticket.sha256==null||ticket.sha256===actual),'WORKER_STREAM_HASH_MISMATCH');break;}
   requireValue(typeof chunk.contentBase64==='string'&&chunk.contentBase64.length<=4*Math.ceil(CHUNK/3),'WORKER_STREAM_CHUNK_INVALID');const part=Buffer.from(chunk.contentBase64,'base64');requireValue(part.length>0&&part.length<=CHUNK&&part.toString('base64')===chunk.contentBase64,'WORKER_STREAM_CHUNK_INVALID');bytes+=part.length;requireValue(bytes<=100*1024*1024&&(ticket.expectedBytes==null||bytes<=ticket.expectedBytes),'WORKER_STREAM_LENGTH_MISMATCH');hash.update(part);yield part;index++;}
  }finally{await call('close',{owner,streamId:ticket.streamId}).catch(()=>{});}
 }
 return {filename:ticket.filename,mediaType:ticket.mediaType,...(ticket.expectedBytes!=null?{expectedBytes:ticket.expectedBytes}:{}),...(ticket.sha256!=null?{sha256:ticket.sha256}:{}),byteStream:byteStream(),dispose:()=>call('close',{owner,streamId:ticket.streamId}).catch(()=>{})};
}
