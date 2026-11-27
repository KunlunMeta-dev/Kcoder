import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYtwAAAAASUVORK5CYII=';
/** Owned HTTP counterpart of the fixed QR protocol, without vendor qualification. */
export async function startWeixinProtocolFixture(context){
 const requests=[],flows=new Map(),tokens=[],waiters=new Set();let sequence=0;
 const server=createServer((request,response)=>{void(async()=>{
  const url=new URL(request.url,'http://127.0.0.1');let body='';for await(const part of request){body+=part;if(body.length>4096)throw Error('OWNED_WEIXIN_BODY_LIMIT');}
  const reply=value=>{if(!response.destroyed){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(value));}};
  if(url.pathname==='/ilink/bot/get_bot_qrcode'){
   assert.equal(request.method,'POST');assert.deepEqual(JSON.parse(body),{local_token_list:[]});assert.equal(request.headers['ilink-app-id'],'owned-qr-product');
   const mode=url.searchParams.get('bot_type');assert.ok(['confirmed','mismatch','cancel','expired','late','unknown'].includes(mode));const id='owned-flow-'+(++sequence);flows.set(id,{mode});requests.push({action:'create',mode});if(mode==='unknown'){response.destroy();return;}return reply({qrcode:id,qrcode_img_content:image});
  }
  assert.equal(url.pathname,'/ilink/bot/get_qrcode_status');const flow=flows.get(url.searchParams.get('qrcode'));assert.ok(flow);requests.push({action:'poll',mode:flow.mode});
  if(flow.mode==='late')await new Promise(resolve=>{flow.release=resolve;waiters.add(resolve);});
  if(flow.mode==='expired')return reply({status:'expired'});
  if(flow.mode==='cancel')return reply({status:'wait'});
  const token='synthetic-owned-qr-'+randomBytes(24).toString('hex');context.registerSecret(token);tokens.push(token);return reply({status:'confirmed',bot_token:token,ilink_bot_id:flow.mode==='mismatch'?'foreign-scanned-account':'owned-confirmed-account',baseurl:'https://ilinkai.weixin.qq.com'});
 })().catch(()=>{requests.push({action:'fixture-error'});response.destroy();});});
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await context.registerPort('owned-weixin-protocol',port);
 context.addCleanup('close owned Weixin protocol',async()=>{for(const done of waiters)done();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return {endpoint:'http://127.0.0.1:'+port,requests,tokens,releaseLate(){for(const done of waiters)done();waiters.clear();}};
}
