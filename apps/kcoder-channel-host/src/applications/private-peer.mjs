import { randomUUID } from 'node:crypto';
import { ChannelError,publicError,requireValue } from '../errors.mjs';

export class PrivateParentPeer {
 constructor(input,output,{maxFrameBytes=2*1024*1024,maxIncoming=32,maxConcurrent=4,maxWriteFrames=64,maxWriteBytes=8*1024*1024,writeTimeoutMs=10000,controlMethods=[],maxControlConcurrent=2,maxControlIncoming=8,eventMethods=[],maxEventConcurrent=4,maxEventIncoming=32,notificationMethods=[]}={}){
  Object.assign(this,{input,output,maxFrameBytes,maxIncoming,maxConcurrent,maxWriteFrames,maxWriteBytes,writeTimeoutMs});
  this.pending=new Map();this.closed=false;this.handler=null;this.incoming=[];this.active=0;this.writes=[];this.writeBytes=0;this.writing=false;
  this.controlMethods=new Set(controlMethods);this.controlIncoming=[];this.controlActive=0;this.maxControlConcurrent=maxControlConcurrent;this.maxControlIncoming=maxControlIncoming;
  this.eventMethods=new Set(eventMethods);this.eventIncoming=[];this.eventActive=0;this.maxEventConcurrent=maxEventConcurrent;this.maxEventIncoming=maxEventIncoming;
  this.notificationMethods=new Set(notificationMethods);this.notifications=new Map();this.notifying=false;
  output.on('error',()=>this.close(new ChannelError('PARENT_OUTPUT_FAILED','reconcile_original')));
 }
 close(error=new ChannelError('PARENT_DISCONNECTED','reconcile_original')){
  if(this.closed)return;this.closed=true;
  for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}
  this.pending.clear();this.incoming.length=0;this.controlIncoming.length=0;this.eventIncoming.length=0;
  this.notifications.clear();
  for(const item of this.writes)item.reject(error);
  this.writes.length=0;this.writeBytes=0;
  this.abortCurrentWrite?.(error);this.abortCurrentWrite=null;
  this.input.destroy?.();
 }
 write(frame){
  if(this.closed)return Promise.reject(new ChannelError('PARENT_DISCONNECTED','reconcile_original'));
  let bytes;try{bytes=Buffer.from(JSON.stringify(frame)+'\n');}catch{return Promise.reject(new ChannelError('PARENT_FRAME_INVALID'));}
  if(bytes.length>this.maxFrameBytes)return Promise.reject(new ChannelError('PARENT_FRAME_TOO_LARGE'));
  if(this.writes.length>=this.maxWriteFrames||this.writeBytes+bytes.length>this.maxWriteBytes)return Promise.reject(new ChannelError('PARENT_OUTPUT_CAPACITY','reconcile_original'));
  return new Promise((resolve,reject)=>{this.writes.push({bytes,resolve,reject});this.writeBytes+=bytes.length;void this.flushWrites();});
 }
 async flushWrites(){
  if(this.writing)return;this.writing=true;
  try{
   while(!this.closed&&this.writes.length){
    const item=this.writes.shift();
    try{
     await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new ChannelError('PARENT_OUTPUT_TIMEOUT','reconcile_original')),this.writeTimeoutMs);
      this.abortCurrentWrite=error=>{clearTimeout(timer);reject(error);};
      this.output.write(item.bytes,error=>{clearTimeout(timer);if(error)reject(new ChannelError('PARENT_OUTPUT_FAILED','reconcile_original'));else resolve();});
     });
     this.abortCurrentWrite=null;
     this.writeBytes-=item.bytes.length;item.resolve();
    }catch(error){item.reject(error);this.close(error);}
   }
  }finally{this.writing=false;}
 }
 call(method,params,timeoutMs=30000){
  if(this.closed)return Promise.reject(new ChannelError('PARENT_DISCONNECTED','reconcile_original'));
  requireValue(this.pending.size<128,'PARENT_REQUEST_CAPACITY');
  const id='channel-host:'+randomUUID();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(new ChannelError('PARENT_REPLY_UNCONFIRMED','reconcile_original'));},Math.min(timeoutMs,60000));
   this.pending.set(id,{resolve,reject,timer});
   this.write({jsonrpc:'2.0',id,method,params}).catch(error=>{
    const current=this.pending.get(id);if(current){this.pending.delete(id);clearTimeout(current.timer);current.reject(error);}
   });
  });
 }
 routeFrame(frame){
  if(frame&&typeof frame.id==='string'&&this.pending.has(frame.id)){
   const item=this.pending.get(frame.id);this.pending.delete(frame.id);clearTimeout(item.timer);
   const hasResult=Object.hasOwn(frame,'result'),hasError=Object.hasOwn(frame,'error');
   if(frame.jsonrpc!=='2.0'||Object.hasOwn(frame,'method')||!Object.keys(frame).every(key=>['jsonrpc','id','result','error'].includes(key))||hasResult===hasError||(hasError&&(!frame.error||!Number.isSafeInteger(frame.error.code)||typeof frame.error.message!=='string'))){
    item.reject(new ChannelError('PARENT_REPLY_INVALID','reconcile_original'));
   }else if(hasError){
    const code=/^[A-Z][A-Z0-9_]{1,79}$/.test(frame.error.message)?frame.error.message:'PARENT_OPERATION_FAILED';
    const recovery=['none','retry_read','reconcile_original','repair_configuration','request_authorization','explicit_user_decision'].includes(frame.error.data?.recovery)?frame.error.data.recovery:'reconcile_original';
    item.reject(new ChannelError(code,recovery));
   }
   else item.resolve(frame.result);
   return;
  }
  if(frame?.jsonrpc==='2.0'&&!Object.hasOwn(frame,'id')&&this.notificationMethods.has(frame.method)
    &&Object.keys(frame).every(key=>['jsonrpc','method','params'].includes(key))){
   const observation=frame.method==='connectivity.taskCompleted'?frame.params?.observation:frame.params;
   const key=JSON.stringify([frame.method,observation?.scope,observation?.operationId]);
   if(this.notifications.has(key)||this.notifications.size<this.maxIncoming)this.notifications.set(key,frame);
   void this.pumpNotifications();return;
  }
  const validId=typeof frame?.id==='string'&&frame.id.length>0&&frame.id.length<=256||Number.isSafeInteger(frame?.id);
  if(!frame||frame.jsonrpc!=='2.0'||!validId||typeof frame.method!=='string'||!Object.keys(frame).every(key=>['jsonrpc','id','method','params'].includes(key)))return;
  if(this.eventMethods.has(frame.method)){
   if(this.eventIncoming.length>=this.maxEventIncoming){this.write({jsonrpc:'2.0',id:frame.id,error:{code:-32003,message:'HOST_EVENT_CAPACITY'}}).catch(error=>this.close(error));return;}
   this.eventIncoming.push(frame);this.pumpIncoming(false,true);return;
  }
  if(this.controlMethods.has(frame.method)){
   if(this.controlIncoming.length>=this.maxControlIncoming){this.write({jsonrpc:'2.0',id:frame.id,error:{code:-32003,message:'HOST_CONTROL_CAPACITY'}}).catch(error=>this.close(error));return;}
   this.controlIncoming.push(frame);this.pumpIncoming(true);return;
  }
  if(this.incoming.length>=this.maxIncoming){
   this.write({jsonrpc:'2.0',id:frame.id,error:{code:-32003,message:'HOST_REQUEST_CAPACITY'}}).catch(error=>this.close(error));return;
  }
  this.incoming.push(frame);this.pumpIncoming();
 }
 async pumpNotifications(){
  if(this.notifying)return;this.notifying=true;
  try{
   while(!this.closed&&this.notifications.size){
    const [key,frame]=this.notifications.entries().next().value;this.notifications.delete(key);
    try{requireValue(typeof this.handler==='function','HOST_NOT_READY');await this.handler(frame.method,frame.params);}
    catch{/* A lost or stale hint is recovered from original durable receipts. */}
   }
  }finally{this.notifying=false;}
 }
 pumpIncoming(control=false,event=false){
  const queue=event?this.eventIncoming:control?this.controlIncoming:this.incoming,activeKey=event?'eventActive':control?'controlActive':'active',limit=event?this.maxEventConcurrent:control?this.maxControlConcurrent:this.maxConcurrent;
  while(!this.closed&&this[activeKey]<limit&&queue.length){
   const frame=queue.shift();this[activeKey]++;
   Promise.resolve().then(async()=>{
    requireValue(typeof this.handler==='function','HOST_NOT_READY');
    const result=await this.handler(frame.method,frame.params);
    await this.write({jsonrpc:'2.0',id:frame.id,result:result??null});
   }).catch(async error=>{
    const safe=publicError(error);
    if(!this.closed)await this.write({jsonrpc:'2.0',id:frame.id,error:{code:-32000,message:safe.code,data:{recovery:safe.recovery}}}).catch(err=>this.close(err));
   }).finally(()=>{this[activeKey]--;this.pumpIncoming(control,event);});
  }
 }
 async run(){
  let bytes=Buffer.alloc(0),discard=false;
  try{
   for await(const chunk of this.input){
    if(this.closed)break;
    let rest=Buffer.from(chunk);
    while(rest.length){
     const newline=rest.indexOf(10);const part=newline<0?rest:rest.subarray(0,newline);rest=newline<0?Buffer.alloc(0):rest.subarray(newline+1);
     if(!discard){if(bytes.length+part.length>this.maxFrameBytes){bytes=Buffer.alloc(0);discard=true;}else bytes=Buffer.concat([bytes,part]);}
     if(newline>=0){
      if(!discard&&bytes.length){try{this.routeFrame(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch{}}
      bytes=Buffer.alloc(0);discard=false;
     }
    }
   }
  }finally{this.close();}
 }
}
