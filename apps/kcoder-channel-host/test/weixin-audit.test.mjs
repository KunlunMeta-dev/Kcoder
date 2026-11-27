import test from 'node:test';
import assert from 'node:assert/strict';
import { WeixinAdapter, WeixinQrAuthorization } from '../src/adapters/weixin.mjs';
import { channelContextTtl } from '../src/adapters/contract.mjs';
import { normalizeWeixinQrImage } from '../src/adapters/weixin-qr-image.mjs';
import { EphemeralSecretStore,platformJson } from '../src/transport.mjs';
import { createWeixinSdk } from '../src/adapters/weixin-sdk.mjs';
import QRCode from 'qrcode';
import { createHash } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelStore } from '../src/channels/store.mjs';
import definitions from '../src/channel-platforms.json' with { type:'json' };
import { stableId } from '../src/validation.mjs';

const configuration={accountId:'fixture',channelId:'fixture-channel'};
const credentials={botToken:'fixture-only'};
const untilAbort=signal=>new Promise((_resolve,reject)=>{
  if(signal.aborted)reject(signal.reason);
  else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
});

test('Weixin start cancellation closes its owned background long poll', {timeout:1000},async t=>{
  const controller=new AbortController();let polls=0,ingested=0,writes=0;
  const adapter=new WeixinAdapter({configuration,credentials,checkpoint:{save:async()=>{writes++;}},transport:async(url,{signal})=>{
    if(!url.endsWith('/getupdates'))return {ret:0};
    if(++polls===1)return {ret:0};
    return untilAbort(signal);
  }});
  t.after(()=>adapter.stop());
  await adapter.start(async()=>{ingested++;},{signal:controller.signal});
  controller.abort();await adapter.loop;
  assert.equal(adapter.connectionState(),'stopped');assert.equal(polls,2);
  assert.equal(ingested,0);assert.equal(writes,0);
});

test('only nonblank own Weixin reply tokens receive the documented open lifetime',()=>{
  assert.equal(channelContextTtl('weixin',{contextToken:'private-context',toUserId:'fixture-user'},123),undefined);
  for(const value of [{contextToken:'',toUserId:''},{contextToken:' ',toUserId:'fixture-user'},
    {contextToken:'context',toUserId:'\t'},Object.create({contextToken:'context',toUserId:'user'})]){
    assert.equal(channelContextTtl('weixin',value,123),123);
  }
});

test('Weixin malformed batch shapes fail closed before accepting or checkpointing',async()=>{
  for(const msgs of ['not-an-array',{},1,null]){
    let saves=0;const adapter=new WeixinAdapter({configuration,credentials,checkpoint:{save:async()=>{saves++;}}});
    await assert.rejects(adapter.consume({msgs,get_updates_buf:'must-not-commit'},async()=>assert.fail('no ingestion')),{code:'PLATFORM_INVALID_JSON'});
    assert.equal(saves,0);assert.equal(adapter.cursor,'');
  }
});

test('Weixin startup failures identify authorization and durable ingress stages',async()=>{
  const missing=new WeixinAdapter({configuration,credentials:{}});
  await assert.rejects(missing.start(async()=>{}),{code:'AUTHORIZATION_REQUIRED'});
  assert.equal(missing.connectionState(),'authorization_required');assert.equal(missing.connectionFailureReason(),'PLATFORM_AUTHORIZATION_FAILED');
  const adapter=new WeixinAdapter({configuration,credentials,transport:async url=>url.endsWith('/getupdates')?
    {msgs:[{message_id:'1',from_user_id:'user',item_list:[{type:1,text_item:{text:'hello'}}]}]}:{ret:0}});
  await assert.rejects(adapter.start(async()=>{throw new Error('fixture inbox unavailable');}));
  assert.equal(adapter.connectionFailureReason(),'WEIXIN_INGRESS_FAILED');await adapter.stop();
});

test('a failed replacement Weixin QR cannot poll the previous session',async()=>{
  let creates=0,polls=0;
  const qr=new WeixinQrAuthorization({transport:async url=>{
    if(url.includes('get_bot_qrcode')){if(++creates===1)return {qrcode:'old-private-session',qrcode_img_content:'image'};throw new Error('fixture-lost-reply');}
    polls++;return {status:'confirmed',bot_token:'fixture-private',ilink_bot_id:'user'};
  }});
  await qr.create();await assert.rejects(qr.create());
  await assert.rejects(qr.poll(),{code:'WEIXIN_QR_CANCELLED'});assert.equal(polls,0);qr.cancel();
});

