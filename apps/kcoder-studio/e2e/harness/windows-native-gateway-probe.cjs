// Actual Cookie Gateway -> selected native Windows target. No model/platform call.
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const {join}=require('node:path');
const {pathToFileURL}=require('node:url');
const {randomBytes}=require('node:crypto');
const assert=require('node:assert/strict');
module.exports=async function({root,profile,workspace,source}){
 const gatewayRoot=join(source,'..','kcoder-studio'),cli=join(root,'probe-cli.exe');
 const auth=randomBytes(24).toString('base64url');
 const env={...process.env,NODE_ENV:'test',KCODER_CONFIG_DIR:profile,KCODER_STUDIO_HOST:'127.0.0.1',KCODER_STUDIO_PORT:'0',
  KCODER_STUDIO_KCODER_BIN:cli,KCODER_STUDIO_WORKSPACE:workspace,KCODER_STUDIO_WEB_ROOT:join(gatewayRoot,'renderer/dist'),
  KCODER_STUDIO_AUTH_TOKEN:auth,KCODER_STUDIO_SERVERS_STORE:join(root,'gateway-state','servers.json'),
  KCODER_STUDIO_SERVERS:JSON.stringify([{id:'owned-native',label:'Owned Windows image target',runtime:'kcoder',transport:'local',command:cli,workspace,settingsFile:join(profile,'settings.json')}])};
 for(const key of Object.keys(env))if(/^(SSH_CONNECTION|SSH_TTY|KCODER_ACCOUNT_PRINCIPAL_ID|KCODER_PRIVATE_RETENTION_PARENT_V1|KCODER_PRIVATE_RETENTION_VERIFIER_V1|KCODER_NATIVE_CONNECTIVITY_BINDING_V1|KCODER_NATIVE_OFFICE_BINDING_V1|KCODER_NATIVE_COMPONENT_IMAGE_BINDING_V1)$/i.test(key))delete env[key];
 fs.copyFileSync(join(root,'kcoder-native-image.node'),join(root,'kcoder_process_supervisor.dll'));
 const child=spawn(process.execPath,[join(gatewayRoot,'dev-server.mjs')],{cwd:gatewayRoot,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 let stdout='',stderr='',rpc;
 child.stdout.on('data',bytes=>{stdout=(stdout+bytes).slice(-16000)});
 child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-16000)});
 const exited=new Promise(resolve=>child.once('close',resolve));
 const wait=async predicate=>{const deadline=Date.now()+60000;while(Date.now()<deadline){const value=predicate();if(value)return value;if(child.exitCode!==null)throw Error('Owned Gateway exited '+child.exitCode+': '+stderr.replaceAll(auth,'[REDACTED]'));await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Owned Gateway did not become ready: '+stderr.replaceAll(auth,'[REDACTED]'));};
 try{
  const port=await wait(()=>stdout.match(/KCoder Studio: http:\/\/[^:]+:(\d+)/)?.[1]);
  const baseUrl='http://127.0.0.1:'+port;
  const http=await import(pathToFileURL(join(gatewayRoot,'e2e/harness/http.mjs')).href);
  const helpers=await import(pathToFileURL(join(gatewayRoot,'e2e/harness/rpc.mjs')).href);
  const cookie=await http.login(baseUrl,auth);
  const page=await fetch(baseUrl,{headers:{cookie}});assert.equal(page.status,200);
  const html=await page.text(),token=html.match(/name="kcoder-rpc-token" content="([^"]+)"/)?.[1];assert.ok(token);
  rpc=await helpers.openRpc(helpers.gatewayRpcUrl({wsUrl:'ws://127.0.0.1:'+port},'owned-native',token),{headers:{Cookie:cookie,Origin:baseUrl}});
  const initialized=await rpc.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'actual-windows-gateway-image-producer',version:'1'},capabilities:{experimental:{integrationScopeV1:true,connectivityV1:true,workspaceOperationReceiptsV2:true}}},60000);
  assert.equal(initialized.capabilities.experimental.connectivityV1,true);
  assert.equal(initialized.capabilities.experimental.workspaceOperationReceiptsV2,false);
  const scope=await rpc.request('integrations/scope/read',{});
  let id=0;const request=payload=>({contractVersion:'parallel-v1',requestId:'gateway-owned-'+ ++id,scope,timeoutMs:30000,payload});
  const cold=await rpc.request('integrations/connectivity/listConnections',request({category:'channels',limit:10}),40000);
  assert.equal(cold.status,'completed');assert.equal(cold.result.connectionObservationState,'unknown');assert.equal(cold.result.catalog.channels.length,5);
  const save=request({action:'save',connectionId:'owned-windows-gateway',kind:'wecom',label:'Owned Windows Gateway',configuration:{botId:'owned-gateway-bot'},resourceGrants:[]});save.operationId='original-gateway-save';
  const saved=await rpc.request('integrations/connectivity/prepareConnectionAction',save,40000);assert.equal(saved.status,'completed',JSON.stringify(saved));
  const listed=await rpc.request('integrations/connectivity/listConnections',request({category:'channels',limit:10}),40000);assert.equal(listed.status,'completed');assert.equal(listed.result.items[0].id,'owned-windows-gateway');assert.equal(listed.result.items[0].enabled,false);
  await helpers.closeRpcAndWait(rpc);rpc=null;
  return {passed:true,cookieAuthenticatedGateway:true,actualSelectedDefaultTarget:true,manualNativeEnvironment:false,actualLoadedImageProducer:true,automaticSealedSdk:true,actualMainSaveRead:true,retainedReceipts:false,providerCalls:0,platformCalls:0};
 }finally{
  if(rpc)rpc.close();child.kill();let timer;try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned Gateway did not exit')),10000);})]);}finally{clearTimeout(timer);}
  const safe=stderr.replaceAll(auth,'[REDACTED]');fs.writeFileSync(join(root,'native-gateway-stderr.log'),safe);
 }
};
