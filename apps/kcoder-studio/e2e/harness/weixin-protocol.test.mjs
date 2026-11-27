import test from 'node:test';
import assert from 'node:assert/strict';
import { startWeixinProtocolFixture } from './weixin-protocol.mjs';

test('owned QR fixture preserves expiry, privately registers confirmation tokens and whitelists its observation fields',async t=>{
 const cleanup=[],secrets=[];const fixture=await startWeixinProtocolFixture({registerSecret:v=>secrets.push(v),registerPort:()=>{},addCleanup:(_label,fn)=>cleanup.push(fn)});t.after(async()=>{for(const fn of cleanup.reverse())await fn();});
 const create=async mode=>(await fetch(fixture.endpoint+'/ilink/bot/get_bot_qrcode?bot_type='+mode,{method:'POST',headers:{'iLink-App-Id':'owned-qr-product'},body:JSON.stringify({local_token_list:[]})})).json();
 const expired=await create('expired');assert.equal((await (await fetch(fixture.endpoint+'/ilink/bot/get_qrcode_status?qrcode='+expired.qrcode)).json()).status,'expired');
 const first=await create('confirmed');const result=await (await fetch(fixture.endpoint+'/ilink/bot/get_qrcode_status?qrcode='+first.qrcode)).json();assert.equal(result.ilink_bot_id,'owned-confirmed-account');assert.ok(result.status==='confirmed');assert.ok(secrets.includes(result.bot_token));assert.ok(!JSON.stringify(fixture.requests).includes(result.bot_token));
 const expected=[['create','expired'],['poll','expired'],['create','confirmed'],['poll','confirmed']];
 assert.deepEqual(fixture.requests.map(row=>Object.keys(row).sort()),expected.map(()=>['action','mode']));
 assert.ok(fixture.requests.length===expected.length&&fixture.requests.every((row,index)=>row.action===expected[index][0]&&row.mode===expected[index][1]),'The owned QR flow must observe exactly the declared action and mode sequence');
});