test('a QR deadline wrapped by fetch remains pending under the original session',async()=>{
  const qr=new WeixinQrAuthorization({transport:async url=>{
    if(url.includes('get_bot_qrcode'))return {qrcode:'original-private-session',qrcode_img_content:'image'};
    throw new TypeError('fetch failed',{cause:new DOMException('deadline','TimeoutError')});
  }});
  await qr.create();assert.deepEqual(await qr.poll(),{state:'pending'});qr.cancel();
});

test('Weixin scan link bytes cannot hide parser-stripped controls or backslashes',async()=>{
  for(const value of ['https://liteapp.weixin.qq.com/q/a\nb','https://liteapp.weixin.qq.com/q/a\\b',' https://liteapp.weixin.qq.com/q/a']){
    await assert.rejects(normalizeWeixinQrImage(value),{code:'WEIXIN_QR_IMAGE_INVALID'});
  }
});

test('Weixin send rejection classification survives an approved API base path',async()=>{
  const secretStore=new EphemeralSecretStore();await secretStore.put('context',{contextToken:'fixture-context',toUserId:'fixture-user'});
  const paths=[];const adapter=new WeixinAdapter({configuration:{apiBase:'https://ilinkai.weixin.qq.com/v2'},credentials,secretStore,
    transport:async url=>{paths.push(new URL(url).pathname);return {ret:-2};}});
  await assert.rejects(adapter.send({destination:{replyRef:'context',conversationId:'fixture-user'},content:{text:'hello'}},{deliveryId:'original'}),{code:'WEIXIN_SEND_PREPARATION_FAILED',externalOutcome:'failed'});
  assert.deepEqual(paths,['/v2/ilink/bot/sendmessage']);
});

test('long Weixin scan URLs keep four pixels per QR module and incomplete PNGs are rejected',async()=>{
  const link='https://liteapp.weixin.qq.com/q/fixture?ticket='+('x'.repeat(1900));
  const modules=QRCode.create(link,{errorCorrectionLevel:'M'}).modules.size;
  const image=await normalizeWeixinQrImage(link),bytes=Buffer.from(image.split(',')[1],'base64');
  assert.ok(bytes.readUInt32BE(16)>=(modules+8)*4);assert.ok(bytes.readUInt32BE(16)<=2048);
  assert.equal(await normalizeWeixinQrImage(image.replace(/^data:image\/png;/,'DATA:IMAGE/PNG;')),image);
  await assert.rejects(normalizeWeixinQrImage('data:image/png;base64,'+bytes.subarray(0,24).toString('base64')),{code:'WEIXIN_QR_IMAGE_INVALID'});
});

test('Weixin SDK sanitizes malformed request JSON before a transport can expose private fragments',async()=>{
  let calls=0;const sdk=createWeixinSdk({transport:async()=>{calls++;assert.fail('invalid request must not be sent');}});
  await assert.rejects(sdk.apiPostFetch({baseUrl:'https://ilinkai.weixin.qq.com',endpoint:'ilink/bot/sendmessage',body:'{"context_token":"fixture-private-context",BROKEN',label:'fixture'}),error=>{
    assert.equal(error.code,'WEIXIN_SDK_REQUEST_INVALID');assert.ok(!error.message.includes('fixture-private-context'));return true;
  });assert.equal(calls,0);
});

test('a bounded Weixin poll can carry several supported text messages over the generic JSON budget',async()=>{
  const msgs=Array.from({length:8},(_,index)=>({message_id:String(index+1),from_user_id:'user',item_list:[{type:1,text_item:{text:'x'.repeat(50000)}}]}));
  const raw=JSON.stringify({ret:0,msgs,get_updates_buf:'next'});assert.ok(Buffer.byteLength(raw)>256*1024);let calls=0;
  const adapter=new WeixinAdapter({configuration,credentials,transport:(url,options)=>platformJson(url,{...options,fetchImpl:async()=>{calls++;return new Response(raw);}})});
  const batch=await adapter.getUpdates(AbortSignal.timeout(1000),{requireResponse:true});
  assert.equal(batch.msgs.length,8);assert.equal(batch.get_updates_buf,'next');assert.equal(calls,1);
});

