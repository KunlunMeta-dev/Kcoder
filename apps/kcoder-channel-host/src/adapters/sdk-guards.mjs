import { requireValue,ChannelError } from '../errors.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export const PLATFORM_FRAME_BYTES=256*1024;
/** These guarded hooks target the exact locked SDK versions; changed internals fail closed. */
export function hardenFeishuSdk(client,{onConnectionChange}={}){
  const config=client?.wsConfig,cache=client?.dataCache;
  requireValue(typeof config?.setWSInstance==='function'&&typeof cache?.mergeData==='function'&&cache.cache instanceof Map,'FEISHU_SDK_GUARD_UNAVAILABLE','repair_configuration');
  const setInstance=config.setWSInstance.bind(config),merge=cache.mergeData.bind(cache);
  config.setWSInstance=socket=>{
    if(socket){
      requireValue(socket._receiver&&Number.isFinite(socket._receiver._maxPayload),'FEISHU_FRAME_GUARD_UNAVAILABLE','repair_configuration');
      socket._receiver._maxPayload=PLATFORM_FRAME_BYTES;
      if(onConnectionChange){requireValue(typeof socket.on==='function','FEISHU_STATE_GUARD_UNAVAILABLE');for(const event of ['open','close','error'])socket.on(event,()=>onConnectionChange());}
    }
    return setInstance(socket);
  };
  cache.mergeData=params=>{
    requireValue(Number.isSafeInteger(params?.sum)&&params.sum>0&&params.sum<=16&&Number.isSafeInteger(params.seq)&&params.seq>=0&&params.seq<params.sum&&params.data instanceof Uint8Array&&params.data.length<=PLATFORM_FRAME_BYTES,'PLATFORM_FRAGMENT_INVALID');
    requireValue(cache.cache.has(params.message_id)||cache.cache.size<32,'PLATFORM_FRAGMENT_CAPACITY');
    let bytes=params.data.length;
    for(const[id,value]of cache.cache){
      for(let index=0;index<value.buffer.length;index++)if(!(id===params.message_id&&index===params.seq))bytes+=value.buffer[index]?.length??0;
    }
    requireValue(bytes<=1024*1024,'PLATFORM_FRAGMENT_CAPACITY');
    const current=cache.cache.get(params.message_id);const mergedSize=params.data.length+(current?.buffer??[]).reduce((size,value,index)=>size+(index===params.seq?0:value?.length??0),0);
    requireValue(mergedSize<=PLATFORM_FRAME_BYTES,'PLATFORM_EVENT_TOO_LARGE');return merge(params);
  };
}
export function hardenDingTalkSdk(client,{onConnectionChange}={}){
  requireValue(client?.sslopts&&typeof client.sslopts==='object'&&client.sslopts.rejectUnauthorized===true&&client.config&&typeof client.getEndpoint==='function','DINGTALK_SDK_GUARD_UNAVAILABLE','repair_configuration');
  Object.assign(client.sslopts,{maxPayload:PLATFORM_FRAME_BYTES,perMessageDeflate:false,handshakeTimeout:10000});
  client.config.autoReconnect=false;
  if(onConnectionChange){
    requireValue(typeof client._connect==='function','DINGTALK_STATE_GUARD_UNAVAILABLE');const connect=client._connect.bind(client);
    client._connect=(...args)=>{const pending=connect(...args),socket=client.socket;requireValue(socket&&typeof socket.on==='function','DINGTALK_STATE_GUARD_UNAVAILABLE');for(const event of ['open','close','error'])socket.on(event,()=>onConnectionChange());return pending;};
    requireValue(typeof client.onSystem==='function','DINGTALK_STATE_GUARD_UNAVAILABLE');const system=client.onSystem.bind(client);client.onSystem=(...args)=>{const result=system(...args);onConnectionChange();return result;};
  }
}
let wecomOutstanding=0;
export function hardenWecomSdk(client){
  const manager=client?.wsManager;requireValue(typeof manager?.sendReply==='function'&&manager.pendingAcks instanceof Map&&manager.replyQueues instanceof Map,'WECOM_SDK_GUARD_UNAVAILABLE','repair_configuration');
  const context=new AsyncLocalStorage(),send=manager.sendReply.bind(manager);
  manager.sendReply=(...args)=>{
    const owner=context.getStore();owner?.signal?.throwIfAborted();
    const command=args[2]===undefined?'aibot_respond_msg':args[2];
    let chunkKey,chunkIntent;
    if(command==='aibot_upload_media_chunk'){
      const body=args[1];requireValue(owner&&typeof body?.upload_id==='string'&&body.upload_id.length<=256&&Number.isSafeInteger(body.chunk_index)&&body.chunk_index>=0&&body.chunk_index<100&&typeof body.base64_data==='string'&&body.base64_data.length<=700000,'WECOM_UPLOAD_GUARD_UNAVAILABLE','repair_configuration');
      chunkKey=body.upload_id+':'+body.chunk_index;chunkIntent=createHash('sha256').update(body.base64_data).digest('hex');
      const previous=owner.chunks.get(chunkKey);
      if(previous){requireValue(previous.intent===chunkIntent,'WECOM_UPLOAD_INTENT_CONFLICT');return previous.promise;}
      requireValue(owner.chunks.size<100,'WECOM_UPLOAD_CHUNK_CAPACITY');
    }
    requireValue(wecomOutstanding<32,'PLATFORM_SEND_CAPACITY');wecomOutstanding++;
    let sent;
    if(chunkKey)sent=Promise.resolve().then(()=>{owner.signal?.throwIfAborted();return send(...args);});
    else {try{sent=Promise.resolve(send(...args));}catch(error){wecomOutstanding--;throw error;}}
    const pending=sent.finally(()=>{wecomOutstanding--;});
    // The locked 1.0.7 SDK retries chunks internally with fresh req_ids. A lost
    // acknowledgement never authorizes another write of that native chunk.
    if(chunkKey)owner.chunks.set(chunkKey,{owner,uploadId:args[1].upload_id,index:args[1].chunk_index,intent:chunkIntent,promise:pending});
    if(!owner?.signal)return pending;
    let abort;
    const cancelled=new Promise((_,reject)=>{abort=()=>reject(new ChannelError('PLATFORM_SEND_CANCELLED','reconcile_original'));owner.signal.addEventListener('abort',abort,{once:true});});
    pending.then(frame=>{try{if(owner.signal.aborted&&['aibot_send_msg','aibot_respond_msg','aibot_respond_update_msg'].includes(command))owner.onLateFrame?.(frame);}catch{}},()=>{});
    return Promise.race([pending,cancelled]).finally(()=>owner.signal.removeEventListener('abort',abort));
  };
  return (signal,action,onLateFrame)=>context.run({signal,onLateFrame,chunks:new Map()},action);
}

export class BoundedPlatformEvents {
  constructor(limit=32){this.limit=limit;this.queue=[];this.running=false;this.closed=false;}
  run(action){
    if(this.closed)return Promise.reject(new ChannelError('CHANNEL_STOPPED'));
    if(this.queue.length>=this.limit)return Promise.reject(new ChannelError('PLATFORM_EVENT_CAPACITY'));
    return new Promise((resolve,reject)=>{this.queue.push({action,resolve,reject});void this.pump();});
  }
  async pump(){
    if(this.running)return;this.running=true;
    try{while(!this.closed&&this.queue.length){const item=this.queue.shift();try{item.resolve(await item.action());}catch(error){item.reject(error);}}}
    finally{this.running=false;}
  }
  close(){this.closed=true;for(const item of this.queue)item.reject(new ChannelError('CHANNEL_STOPPED'));this.queue.length=0;}
}
