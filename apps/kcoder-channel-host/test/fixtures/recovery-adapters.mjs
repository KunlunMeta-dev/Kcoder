// Only the physical endpoint discovery/token responses are fixtures; SDK sockets are real.
import { readFileSync } from 'node:fs';
import * as lark from '@larksuiteoapi/node-sdk';
import * as ding from 'dingtalk-stream';
import { FeishuAdapter,DingTalkAdapter } from '../../src/adapters/sdk.mjs';
export const clients=[];
export function recoveryAdapter(platform,options){
 const configuration=options.configuration;
 if(platform==='feishu'){
  class Client extends lark.WSClient{constructor(value){super(value);clients.push(this);}}
  return new FeishuAdapter({...options,sdk:{...lark,WSClient:Client},transport:async(url)=>{
   if(url.includes('/auth/'))return {code:0,tenant_access_token:'INERT_OWNED_FIXTURE',expire:3600};
   if(url.includes('/bot/'))return {code:0,bot:{open_id:'owned-open-bot'}};
   if(url.endsWith('/callback/ws/endpoint'))return {code:0,data:{URL:configuration.fixtureEndpoint,ClientConfig:{PingInterval:60,ReconnectCount:0,ReconnectInterval:1,ReconnectNonce:0}}};
   throw new Error('OWNED_FIXTURE_REFUSES_PLATFORM_REQUEST');
  }});
 }
 class Client extends ding.DWClient{constructor(value){super(value);this.sslopts.ca=readFileSync(configuration.fixtureCa);this.sslopts.lookup=(_name,options,callback)=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4);clients.push(this);}}
 return new DingTalkAdapter({...options,sdk:{...ding,DWClient:Client},transport:async(url)=>{
  if(url.endsWith('/gateway/connections/open'))return {endpoint:configuration.fixtureEndpoint,ticket:'INERT_OWNED_FIXTURE'};
  throw new Error('OWNED_FIXTURE_REFUSES_PLATFORM_REQUEST');
 }});
}
