import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { WeixinAdapter,WeixinQrAuthorization,WEIXIN_CLIENT_METADATA } from '../src/adapters/weixin.mjs';
import { weixinEvent } from '../src/normalizers.mjs';
import { EphemeralSecretStore } from '../src/transport.mjs';
import { ChannelError } from '../src/errors.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const product=WEIXIN_CLIENT_METADATA;
test('Weixin headers encode decimal uint32 and include its own product metadata',()=>{
 const adapter=new WeixinAdapter({configuration:{accountId:'account'},credentials:{botToken:'inert'}});
 const headers=adapter.headers();assert.match(Buffer.from(headers['X-WECHAT-UIN'],'base64').toString(),/^\d{1,10}$/);assert.equal(headers['iLink-App-Id'],product.appId);
});
test('Weixin QR uses POST and handles verification states without publishing a token',async()=>{
 const calls=[];const qr=new WeixinQrAuthorization({product,transport:async(url,args)=>{calls.push({url,args});return url.includes('get_bot_qrcode')?{qrcode:'test-qr',qrcode_img_content:'test-image'}:{status:'need_verifycode'};}});
 await qr.create();assert.equal(calls[0].args.method,'POST');assert.deepEqual(calls[0].args.body,{local_token_list:[]});assert.equal((await qr.poll()).state,'verification_required');
});
test('Weixin QR refuses a redirect outside approved service hosts',async()=>{
 const qr=new WeixinQrAuthorization({product,transport:async url=>url.includes('get_bot_qrcode')?{qrcode:'test-qr',qrcode_img_content:'test-image'}:{status:'scaned_but_redirect',redirect_host:'evil.example.invalid'}});
 await qr.create();await assert.rejects(qr.poll(),/UNAPPROVED_HOST/);
});
test('Weixin QR reports network loss without secrets and preserves explicit cancellation and expiry',async()=>{
 let now=0;const qr=new WeixinQrAuthorization({now:()=>now,transport:async url=>{
  if(url.includes('get_bot_qrcode'))return {qrcode:'private-qr',qrcode_img_content:'test-image'};
  throw new TypeError('fetch failed');
 }});
 await qr.create();await assert.rejects(qr.poll(),error=>error.code==='WEIXIN_QR_NETWORK_UNAVAILABLE'&&!error.message.includes('private-qr'));
 const controller=new AbortController();controller.abort(new DOMException('Owned timeout','TimeoutError'));
 qr.http=async(_url,{signal})=>{signal.throwIfAborted();};
 await assert.rejects(qr.poll(controller.signal),{name:'TimeoutError'});
 now=600001;await assert.rejects(qr.poll(),{code:'WEIXIN_QR_EXPIRED'});
 qr.cancel();await assert.rejects(qr.poll(),{code:'WEIXIN_QR_CANCELLED'});
});
test('Weixin numeric message identity and per-message context survive normalization without leaking keys',async()=>{
 const secrets=new EphemeralSecretStore(),configuration={accountId:'account',channelId:'channel'};
 const first=await weixinEvent(configuration,{message_id:123,from_user_id:'sender',context_token:'inert-one',item_list:[{type:1,text_item:{text:'one'}}]},secrets);
 const second=await weixinEvent(configuration,{message_id:124,from_user_id:'sender',context_token:'inert-two',item_list:[{type:1,text_item:{text:'two'}}]},secrets);
 assert.equal(first.eventId,'123');assert.notEqual(first.replyRef,second.replyRef);assert.equal((await secrets.get(first.replyRef)).contextToken,'inert-one');assert.ok(!JSON.stringify(first).includes('inert-one'));
});
test('Weixin stream decrypts known ciphertext without allocating the complete file',async()=>{
 const key=Buffer.alloc(16,7),plain=Buffer.from('isolated encrypted media'),cipher=createCipheriv('aes-128-ecb',key,null),encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
 const secretStore=new EphemeralSecretStore();await secretStore.put('media',{aeskey:key.toString('hex'),media:{encrypt_query_param:'inert'}});
 const adapter=new WeixinAdapter({configuration:{},credentials:{},secretStore,binaryTransport:async()=>({byteStream:(async function*(){yield encrypted.subarray(0,9);yield encrypted.subarray(9);})()})});
 const media=await adapter.download({kind:'file',mediaId:'media',filename:'result.txt'});const parts=[];for await(const part of media.byteStream)parts.push(part);assert.deepEqual(Buffer.concat(parts),plain);
});
test('Weixin poll cursor advances only after every event has been durably accepted',async()=>{
 let saved=false;const adapter=new WeixinAdapter({configuration:{channelId:'channel',accountId:'account'},credentials:{},checkpoint:{save:async()=>{saved=true;}}});
 const data={msgs:[{message_id:1,from_user_id:'sender',item_list:[{type:1,text_item:{text:'hello'}}]}],get_updates_buf:'next'};
 await assert.rejects(adapter.consume(data,async()=>{throw new Error('controlled acceptance failure');}));assert.equal(saved,false);assert.equal(adapter.cursor,'');
 await adapter.consume(data,async()=>{});assert.equal(saved,true);assert.equal(adapter.cursor,'next');
});
test('Weixin authorization loss leaves connected state immediately and cannot silently restart',async t=>{
 let request=0;const changes=[];const adapter=new WeixinAdapter({configuration:{accountId:'account',channelId:'channel'},credentials:{botToken:'inert'},transport:async url=>{if(!url.endsWith('/getupdates'))return {ret:0};if(++request===1)return {get_updates_buf:'original'};throw new ChannelError('PLATFORM_AUTHORIZATION_FAILED');},checkpoint:{load:async()=>'',save:async()=>{}}});t.after(()=>adapter.stop());adapter.setConnectionObserver(()=>changes.push(adapter.connectionState()));
 await adapter.start(async()=>{});await adapter.loop;assert.equal(adapter.connectionState(),'authorization_required');assert.ok(changes.includes('connected'));assert.equal(request,2);await assert.rejects(adapter.reconnect(),/CHANNEL_STOPPED/);
});
test('an unclassified Weixin platform rejection is failed without claiming credential revocation',async t=>{
 let count=0;const adapter=new WeixinAdapter({configuration:{accountId:'account',channelId:'channel'},credentials:{botToken:'inert'},transport:async url=>!url.endsWith('/getupdates')?{ret:0}:++count===1?{}:{ret:1234}});t.after(()=>adapter.stop());await adapter.start(async()=>{});await adapter.loop;assert.equal(adapter.connectionState(),'failed');await assert.rejects(adapter.reconnect(),/CHANNEL_STOPPED/);assert.equal(count,2);
});
test('Weixin transport exhaustion is observable and explicit reconnect reloads the committed cursor',async t=>{
 let count=0,stored='',saved=0;const adapter=new WeixinAdapter({configuration:{accountId:'account',channelId:'channel'},credentials:{botToken:'inert'},checkpoint:{load:async()=>stored,save:async value=>{stored=value;saved++;}},transport:async(url,{body,signal})=>{if(!url.endsWith('/getupdates'))return {ret:0};count++;if(count===1)return {get_updates_buf:'committed'};if(count<=4)throw new ChannelError('PLATFORM_HTTP_REJECTED');if(count===5){assert.equal(body.get_updates_buf,'committed');return {};}return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new ChannelError('OWNED_STOP')),{once:true}));}});t.after(()=>adapter.stop());
 await adapter.start(async()=>{});await adapter.loop;assert.equal(adapter.connectionState(),'degraded');assert.equal(count,4);await adapter.reconnect();assert.equal(adapter.connectionState(),'connected');assert.equal(saved,1);await adapter.stop();assert.equal(adapter.connectionState(),'stopped');await assert.rejects(adapter.reconnect(),/CHANNEL_STOPPED/);
});
test('a stopped Weixin initial request cannot accept a late reply or advance its cursor',async()=>{
 let release,saves=0,events=0;const pending=new Promise(resolve=>{release=resolve;});const adapter=new WeixinAdapter({configuration:{accountId:'account',channelId:'channel'},credentials:{botToken:'inert'},checkpoint:{save:async()=>{saves++;}},transport:async url=>url.endsWith('/getupdates')?pending:{ret:0}});
 const starting=adapter.start(async()=>{events++;});await delay(0);await adapter.stop();release({get_updates_buf:'late',msgs:[{message_id:'late',from_user_id:'sender',item_list:[]}]});await assert.rejects(starting,/WEIXIN_CONNECTION_CANCELLED/);assert.equal(events,0);assert.equal(saves,0);assert.equal(adapter.connectionState(),'stopped');
});
