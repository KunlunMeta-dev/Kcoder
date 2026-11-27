import test from 'node:test';
import assert from 'node:assert/strict';
import {feishuEvent} from '../src/normalizers.mjs';
const scope={accountId:'owned',targetId:'target',workspaceId:'workspace',identityGeneration:'1',targetRevision:'1'};

test('the installed Feishu receive schema keeps its original reply message reference',()=>{
 const packet={header:{event_id:'actual-event',tenant_key:'tenant'},event:{sender:{sender_type:'user',sender_id:{open_id:'member'}},message:{message_id:'message',parent_id:'original-message',root_id:'different-root',create_time:'140',chat_id:'private',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'Answer'})}}};
 const normalized=feishuEvent({channelId:'connection',appId:'bot'},packet);
 assert.equal(normalized.replyToMessageId,'original-message');
 delete packet.event.message.parent_id;assert.equal(feishuEvent({channelId:'connection',appId:'bot'},packet).replyToMessageId,'different-root');
});
