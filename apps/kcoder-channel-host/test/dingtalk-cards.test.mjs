import test from 'node:test';
import assert from 'node:assert/strict';
import { DingTalkAdapter } from '../src/adapters/sdk.mjs';
import { EphemeralSecretStore } from '../src/transport.mjs';

const scope={accountId:'owned-account',targetId:'owned-target',workspaceId:'owned-workspace',identityGeneration:'native-epoch',targetRevision:'native-config'};
const event={platform:'dingtalk',tenantId:'owned-corp',botId:'owned-bot',channelId:'channel',channelInstanceId:'owned-sdk',eventId:'owned-event',senderId:'owned-subject',conversationId:'owned-chat',chatKind:'private',kind:'message',text:'Summarize this fixture.',attachments:[]};
const payload={destination:{channelId:'channel',conversationId:'owned-chat',chatKind:'private',externalSubjectId:'owned-subject'},content:{text:'The native task is running.',presentation:{kind:'status',title:'Task progress'}}};
function adapterFixture({template=true,failCreate=false,failUpdate=false,reject=false,secretStore}={}){
 const calls=[],configuration={clientId:'owned-bot',...(template?{taskCardTemplateId:'owned-application-template.schema'}:{})};
 const adapter=new DingTalkAdapter({configuration,credentials:{clientSecret:'INERT_NO_PLATFORM_ACCOUNT'},secretStore,transport:async(url,options)=>{
  calls.push({url,options});if(url.includes('/accessToken'))return {accessToken:'INERT_NO_PLATFORM_ACCOUNT',expireIn:3600};
  if(failCreate&&url.endsWith('/createAndDeliver'))throw new Error('owned lost create acknowledgement');
  if(failUpdate&&options.method==='PUT')throw new Error('owned lost update acknowledgement');
  if(url.endsWith('/createAndDeliver'))return reject?{success:false}:{success:true,result:{outTrackId:options.body.outTrackId,deliverResults:[{success:true}]}};
  if(options.method==='PUT')return {success:true,result:true};
  return url.includes('oapi.dingtalk.com')?{errcode:0}:{processQueryKey:'owned-text-receipt'};
 }});return {adapter,calls};
}
test('DingTalk uses the owned template and official group/private createAndDeliver bodies with stable native identities',async()=>{
 const f=adapterFixture();
 const privateResult=await f.adapter.send(payload,{deliveryId:'owned-private'});
 await f.adapter.send({...payload,destination:{...payload.destination,chatKind:'group'}},{deliveryId:'owned-group'});
 const messages=f.calls.filter(value=>value.url.endsWith('/createAndDeliver'));assert.equal(messages.length,2);
 const [direct,group]=messages.map(value=>value.options.body);
 assert.equal(direct.cardTemplateId,'owned-application-template.schema');assert.equal(direct.openSpaceId,'dtv1.card//IM_ROBOT.owned-subject');
 assert.equal(direct.imRobotOpenDeliverModel.robotCode,'owned-bot');assert.equal(direct.imRobotOpenSpaceModel.supportForward,false);
 assert.equal(group.openSpaceId,'dtv1.card//IM_GROUP.owned-chat');assert.equal(group.imGroupOpenSpaceModel.supportForward,false);assert.equal(group.imRobotOpenDeliverModel,undefined);
 assert.equal(privateResult.outTrackId,direct.outTrackId);assert.equal(privateResult.messageType,'dingtalk_card');
 assert.notEqual(direct.outTrackId,group.outTrackId);assert.equal(direct.cardData.cardParamMap.content,payload.content.text);
});
test('DingTalk updates only the original receipt and never creates a replacement on lost update or changed template',async()=>{
 const f=adapterFixture({failUpdate:true}),original=await f.adapter.send(payload,{deliveryId:'owned-original'});
 const update={...payload,cardUpdateReceipt:{outTrackId:original.outTrackId,cardTemplateId:original.cardTemplateId}};
 await assert.rejects(f.adapter.send(update,{deliveryId:'owned-update'}),/lost update/);
 const writes=f.calls.filter(value=>!value.url.includes('/accessToken'));assert.deepEqual(writes.map(value=>value.options.method),['POST','PUT']);assert.equal(writes[1].options.body.outTrackId,original.outTrackId);assert.equal(writes[1].options.body.cardTemplateId,undefined);
 f.adapter.configuration.taskCardTemplateId='different-owned-template.schema';
 await assert.rejects(f.adapter.send(update,{deliveryId:'owned-update'}),error=>error.code==='CARD_UPDATE_TEMPLATE_CHANGED'&&error.externalOutcome==='failed');
 assert.equal(f.calls.filter(value=>!value.url.includes('/accessToken')).length,2);
});
test('DingTalk card rejection never falls back to another send and Question keeps the exact native revision',async()=>{
 const f=adapterFixture({reject:true});
 const result=await f.adapter.send({...payload,content:{text:'Which source?',presentation:{kind:'question',title:'Information needed',questionRef:{id:'owned-question',revision:'17'}}}},{deliveryId:'owned-question'});
 assert.equal(result.state,'failed');const writes=f.calls.filter(value=>!value.url.includes('/accessToken'));assert.equal(writes.length,1);
 assert.deepEqual(writes[0].options.body.cardData.cardParamMap,{title:'Information needed',content:'Which source?',status:'question',questionId:'owned-question',questionRevision:'17'});
 assert.ok(!JSON.stringify(writes[0].options.body).includes('approve'),'Question never sends native Approval buttons');
});
test('expired, missing, unconfirmed and unsafe private replies fail before any network call even with a card template',async()=>{
 for(const [value,expected]of [[{url:'https://oapi.dingtalk.com/owned-inert',expiresAt:Date.now()-1},'REPLY_WINDOW_EXPIRED'],[{url:'https://oapi.dingtalk.com/owned-inert'},'REPLY_WINDOW_UNCONFIRMED'],[{url:'https://untrusted.example.test/owned-inert',expiresAt:Date.now()+10000},'UNAPPROVED_HOST'],[null,'PLATFORM_CONTEXT_EXPIRED']]){
  const secrets=new EphemeralSecretStore();if(value)await secrets.put('owned-private-ref',value);
  const f=adapterFixture({secretStore:secrets});await assert.rejects(f.adapter.send({...payload,destination:{...payload.destination,replyRef:'owned-private-ref'}},{deliveryId:'owned-window'}),error=>error.code===expected&&error.externalOutcome==='failed');
  assert.equal(f.calls.length,0);
 }
});
test('DingTalk without a configured task template preserves the original session webhook text path',async()=>{
 const secrets=new EphemeralSecretStore();await secrets.put('owned-private-ref',{url:'https://oapi.dingtalk.com/owned-inert',expiresAt:Date.now()+10000});
 const f=adapterFixture({template:false,secretStore:secrets});const result=await f.adapter.send({...payload,destination:{...payload.destination,replyRef:'owned-private-ref'}},{deliveryId:'owned-text'});
 assert.equal(result.receiptKind,'session_webhook');assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.body.msgtype,'text');
});