test('Weixin SDK helper receipts report the generated client identity actually sent',async()=>{
  const secretStore=new EphemeralSecretStore(),messages=[];
  await secretStore.put('context',{contextToken:'fixture-context',toUserId:'fixture-user'});
  const adapter=new WeixinAdapter({configuration,credentials,secretStore,transport:async(_url,{body})=>{messages.push(body.msg);return {ret:0};}});
  const receipt=await adapter.send({destination:{replyRef:'context',conversationId:'fixture-user'},content:{text:'hello'}},{});
  assert.match(receipt.clientRequestId,/^[a-f0-9-]{36}$/);assert.equal(receipt.clientRequestId,messages[0].client_id);
});

test('Weixin upload helpers reject corrupted first reads and changed second reads without accepting a handle',async()=>{
  const good=Buffer.from('original'),changed=Buffer.from('modified');
  const secretStore=new EphemeralSecretStore();await secretStore.put('context',{contextToken:'fixture-context',toUserId:'user'});
  let requests=0,uploads=0,reads=0;
  const adapter=new WeixinAdapter({configuration,credentials,secretStore,
    transport:async()=>{requests++;return {ret:0,upload_param:'fixture'};},
    binaryUploader:async(_url,{byteStream})=>{uploads++;for await(const _chunk of byteStream){}return {encryptedParam:'fixture'};}});
  const file={filename:'fixture.bin',mediaType:'application/octet-stream',expectedBytes:good.length,sha256:createHash('sha256').update(good).digest('hex'),
    byteStream:()=> (async function*(){yield ++reads===1?good:changed;})()};
  const destination={replyRef:'context',conversationId:'user'};
  const uploadContext=await adapter.prepareUpload(file,{destination});
  await assert.rejects(adapter.upload(file,{deliveryId:'original',uploadContext}),{code:'UPLOAD_INTEGRITY_FAILED'});
  assert.equal(requests,1);assert.equal(uploads,1);
  await assert.rejects(adapter.prepareUpload({...file,byteStream:()=> (async function*(){yield changed;})()},{destination}),{code:'UPLOAD_INTEGRITY_FAILED'});
  assert.equal(requests,1);
});

test('Weixin file handles remain bound to the original reply context',async()=>{
 const secretStore=new EphemeralSecretStore();
 await secretStore.put('original',{contextToken:'fixture-original',toUserId:'user'});
 await secretStore.put('other',{contextToken:'fixture-other',toUserId:'user'});
 let sends=0,uploads=0;
 const adapter=new WeixinAdapter({configuration,credentials,secretStore,
  transport:async(url)=>{if(url.endsWith('/sendmessage'))sends++;return url.endsWith('/getuploadurl')?{ret:0,upload_param:'fixture'}:{ret:0};},
  binaryUploader:async(_url,{byteStream})=>{for await(const _ of byteStream){}uploads++;return {encryptedParam:'fixture'};}});
 const bytes=Buffer.from('owned data');const file={filename:'fixture.bin',mediaType:'application/octet-stream',expectedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),byteStream:()=> (async function*(){yield bytes;})()};
 const destination={replyRef:'original',conversationId:'user'};const uploadContext=await adapter.prepareUpload(file,{destination});
 const handle=await adapter.upload(file,{deliveryId:'original-delivery',uploadContext});assert.equal(uploads,1);
 assert.equal((await adapter.sendFile({destination},handle,{deliveryId:'valid-send'})).state,'accepted');assert.equal(sends,1);
 await assert.rejects(adapter.sendFile({destination:{replyRef:'other',conversationId:'user'}},handle,{deliveryId:'wrong-context'}),{code:'WEIXIN_MEDIA_CONTEXT_CHANGED'});assert.equal(sends,1);
 await secretStore.remove('original');await assert.rejects(adapter.sendFile({destination},handle,{deliveryId:'removed-context'}),{code:'PLATFORM_CONTEXT_EXPIRED'});assert.equal(sends,1);
 await secretStore.put('original',{contextToken:'fixture-refreshed',toUserId:'user'});await assert.rejects(adapter.sendFile({destination},handle,{deliveryId:'refreshed-context'}),{code:'WEIXIN_MEDIA_CONTEXT_CHANGED'});assert.equal(sends,1);
});

