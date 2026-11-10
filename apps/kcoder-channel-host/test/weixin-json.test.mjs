import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWeixinJson} from '../src/weixin-json.mjs';
import {WeixinAdapter} from '../src/adapters/weixin.mjs';
import {weixinEventMetadata} from '../src/normalizers.mjs';
import {platformJson} from '../src/transport.mjs';

test('Weixin uint64 message identities stay distinct through the bounded HTTP parser and event normalization',async()=>{
 const raw='{"ret":0,"msgs":[{"message_id":9007199254740992,"from_user_id":"owned-sender","item_list":[]},{"message_id":9007199254740993,"from_user_id":"owned-sender","item_list":[]}]}';
 const configuration={accountId:'owned-bot',channelId:'owned-channel'};
 const adapter=new WeixinAdapter({configuration,credentials:{botToken:'SYNTHETIC_TOKEN'},transport:(url,options)=>platformJson(url,{...options,fetchImpl:async()=>new Response(raw)})});
 const result=await adapter.post('ilink/bot/getupdates',{},AbortSignal.timeout(1000));
 const events=await Promise.all(result.msgs.map(msg=>weixinEventMetadata(configuration,msg)));
 assert.deepEqual(events.map(event=>event.eventId),['9007199254740992','9007199254740993']);
});
test('Weixin lossless decoding leaves text and unrelated numeric fields unchanged',()=>{
 const text='inside text: "message_id":9007199254740993';
 const raw=JSON.stringify({text,count:123,nested:{svr_id:'existing-string'},message_id:1});
 assert.deepEqual(parseWeixinJson(raw),{text,count:123,nested:{svr_id:'existing-string'},message_id:'1'});
 assert.equal(parseWeixinJson('{"message_\\u0069d":18446744073709551615}').message_id,'18446744073709551615');
});
test('lossless decoding never repairs malformed JSON or converts fractional identifiers',()=>{
 for(const raw of ['{"message_id":01}','{"message_id":-}','{"message_id":12oops}'])assert.throws(()=>parseWeixinJson(raw));
 assert.equal(parseWeixinJson('{"message_id":1.5}').message_id,1.5);
 assert.equal(parseWeixinJson('{"message_id":1e3}').message_id,1000);
});
