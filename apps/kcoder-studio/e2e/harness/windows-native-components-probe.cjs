// Actual ordinary-account Node -> Windows CLI stdio. No model/platform request.
const {spawn,spawnSync}=require('node:child_process');
const {createInterface}=require('node:readline');
const {readFile,writeFile,mkdir}=require('node:fs/promises');
const {join}=require('node:path');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs');
const [root,profile,workspace,source,mode]=process.argv.slice(2);
const cli=join(root,'probe-cli.exe');
const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const stages=[];const started=Date.now();
async function note(stage,fields={}){stages.push({stage,elapsedMs:Date.now()-started,...fields});await writeFile(join(root,'native-components-progress.json'),JSON.stringify(stages));}
async function run(binding,parent,expected,mutate=false,readOnly=false,existing=false){
 await note(parent?.mode??'unverified',{phase:'start'});
 const env={...process.env,KCODER_CONFIG_DIR:profile};
 for(const key of Object.keys(env))if(/^(SSH_CONNECTION|SSH_TTY|KCODER_ACCOUNT_PRINCIPAL_ID|KCODER_WIKI_WORKER_MANAGED|KCODER_PRIVATE_RETENTION_PARENT_V1|KCODER_PRIVATE_RETENTION_VERIFIER_V1|KCODER_NATIVE_CONNECTIVITY_BINDING_V1)$/i.test(key))delete env[key];
 env.KCODER_NATIVE_CONNECTIVITY_BINDING_V1=encoded(binding);
 if(parent)env.KCODER_PRIVATE_RETENTION_PARENT_V1='v1.'+encoded(parent);
 const child=spawn(cli,['--settings-file',join(profile,'settings.json'),'--cwd',workspace,'app-server'],{cwd:workspace,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
 let stderr='',failure;const pending=new Map(),lines=createInterface({input:child.stdout});let id=0;
 child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-16000)});
 lines.on('line',line=>{let frame;try{frame=JSON.parse(line)}catch{return}const call=pending.get(frame.id);if(call){pending.delete(frame.id);call.resolve(frame)}});
 const exited=new Promise(resolve=>child.once('close',code=>{for(const call of pending.values())call.reject(Error('Native CLI exited before reply code='+code+': '+stderr.slice(-3000)));pending.clear();resolve(code)}));
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const current=++id;const timer=setTimeout(()=>{pending.delete(current);reject(Error('Native RPC timed out '+method))},40000);pending.set(current,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:current,method,params})+'\n')});
 try{
  const init=await rpc('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'owned-windows-native-parent',version:'1'},capabilities:{experimental:{integrationScopeV1:true,connectivityV1:true,workspaceOperationReceiptsV2:true}}});
  const cap=init.result?.capabilities?.experimental?.connectivityV1;
  assert.equal(init.result?.capabilities?.experimental?.workspaceOperationReceiptsV2,false);
  await note('initialize',{expected,capability:cap});
  assert.equal(cap,expected,'OS/native resource parent availability');
  if(!expected)return {capability:false};
  const scope=(await rpc('integrations/scope/read',{})).result;
  const request=payload=>({contractVersion:'parallel-v1',requestId:'native-win-'+id,scope,timeoutMs:30000,payload});
  const cold=await rpc('integrations/connectivity/listConnections',request({category:'channels',limit:10}));
  await note('cold-list',{status:cold.result?.status,errorCode:cold.result?.error?.code});
  if(mutate){assert.equal(cold.result?.status,'unavailable');return {capability:true,tamperedResourceRejected:true};}
  if(existing){
   assert.equal(cold.result.status,'completed');assert.equal(cold.result.result.items.length,1);
   assert.equal(cold.result.result.items[0].id,'owned-windows-source');assert.equal(cold.result.result.items[0].enabled,false);
   await note('actual-existing-main-reopened',{status:'completed',persistedConnection:true});
   return {capability:true,originalPersistedConnection:true,disabledConnection:true};
  }
  assert.equal(cold.result.status,'completed');assert.equal(cold.result.result.connectionObservationState,'unknown');assert.equal(cold.result.result.catalog.channels.length,5);
  if(readOnly)return {capability:true,coldUnknown:true,catalogChannels:5,retainedReceipts:false};
  const save=request({action:'save',connectionId:'owned-windows-source',kind:'wecom',label:'Owned Windows native',configuration:{botId:'owned-windows-bot'},resourceGrants:[]});save.operationId='owned-windows-native-save';
  const saved=await rpc('integrations/connectivity/prepareConnectionAction',save);await note('save',{status:saved.result?.status,errorCode:saved.result?.error?.code});
  const readonlyProbe=join(root,'native-store-readonly-probe.exe');
  if(saved.result?.status!=='completed'&&fs.existsSync(readonlyProbe)){
   for(const entry of fs.readdirSync(profile,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()){
    const directory=join(profile,entry.name);
    if(fs.existsSync(join(directory,'channel-host-initialization.json'))){
     const observation=spawnSync(readonlyProbe,[directory],{encoding:'utf8',timeout:5000,windowsHide:true});
     await note('readonly-original-control',{exitCode:observation.status,report:String(observation.stdout).replaceAll(root,'<owned-run>').slice(0,2048)});
    }
   }
  }
  assert.equal(saved.result?.status,'completed',JSON.stringify(saved));
  const read=await rpc('integrations/connectivity/listConnections',request({category:'channels',limit:10}));assert.equal(read.result.status,'completed');assert.equal(read.result.result.items.length,1);assert.equal(read.result.result.items[0].id,'owned-windows-source');assert.equal(read.result.result.items[0].enabled,false);
  return {capability:true,coldUnknown:true,actualNodeMainSaveRead:true,disabledConnection:true,providerCalls:0,platformCalls:0};
 }catch(error){failure=error;throw error}
 finally{
  child.stdin.end();let timer;const code=await Promise.race([exited,new Promise((resolve,reject)=>{timer=setTimeout(()=>{child.kill();reject(Error('Owned CLI did not settle after stdin close'))},15000)})]).finally(()=>clearTimeout(timer));lines.close();
  if(!failure)assert.equal(code,0,'Owned native CLI cleanup');
  await writeFile(join(root,'native-components-last-stderr.log'),stderr);
 }
}
(async()=>{
 if(mode==='gateway'){const result=await require('./native-gateway-probe.cjs')({root,profile,workspace,source});await note('actual-windows-gateway-default-image',result);process.stdout.write(JSON.stringify(result)+'\n');return;}
 if(mode==='imageOnly'){
  const {createHash}=require('node:crypto');
  const addon=join(root,'kcoder-native-image.node'),loaded={exports:{}};process.dlopen(loaded,addon);
  const native=loaded.exports;assert.equal(native.abiVersion,1);
  const hash=path=>createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  const addonSha=hash(addon),programSha=hash(cli);
  const opaque=native.captureImage(addon,addonSha,cli,programSha);
  assert.equal(native.sameImage(opaque,cli),true);
  assert.throws(()=>native.sameImage(JSON.parse(JSON.stringify(opaque)),cli));
  assert.throws(()=>native.captureImage(addon,'0'.repeat(64),cli,programSha));
  let writeDenied=false;
  try{const fd=fs.openSync(cli,fs.constants.O_WRONLY);fs.closeSync(fd);}catch(error){writeDenied=['EPERM','EACCES','EBUSY'].includes(error.code);}
  assert.equal(writeDenied,true,'Held native image denies write before any CLI starts');
  const renamed=join(root,'owned-peer-image.exe');let renameDenied=false;
  try{fs.renameSync(cli,renamed);fs.renameSync(renamed,cli);}catch(error){renameDenied=['EPERM','EACCES','EBUSY'].includes(error.code);}
  assert.equal(renameDenied,true,'Held native image denies path replacement');
  native.closeImage(opaque);assert.throws(()=>native.sameImage(opaque,cli));
  const fd=fs.openSync(cli,fs.constants.O_WRONLY);fs.closeSync(fd);
  const result={passed:true,actualLoadedAddon:true,actualNativeOpaque:true,writeDenied,renameDenied,clonedObjectRejected:true,wrongAddonHashRejected:true,closedHandleRejected:true,writeAccessAfterClose:true,providerCalls:0,platformCalls:0};
  await note('actual-windows-kernel-image-lock',result);process.stdout.write(JSON.stringify(result)+'\n');return;
 }
 let fd;const boundary={};
 try{fd=fs.openSync(workspace,fs.constants.O_RDONLY);boundary.open='ok';fs.fstatSync(fd);boundary.stat='ok';fs.fsyncSync(fd);boundary.fsync='ok';}
 catch(error){boundary.error=String(error.code??'UNKNOWN');}
 finally{if(fd!==undefined)fs.closeSync(fd);}
 await note('actual-node-directory-boundary',boundary);
 const stage=await import(pathToFileURL(join(source,'scripts','stage-native-resources.mjs')).href);
 const bundle=join(root,'sealed-channel-resources');const binding=await stage.stageNativeConnectivityResources({output:bundle,nodeProgram:process.execPath});
 const unverified=await run(binding,null,false);
 const localParent=await run(binding,{version:1,mode:'localOs'},true,false,true);
 const wrongKind=await run(binding,{version:1,mode:'verifiedAccount',principalId:'caller-label',uid:0},false);
 const manifest=join(bundle,'channel-resource-manifest.json'),bytes=await readFile(manifest);await writeFile(manifest,Buffer.concat([bytes,Buffer.from(' ')]));
 const tampered=await run(binding,{version:1,mode:'localOs'},true,true);
 await writeFile(manifest,bytes);
 const local=await run(binding,{version:1,mode:'localOs'},true);
 const reopened=await run(binding,{version:1,mode:'localOs'},true,false,true,true);
 process.stdout.write(JSON.stringify({passed:true,unverified,localParent,local,reopened,wrongKind,tampered,providerCalls:0,platformCalls:0})+'\n');
})().catch(error=>{process.stderr.write(String(error.stack||error)+'\n'+JSON.stringify(stages)+'\n');process.exitCode=1});
