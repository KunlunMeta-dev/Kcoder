import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const {gatewayStartupRecords}=createRequire(import.meta.url)('./windows-gateway-startup-records.cjs');
test('Windows Gateway timings retain fixed metadata only, never original payloads',()=>{
 const raw='[gateway] '+JSON.stringify({event:'gateway-startup',phase:'office_resources',status:'completed',elapsedMs:21000,privateValue:'must not retain'})+'\nnot-json\n'+JSON.stringify({event:'gateway-startup',phase:'unknown-private-label',status:'started',elapsedMs:0});
 assert.deepEqual(gatewayStartupRecords(raw),[{phase:'office_resources',status:'completed',elapsedMs:21000}]);
});


test('desktop session cookie evidence neither reads nor serializes cookie values', () => {
 const {desktopSessionCookieMetadata}=createRequire(import.meta.url)('./windows-gateway-startup-records.cjs');
 const cookie={name:'kcoder_studio_session',domain:'127.0.0.1',path:'/',httpOnly:true,
  secure:false,session:true,sameSite:'Strict',expires:-1};
 Object.defineProperty(cookie,'value',{get(){throw Error('Secret value must not be read');},enumerable:true});
 const result=desktopSessionCookieMetadata([cookie,{name:'other',value:'unrelated-secret'}]);
 assert.deepEqual(result,{present:true,count:1,metadata:[{domain:'127.0.0.1',path:'/',httpOnly:true,
  secure:false,session:true,sameSite:'Strict',expires:null}]});
 assert.equal(JSON.stringify(result).includes('value'),false);
 assert.equal(JSON.stringify(result).includes('unrelated-secret'),false);
 assert.deepEqual(desktopSessionCookieMetadata([]),{present:false,count:0,metadata:[]});
});
