import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuAdapter,WeComAdapter } from '../src/adapters/sdk.mjs';

const scope={accountId:'owned-account',targetId:'owned-target',workspaceId:'owned-workspace',identityGeneration:'native-epoch',targetRevision:'native-config'};
const event={platform:'feishu',tenantId:'tenant',botId:'owned-bot',channelId:'channel',eventId:'owned-event',senderId:'owned-subject',conversationId:'owned-chat',chatKind:'private',kind:'message',text:'Summarize the owned fixture.',attachments:[]};
function adapterFixture({failCreate=false,failUpdate=false}={}){
 const calls=[];const adapter=new FeishuAdapter({configuration:{appId:'owned-inert-app'},credentials:{appSecret:'owned-inert-secret'},transport:async(url,options)=>{
  calls.push({url,options});if(url.includes('/auth/'))return {code:0,tenant_access_token:'SYNTHETIC_INERT',expire:3600};
  if(failCreate&&options.method==='POST')throw new Error('owned lost create acknowledgement');
  if(failUpdate&&options.method==='PATCH')throw new Error('owned lost update acknowledgement');
  return options.method==='PATCH'?{code:0}:{code:0,data:{message_id:'owned-native-message'}};
 }});return {adapter,calls};
}
test('Feishu uses actual interactive create and exact-message PATCH with no second create on lost update',async()=>{
 const f=adapterFixture({failUpdate:true});const payload={destination:{conversationId:'owned-chat'},content:{text:'Question body',presentation:{kind:'question',title:'Information needed',questionRef:{id:'owned-question',revision:'4'}}}};
 const result=await f.adapter.send(payload,{deliveryId:'owned-delivery'});assert.equal(result.messageType,'interactive');
 const created=f.calls.find(value=>value.url.includes('/im/v1/messages'));assert.equal(created.options.body.msg_type,'interactive');
 const card=JSON.parse(created.options.body.content);assert.equal(card.header.title.content,'Information needed');assert.match(JSON.stringify(card),/owned-question/);assert.match(JSON.stringify(card),/4/);
 assert.ok(!card.elements.some(value=>value.tag==='action'),'Question cards never approve native Approval');
 await assert.rejects(f.adapter.send({...payload,cardUpdateMessageId:result.messageId},{deliveryId:'owned-update'}),/lost update/);
 const messages=f.calls.filter(value=>value.url.includes('/im/v1/messages'));assert.equal(messages.length,2);assert.equal(messages[1].options.method,'PATCH');assert.match(messages[1].url,/\/owned-native-message$/);assert.deepEqual(Object.keys(messages[1].options.body),['content']);
});
test('WeCom sends real template_card for short native task status and preserves long content with Markdown',async()=>{
 const sent=[],adapter=new WeComAdapter({configuration:{botId:'owned-inert'},credentials:{secret:'owned-inert'}});adapter.client={sendMessage:async(chat,body)=>{sent.push({chat,body});return {headers:{req_id:'owned-ack'}};}};adapter.withSignal=async(_signal,fn)=>fn();
 let result=await adapter.send({destination:{conversationId:'owned-chat'},content:{text:'The task is running.',presentation:{kind:'status',title:'Task progress'}}},{deliveryId:'owned-status'});
 assert.equal(result.messageType,'template_card');assert.equal(sent[0].body.template_card.card_type,'text_notice');assert.equal(sent[0].body.template_card.sub_title_text,'The task is running.');
 const text='Long owned question '.repeat(20);result=await adapter.send({destination:{conversationId:'owned-chat'},content:{text,presentation:{kind:'question',title:'Information needed',questionRef:{id:'question',revision:'1'}}}},{deliveryId:'owned-question'});
 assert.equal(result.messageType,'markdown');assert.equal(sent[1].body.markdown.content,text);
});
test('Feishu callback acknowledges only the original durable ingress within the bounded callback window',async()=>{
 const f=adapterFixture();f.adapter.configuration={appId:'owned-bot',channelId:'channel',locale:'en'};
 const packet={header:{event_id:'callback-event',tenant_key:'tenant'},event:{operator:{open_id:'owned-subject'},context:{open_chat_id:'owned-chat'},action:{value:{kcoderQuestionAction:'owned-question-action'},form_value:{answer:'Owned answer'}}}};
 let seen;const response=await f.adapter.handleCardAction(packet,async event=>{seen=event;return {durablyAccepted:true};});assert.equal(seen.cardActionRef,'owned-question-action');assert.equal(seen.text,'Owned answer');assert.match(response.toast.content,/native task receipt/);
 await assert.rejects(f.adapter.handleCardAction(packet,async()=>({durablyAccepted:false})),/CARD_ACCEPTANCE_UNCONFIRMED/);
 await assert.rejects(f.adapter.handleCardAction(packet,async()=>{throw new Error('owned durable transaction failed');}),/durable transaction failed/);
 assert.equal(f.calls.length,0,'callback ACK performs no model or outgoing-message call');
});
test('Feishu callback timeout remains unconfirmed while an original late ingress can still finish',async()=>{
 const f=adapterFixture();f.adapter.configuration={appId:'owned-bot',channelId:'channel'};let finish;
 const packet={header:{event_id:'late-callback-event',tenant_key:'tenant'},event:{operator:{open_id:'owned-subject'},context:{open_chat_id:'owned-chat'},action:{value:{kcoderQuestionAction:'owned-question-action'},form_value:{answer:'Owned answer'}}}};
 await assert.rejects(f.adapter.handleCardAction(packet,()=>new Promise(resolve=>{finish=resolve;})),/CARD_ACCEPTANCE_UNCONFIRMED/);
 finish({durablyAccepted:true});assert.equal(f.calls.length,0);
});
