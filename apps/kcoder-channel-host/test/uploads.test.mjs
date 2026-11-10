import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,createDecipheriv } from 'node:crypto';
import { FeishuAdapter,DingTalkAdapter,WeComAdapter,WeixinAdapter,QQAdapter } from '../src/adapters/index.mjs';
import { hardenWecomSdk } from '../src/adapters/sdk-guards.mjs';
import { platformMultipart } from '../src/upload-transport.mjs';
import { EphemeralSecretStore,silentSdkLogger } from '../src/transport.mjs';
const bytes=Buffer.from('verified upload body');
const file={filename:'report.pdf',mediaType:'application/pdf',expectedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),byteStream:()=> (async function*(){yield bytes.subarray(0,5);yield bytes.subarray(5);})()};
test('multipart uploads stream complete bytes with exact length and no arbitrary destination',async()=>{
 let received=0;await platformMultipart('https://open.feishu.cn/upload',{file,fields:{file_type:'stream'},hosts:['open.feishu.cn'],fetchImpl:async(_url,args)=>{const parts=[];for await(const part of args.body){received+=part.length;parts.push(part);}assert.equal(received,Number(args.headers['Content-Length']));assert.ok(Buffer.concat(parts).includes(bytes));return new Response('{"code":0}');}});
 let fetched=false;await assert.rejects(platformMultipart('https://evil.example.invalid/upload',{file,hosts:['open.feishu.cn'],fetchImpl:async()=>{fetched=true;}}),/UNAPPROVED_HOST/);assert.equal(fetched,false);
});
test('Feishu upload and file message are distinct requests with real returned file key',async()=>{
 const calls=[];const adapter=new FeishuAdapter({configuration:{appId:'inert-app'},credentials:{appSecret:'inert-secret'},multipartTransport:async(url,args)=>{calls.push({url,args});return {code:0,data:{file_key:'real-shaped-file-key'}};},transport:async(url,args)=>{calls.push({url,args});return url.includes('/auth/')?{code:0,tenant_access_token:'inert',expire:3600}:{code:0,data:{message_id:'platform-message'}};}});
 const uploaded=await adapter.upload(file,{});assert.equal(uploaded.mediaId,'real-shaped-file-key');const sent=await adapter.sendFile({destination:{conversationId:'conversation'}},uploaded,{deliveryId:'stable-part'});assert.equal(sent.messageId,'platform-message');
 assert.equal(calls.filter(value=>value.url.includes('/messages')).length,1);assert.equal(JSON.parse(calls.at(-1).args.body.content).file_key,uploaded.mediaId);
});
test('DingTalk file REST targets the original member rather than its conversation identifier',async()=>{
 const calls=[];const adapter=new DingTalkAdapter({configuration:{clientId:'inert'},credentials:{clientSecret:'inert'},multipartTransport:async()=>({errcode:0,media_id:'uploaded-media'}),transport:async(url,args)=>{calls.push({url,args});return url.includes('/gettoken')?{errcode:0,access_token:'inert'}:url.includes('/accessToken')?{accessToken:'inert'}:{processQueryKey:'original-process'};}});
 const handle=await adapter.upload(file,{});const receipt=await adapter.sendFile({destination:{chatKind:'private',conversationId:'cid-not-user',externalSubjectId:'actual-member'}},handle,{});
 assert.equal(receipt.processQueryKey,'original-process');assert.equal(receipt.messageId,undefined);assert.deepEqual(calls.at(-1).args.body.userIds,['actual-member']);assert.equal(calls.at(-1).args.body.msgKey,'sampleFile');
});
test('WeCom actual SDK upload uses Buffer only after reservation and keeps upload/send acknowledgements separate',async()=>{
 const sdk=await import('@wecom/aibot-node-sdk');const client=new sdk.WSClient({botId:'inert',secret:'inert',logger:silentSdkLogger});const frames=[];
 client.wsManager.sendReply=async(reqId,body,cmd)=>{frames.push({reqId,body,cmd});return {headers:{req_id:reqId},errcode:0,body:cmd==='aibot_upload_media_init'?{upload_id:'upload'}:cmd==='aibot_upload_media_finish'?{media_id:'uploaded-media'}:{}};};
 const adapter=new WeComAdapter({configuration:{botId:'inert'},credentials:{secret:'inert'}});adapter.client=client;adapter.withSignal=hardenWecomSdk(client);
 const handle=await adapter.upload(file,{});assert.equal(handle.mediaId,'uploaded-media');assert.equal(frames.some(value=>value.cmd==='aibot_send_msg'),false);
 const receipt=await adapter.sendFile({destination:{conversationId:'conversation'}},handle,{});assert.equal(receipt.state,'accepted');assert.equal(receipt.receiptKind,'wecom_ack');assert.equal(receipt.messageId,undefined);assert.ok(receipt.requestId);client.disconnect();
});
test('WeCom locked SDK chunk retry after lost ACK cannot submit the native chunk a second time',async()=>{
 const sdk=await import('@wecom/aibot-node-sdk');const client=new sdk.WSClient({botId:'inert',secret:'inert',logger:silentSdkLogger});const frames=[];
 client.wsManager.sendReply=async(reqId,body,cmd)=>{frames.push({reqId,body,cmd});if(cmd==='aibot_upload_media_init')return {headers:{req_id:reqId},errcode:0,body:{upload_id:'owned-unknown-upload'}};if(cmd==='aibot_upload_media_chunk')throw new Error('owned lost chunk acknowledgement');throw new Error('must not finish an unconfirmed upload');};
 const adapter=new WeComAdapter({configuration:{botId:'inert'},credentials:{secret:'inert'}});adapter.client=client;adapter.withSignal=hardenWecomSdk(client);
 await assert.rejects(adapter.upload(file,{}),/lost chunk acknowledgement/);
 assert.equal(frames.filter(value=>value.cmd==='aibot_upload_media_init').length,1);
 assert.equal(frames.filter(value=>value.cmd==='aibot_upload_media_chunk').length,1);
 assert.equal(frames.filter(value=>value.cmd==='aibot_upload_media_finish').length,0);client.disconnect();
});
test('Weixin upload streams valid AES ciphertext and stores the key only in the private context',async()=>{
 let metadata,ciphertext;const secrets=new EphemeralSecretStore();await secrets.put('reply',{toUserId:'recipient',contextToken:'inert-context'});
 const adapter=new WeixinAdapter({configuration:{accountId:'account'},credentials:{botToken:'inert'},secretStore:secrets,transport:async(url,args)=>{if(url.includes('getuploadurl')){metadata=args.body;return {ret:0,upload_param:'inert-upload'};}return {ret:0};},binaryUploader:async(_url,args)=>{const parts=[];for await(const part of args.byteStream)parts.push(part);ciphertext=Buffer.concat(parts);assert.equal(ciphertext.length,args.expectedBytes);return {encryptedParam:'inert-download'};}});
 const destination={replyRef:'reply',conversationId:'recipient'},context=await adapter.prepareUpload(file,{destination});
 const handle=await adapter.upload(file,{deliveryId:'part',uploadContext:context});assert.deepEqual(Object.keys(handle),['handleRef']);
 const cipher=createDecipheriv('aes-128-ecb',Buffer.from(metadata.aeskey,'hex'),null);assert.deepEqual(Buffer.concat([cipher.update(ciphertext),cipher.final()]),bytes);
 const receipt=await adapter.sendFile({destination},handle,{deliveryId:'part'});assert.equal(receipt.clientRequestId,'part');assert.equal(receipt.messageId,undefined);
});
test('QQ refuses unsupported ordinary files and never invents a base64 upload path',async()=>{
 const adapter=new QQAdapter({configuration:{appId:'inert'},credentials:{appSecret:'inert'},transport:async()=>{throw new Error('must not send');}});
 await assert.rejects(adapter.prepareUpload(file,{artifactRef:{kind:'artifact',id:'artifact',revision:'1'},destination:{conversationId:'owned-user',replyMessageId:'incoming',replySequence:1,replyExpiresAt:Date.now()+60000,chatKind:'private'}}),/QQ_FILE_TYPE_UNAVAILABLE/);
});
