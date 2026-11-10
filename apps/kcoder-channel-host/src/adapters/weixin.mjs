import { createWeixinSdk, weixinSdkMetadata } from './weixin-sdk.mjs';
import { randomBytes,randomUUID,createDecipheriv,createCipheriv,createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { requireValue,ChannelError } from '../errors.mjs';
import { platformJson,platformBinary,EphemeralSecretStore } from '../transport.mjs';
import { weixinEvent,weixinEventMetadata } from '../normalizers.mjs';
import { boundedText,stableId } from '../validation.mjs';
import { platformBinaryUpload } from '../upload-transport.mjs';
import { parseWeixinJson } from '../weixin-json.mjs';

const HOSTS=['ilinkai.weixin.qq.com','ilink.b.qq.com'];
export const WEIXIN_CLIENT_METADATA=Object.freeze({appId:weixinSdkMetadata.appId,botType:'3',clientVersion:weixinSdkMetadata.clientVersion});
const CDN_HOSTS=['novac2c.cdn.weixin.qq.com'];
const POLL_TIMEOUT_MS=40_000;
const START_NOTIFICATION_TIMEOUT_MS=10_000;
export const WEIXIN_CONNECTION_TIMEOUT_MS=POLL_TIMEOUT_MS+START_NOTIFICATION_TIMEOUT_MS+5_000;
export const WEIXIN_CONNECTION_REASON_CODES=Object.freeze(['PLATFORM_AUTHORIZATION_FAILED','PLATFORM_RATE_LIMIT','PLATFORM_HTTP_REJECTED','PLATFORM_INVALID_JSON','PLATFORM_RESPONSE_TOO_LARGE','WEIXIN_PLATFORM_REJECTED','WEIXIN_METADATA_FAILED','WEIXIN_RECEIPT_FAILED','WEIXIN_CONTEXT_FAILED','WEIXIN_INGRESS_FAILED','WEIXIN_CHECKPOINT_FAILED','WEIXIN_POLL_FAILED']);
const connectionReasons=new Set(WEIXIN_CONNECTION_REASON_CODES);
function connectionFailure(error,stage){return connectionReasons.has(error?.code)?error.code:({metadata:'WEIXIN_METADATA_FAILED',receipt:'WEIXIN_RECEIPT_FAILED',context:'WEIXIN_CONTEXT_FAILED',ingress:'WEIXIN_INGRESS_FAILED',checkpoint:'WEIXIN_CHECKPOINT_FAILED'}[stage]??'WEIXIN_POLL_FAILED');}
function apiBase(value){const base=new URL(value??'https://ilinkai.weixin.qq.com');requireValue(base.protocol==='https:'&&HOSTS.includes(base.hostname)&&!base.username&&!base.password&&!base.search&&!base.hash,'UNAPPROVED_HOST');return base.href;}
function mediaKey(material){
 if(typeof material.aeskey==='string'){requireValue(/^[a-f0-9]{32}$/i.test(material.aeskey),'WEIXIN_MEDIA_KEY_INVALID');return Buffer.from(material.aeskey,'hex');}
 if(material.media?.aes_key){const bytes=Buffer.from(material.media.aes_key,'base64');if(bytes.length===16)return bytes;const hex=bytes.toString('ascii');requireValue(/^[a-f0-9]{32}$/i.test(hex),'WEIXIN_MEDIA_KEY_INVALID');return Buffer.from(hex,'hex');}
 return null;
}
export class WeixinAdapter {
 constructor({configuration,credentials,transport=platformJson,binaryTransport=platformBinary,binaryUploader=platformBinaryUpload,secretStore=new EphemeralSecretStore(),checkpoint}){
  this.configuration=configuration;this.credentials=credentials;this.http=transport;this.binary=binaryTransport;this.uploader=binaryUploader;this.secrets=secretStore;this.checkpoint=checkpoint;this.controller=null;this.loop=null;this.cursor='';this.fileMaxBytes=100*1024*1024;this.generation=0;this.state='stopped';this.ingest=null;this.connectionObserver=null;this.failureReason=null;this.lifecycleStarted=false;
 }
 setConnectionObserver(listener){this.connectionObserver=listener;}
 connectionState(){return this.state;}
 connectionFailureReason(){return this.failureReason;}
 observe(state){if(this.state===state)return;this.state=state;this.connectionObserver?.();}
 authorizationFailure(error){return ['AUTHORIZATION_REQUIRED','PLATFORM_AUTHORIZATION_FAILED'].includes(error?.code);}
 sdk(signal){return createWeixinSdk({transport:this.http,signal});}
 headers(){requireValue(this.credentials.botToken,'AUTHORIZATION_REQUIRED','request_authorization');return this.sdk().buildHeaders({token:this.credentials.botToken});}
 async post(path,body,signal){
  this.headers();const sdk=this.sdk(signal);
  return parseWeixinJson(await sdk.apiPostFetch({baseUrl:apiBase(this.configuration.apiBase),endpoint:path,token:this.credentials.botToken,body:JSON.stringify({...body,base_info:sdk.buildBaseInfo()}),timeoutMs:30000,label:'KCoder Weixin'}));
 }
 async sdkCall(operation, params, signal) {
  requireValue(this.credentials.botToken,'AUTHORIZATION_REQUIRED','request_authorization');
  return this.sdk(signal)[operation]({...params,baseUrl:apiBase(this.configuration.apiBase),token:this.credentials.botToken});
 }
 async getUpdates(signal,{requireResponse=false}={}){
  try{return await this.sdkCall('getUpdates',{get_updates_buf:this.cursor,timeoutMs:POLL_TIMEOUT_MS,abortSignal:signal},AbortSignal.any([signal,AbortSignal.timeout(POLL_TIMEOUT_MS)]));}
  catch(error){
   // Only an established receive loop can treat a quiet poll as an empty batch.
   if(requireResponse)throw error;
   if(error?.name==='AbortError'||error?.name==='TimeoutError')return {ret:0,msgs:[]};
   throw error;
  }
 }
 async start(ingest,{signal}={}){
  this.ingest=ingest;const generation=++this.generation,controller=new AbortController();this.controller=controller;
  const current=()=>generation===this.generation&&!controller.signal.aborted&&!signal?.aborted;
  this.failureReason=null;this.observe('starting');
  try{
   this.headers();this.cursor=await this.checkpoint?.load?.()??'';requireValue(current(),'WEIXIN_CONNECTION_CANCELLED');
   this.lifecycleStarted=true;
   // Lifecycle notification is telemetry, not the receive-session authority.
   // The official client continues to authenticated getUpdates if this hook fails.
   try{await this.post('ilink/bot/msg/notifystart',{},AbortSignal.any([controller.signal,...(signal?[signal]:[]),AbortSignal.timeout(START_NOTIFICATION_TIMEOUT_MS)]));}
   catch(error){if(!current())throw error;}
   requireValue(current(),'WEIXIN_CONNECTION_CANCELLED');
   const initial=await this.getUpdates(AbortSignal.any([controller.signal,...(signal?[signal]:[])]),{requireResponse:true});
   requireValue(current(),'WEIXIN_CONNECTION_CANCELLED');await this.consume(initial,ingest,current);requireValue(current(),'WEIXIN_CONNECTION_CANCELLED');
   this.observe('connected');this.loop=this.poll(ingest,controller,generation);
  }catch(error){if(generation===this.generation&&!controller.signal.aborted){this.failureReason=connectionFailure(error,'poll');this.observe(this.authorizationFailure(error)?'authorization_required':error.code==='WEIXIN_PLATFORM_REJECTED'?'failed':'degraded');}throw error;}
 }
 async consume(data,ingest,current=()=>true,stage=()=>{}){
  for(const msg of data.msgs??data.messages??[]){
   requireValue(current(),'STALE_PLATFORM_SOURCE');stage('metadata');const metadata=await weixinEventMetadata(this.configuration,msg);if(!metadata)continue;
   stage('receipt');
   requireValue(current(),'STALE_PLATFORM_SOURCE');
   stage('context');const event=await weixinEvent(this.configuration,msg,this.secrets);
   requireValue(current(),'STALE_PLATFORM_SOURCE');stage('ingress');if(event)await ingest(event);requireValue(current(),'STALE_PLATFORM_SOURCE');
  }
  if(typeof data.get_updates_buf==='string'&&data.get_updates_buf.length){stage('checkpoint');requireValue(current(),'STALE_PLATFORM_SOURCE');await this.checkpoint?.save?.(data.get_updates_buf);requireValue(current(),'STALE_PLATFORM_SOURCE');this.cursor=data.get_updates_buf;}
 }
 async poll(ingest,controller=this.controller,generation=this.generation){
  const current=()=>generation===this.generation&&!controller.signal.aborted;
  let failures=0;
  while(current()){
    let stage='poll';
    try{
      const data=await this.getUpdates(controller.signal);
      if(!current())return;await this.consume(data,ingest,current,value=>{stage=value;});failures=0;this.failureReason=null;
    }catch(error){
      if(!current())return;
      this.failureReason=connectionFailure(error,stage);
      if(this.authorizationFailure(error)){this.observe('authorization_required');return;}
      if(error.code==='WEIXIN_PLATFORM_REJECTED'){this.observe('failed');return;}
      if(++failures>=3){this.observe('degraded');return;}
      await delay(Math.min(1000*2**failures,30000),undefined,{signal:controller.signal}).catch(()=>{});
    }
  }
 }
 async reconnect({signal}={}){const ingest=this.ingest;requireValue(ingest&&this.state==='degraded','CHANNEL_STOPPED');this.generation++;this.controller?.abort();await this.loop?.catch(()=>{});this.loop=null;try{return await this.start(ingest,{signal});}catch(error){if(this.authorizationFailure(error))throw new ChannelError('AUTHORIZATION_REQUIRED','request_authorization');throw error;}}
 async stop(){this.generation++;this.controller?.abort();this.observe('stopped');await this.loop?.catch(()=>{});this.loop=null;if(this.lifecycleStarted){this.lifecycleStarted=false;await this.post('ilink/bot/msg/notifystop',{},AbortSignal.timeout(3000)).catch(()=>{});}}
 async download(media,{signal}={}){
  const material=await this.secrets.get(media.mediaId),reference=material.media;
  requireValue(reference&&typeof reference==='object','WEIXIN_MEDIA_REFERENCE_INVALID');
  const url=reference.full_url??(typeof reference.encrypt_query_param==='string'?'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param='+encodeURIComponent(reference.encrypt_query_param):null);
  requireValue(typeof url==='string','WEIXIN_MEDIA_REFERENCE_INVALID');
  const key=mediaKey(material);requireValue(key||media.kind==='image','WEIXIN_MEDIA_KEY_REQUIRED');
  const encrypted=await this.binary(url,{signal,hosts:CDN_HOSTS,maxBytes:100*1024*1024+16});
  async function* decrypted(){
    if(!key){yield* encrypted.byteStream;return;}
    const cipher=createDecipheriv('aes-128-ecb',key,null);
    try{for await(const part of encrypted.byteStream){signal?.throwIfAborted();yield cipher.update(part);}yield cipher.final();}
    finally{key.fill(0);cipher.destroy();await encrypted.dispose?.();}
  }
  return {filename:media.filename,mediaType:media.kind==='image'?'image/jpeg':'application/octet-stream',byteStream:decrypted(),dispose:async()=>{key?.fill(0);await encrypted.dispose?.();}};
 }
 async send(payload,{deliveryId,signal}){
  requireValue(payload.destination.replyRef,'WEIXIN_CONTEXT_REQUIRED','request_authorization');
  const context=await this.secrets.get(payload.destination.replyRef);
  requireValue(context.toUserId===payload.destination.conversationId,'WEIXIN_RECIPIENT_MISMATCH');
  const body=await this.sdkCall('sendMessage',{body:{msg:{from_user_id:'',to_user_id:context.toUserId,client_id:deliveryId??randomUUID(),message_type:2,message_state:2,item_list:[{type:1,text_item:{text:boundedText(String(payload.content.text??''),16000)}}],context_token:context.contextToken}}},signal);
  return {state:'accepted',...(typeof body.message_id==='string'||Number.isSafeInteger(body.message_id)?{messageId:String(body.message_id)}:{}),clientRequestId:deliveryId,receiptKind:'ilink_response'};
 }
 async prepareUpload(file,{destination,signal}){
  this.headers();requireValue(destination.replyRef,'WEIXIN_CONTEXT_REQUIRED','request_authorization');
  const context=await this.secrets.get(destination.replyRef);requireValue(context.toUserId===destination.conversationId,'WEIXIN_RECIPIENT_MISMATCH');
  requireValue(file.expectedBytes>0&&file.expectedBytes<=this.fileMaxBytes,'PLATFORM_FILE_TOO_LARGE','explicit_user_decision');
  const md5=createHash('md5');for await(const chunk of file.byteStream()){signal?.throwIfAborted();md5.update(chunk);}return {toUserId:context.toUserId,rawMd5:md5.digest('hex'),contextRef:destination.replyRef};
 }
 async upload(file,{deliveryId,uploadContext,signal}){
  requireValue(uploadContext,'WEIXIN_CONTEXT_REQUIRED');const key=randomBytes(16),filekey=randomBytes(16).toString('hex'),cipherBytes=(Math.floor(file.expectedBytes/16)+1)*16;
  const image=['image/jpeg','image/png'].includes(file.mediaType),mediaType=image?1:file.mediaType==='video/mp4'?2:3;
  try{
    const info=await this.sdkCall('getUploadUrl',{filekey,media_type:mediaType,to_user_id:uploadContext.toUserId,rawsize:file.expectedBytes,rawfilemd5:uploadContext.rawMd5,filesize:cipherBytes,no_need_thumb:true,aeskey:key.toString('hex')},signal);
    const target=info.upload_full_url??(typeof info.upload_param==='string'?'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param='+encodeURIComponent(info.upload_param)+'&filekey='+encodeURIComponent(filekey):null);
    requireValue(typeof target==='string','PLATFORM_UPLOAD_RECEIPT_MISSING');
    async function* encrypted(){const cipher=createCipheriv('aes-128-ecb',key,null);try{for await(const chunk of file.byteStream()){signal?.throwIfAborted();yield cipher.update(chunk);}yield cipher.final();}finally{cipher.destroy();}}
    const uploaded=await this.uploader(target,{byteStream:encrypted(),expectedBytes:cipherBytes,signal,hosts:CDN_HOSTS});requireValue(typeof uploaded?.encryptedParam==='string','PLATFORM_UPLOAD_RECEIPT_MISSING');
    const media={encrypt_query_param:uploaded.encryptedParam,aes_key:Buffer.from(key.toString('hex')).toString('base64'),encrypt_type:1};
    const item=mediaType===1?{type:2,image_item:{media,mid_size:cipherBytes}}:mediaType===2?{type:5,video_item:{media,video_size:cipherBytes}}:{type:4,file_item:{media,file_name:file.filename,len:String(file.expectedBytes)}};
    const handleRef=stableId('weixin-upload',[deliveryId,file.sha256]);await this.secrets.put(handleRef,{item,toUserId:uploadContext.toUserId},3600000,uploadContext.contextRef?{parentRef:uploadContext.contextRef}:undefined);return {handleRef};
  }finally{key.fill(0);}
 }
 async sendFile(payload,handle,{deliveryId,signal}){
  const material=await this.secrets.get(handle.handleRef),context=await this.secrets.get(payload.destination.replyRef);
  requireValue(material.toUserId===payload.destination.conversationId&&context.toUserId===material.toUserId,'WEIXIN_RECIPIENT_MISMATCH');
  const result=await this.sdkCall('sendMessage',{body:{msg:{from_user_id:'',to_user_id:context.toUserId,client_id:deliveryId,message_type:2,message_state:2,item_list:[material.item],context_token:context.contextToken}}},signal);
  return {state:'accepted',...(typeof result.message_id==='string'||Number.isSafeInteger(result.message_id)?{messageId:String(result.message_id)}:{}),clientRequestId:deliveryId,receiptKind:'ilink_response'};
 }
}
export class WeixinQrAuthorization {
 constructor({transport=platformJson,now=()=>Date.now()}={}){this.clientMetadata=WEIXIN_CLIENT_METADATA;this.http=transport;this.now=now;this.qr=null;this.cancelled=false;this.generation=0;this.pollBase='https://ilinkai.weixin.qq.com';}
 sdk(signal){return createWeixinSdk({transport:this.http,signal});}
 headers(){return this.sdk().buildCommonHeaders();}
 async create(signal){
  this.cancelled=false;const generation=++this.generation;this.pollBase='https://ilinkai.weixin.qq.com';
  const response=parseWeixinJson(await this.sdk(signal).apiPostFetch({baseUrl:this.pollBase,endpoint:'ilink/bot/get_bot_qrcode?bot_type='+encodeURIComponent(this.clientMetadata.botType),body:JSON.stringify({local_token_list:[]}),timeoutMs:30000,label:'KCoder Weixin QR'}));
  requireValue(generation===this.generation&&!this.cancelled,'WEIXIN_QR_CANCELLED');
  requireValue(typeof response.qrcode==='string'&&typeof response.qrcode_img_content==='string','WEIXIN_QR_INVALID');this.qr=response.qrcode;
  this.expiresAt=this.now()+10*60*1000;
  return {image:response.qrcode_img_content,state:'waiting'};
 }
 async poll(signal,verifyCode){
  requireValue(this.qr&&!this.cancelled,'WEIXIN_QR_CANCELLED');requireValue(this.expiresAt>this.now(),'WEIXIN_QR_EXPIRED');
  const generation=this.generation;
  requireValue(verifyCode===undefined||typeof verifyCode==='string'&&/^[0-9]{1,12}$/.test(verifyCode),'WEIXIN_VERIFICATION_CODE_INVALID');
  let data;
  try {
   data=parseWeixinJson(await this.sdk(signal).apiGetFetch({baseUrl:this.pollBase,endpoint:'ilink/bot/get_qrcode_status?qrcode='+encodeURIComponent(this.qr)+(verifyCode?'&verify_code='+encodeURIComponent(verifyCode):''),timeoutMs:30000,label:'KCoder Weixin QR status'}));
  } catch(error) {
   requireValue(!this.cancelled&&generation===this.generation,'WEIXIN_QR_CANCELLED');
   if(signal?.aborted)throw error;
   // A long-poll deadline supplies no new platform state; keep the same QR and last observation.
   if(error?.name==='AbortError')return {state:'pending'};
   if(error instanceof TypeError&&['fetch failed','terminated'].includes(error.message))throw new ChannelError('WEIXIN_QR_NETWORK_UNAVAILABLE');
   throw error;
  }
  if(this.cancelled||generation!==this.generation)throw new ChannelError('WEIXIN_QR_CANCELLED');
  if(data.status==='confirmed'){requireValue(typeof data.bot_token==='string'&&typeof data.ilink_bot_id==='string','WEIXIN_QR_INVALID');const base=apiBase(data.baseurl);return {state:'confirmed',privateCredentials:{botToken:data.bot_token,accountId:data.ilink_bot_id,userId:data.ilink_user_id,apiBase:base}};}
  if(data.status==='scaned_but_redirect'){const redirected=apiBase(data.redirect_host?.includes('://')?data.redirect_host:'https://'+data.redirect_host);this.pollBase=redirected.replace(/\/$/,'');return {state:'scanned'};}
  const state={wait:'waiting',scaned:'scanned',expired:'expired',need_verifycode:'verification_required',verify_code_blocked:'verification_blocked',binded_redirect:'already_bound'}[data.status];
  requireValue(state,'WEIXIN_QR_STATE_UNSUPPORTED');return {state};
 }
 cancel(){this.cancelled=true;this.qr=null;this.generation++;}
}
