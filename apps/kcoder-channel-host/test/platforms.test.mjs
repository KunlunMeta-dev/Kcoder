import test from 'node:test';
import assert from 'node:assert/strict';
import { feishuEvent,dingtalkEvent,qqEvent,wecomEvent,weixinEvent } from '../src/normalizers.mjs';
import { EphemeralSecretStore,boundedJson,platformJson } from '../src/transport.mjs';
import { FeishuAdapter,DingTalkAdapter,QQAdapter,WeixinAdapter } from '../src/adapters/index.mjs';
import { WeixinQrAuthorization } from '../src/adapters/weixin.mjs';
const config={channelId:'channel',tenantId:'tenant',appId:'app',clientId:'client',botId:'bot',accountId:'wechat'};
test('Feishu normalizes a user event and excludes app generated messages',()=>{
 const p={event_id:'event',tenant_key:'tenant',sender:{sender_type:'user',sender_id:{open_id:'alice'}},message:{message_id:'message',chat_id:'chat',chat_type:'p2p',message_type:'text',content:'{"text":"hello"}',create_time:'1'}};
 assert.equal(feishuEvent(config,p).senderId,'alice');
 assert.equal(feishuEvent(config,{...p,sender:{sender_type:'app'}}),null);
});
test('DingTalk removes temporary session webhook from persisted event',async()=>{
 const secrets=new EphemeralSecretStore();
 const e=await dingtalkEvent(config,{headers:{messageId:'e'},data:JSON.stringify({msgId:'e',senderStaffId:'alice',conversationId:'chat',conversationType:'1',text:{content:'hello'},sessionWebhook:'https://oapi.dingtalk.com/robot/sendBySession?test=only',sessionWebhookExpiredTime:Date.now()+10000})},secrets);
 assert.equal(e.text,'hello');assert.ok(e.replyRef);assert.ok(!JSON.stringify(e).includes('sendBySession'));
 assert.ok((await secrets.get(e.replyRef)).url.includes('sendBySession'));
});
test('QQ accepts known message events and ignores non turn receipt',()=>{
 assert.equal(qqEvent(config,{t:'MESSAGE_AUDIT_PASS',d:{}}),null);
 const e=qqEvent(config,{t:'GROUP_AT_MESSAGE_CREATE',d:{id:'e',author:{member_openid:'alice'},group_openid:'g',content:'/status'}});
 assert.equal(e.kind,'control');assert.equal(e.chatKind,'group');
});
test('WeCom media keys remain in private context rather than public event',async()=>{
 const secrets=new EphemeralSecretStore();
 const e=await wecomEvent(config,{headers:{req_id:'e'},body:{msgid:'e',from:{userid:'alice'},chatid:'chat',chattype:'group',file:{url:'https://test.example.invalid/file',aeskey:'synthetic-only',filename:'a.txt'}}},secrets);
 assert.equal(e.attachments.length,1);assert.ok(!JSON.stringify(e).includes('synthetic-only'));
});
test('Weixin binds context to sender and ignores bot echo',async()=>{
 const secrets=new EphemeralSecretStore();
 const e=await weixinEvent(config,{message_id:'e',from_user_id:'alice',context_token:'synthetic-only',item_list:[{type:1,text_item:{text:'hello'}}]},secrets);
 assert.equal(e.chatKind,'private');assert.equal(e.conversationId,'alice');assert.ok(!JSON.stringify(e).includes('synthetic-only'));
 assert.equal(await weixinEvent(config,{message_type:2,from_user_id:'bot'},secrets),null);
});
test('quoted command text is not parsed as a control request',()=>{
 const e=qqEvent(config,{t:'C2C_MESSAGE_CREATE',d:{id:'e',author:{user_openid:'alice'},content:'> /stop'}});
 assert.equal(e.kind,'message');
});
test('expired secret contexts are not silently reused',async()=>{
 let now=1;const vault=new EphemeralSecretStore({now:()=>now});
 await vault.put('key',{contextToken:'synthetic'},10);now=20;
 await assert.rejects(vault.get('key'),/PLATFORM_CONTEXT_EXPIRED/);
});
test('bounded platform JSON rejects oversize stream and invalid JSON',async()=>{
 await assert.rejects(boundedJson(new Response('x'.repeat(200)),100),/PLATFORM_RESPONSE_TOO_LARGE/);
 await assert.rejects(boundedJson(new Response('not json')),/PLATFORM_INVALID_JSON/);
});
test('platform transport denies unauthorized hosts before fetch',async()=>{
 let called=false;
 await assert.rejects(platformJson('https://169.254.169.254/path',{hosts:['api.dingtalk.com'],fetchImpl:async()=>{called=true;}}),/UNAPPROVED_HOST/);
 assert.equal(called,false);
});
test('Feishu sends a deterministic uuid and requires platform receipt',async()=>{
 const calls=[];const adapter=new FeishuAdapter({configuration:config,credentials:{appSecret:'synthetic'},transport:async(url,args)=>{calls.push({url,args});return url.includes('/auth/')?{code:0,tenant_access_token:'synthetic-token',expire:3600}:{code:0,data:{message_id:'message'}};}});
 const result=await adapter.send({destination:{conversationId:'chat'},content:{text:'result'}},{deliveryId:'delivery',signal:AbortSignal.timeout(1000)});
 assert.equal(result.messageId,'message');assert.equal(calls[1].args.body.uuid.length,32);
});
test('DingTalk Stream callback acknowledges only after durable ingestion',async()=>{
 let handler,acked=false,release;const gate=new Promise(r=>release=r);
 class Client{sslopts={rejectUnauthorized:true};config={subscriptions:[]};registered=true;socket={readyState:1,on(){},terminate(){}};getConfig(){return this.config;}async getEndpoint(){}async _connect(){}onSystem(){}registerCallbackListener(_topic,fn){handler=fn;}async connect(){this.connected=true;}socketCallBackResponse(){acked=true;}disconnect(){}}
 const adapter=new DingTalkAdapter({configuration:config,credentials:{clientSecret:'synthetic'},sdk:{DWClient:Client,TOPIC_ROBOT:'topic'}});
 await adapter.start(async()=>gate);
 handler({headers:{messageId:'e'},data:JSON.stringify({msgId:'e',senderStaffId:'alice',conversationId:'chat',conversationType:'1',text:{content:'hello'}})});
 await new Promise(r=>setImmediate(r));assert.equal(acked,false);release();await new Promise(r=>setImmediate(r));assert.equal(acked,true);await adapter.stop();
});
test('DingTalk sends outgoing messages via REST rather than Stream socket',async()=>{
 const urls=[];const adapter=new DingTalkAdapter({configuration:config,credentials:{clientSecret:'synthetic'},transport:async(url)=>{urls.push(url);return url.includes('accessToken')?{accessToken:'synthetic',expireIn:3600}:{processQueryKey:'receipt'};}});
 assert.equal((await adapter.send({destination:{conversationId:'private-conversation',externalSubjectId:'alice',chatKind:'private'},content:{text:'hello'}},{signal:AbortSignal.timeout(1000)})).state,'accepted');
 assert.ok(urls[1].includes('batchSend'));
});
test('QQ SDK can send an explicit proactive message without an old reply context',async()=>{
 const requests=[];
 const adapter=new QQAdapter({configuration:config,credentials:{appSecret:'fixture'},transport:async(url,args)=>{
  requests.push({url,args});return url.includes('getAppAccessToken')?{access_token:'fixture',expires_in:3600}:{id:'accepted'};
 }});
 const sent=await adapter.send({destination:{conversationId:'user',chatKind:'private'},content:{text:'hello'}},{});
 assert.equal(sent.messageId,'accepted');const request=requests.at(-1);
 assert.ok(request.url.endsWith('/v2/users/user/messages'));assert.equal(request.args.body.msg_id,undefined);assert.equal(request.args.body.msg_seq,undefined);
});
test('QQ Access Token auth is used instead of deprecated bot token',async()=>{
 const calls=[];const adapter=new QQAdapter({configuration:config,credentials:{appSecret:'synthetic'},transport:async(url,args)=>{calls.push(args);return url.includes('getAppAccessToken')?{access_token:'synthetic-access',expires_in:3600}:{id:'platform-message'};}});
 const sent=await adapter.send({destination:{conversationId:'chat',chatKind:'private',replyMessageId:'incoming',replySequence:1,replyExpiresAt:Date.now()+60000},content:{text:'hi'}},{signal:AbortSignal.timeout(1000)});
 assert.equal(sent.state,'accepted');assert.equal(calls[1].headers.Authorization,'QQBot synthetic-access');
});
test('Weixin uses its SDK client metadata and needs no secondary product grant',()=>{
 const adapter=new WeixinAdapter({configuration:config,credentials:{botToken:'synthetic'}});
 assert.equal(adapter.headers()['iLink-App-Id'],'bot');
 assert.equal(adapter.headers().Authorization,'Bearer synthetic');
 assert.throws(()=>new WeixinAdapter({configuration:config,credentials:{}}).headers(),/AUTHORIZATION_REQUIRED/);
});
test('cancelled Weixin QR cannot publish late authorization',async()=>{
 let resolve;const adapter=new WeixinQrAuthorization({product:{appId:'authorized-test-app',botType:'authorized-test-product',clientVersion:'1'},transport:async(url)=>url.includes('get_bot_qrcode')?{qrcode:'synthetic-qr',qrcode_img_content:'https://example.invalid/qr'}:await new Promise(r=>resolve=r)});
 await adapter.create();const pending=adapter.poll();adapter.cancel();resolve({status:'confirmed',bot_token:'synthetic-only'});
 await assert.rejects(pending,/WEIXIN_QR_CANCELLED/);
});
