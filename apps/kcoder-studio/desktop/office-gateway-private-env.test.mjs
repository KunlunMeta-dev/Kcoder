// Owned Gateway child transport only; private config does not replace parent authorization.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startGateway} from './gateway-process.mjs';
const KEY='KCODER_NATIVE_OFFICE_BINDING_V1';
const CHANNEL='KCODER_NATIVE_CONNECTIVITY_BINDING_V1';
async function fixture(t,options={}) {
 const root=await mkdtemp(join(tmpdir(),'owned-office-gateway-env-'));let gateway;
 t.after(async()=>{await gateway?.stop();await rm(root,{recursive:true,force:true});});
 const script=join(root,'gateway.mjs');const marker=join(root,'observed.json');
 await writeFile(script,`import {createServer} from 'node:http';import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify({office:process.env.${KEY}??null,channel:process.env.${CHANNEL}??null,aliases:Object.keys(process.env).filter(name=>name.toUpperCase()==='${KEY}')}));const server=createServer((request,response)=>{if(request.url==='/login'){response.writeHead(303,{'Set-Cookie':'kcoder_studio_session=owned-office-fixture; Path=/','x-kcoder-session-ttl-ms':'600000'});response.end();}else{response.writeHead(200);response.end('{}');}});server.listen(0,'127.0.0.1',()=>console.log('KCoder Studio: http://127.0.0.1:'+server.address().port));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
 gateway=await startGateway({gatewayScript:script,cwd:root,timeoutMs:5000,stopGraceMs:3000,...options});
 return {gateway,value:JSON.parse(await readFile(marker,'utf8'))};
}
test('ordinary desktop env cannot supply the reserved native Office input',async t=>{
 const {gateway,value}=await fixture(t,{env:{[KEY]:'ambient-or-user-forgery'}});assert.equal(value.office,null);await gateway.stop();
});
test('ordinary mixed-case reserved aliases never reach a Gateway child',async t=>{
 const {gateway,value}=await fixture(t,{env:{kcoder_native_office_binding_v1:'lowercase-forgery',Kcoder_Native_Office_Binding_V1:'mixed-case-forgery'}});
 assert.deepEqual(value.aliases,[]);await gateway.stop();
});
test('removed Office private environment is rejected before starting a Gateway child',async()=>{
 const observed=Buffer.from(JSON.stringify({schemaVersion:1,kind:'configuration-only-fixture'})).toString('base64url');
 await assert.rejects(startGateway({privateEnvironment:{[KEY]:observed}}),/Invalid native private environment/);
});
test('private environment rejects unrelated keys and malformed input before spawn',async()=>{
 await assert.rejects(startGateway({privateEnvironment:{NODE_OPTIONS:'forbidden'}}),/Invalid native private environment/);
 await assert.rejects(startGateway({privateEnvironment:{[KEY]:'not valid base64'}}),/Invalid native private environment/);
});

test('ordinary connectivity aliases cannot populate private native configuration',async t=>{
 const {gateway,value}=await fixture(t,{env:{[CHANNEL]:'ambient-forgery',kcoder_native_connectivity_binding_v1:'case-forgery'}});
 assert.equal(value.channel,null);await gateway.stop();
});
test('native connectivity resource producer can share the protected Gateway environment',async t=>{
 const raw=Buffer.from(JSON.stringify({schemaVersion:1,scope:'configuration-only'})).toString('base64url');
 const {gateway,value}=await fixture(t,{privateEnvironment:{[CHANNEL]:raw}});
 assert.equal(value.channel,raw);await gateway.stop();
});
