import { createHash } from 'node:crypto';
import { FeishuReceiptFeedback } from './feishu-receipt-feedback.mjs';
import { ChannelError,requireValue } from '../errors.mjs';
import { platformJson,platformBinary,silentSdkLogger,EphemeralSecretStore } from '../transport.mjs';
import { feishuEvent,feishuCardActionEvent,dingtalkEvent,wecomEvent,wecomCardActionEvent } from '../normalizers.mjs';
import { boundedText,httpsUrl,identifier } from '../validation.mjs';
import { hardenFeishuSdk,hardenDingTalkSdk,hardenWecomSdk,BoundedPlatformEvents } from './sdk-guards.mjs';
import { mediaBufferBudget } from '../media-budget.mjs';
import { platformMultipart } from '../upload-transport.mjs';
import { readUploadBuffer } from './file-buffer.mjs';
import { assertSdkInstalled } from '../installation.mjs';
import { DingTalkRest } from './dingtalk-rest.mjs';

function text(content){return boundedText(String(content.text??''),16*1024);}
function feishuMessageRequest(destination,msg_type,content,uuid){
 if(destination.topicId!=null){
  identifier(destination.topicId,'topic');
  requireValue(typeof destination.replyMessageId==='string'&&destination.replyMessageId.length>0,'FEISHU_TOPIC_REPLY_TARGET_REQUIRED');
  identifier(destination.replyMessageId,'reply_message');
  return {url:'https://open.feishu.cn/open-apis/im/v1/messages/'+encodeURIComponent(destination.replyMessageId)+'/reply',
   body:{msg_type,content,uuid,reply_in_thread:true}};
 }
 return {url:'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
  body:{receive_id:destination.conversationId,msg_type,content,uuid}};
}
function taskPresentation(content){
 const value=content.presentation;if(value==null)return null;
 requireValue(value&&['status','question','result','approval_link'].includes(value.kind)&&typeof value.title==='string'&&value.title.length<=120,'INVALID_NATIVE_PRESENTATION');
 if(value.questionRef)requireValue(value.kind==='question'&&typeof value.questionRef.id==='string'&&typeof value.questionRef.revision==='string','INVALID_NATIVE_QUESTION');
 return value;
}
function feishuCard(content){
 const presentation=taskPresentation(content);requireValue(presentation,'INVALID_NATIVE_PRESENTATION');
 const elements=[{tag:'div',text:{tag:'lark_md',content:text(content)}}];
 if(presentation.kind==='question')elements.push({tag:'note',elements:[{tag:'plain_text',content:presentation.questionRef?`Question ${presentation.questionRef.id} · ${presentation.questionRef.revision}`:'Reply in this conversation.'}]});
 if(presentation.kind==='question'&&typeof presentation.actionRef==='string')elements.push({tag:'form',name:'native_question',elements:[{tag:'input',name:'answer',placeholder:{tag:'plain_text',content:'Reply to this question'},max_length:4000},{tag:'button',name:'submit_answer',action_type:'form_submit',text:{tag:'plain_text',content:'Submit answer'},type:'primary',value:{kcoderQuestionAction:presentation.actionRef}}]});
 if(presentation.kind==='approval_link')elements.push({tag:'note',elements:[{tag:'plain_text',content:'Approval requires the original authorized Studio action.'}]});
 return {config:{wide_screen_mode:true,enable_forward:false},header:{title:{tag:'plain_text',content:presentation.title},template:presentation.kind==='question'?'orange':presentation.kind==='result'?'green':'blue'},elements};
}
function dingTalkCard(configuration,payload,deliveryId){
 const presentation=taskPresentation(payload.content),templateId=configuration.taskCardTemplateId;
 if(!presentation||templateId==null)return null;
 requireValue(typeof templateId==='string'&&templateId.length>0&&templateId.length<=256,'DINGTALK_CARD_TEMPLATE_INVALID','repair_configuration');
 requireValue(typeof deliveryId==='string'&&deliveryId.length>0,'DELIVERY_ID_REQUIRED');
 const group=payload.destination.chatKind==='group',target=group?payload.destination.conversationId:payload.destination.externalSubjectId;
 requireValue(typeof target==='string'&&target.length>0&&target.length<=512,'DINGTALK_MEMBER_ID_REQUIRED');
 const update=payload.cardUpdateReceipt;
 if(update)requireValue(typeof update.outTrackId==='string'&&update.outTrackId.length>0&&update.outTrackId.length<=256&&update.cardTemplateId===templateId,'CARD_UPDATE_TEMPLATE_CHANGED','repair_configuration');
 const outTrackId=update?.outTrackId??'kcoder_'+createHash('sha256').update(deliveryId).digest('hex');
 const cardData={cardParamMap:{title:presentation.title,content:text(payload.content),status:presentation.kind,questionId:presentation.questionRef?.id??'',questionRevision:presentation.questionRef?.revision??''}};
 if(update)return {update:true,outTrackId,templateId,body:{outTrackId,userIdType:1,cardData,cardUpdateOptions:{updateCardDataByKey:true}}};
 const robotCode=configuration.robotCode??configuration.clientId,openSpaceId='dtv1.card//'+(group?'IM_GROUP.':'IM_ROBOT.')+target;
 return {update:false,outTrackId,templateId,body:{userIdType:1,cardTemplateId:templateId,outTrackId,callbackType:'STREAM',cardData,openSpaceId,
  ...(group?{imGroupOpenSpaceModel:{supportForward:false},imGroupOpenDeliverModel:{robotCode,extension:{}}}:{imRobotOpenSpaceModel:{supportForward:false},imRobotOpenDeliverModel:{robotCode,spaceType:'IM_ROBOT',extension:{}}})}};
}
function onceReady(register,timeout=15000,signal){
 return new Promise((resolve,reject)=>{
  let settled=false;const done=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();},abort=()=>done(new ChannelError('PLATFORM_CONNECT_CANCELLED','none'));
  const timer=setTimeout(()=>done(new ChannelError('PLATFORM_CONNECT_TIMEOUT','repair_configuration')),timeout);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
  try{register(()=>done(),error=>done(error instanceof ChannelError?error:new ChannelError('PLATFORM_CONNECTION_FAILED','repair_configuration')));}catch(error){done(error);}
 });
}
export class FeishuAdapter {
 constructor({configuration,credentials,transport=platformJson,multipartTransport=platformMultipart,sdk,secretStore,checkpoint}) {this.configuration=configuration;this.credentials=credentials;this.http=transport;this.multipart=multipartTransport;this.sdk=sdk;this.secretStore=secretStore;this.checkpoint=checkpoint;this.client=null;this.token=null;this.events=new BoundedPlatformEvents();this.fileMaxBytes=30*1024*1024;this.generation=0;this.ingest=null;this.connectionObserver=null;this.connectController=null;}
 setConnectionObserver(listener){this.connectionObserver=listener;}
 connectionState(){return this.client?.getConnectionStatus?.().state==='connected'?'connected':'degraded';}
 closeTransport(){this.generation++;this.connectController?.abort();this.client?.close({force:true});this.client=null;this.token=null;}
 async reconnect({signal}={}){const ingest=this.ingest;requireValue(ingest&&!this.events.closed,'CHANNEL_STOPPED');this.closeTransport();return this.start(ingest,{signal});}
 async start(ingest,{signal}={}){
  this.ingest=ingest;const generation=++this.generation,controller=new AbortController();this.connectController=controller;signal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const current=()=>this.generation===generation&&!signal.aborted&&!this.events.closed;
  if(!this.sdk)assertSdkInstalled('feishu');
  const sdk=this.sdk??await import('@larksuiteoapi/node-sdk');
  requireValue(this.credentials.appSecret&&this.configuration.appId,'AUTHORIZATION_REQUIRED');
  const bot=await this.http('https://open.feishu.cn/open-apis/bot/v3/info',{headers:{Authorization:'Bearer '+await this.accessToken(AbortSignal.any([signal,AbortSignal.timeout(10000)]))},signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),hosts:['open.feishu.cn']});
  requireValue(bot.code===0&&typeof bot.bot?.open_id==='string','PLATFORM_BOT_IDENTITY_UNAVAILABLE');
  this.configuration={...this.configuration,botOpenId:bot.bot.open_id};
  this.feedback=new FeishuReceiptFeedback({checkpoint:this.checkpoint,current,
   post:messageId=>this.addTypingReaction(messageId,{signal})});
  await this.feedback.load();requireValue(current(),'STALE_PLATFORM_SOURCE');
  const dispatcher=new sdk.EventDispatcher({logger:silentSdkLogger}).register({'im.message.receive_v1':async packet=>{
   requireValue(current(),'STALE_PLATFORM_SOURCE');const event=feishuEvent(this.configuration,packet);
   if(!event)return {code:0};
   process.stderr.write(JSON.stringify({event:'channel_latency',stage:'sdk_received',atMs:Date.now(),messageId:event.sourceMessageId})+'\n');
   return this.events.run(async()=>{
    requireValue(current(),'STALE_PLATFORM_SOURCE');const receipt=await ingest(event);
    // Typing means a bound task accepted work, not merely that the SDK received a message.
    requireValue(current(),'STALE_PLATFORM_SOURCE');
    if(this.configuration.features?.showTyping!==false&&receipt?.accepted===true&&receipt.state==='pending'&&!receipt.duplicate)await this.feedback.receive(event).catch(()=>{});
    return {code:0};
   });},
   'card.action.trigger':packet=>{requireValue(current(),'STALE_PLATFORM_SOURCE');return this.handleCardAction(packet,event=>{requireValue(current(),'STALE_PLATFORM_SOURCE');return ingest(event);});}});
  const httpInstance={request:config=>{requireValue(current(),'STALE_PLATFORM_SOURCE');return this.http(config.url,{method:String(config.method??'POST').toUpperCase(),headers:config.headers,body:config.data,signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),hosts:['open.feishu.cn']});}};
  requireValue(current(),'PLATFORM_CONNECT_CANCELLED');let ready,failed;
  const client=new sdk.WSClient({appId:this.configuration.appId,appSecret:this.credentials.appSecret,logger:silentSdkLogger,autoReconnect:false,handshakeTimeoutMs:10000,httpInstance,onReady:()=>ready?.(),onError:error=>failed?.(error)});this.client=client;
  hardenFeishuSdk(client,{onConnectionChange:()=>{if(current()&&this.client===client)this.connectionObserver?.();}});
  try{await onceReady((resolve,reject)=>{ready=resolve;failed=reject;Promise.resolve(client.start({eventDispatcher:dispatcher})).then(()=>{if(client.getConnectionStatus?.().state==='connected')resolve();},reject);},15000,signal);
   requireValue(current()&&this.client===client&&this.connectionState()==='connected','PLATFORM_CONNECTION_FAILED');
  }catch(error){if(this.client===client){client.close({force:true});this.client=null;}throw error;}
 }
 handleCardAction(packet,ingest){const receivedAt=Date.now();return this.events.run(async()=>{
  const remaining=2000-(Date.now()-receivedAt);requireValue(remaining>0,'CARD_CALLBACK_WINDOW_EXPIRED','explicit_user_decision');
  const event=feishuCardActionEvent(this.configuration,packet);let timer;
  try{const receipt=await Promise.race([ingest(event),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ChannelError('CARD_ACCEPTANCE_UNCONFIRMED','reconcile_original')),remaining);})]);
   requireValue(receipt?.durablyAccepted===true,'CARD_ACCEPTANCE_UNCONFIRMED','reconcile_original');
   const zh=String(this.configuration.locale??'zh-CN').startsWith('zh');
   return {toast:{type:'info',content:zh?'已提交，处理结果以原生任务回执为准。':'Submitted. The native task receipt determines the outcome.'}};
  }finally{clearTimeout(timer);}
 });}
 async stop(){this.events.close();this.ingest=null;this.closeTransport();}
 async addTypingReaction(sourceMessageId,{signal}={}){
  identifier(sourceMessageId,'source_message');
  signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(8000)]);
  const token=await this.accessToken(signal);signal.throwIfAborted();
  const response=await this.http('https://open.feishu.cn/open-apis/im/v1/messages/'+encodeURIComponent(sourceMessageId)+'/reactions',
   {method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:{reaction_type:{emoji_type:'Typing'}},signal,hosts:['open.feishu.cn']});
  if(response.code!==0)return {state:'failed',code:'PLATFORM_REACTION_REJECTED'};
  requireValue(typeof response.data?.reaction_id==='string','PLATFORM_REACTION_RECEIPT_MISSING');
  return {state:'accepted',reactionId:response.data.reaction_id};
 }
 async accessToken(signal){
  if(this.token&&this.token.expiresAt>Date.now()+30000)return this.token.value;
  const body=await this.http('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'Content-Type':'application/json'},body:{app_id:this.configuration.appId,app_secret:this.credentials.appSecret},signal,hosts:['open.feishu.cn']});
  requireValue(body.code===0&&typeof body.tenant_access_token==='string','PLATFORM_AUTHORIZATION_FAILED','request_authorization');
  this.token={value:body.tenant_access_token,expiresAt:Date.now()+Number(body.expire??3600)*1000};return this.token.value;
 }
 async readOriginalMessage({sourceMessageId},{signal}={}){
  identifier(sourceMessageId,'source_message');
  requireValue(this.connectionState()==='connected'&&this.connectController&&!this.connectController.signal.aborted,'SDK_WORKER_NOT_CONNECTED');
  const generation=this.generation;
  signal=AbortSignal.any([...(signal?[signal]:[]),this.connectController.signal,AbortSignal.timeout(8000)]);
  const token=await this.accessToken(signal);
  const response=await this.http('https://open.feishu.cn/open-apis/im/v1/messages/'+encodeURIComponent(sourceMessageId)+'?user_id_type=open_id',
   {method:'GET',headers:{Authorization:'Bearer '+token},signal,hosts:['open.feishu.cn']});
  signal.throwIfAborted();
  requireValue(generation===this.generation&&this.connectionState()==='connected','STALE_PLATFORM_SOURCE');
  requireValue(response.code===0,'PLATFORM_MESSAGE_READBACK_REJECTED','repair_configuration');
  const items=response.data?.items;
  requireValue(Array.isArray(items)&&items.length===1,'PLATFORM_MESSAGE_READBACK_INVALID');
  const message=items[0],sender=message?.sender;
  requireValue(message?.message_id===sourceMessageId&&message.deleted===false&&message.msg_type==='text'
   &&sender?.sender_type==='user'&&sender.id_type==='open_id','PLATFORM_MESSAGE_READBACK_INVALID');
  for(const value of [message.chat_id,sender.id,sender.tenant_key,this.configuration.appId])identifier(value);
  const raw=message.body?.content;requireValue(typeof raw==='string'&&Buffer.byteLength(raw)<=128*1024,'PLATFORM_MESSAGE_READBACK_INVALID');
  let content;try{content=JSON.parse(raw);}catch{throw new ChannelError('PLATFORM_MESSAGE_READBACK_INVALID');}
  requireValue(typeof content?.text==='string','PLATFORM_MESSAGE_READBACK_INVALID');
  if(message.thread_id!=null)identifier(message.thread_id,'topic');
  return {sourceMessageId,conversationId:message.chat_id,tenantId:sender.tenant_key,senderId:sender.id,
   botId:this.configuration.appId,text:boundedText(content.text,16*1024),topicId:message.thread_id??null};
 }
 async send(payload,{deliveryId,signal}){
  const id=createHash('sha256').update(deliveryId).digest('hex').slice(0,32);
  const presentation=taskPresentation(payload.content),update=payload.cardUpdateMessageId;
  requireValue(!update||presentation&&typeof update==='string'&&update.length<=256,'CARD_UPDATE_RECEIPT_REQUIRED');
  // Octop's ordinary replies are Markdown posts, without a task-status card header.
  const plain=payload.messageFormat==='plain'&&!update&&(!presentation||presentation.kind==='result');
  const post=!plain&&!update&&(!presentation||presentation.kind==='result');
  const messageType=plain?'text':post?'post':presentation?'interactive':'text';
  const content=JSON.stringify(plain?{text:text(payload.content)}:post?{zh_cn:{content:[[{tag:'md',text:text(payload.content).replace(/([^\n])(```)/g,'$1\n$2')||'[empty]'}]]}}:presentation?feishuCard(payload.content):{text:text(payload.content)});
  const target=update?{url:'https://open.feishu.cn/open-apis/im/v1/messages/'+encodeURIComponent(update),body:{content}}
   :feishuMessageRequest(payload.destination,messageType,content,id);
  const token=await this.accessToken(signal);
  // This is the real API dispatch after token lookup and worker authorization,
  // rather than entry into the parent's asynchronous delivery queue.
  process.stderr.write(JSON.stringify({event:'channel_latency',stage:'platform_send_started',atMs:Date.now(),deliveryId})+'\n');
  const body=await this.http(target.url,{method:update?'PATCH':'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:target.body,signal,hosts:['open.feishu.cn']});
  process.stderr.write(JSON.stringify({event:'channel_latency',stage:'platform_send_response',atMs:Date.now(),deliveryId,accepted:body.code===0})+'\n');
  if(body.code!==0)return {state:'failed',code:'PLATFORM_REJECTED'};
  const messageId=update??body.data?.message_id;requireValue(typeof messageId==='string','PLATFORM_RECEIPT_MISSING');
  return {state:'accepted',messageId,messageType,...(update?{updated:true}:{})};
 }
 async download(media,{signal}={}){
  const token=await this.accessToken(signal);
  const url='https://open.feishu.cn/open-apis/im/v1/messages/'+encodeURIComponent(media.sourceMessageId)+'/resources/'+encodeURIComponent(media.mediaId)+'?type='+(media.kind==='image'?'image':'file');
  return {...await platformBinary(url,{headers:{Authorization:'Bearer '+token},signal,hosts:['open.feishu.cn']}),filename:media.filename};
 }
 async upload(file,{signal}){
  requireValue(file.expectedBytes>0&&file.expectedBytes<=this.fileMaxBytes,'PLATFORM_FILE_TOO_LARGE','explicit_user_decision');
  const image=['image/jpeg','image/png','image/gif','image/bmp','image/webp'].includes(file.mediaType),token=await this.accessToken(signal);
  const result=await this.multipart('https://open.feishu.cn/open-apis/im/v1/'+(image?'images':'files'),{file,fieldName:image?'image':'file',fields:image?{image_type:'message'}:{file_type:'stream',file_name:file.filename},headers:{Authorization:'Bearer '+token},signal,hosts:['open.feishu.cn']});
  const mediaId=image?result.data?.image_key:result.data?.file_key;
  requireValue(result.code===0&&typeof mediaId==='string','PLATFORM_UPLOAD_RECEIPT_MISSING');return {mediaId,mediaKind:image?'image':'file'};
 }
 async sendFile(payload,handle,{deliveryId,signal}){
  const target=feishuMessageRequest(payload.destination,handle.mediaKind,
   JSON.stringify(handle.mediaKind==='image'?{image_key:handle.mediaId}:{file_key:handle.mediaId}),
   createHash('sha256').update(deliveryId).digest('hex').slice(0,32));
  const result=await this.http(target.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+await this.accessToken(signal)},body:target.body,signal,hosts:['open.feishu.cn']});
  if(result.code!==0)return {state:'failed',code:'PLATFORM_REJECTED'};requireValue(typeof result.data?.message_id==='string','PLATFORM_RECEIPT_MISSING');return {state:'accepted',messageId:result.data.message_id};
 }
}
export class DingTalkAdapter {
 constructor({configuration,credentials,transport=platformJson,multipartTransport=platformMultipart,sdk,secretStore=new EphemeralSecretStore()}){this.configuration=configuration;this.credentials=credentials;this.http=transport;this.multipart=multipartTransport;this.rest=new DingTalkRest(transport);this.sdk=sdk;this.secrets=secretStore;this.client=null;this.token=null;this.legacyTokenCache=null;this.events=new BoundedPlatformEvents();this.fileMaxBytes=20*1024*1024;this.generation=0;this.ingest=null;this.connectionObserver=null;this.connectController=null;}
 setConnectionObserver(listener){this.connectionObserver=listener;}
 connectionState(){return this.client?.connected===true&&this.client?.registered===true&&this.client?.socket?.readyState===1?'connected':'degraded';}
 closeTransport(){this.generation++;this.connectController?.abort();const client=this.client;this.client=null;client?.disconnect();client?.socket?.terminate?.();this.token=null;this.legacyTokenCache=null;}
 async reconnect({signal}={}){const ingest=this.ingest;requireValue(ingest&&!this.events.closed,'CHANNEL_STOPPED');this.closeTransport();return this.start(ingest,{signal});}
 async start(ingest,{signal}={}){
  this.ingest=ingest;const generation=++this.generation,controller=new AbortController();this.connectController=controller;signal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const current=()=>this.generation===generation&&!signal.aborted&&!this.events.closed;
  if(!this.sdk)assertSdkInstalled('dingtalk');
  const sdk=this.sdk??await import('dingtalk-stream');
  requireValue(this.configuration.clientId&&this.credentials.clientSecret,'AUTHORIZATION_REQUIRED');
  requireValue(current(),'PLATFORM_CONNECT_CANCELLED');const client=new sdk.DWClient({clientId:this.configuration.clientId,clientSecret:this.credentials.clientSecret,debug:false,keepAlive:true,autoReconnect:false});this.client=client;
  let ready,failed;hardenDingTalkSdk(client,{onConnectionChange:()=>{if(current()&&this.client===client){this.connectionObserver?.();if(this.connectionState()==='connected')ready?.();}}});
  client.getEndpoint=async()=>{
    requireValue(current(),'STALE_PLATFORM_SOURCE');const data=await this.rest.openConnection({clientId:this.configuration.clientId,clientSecret:this.credentials.clientSecret,ua:'KCoderChannelHost/0.1.0',subscriptions:client.config.subscriptions},AbortSignal.any([signal,AbortSignal.timeout(15000)]));
    let endpoint;try{endpoint=new URL(data.endpoint);}catch{throw new ChannelError('PLATFORM_GATEWAY_INVALID');}
    requireValue(endpoint.protocol==='wss:'&&(endpoint.hostname==='dingtalk.com'||endpoint.hostname.endsWith('.dingtalk.com'))&&!endpoint.username&&!endpoint.password&&typeof data.ticket==='string','PLATFORM_GATEWAY_INVALID');
    requireValue(current(),'STALE_PLATFORM_SOURCE');endpoint.searchParams.set('ticket',data.ticket);client.dw_url=endpoint.href;return client;
  };
  client.registerCallbackListener(sdk.TOPIC_ROBOT,packet=>{
    this.events.run(async()=>{requireValue(current(),'STALE_PLATFORM_SOURCE');const event=await dingtalkEvent(this.configuration,packet,this.secrets);requireValue(current(),'STALE_PLATFORM_SOURCE');if(event)await ingest(event);requireValue(current(),'STALE_PLATFORM_SOURCE');client.socketCallBackResponse(packet.headers.messageId,{status:'SUCCESS'});}).catch(()=>{});
  });
  try{await onceReady((resolve,reject)=>{ready=resolve;failed=reject;Promise.resolve(client.connect()).then(()=>{if(this.connectionState()==='connected')resolve();else if(client.socket?.readyState!==1)reject(new ChannelError('PLATFORM_CONNECTION_FAILED','repair_configuration'));},failed);},15000,signal);
   requireValue(current()&&this.client===client&&this.connectionState()==='connected','PLATFORM_CONNECTION_FAILED');
  }catch(error){if(this.client===client){this.client=null;client.disconnect();client.socket?.terminate?.();}throw error;}
 }
 async stop(){this.events.close();this.ingest=null;this.closeTransport();}
 async accessToken(signal){
  if(this.token&&this.token.expiresAt>Date.now()+30000)return this.token.value;
  const body=await this.rest.accessToken({appKey:this.configuration.clientId,appSecret:this.credentials.clientSecret},signal);
  requireValue(typeof body.accessToken==='string','PLATFORM_AUTHORIZATION_FAILED','request_authorization');
  this.token={value:body.accessToken,expiresAt:Date.now()+Number(body.expireIn??3600)*1000};return this.token.value;
 }
 async send(payload,{deliveryId,signal}){
  let reply,card;
  try{
   if(payload.destination.replyRef){
    reply=await this.secrets.get(payload.destination.replyRef);
    requireValue(Number.isFinite(reply.expiresAt),'REPLY_WINDOW_UNCONFIRMED','explicit_user_decision');
    requireValue(reply.expiresAt>Date.now(),'REPLY_WINDOW_EXPIRED','explicit_user_decision');
    httpsUrl(reply.url,{allowedHosts:['oapi.dingtalk.com']});
   }
   card=dingTalkCard(this.configuration,payload,deliveryId);
   requireValue(!payload.cardUpdateReceipt||card?.update,'CARD_UPDATE_RECEIPT_REQUIRED');
  }catch(error){
   // No platform delivery has begun; preserve that fact across the worker IPC.
   error.externalOutcome='failed';throw error;
  }
  if(card){
   const body=await this.rest.card(card.body,card.update,{token:await this.accessToken(signal),signal});
   if(body.success===false||card.update&&body.result===false)return {state:'failed',code:'PLATFORM_REJECTED'};
   requireValue(body.success===true,'PLATFORM_RECEIPT_MISSING');
   if(card.update)requireValue(body.result===true,'PLATFORM_RECEIPT_MISSING');
   else{
    requireValue(body.result?.outTrackId===card.outTrackId&&Array.isArray(body.result?.deliverResults)&&body.result.deliverResults.length===1,'PLATFORM_RECEIPT_MISSING');
    if(body.result.deliverResults[0].success===false)return {state:'failed',code:'PLATFORM_REJECTED'};
    requireValue(body.result.deliverResults[0].success===true,'PLATFORM_RECEIPT_MISSING');
   }
   return {state:'accepted',messageType:'dingtalk_card',outTrackId:card.outTrackId,cardTemplateId:card.templateId,receiptKind:'dingtalk_card',...(card.update?{updated:true}:{})};
  }
  if(reply){
    const body=await this.http(reply.url,{method:'POST',headers:{'Content-Type':'application/json'},body:{msgtype:'text',text:{content:text(payload.content)}},signal,hosts:['oapi.dingtalk.com']});
    return body.errcode===0?{state:'accepted',receiptKind:'session_webhook'}:{state:'failed',code:'PLATFORM_REJECTED'};
  }
  const token=await this.accessToken(signal);
  const isGroup=payload.destination.chatKind==='group';
  requireValue(isGroup||typeof payload.destination.externalSubjectId==='string','DINGTALK_MEMBER_ID_REQUIRED');
  const data={robotCode:this.configuration.robotCode??this.configuration.clientId,msgKey:'sampleText',msgParam:JSON.stringify({content:text(payload.content)}),...(isGroup?{openConversationId:payload.destination.conversationId}:{userIds:[payload.destination.externalSubjectId]})};
  const body=await this.rest.sendMessage(data,isGroup,{token,signal});
  requireValue(typeof body.processQueryKey==='string','PLATFORM_RECEIPT_MISSING');
  return {state:'accepted',processQueryKey:body.processQueryKey,receiptKind:'dingtalk_process'};
 }
 async download(media,{signal}={}){
  const token=await this.accessToken(signal);
  const result=await this.rest.download({downloadCode:media.mediaId,robotCode:this.configuration.robotCode??this.configuration.clientId},{token,signal});
  requireValue(typeof result.downloadUrl==='string','MEDIA_DOWNLOAD_URL_MISSING');
  const hosts=this.credentials.allowedMediaHosts??['down.dingtalk.com','static.dingtalk.com'];
  return {...await platformBinary(result.downloadUrl,{signal,hosts}),filename:media.filename};
 }
 async upload(file,{signal}){
  requireValue(file.expectedBytes>0&&file.expectedBytes<=this.fileMaxBytes,'PLATFORM_FILE_TOO_LARGE','explicit_user_decision');
  if(!this.legacyTokenCache||this.legacyTokenCache.expiresAt<Date.now()+30000){
    const url=new URL('https://oapi.dingtalk.com/gettoken');url.searchParams.set('appkey',this.configuration.clientId);url.searchParams.set('appsecret',this.credentials.clientSecret);
    const result=await this.http(url.href,{signal,hosts:['oapi.dingtalk.com']});requireValue(result.errcode===0&&typeof result.access_token==='string','PLATFORM_AUTHORIZATION_FAILED');this.legacyTokenCache={value:result.access_token,expiresAt:Date.now()+Number(result.expires_in??3600)*1000};
  }
  const url=new URL('https://oapi.dingtalk.com/media/upload');url.searchParams.set('access_token',this.legacyTokenCache.value);url.searchParams.set('type','file');
  const result=await this.multipart(url.href,{file,fieldName:'media',signal,hosts:['oapi.dingtalk.com']});requireValue(result.errcode===0&&typeof result.media_id==='string','PLATFORM_UPLOAD_RECEIPT_MISSING');return {mediaId:result.media_id,mediaKind:'file',filename:file.filename};
 }
 async sendFile(payload,handle,{signal}){
  const group=payload.destination.chatKind==='group';requireValue(group||typeof payload.destination.externalSubjectId==='string','DINGTALK_MEMBER_ID_REQUIRED');
  const extension=handle.filename.split('.').at(-1).toLowerCase(),fileType=/^[a-z0-9]{1,16}$/.test(extension)?extension:'bin';
  const result=await this.rest.sendMessage({robotCode:this.configuration.robotCode??this.configuration.clientId,msgKey:'sampleFile',msgParam:JSON.stringify({mediaId:handle.mediaId,fileName:handle.filename,fileType}),...(group?{openConversationId:payload.destination.conversationId}:{userIds:[payload.destination.externalSubjectId]})},group,{token:await this.accessToken(signal),signal});
  requireValue(typeof result.processQueryKey==='string','PLATFORM_RECEIPT_MISSING');return {state:'accepted',processQueryKey:result.processQueryKey,receiptKind:'dingtalk_process'};
 }
}
function wecomReceipt(result){
 if(result?.errcode!==undefined&&result.errcode!==0)return {state:'failed',code:'PLATFORM_REJECTED'};
 const requestId=result?.headers?.req_id;requireValue(typeof requestId==='string','PLATFORM_RECEIPT_MISSING');
 return {state:'accepted',receiptKind:'wecom_ack',requestId,...(typeof result.body?.msgid==='string'?{messageId:result.body.msgid}:{})};
}
function wecomCard(presentation,bodyText,deliveryId){
 const action=presentation.actionRef,taskId=presentation.cardTaskId??createHash('sha256').update(String(deliveryId)).digest('hex').slice(0,32);
 if(action)requireValue(presentation.kind==='status'&&typeof action==='string'&&action.length<=256&&typeof presentation.cardTaskId==='string','INVALID_NATIVE_CARD_ACTION');
 return {card_type:action?'button_interaction':'text_notice',source:{desc:'KCoder'},main_title:{title:[...presentation.title].slice(0,26).join('')},sub_title_text:bodyText,task_id:taskId,
  ...(action?{button_list:[{text:presentation.refreshLabel??'Refresh status',key:action,style:1}]}:{})};
}
function wecomCardUpdateReceipt(frame,taskId){
 const {requestId,...receipt}=wecomReceipt(frame);
 return {...receipt,receiptKind:'wecom_card_update',cardTaskId:taskId};
}
function wecomStreamReceipt(frame,metadata){
 const {requestId,...receipt}=wecomReceipt(frame);return {...receipt,receiptKind:'wecom_stream',messageType:'wecom_stream',...metadata};
}
export class WeComAdapter {
 constructor({configuration,credentials,sdk,secretStore=new EphemeralSecretStore()}){this.configuration=configuration;this.credentials=credentials;this.sdk=sdk;this.secrets=secretStore;this.client=null;this.events=new BoundedPlatformEvents();this.fileMaxBytes=50*1024*1024;this.generation=0;this.contextIntents=new Map();this.state='stopped';this.ingest=null;this.connectionObserver=null;this.connectController=null;}
 setConnectionObserver(listener){this.connectionObserver=listener;}
 connectionState(){return this.state;}
 observe(state){if(this.state===state)return;this.state=state;this.connectionObserver?.();}
 async start(ingest,{signal}={}){
  requireValue(!this.events.closed,'CHANNEL_STOPPED');this.ingest=ingest;
  const generation=++this.generation,controller=new AbortController();this.connectController=controller;
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const current=()=>this.generation===generation&&!controller.signal.aborted&&!this.events.closed;
  this.observe('starting');
  if(!this.sdk)assertSdkInstalled('wecom');
  const sdk=this.sdk??await import('@wecom/aibot-node-sdk');
  requireValue(this.configuration.botId&&this.credentials.secret,'AUTHORIZATION_REQUIRED');
  requireValue(current(),'PLATFORM_CONNECT_CANCELLED');
  // Reconnection belongs to the native worker's current owner/credential checks.
  const client=new sdk.WSClient({botId:this.configuration.botId,secret:this.credentials.secret,logger:silentSdkLogger,maxReconnectAttempts:0,maxAuthFailureAttempts:0,requestTimeout:10000,wsOptions:{maxPayload:256*1024,perMessageDeflate:false},maxReplyQueueSize:32});this.client=client;
  this.withSignal=hardenWecomSdk(client);
  client.on('authenticated',()=>{if(current())this.observe('connected');});
  client.on('disconnected',()=>{if(current()&&this.state!=='authorization_required')this.observe('degraded');});
  client.on('error',error=>{if(current())this.observe(error?.code==='WS_AUTH_FAILURE_EXHAUSTED'?'authorization_required':'degraded');});
  client.on('message',packet=>{const receivedAtMs=Date.now();this.events.run(async()=>{requireValue(current(),'STALE_PLATFORM_SOURCE');const event=await wecomEvent(this.configuration,packet,this.secrets,{receivedAtMs,contextIntents:this.contextIntents});requireValue(current(),'STALE_PLATFORM_SOURCE');if(event)await ingest(event);}).catch(()=>{});});
  client.on('event.template_card_event',packet=>{const receivedAtMs=Date.now();this.events.run(async()=>{requireValue(current(),'STALE_PLATFORM_SOURCE');const event=await wecomCardActionEvent(this.configuration,packet,this.secrets,receivedAtMs);requireValue(current(),'STALE_PLATFORM_SOURCE');await ingest(event);}).catch(()=>{});});
  try{
   await onceReady((ready,failed)=>{client.once('authenticated',ready);client.once('error',failed);client.connect();},15000,combined);
   requireValue(current()&&this.state==='connected','PLATFORM_CONNECTION_FAILED');
  }catch(error){
   if(generation===this.generation){controller.abort();if(this.state!=='authorization_required')this.observe('degraded');client.disconnect();if(this.client===client)this.client=null;}
   throw error;
  }
 }
 async reconnect({signal}={}){
  requireValue(this.ingest&&this.state==='degraded'&&!this.events.closed,'CHANNEL_STOPPED');
  this.generation++;this.connectController?.abort();this.client?.disconnect();this.client=null;
  return this.start(this.ingest,{signal});
 }
 async stop(){this.generation++;this.events.close();this.connectController?.abort();this.client?.disconnect();this.client=null;this.observe('stopped');}
 async send(payload,{deliveryId,signal,onLateReceipt}={}){
  requireValue(this.client,'CHANNEL_NOT_CONNECTED');
  const presentation=taskPresentation(payload.content),bodyText=text(payload.content);
  if(presentation?.wecomStream){
   let context,deadline,metadata;
   try{
    requireValue(payload.destination.replyRef,'STREAM_CONTEXT_REQUIRED');context=await this.secrets.get(payload.destination.replyRef);
    requireValue(context.kind==='wecom_task_stream'&&typeof context.reqId==='string'&&context.reqId.length>0&&context.reqId.length<=256,'STREAM_CONTEXT_REQUIRED');
    requireValue(['platform','channelId','tenantId','botId','conversationId','chatKind'].every(key=>context[key]===(payload.destination[key]??null))&&context.senderId===payload.destination.externalSubjectId&&context.botId===this.configuration.botId&&context.channelId===this.configuration.channelId,'STREAM_CONTEXT_OWNER_CHANGED');
    const stream=presentation.wecomStream,previous=payload.streamPreviousReceipt;
    requireValue(stream.streamId===context.streamId&&Number.isSafeInteger(stream.sequence)&&stream.sequence>0&&stream.sequence<=64&&typeof stream.finish==='boolean','STREAM_INTENT_INVALID');
    const first=stream.sequence===1,startedAt=first?Date.now():previous?.streamStartedAtMs;
    requireValue(first?!previous:previous?.state==='accepted'&&previous.messageType==='wecom_stream'&&previous.streamId===stream.streamId&&previous.sequence===stream.sequence-1&&previous.finish===false,'STREAM_ORIGINAL_RECEIPT_REQUIRED');
    requireValue(Number.isFinite(startedAt)&&Number.isFinite(context.firstReplyDeadlineMs)&&startedAt<=context.firstReplyDeadlineMs&&startedAt>=context.receivedAtMs,'STREAM_ORIGINAL_RECEIPT_REQUIRED');
    deadline=first?context.firstReplyDeadlineMs:Math.min(context.expiresAtMs,startedAt+360000);requireValue(Number.isFinite(deadline)&&deadline>Date.now(),'STREAM_WINDOW_EXPIRED','explicit_user_decision');
    metadata={streamId:stream.streamId,sequence:stream.sequence,streamStartedAtMs:startedAt,finish:stream.finish};
   }catch(error){error.externalOutcome='failed';throw error;}
   const receipt=frame=>{requireValue(frame?.headers?.req_id===context.reqId,'STREAM_RECEIPT_IDENTITY_CHANGED');return wecomStreamReceipt(frame,metadata);};
   const timeout=AbortSignal.timeout(Math.max(1,Math.floor(deadline-Date.now()))),combined=signal?AbortSignal.any([signal,timeout]):timeout;
   const result=await this.withSignal(combined,()=>{
    if(deadline<=Date.now()){const error=new ChannelError('STREAM_WINDOW_EXPIRED','explicit_user_decision');error.externalOutcome='failed';throw error;}
    return this.client.replyStream({headers:{req_id:context.reqId}},metadata.streamId,bodyText,metadata.finish);
   },frame=>onLateReceipt?.(receipt(frame)));
   return receipt(result);
  }
  if(payload.destination.replyRef){
   let context;
   try{
    context=await this.secrets.get(payload.destination.replyRef);
    requireValue(context.kind==='wecom_card_callback'&&typeof context.reqId==='string'&&context.reqId.length>0&&context.reqId.length<=256&&context.botId===this.configuration.botId&&context.channelId===this.configuration.channelId,'CARD_CALLBACK_OWNER_CHANGED');
    requireValue(['platform','channelId','tenantId','botId','conversationId','chatKind'].every(key=>context[key]===(payload.destination[key]??null))&&context.senderId===payload.destination.externalSubjectId,'CARD_CALLBACK_OWNER_CHANGED');
    requireValue(Number.isFinite(context.expiresAtMs)&&context.expiresAtMs>Date.now(),'CARD_CALLBACK_WINDOW_EXPIRED','explicit_user_decision');
    requireValue(presentation?.kind==='status'&&presentation.cardTaskId===context.taskId&&[...bodyText].length<=112,'CARD_CALLBACK_TASK_CHANGED');
   }catch(error){error.externalOutcome='failed';throw error;}
   const remaining=context.expiresAtMs-Date.now(),windowSignal=AbortSignal.timeout(Math.max(1,Math.floor(remaining))),combined=signal?AbortSignal.any([signal,windowSignal]):windowSignal;
   const result=await this.withSignal(combined,()=>{
    if(context.expiresAtMs<=Date.now()){const error=new ChannelError('CARD_CALLBACK_WINDOW_EXPIRED','explicit_user_decision');error.externalOutcome='failed';throw error;}
    return this.client.updateTemplateCard({headers:{req_id:context.reqId}},wecomCard(presentation,bodyText,deliveryId),[context.senderId]);
   },frame=>onLateReceipt?.(wecomCardUpdateReceipt(frame,context.taskId)));
   return {...wecomCardUpdateReceipt(result,context.taskId),messageType:'template_card',updated:true};
  }
  // Long questions/results keep the complete supported Markdown representation;
  // they are never silently clipped to a template-card subtitle.
  const useCard=presentation&&[...bodyText].length<=112;
  const plain=payload.messageFormat==='plain';
  const body=plain?{msgtype:'text',text:{content:bodyText}}:useCard?{msgtype:'template_card',template_card:wecomCard(presentation,bodyText,deliveryId)}:{msgtype:'markdown',markdown:{content:bodyText}};
  return {...wecomReceipt(await this.withSignal(signal,()=>this.client.sendMessage(payload.destination.conversationId,body),frame=>onLateReceipt?.(wecomReceipt(frame)))),messageType:plain?'text':useCard?'template_card':'markdown'};
 }
 async download(media,{signal}={}){
  const context=await this.secrets.get(media.mediaId);
  const hosts=this.credentials.allowedMediaHosts??['openapi.work.weixin.qq.com','open.work.weixin.qq.com'];
  const reservation=mediaBufferBudget.reserve(150*1024*1024);
  let encrypted;
  try{
    encrypted=await platformBinary(context.url,{signal,hosts,maxBytes:50*1024*1024});
    const parts=[];let total=0;for await(const part of encrypted.byteStream){total+=part.length;requireValue(total<=50*1024*1024,'INPUT_TOO_LARGE');parts.push(Buffer.from(part));}
    const sdk=this.sdk??await import('@wecom/aibot-node-sdk');const data=context.aesKey?sdk.decryptFile(Buffer.concat(parts),context.aesKey):Buffer.concat(parts);
    const cleanup=async()=>{data.fill(0);reservation.release();await encrypted.dispose?.();};
    async function* bytes(){try{yield data;}finally{await cleanup();}}
    return {filename:media.filename,mediaType:encrypted.mediaType,expectedBytes:data.length,byteStream:bytes(),dispose:cleanup};
  }catch(error){reservation.release();await encrypted?.dispose?.();throw error;}
 }
 async upload(file,{signal}){
  requireValue(this.client&&this.withSignal,'CHANNEL_NOT_CONNECTED');const buffer=await readUploadBuffer(file,{maxBytes:this.fileMaxBytes,copies:3,signal});
  try{const mediaKind=['image/jpeg','image/png','image/gif'].includes(file.mediaType)?'image':'file';const result=await this.withSignal(signal,()=>this.client.uploadMedia(buffer.data,{type:mediaKind,filename:file.filename}));requireValue(typeof result?.media_id==='string','PLATFORM_UPLOAD_RECEIPT_MISSING');return {mediaId:result.media_id,mediaKind};}
  finally{buffer.dispose();}
 }
 async sendFile(payload,handle,{signal,onLateReceipt}){
  requireValue(this.client&&this.withSignal,'CHANNEL_NOT_CONNECTED');return wecomReceipt(await this.withSignal(signal,()=>this.client.sendMediaMessage(payload.destination.conversationId,handle.mediaKind,handle.mediaId),frame=>onLateReceipt?.(wecomReceipt(frame))));
 }
}