test('Weixin refuses a changed context before starting an upload',async()=>{
 const secretStore=new EphemeralSecretStore();await secretStore.put('original',{contextToken:'fixture-original',toUserId:'user'});let calls=0;
 const adapter=new WeixinAdapter({configuration,credentials,secretStore,transport:async()=>{calls++;return {ret:0};}});
 const bytes=Buffer.from('owned data');const file={filename:'fixture.bin',mediaType:'application/octet-stream',expectedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),byteStream:()=> (async function*(){yield bytes;})()};
 const destination={replyRef:'original',conversationId:'user'};const uploadContext=await adapter.prepareUpload(file,{destination});
 await secretStore.put('original',{contextToken:'fixture-refreshed',toUserId:'user'});
 await assert.rejects(adapter.upload(file,{deliveryId:'original-delivery',uploadContext}),{code:'WEIXIN_MEDIA_CONTEXT_CHANGED'});assert.equal(calls,0);
});


test('Weixin upload after context revocation retains the unknown external outcome',async()=>{
 const secretStore=new EphemeralSecretStore();await secretStore.put('original',{contextToken:'fixture-original',toUserId:'user'});let uploads=0;
 const adapter=new WeixinAdapter({configuration,credentials,secretStore,transport:async()=>({ret:0,upload_param:'fixture'}),
  binaryUploader:async(_url,{byteStream})=>{for await(const _ of byteStream){}uploads++;await secretStore.remove('original');return {encryptedParam:'fixture'};}});
 const bytes=Buffer.from('owned data');const file={filename:'fixture.bin',mediaType:'application/octet-stream',expectedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),byteStream:()=> (async function*(){yield bytes;})()};
 const uploadContext=await adapter.prepareUpload(file,{destination:{replyRef:'original',conversationId:'user'}});
 await assert.rejects(adapter.upload(file,{deliveryId:'original-delivery',uploadContext}),error=>error.code==='PLATFORM_CONTEXT_EXPIRED'&&error.externalOutcome==='unknown');
 assert.equal(uploads,1);await assert.rejects(secretStore.get(stableId('weixin-upload',['original-delivery',file.sha256])),{code:'PLATFORM_CONTEXT_EXPIRED'});
});

test('Weixin file binding also uses the worker persistent context store',async t=>{
 const root=mkdtempSync(join(tmpdir(),'weixin-context-binding-'));const store=new ChannelStore(root);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const def=definitions.weixin;store.saveConnection({id:'fixture-channel',platform:'weixin',label:'fixture',configuration:{[def.identityField]:'fixture'}},{[def.credentialField]:'fixture'});
 const secrets={put:async(id,value,ttl)=>store.putContext('fixture-channel',id,value,channelContextTtl('weixin',value,ttl)),
  get:async id=>store.context('fixture-channel',id),remove:async id=>store.removeContext('fixture-channel',id)};
 await secrets.put('original',{contextToken:'fixture-original',toUserId:'user'});let sends=0;
 const adapter=new WeixinAdapter({configuration,credentials,secretStore:secrets,transport:async url=>{if(url.endsWith('/sendmessage'))sends++;return url.endsWith('/getuploadurl')?{ret:0,upload_param:'fixture'}:{ret:0};},
  binaryUploader:async(_url,{byteStream})=>{for await(const _ of byteStream){}return {encryptedParam:'fixture'};}});
 const bytes=Buffer.from('owned data');const file={filename:'fixture.bin',mediaType:'application/octet-stream',expectedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),byteStream:()=> (async function*(){yield bytes;})()};
 const destination={replyRef:'original',conversationId:'user'},uploadContext=await adapter.prepareUpload(file,{destination});const handle=await adapter.upload(file,{deliveryId:'persisted',uploadContext});
 await secrets.put('original',{contextToken:'changed-token',toUserId:'user'});await assert.rejects(adapter.sendFile({destination},handle,{deliveryId:'no-send'}),{code:'WEIXIN_MEDIA_CONTEXT_CHANGED'});assert.equal(sends,0);
});
