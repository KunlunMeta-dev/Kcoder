import test from 'node:test';
import assert from 'node:assert/strict';
import { WeixinAdapter } from '../src/adapters/weixin.mjs';

test('unsupported Weixin group frame cannot write context, accept ingress or advance a cursor',async()=>{
 let puts=0,accepted=0,saves=0;const adapter=new WeixinAdapter({configuration:{accountId:'original-bot',channelId:'channel'},credentials:{},secretStore:{async put(){puts++;}},checkpoint:{async save(){saves++;}}});adapter.cursor='original-cursor';
 await assert.rejects(adapter.consume({msgs:[{message_id:'group-event',from_user_id:'sender',group_id:'unsupported-group',context_token:'SYNTHETIC_PRIVATE_CONTEXT',item_list:[{type:1,text_item:{text:'group message'}}]}],get_updates_buf:'unaccepted-cursor'},async()=>{accepted++;}),/WEIXIN_GROUP_UNSUPPORTED/);
 assert.deepEqual({puts,accepted,saves},{puts:0,accepted:0,saves:0});assert.equal(adapter.cursor,'original-cursor');
});
