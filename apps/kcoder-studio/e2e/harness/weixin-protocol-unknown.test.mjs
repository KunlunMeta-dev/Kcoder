import assert from 'node:assert/strict';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import { startWeixinProtocolFixture } from './weixin-protocol.mjs';

test('owned unknown QR response records one original request and never returns credentials',async()=>{
 const context=await RunContext.create(import.meta.url,{testId:'owned-qr-original-unknown-http',modelPolicy:'Owned HTTP response-loss only, no Native/vendor claim'});let failure;
 try{
  const protocol=await startWeixinProtocolFixture(context);
  await assert.rejects(fetch(protocol.endpoint+'/ilink/bot/get_bot_qrcode?bot_type=unknown',{method:'POST',headers:{'ilink-app-id':'owned-qr-product'},body:JSON.stringify({local_token_list:[]})}));
  assert.deepEqual(protocol.requests,[{action:'create',mode:'unknown'}]);assert.equal(protocol.tokens.length,0);
 }catch(error){failure=error;throw error;}finally{await context.finish(failure?'failed':'passed',{httpOnly:true},failure);}
});
