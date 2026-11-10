import { requireValue } from './errors.mjs';
import { boundedText, identifier, stableId, privatePayload,canonical,PLATFORM_IDENTITY_FIELD } from './validation.mjs';
const COMMANDS=new Set(['/help','/new','/status','/stop','/resume','/tasks','/studio','/unbind']);
function parsedContent(raw) {
  if(typeof raw!=='string')return raw??{};
  boundedText(raw,256*1024);
  try{return JSON.parse(raw);}catch{return {text:raw};}
}
export function secretContextOrigin(event){
 const value={botId:event.botId,tenantId:event.tenantId,senderId:event.senderId,conversationId:event.conversationId,chatKind:event.chatKind,eventId:event.eventId,observedAtMs:Number.isFinite(event.occurredAtMs)?Math.min(event.occurredAtMs,Date.now()):Date.now()};
 for(const key of ['botId','tenantId','senderId','conversationId','eventId'])identifier(value[key]);return value;
}
function base(platform,configuration,data) {
  const botId=configuration[PLATFORM_IDENTITY_FIELD[platform]];
  const eventId=typeof data.eventId==='number'&&Number.isSafeInteger(data.eventId)&&data.eventId>=0?String(data.eventId):data.eventId;
  for (const value of [configuration.channelId,botId,eventId,data.senderId,data.conversationId]) requireValue(typeof value==='string'&&value.length>0,'PLATFORM_IDENTITY_MISSING');
  return {platform,channelId:configuration.channelId,tenantId:String(data.tenantId??configuration.tenantId??'default'),botId,eventId,senderId:String(data.senderId),conversationId:String(data.conversationId),chatKind:data.chatKind,kind:'message',text:boundedText(String(data.text??'')),attachments:data.attachments??[],occurredAtMs:Number.isSafeInteger(data.occurredAtMs)?data.occurredAtMs:null};
}
function finish(event) {
  for(const name of ['channelId','botId','eventId','senderId','conversationId'])identifier(event[name],name);
  if(COMMANDS.has(event.text.trim().split(/\s+/,1)[0]))event.kind='control';
  privatePayload(event);return event;
}
export function feishuEvent(configuration,packet) {
  const e=packet.event??packet;const msg=e.message;const sender=e.sender;
  if(!msg||['app','bot'].includes(sender?.sender_type))return null;
  if(msg.chat_type==='group'&&configuration.botOpenId&&!(msg.mentions??[]).some(mention=>mention.id?.open_id===configuration.botOpenId))return null;
  const body=parsedContent(msg.content);const kind=msg.message_type;
  let text=body.text??'';
  if(kind==='post')text=Object.values(body).flatMap(x=>x?.content??[]).flat().map(x=>x.text??'').join('');
  const attachments=[];
  const mediaId=body.image_key??body.file_key;
  if(mediaId)attachments.push({kind:kind==='image'?'image':'file',mediaId:String(mediaId),sourceMessageId:String(msg.message_id),filename:String(body.file_name??'attachment')});
  const event=base('feishu',configuration,{tenantId:packet.header?.tenant_key??packet.tenant_key,eventId:packet.header?.event_id??packet.event_id??msg.message_id,senderId:sender?.sender_id?.open_id??sender?.sender_id?.user_id,conversationId:msg.chat_id,chatKind:msg.chat_type==='p2p'?'private':'group',text,attachments,occurredAtMs:Number(msg.create_time)});
  // Platform topics and the original message ID are distinct from event IDs.
  if(msg.thread_id){identifier(msg.thread_id,'topic');event.topicId=msg.thread_id;}
  if(msg.message_id){identifier(msg.message_id,'source_message');event.sourceMessageId=msg.message_id;}
  if(msg.parent_id){identifier(msg.parent_id,'reply_message');event.replyToMessageId=msg.parent_id;}
  else if(msg.root_id){identifier(msg.root_id,'reply_message');event.replyToMessageId=msg.root_id;}
  return finish(event);
}
export function feishuCardActionEvent(configuration,packet){
 const value=packet.event??packet,action=value.action??{},form=action.form_value??{};
 const ref=action.value?.kcoderQuestionAction;
 identifier(ref,'card_action');
 const event=base('feishu',configuration,{tenantId:packet.header?.tenant_key??packet.tenant_key,eventId:packet.header?.event_id??packet.event_id,
  senderId:value.operator?.open_id??value.operator?.user_id,conversationId:value.context?.open_chat_id??value.open_chat_id,chatKind:'private',text:boundedText(String(form.answer??'')),attachments:[]});
 event.kind='control';event.cardActionRef=ref;return finish(event);
}
export async function dingtalkEvent(configuration,packet,secrets) {
  const msg=parsedContent(packet.data);
  if(String(msg.conversationType)==='2'&&msg.isInAtList===false)return null;
  const event=base('dingtalk',configuration,{tenantId:msg.senderCorpId??msg.chatbotCorpId,eventId:msg.msgId??packet.headers?.messageId,senderId:msg.senderStaffId??msg.senderId,conversationId:msg.conversationId,chatKind:String(msg.conversationType)==='1'?'private':'group',text:msg.text?.content??msg.content??'',attachments:msg.content?.downloadCode?[{kind:'file',mediaId:String(msg.content.downloadCode),filename:'attachment'}]:[],occurredAtMs:Number(msg.createAt)});
  if(msg.sessionWebhook){
    const ref=stableId('reply-context',[event.botId,event.eventId]);
    await secrets.put(ref,{url:msg.sessionWebhook,expiresAt:msg.sessionWebhookExpiredTime},Math.max(1000,Math.min(3600000,Number(msg.sessionWebhookExpiredTime)-Date.now()||300000)),secretContextOrigin(event));
    event.replyRef=ref;
  }
  return finish(event);
}
export function qqEvent(configuration,packet) {
  const msg=packet.d??packet;
  const types=new Set(['C2C_MESSAGE_CREATE','GROUP_AT_MESSAGE_CREATE','AT_MESSAGE_CREATE','DIRECT_MESSAGE_CREATE','MESSAGE_CREATE']);
  if(packet.t&&!types.has(packet.t))return null;
  if(msg.author?.bot)return null;
  requireValue(Array.isArray(msg.attachments??[])&&(msg.attachments??[]).length<=32,'TOO_MANY_ATTACHMENTS');
  const attachments=(msg.attachments??[]).map(a=>({kind:String(a.content_type??'').startsWith('image/')?'image':'file',mediaId:String(a.url??a.id),filename:String(a.filename??'attachment')}));
  const direct=packet.t==='DIRECT_MESSAGE_CREATE',chatKind=packet.t==='C2C_MESSAGE_CREATE'||direct?'private':msg.group_openid?'group':'channel';
  const event=base('qq',configuration,{eventId:msg.id??packet.id,senderId:msg.author?.user_openid??msg.author?.member_openid??msg.author?.id,conversationId:direct?msg.guild_id:msg.group_openid??msg.channel_id??msg.author?.user_openid??msg.author?.id,chatKind,text:msg.content??'',attachments,occurredAtMs:Date.parse(msg.timestamp)});
  if(direct)event.platformRoute='qq_guild_dm';return finish(event);
}
export async function wecomEvent(configuration,packet,secrets,{receivedAtMs=Date.now(),contextIntents}={}) {
  const msg=packet.body??packet;
  if(!msg.from?.userid)return null;
  const attachments=[];
  const contextOwner=base('wecom',configuration,{eventId:msg.msgid??packet.headers?.req_id,senderId:msg.from.userid,conversationId:msg.chatid??msg.from.userid,chatKind:msg.chattype==='group'?'group':'private',text:'',occurredAtMs:msg.create_time?Number(msg.create_time)*1000:null});
  if(msg.file||msg.image){
    const material=msg.file??msg.image;const ref=stableId('media-context',[configuration.botId,msg.msgid??packet.headers?.req_id]);
    await secrets.put(ref,{url:material.url,aesKey:material.aeskey??null},300000,secretContextOrigin(contextOwner));
    attachments.push({kind:msg.image?'image':'file',mediaId:ref,filename:String(material.filename??'attachment')});
  }
  const event=base('wecom',configuration,{eventId:msg.msgid??packet.headers?.req_id,senderId:msg.from.userid,conversationId:msg.chatid??msg.from.userid,chatKind:msg.chattype==='group'?'group':'private',text:msg.text?.content??msg.voice?.content??'',attachments,occurredAtMs:msg.create_time?Number(msg.create_time)*1000:null});
  if(packet.cmd==='aibot_msg_callback'&&configuration.replyMode!=='card'){
    requireValue(msg.aibotid===configuration.botId&&typeof msg.msgid==='string','INVALID_WECOM_STREAM_CALLBACK');identifier(packet.headers?.req_id,'callback');
    const ref=stableId('wecom-stream-context',[event.botId,event.eventId]),owner=Object.fromEntries(['platform','channelId','tenantId','botId','senderId','conversationId','chatKind'].map(key=>[key,event[key]]));
    let context;try{context=await secrets.get(ref);}catch(error){if(error?.code!=='PLATFORM_CONTEXT_EXPIRED')throw error;}
    if(context)requireValue(context.kind==='wecom_task_stream'&&context.eventId===event.eventId&&Object.keys(owner).every(key=>context[key]===owner[key]),'STREAM_CONTEXT_OWNER_CHANGED');
    else{
      if(contextIntents)for(const[key,expires]of contextIntents)if(expires<=Date.now())contextIntents.delete(key);
      requireValue(!contextIntents?.has(ref),'STREAM_CONTEXT_UNCONFIRMED','reconcile_original');
      const received=Math.min(Date.now(),receivedAtMs,Number.isFinite(msg.create_time)?msg.create_time*1000:receivedAtMs);
      context={kind:'wecom_task_stream',...owner,eventId:event.eventId,reqId:packet.headers.req_id,streamId:stableId('wecom-stream',[event.botId,event.eventId]).slice(-32),receivedAtMs:received,firstReplyDeadlineMs:received+5000,expiresAtMs:received+365000};
      requireValue(context.expiresAtMs>Date.now(),'STREAM_WINDOW_EXPIRED','explicit_user_decision');
      if(contextIntents){requireValue(contextIntents.size<1000,'STREAM_CONTEXT_CAPACITY');contextIntents.set(ref,context.expiresAtMs);}
      try{await secrets.put(ref,context,Math.max(1,Math.floor(context.expiresAtMs-Date.now())));}
      catch(error){let original;try{original=await secrets.get(ref);}catch{}requireValue(original&&canonical(original)===canonical(context),'STREAM_CONTEXT_UNCONFIRMED','reconcile_original');context=original;}
    }
    requireValue(typeof context.reqId==='string'&&context.reqId.length>0&&context.reqId.length<=256&&context.streamId===stableId('wecom-stream',[event.botId,event.eventId]).slice(-32)&&Number.isFinite(context.receivedAtMs)&&context.firstReplyDeadlineMs===context.receivedAtMs+5000&&context.expiresAtMs===context.receivedAtMs+365000,'STREAM_CONTEXT_INVALID');
    event.streamReplyRef=ref;event.streamId=context.streamId;event.streamFirstReplyDeadlineMs=context.firstReplyDeadlineMs;event.streamContextExpiresAtMs=context.expiresAtMs;
  }
  return finish(event);
}
export async function wecomCardActionEvent(configuration,packet,secrets,receivedAtMs=Date.now()){
 const msg=packet.body,event=msg?.event;
 requireValue(msg?.msgtype==='event'&&event?.eventtype==='template_card_event'&&msg.aibotid===configuration.botId,'INVALID_WECOM_CARD_CALLBACK');
 identifier(msg.msgid,'event');identifier(packet.headers?.req_id,'callback');identifier(event.event_key,'card_action');identifier(event.task_id,'card_task');
 requireValue(Number.isFinite(msg.create_time)&&Number.isFinite(receivedAtMs),'CARD_CALLBACK_WINDOW_UNCONFIRMED');
 const startedAt=Math.min(Date.now(),receivedAtMs,msg.create_time*1000),expiresAtMs=startedAt+5000;
 requireValue(expiresAtMs>Date.now(),'CARD_CALLBACK_WINDOW_EXPIRED','explicit_user_decision');
 const normalized=base('wecom',configuration,{tenantId:msg.from?.corpid,eventId:msg.msgid,senderId:msg.from?.userid,conversationId:msg.chatid??msg.from?.userid,chatKind:msg.chattype==='group'?'group':'private',text:'/status',attachments:[],occurredAtMs:msg.create_time*1000});
 const ref=stableId('wecom-card-context',[normalized.botId,normalized.eventId]);
 const context={kind:'wecom_card_callback',reqId:packet.headers.req_id,taskId:event.task_id,eventId:msg.msgid,expiresAtMs,
  ...Object.fromEntries(['platform','channelId','tenantId','botId','senderId','conversationId','chatKind'].map(key=>[key,normalized[key]]))};
 let old;try{old=await secrets.get(ref);}catch(error){if(error?.code!=='PLATFORM_CONTEXT_EXPIRED')throw error;}
 if(old)requireValue(old.kind===context.kind&&old.reqId===context.reqId&&old.taskId===context.taskId&&old.eventId===context.eventId&&['platform','channelId','tenantId','botId','senderId','conversationId','chatKind'].every(key=>old[key]===context[key]),'CARD_CALLBACK_CONTEXT_CHANGED');
 else await secrets.put(ref,context,Math.max(1,Math.floor(expiresAtMs-Date.now())));
 normalized.kind='control';normalized.cardActionRef=event.event_key;normalized.cardTaskId=event.task_id;normalized.replyRef=ref;
 return finish(normalized);
}
export async function weixinEvent(configuration,msg,secrets) {return normalizeWeixinEvent(configuration,msg,secrets,false);}
/** Only a draft for comparing an already accepted original event; it grants no content access. */
export async function weixinEventMetadata(configuration,msg) {return normalizeWeixinEvent(configuration,msg,null,true);}
async function normalizeWeixinEvent(configuration,msg,secrets,metadataOnly) {
  if(msg.message_type===2||!msg.from_user_id)return null;
  requireValue(!msg.group_id,'WEIXIN_GROUP_UNSUPPORTED');
  requireValue(Array.isArray(msg.item_list??[])&&(msg.item_list??[]).length<=32,'TOO_MANY_ATTACHMENTS');
  const ref=stableId('weixin-context',[configuration.accountId,msg.from_user_id,msg.message_id??msg.client_id]);
  const origin=secretContextOrigin(base('weixin',configuration,{eventId:msg.message_id??msg.client_id,senderId:msg.from_user_id,conversationId:msg.from_user_id,chatKind:'private',text:'',occurredAtMs:msg.create_time_ms??null}));
  if(msg.context_token&&!metadataOnly)await secrets.put(ref,{contextToken:msg.context_token,toUserId:msg.from_user_id},3600000,origin);
  const text=(msg.item_list??[]).filter(i=>i.type===1).map(i=>i.text_item?.text??'').join('\n');
  const attachments=[];
  for(const item of msg.item_list??[]){
    if(item.type===1)continue;
    const material=item.image_item??item.file_item??item.voice_item??item.video_item;
    if(material){
      const mediaRef=stableId('weixin-media',[configuration.accountId,msg.message_id??msg.client_id,attachments.length]);
      if(!metadataOnly)await secrets.put(mediaRef,material,3600000,origin);
      attachments.push({kind:item.type===2?'image':item.type===3?'audio':'file',mediaId:mediaRef,filename:String(material.file_name??'attachment')});
    }
  }
  const event=base('weixin',configuration,{eventId:msg.message_id??msg.client_id,senderId:msg.from_user_id,conversationId:msg.from_user_id,chatKind:'private',text,attachments,occurredAtMs:msg.create_time_ms??null});
  event.replyRef=ref;return finish(event);
}
const GITHUB_LOGIN=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPOSITORY=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export function githubLogin(value){requireValue(typeof value==='string'&&GITHUB_LOGIN.test(value),'GITHUB_BOT_LOGIN_INVALID','repair_configuration');return value;}
/** Repository names are case-insensitive on GitHub; one canonical spelling keys topics and cursors. */
export function githubRepository(value){requireValue(typeof value==='string'&&GITHUB_REPOSITORY.test(value)&&!value.endsWith('.')&&!value.split('/')[1].startsWith('.'),'GITHUB_REPOSITORY_INVALID','repair_configuration');return value.toLowerCase();}
function escapeRegExp(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
/** Bots, apps, CI and this connection's own account never become task input. */
export function githubAutomatedAuthor(configuration,comment){
 const login=String(comment?.user?.login??'').toLowerCase();
 return !login||comment.user.type!=='User'||login.endsWith('[bot]')||login===String(configuration.botLogin).toLowerCase()||comment.performed_via_github_app!=null;
}
/** Only a direct @mention outside quotes and code addresses the bot. */
export function githubMentions(body,botLogin){
 const visible=String(body).replace(/```[\s\S]*?(?:```|$)/g,'').replace(/`[^`\n]*`/g,'').split('\n').filter(line=>!/^\s*>/.test(line)).join('\n');
 return new RegExp('(^|[^A-Za-z0-9_/`-])@'+escapeRegExp(botLogin)+'(?![A-Za-z0-9_-])','i').test(visible);
}
export function githubEvent(configuration,repository,comment){
 repository=githubRepository(repository);const botLogin=githubLogin(configuration.botLogin);
 if(!comment||typeof comment.body!=='string'||githubAutomatedAuthor(configuration,comment))return null;
 if(!Number.isSafeInteger(comment.id)||!Number.isSafeInteger(comment.user.id))return null;
 const body=comment.body.slice(0,32000);
 if(!githubMentions(body,botLogin))return null;
 const issue=/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]{0,9})$/.exec(String(comment.issue_url??''));
 requireValue(issue&&issue[1].toLowerCase()===repository,'GITHUB_COMMENT_SOURCE_MISMATCH');
 const number=issue[2],login=String(comment.user.login);
 let text=body.replace(new RegExp('(^|[^A-Za-z0-9_/`-])@'+escapeRegExp(botLogin)+'(?![A-Za-z0-9_-])','gi'),'$1').trim();
 // Commands stay first so /stop, /status and /new keep their channel meaning.
 if(!text.startsWith('/'))text='[GitHub '+repository+'#'+number+' @'+login+']\n'+text;
 const event=base('github',configuration,{tenantId:'github.com',eventId:String(comment.id),senderId:String(comment.user.id),conversationId:repository,chatKind:'group',text,attachments:[],occurredAtMs:Date.parse(comment.created_at)});
 // The issue or pull request is the topic: follow-ups there continue one task.
 event.topicId=number;event.sourceMessageId=String(comment.id);
 return finish(event);
}
