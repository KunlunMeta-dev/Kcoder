import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run=promisify(execFile);
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'electron-bootstrap-review-'));await copyFile(new URL('./fixtures/bootstrap-gateway.mjs',import.meta.url),join(root,'gateway.mjs'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

for(const choice of ['cancel','defaults','custom'])test(`actual main first-launch ${choice} only prepares storage after confirmation`,async t=>{
 const root=await fixture(t);
 const result=await run(process.execPath,['--experimental-vm-modules',new URL('./fixtures/bootstrap-main-probe.mjs',import.meta.url).pathname,root,`storage-install-${choice}`],{timeout:12000,maxBuffer:1024*1024});
 const observed=JSON.parse(result.stdout.trim());
 assert.equal(observed.exitFacts.code,0);assert.equal(observed.starts,0);
 if(choice==='cancel'){
  assert.deepEqual(observed.installationOrder,['choose']);assert.equal(observed.storageChoice,null);assert.equal(observed.record,null);
  assert.equal(observed.defaultNativeExists,false);
 }else{
  assert.deepEqual(observed.installationOrder,['choose','initialize']);
  assert.deepEqual(observed.storageChoice,{silent:false,dataRoot:choice==='custom'?join(root,'Custom Data'):join(root,'.config','kcoder'),
   cacheRoot:choice==='custom'?join(root,'Custom Cache'):join(root,'.cache','kcoder')});
  assert.equal(observed.record.dataRoot,observed.storageChoice.dataRoot);assert.equal(observed.record.cacheRoot,observed.storageChoice.cacheRoot);
  assert.equal(observed.record.revision,1);assert.equal(observed.record.operationId,undefined);
  assert.equal(observed.defaultNativeExists,choice==='defaults');
 }
});

test('the actual main wiring joins a real in-flight replacement before its app exit point',async t=>{
 const root=await fixture(t);
 const result=await run(process.execPath,['--experimental-vm-modules',new URL('./fixtures/bootstrap-main-probe.mjs',import.meta.url).pathname,root],{timeout:12000,maxBuffer:1024*1024});
 const observed=JSON.parse(result.stdout.trim());
 assert.equal(observed.starts,2);assert.equal(observed.exitFacts.code,0);
 assert.equal(observed.exitFacts.heldAlive,false,'owned replacement was alive when the original main called app.exit');
});

test('a failed spawn rejects its actual start promise instead of waiting for an exit event that cannot fire',async t=>{
 const root=await fixture(t),module=new URL(process.env.KCODER_BOOTSTRAP_GATEWAY_MODULE || './gateway-process.mjs',import.meta.url).href;
 const code=`import{startGateway}from${JSON.stringify(module)};let settled=false;const pending=startGateway({nodeBinary:${JSON.stringify(join(root,'missing-node'))},gatewayScript:${JSON.stringify(join(root,'gateway.mjs'))},env:{HOME:${JSON.stringify(root)},KCODER_CONFIG_DIR:${JSON.stringify(root)},KCODER_STUDIO_DATA_DIR:${JSON.stringify(root)}},timeoutMs:100,stopGraceMs:25}).catch(error=>{settled=true;console.log(JSON.stringify({settled,code:error.code}));});setTimeout(()=>{if(!settled){console.log(JSON.stringify({settled:false}));process.exit(0);}},250);await pending;`;
 const result=await run(process.execPath,['--input-type=module','-e',code],{timeout:2000});
 const observed=JSON.parse(result.stdout.trim());assert.equal(observed.settled,true);assert.equal(observed.code,'ENOENT');
});

for(const mode of ['bad-url','bad-cookie'])test(`${mode} rejects startup without an uncaught event-handler exception`,async t=>{
 const root=await fixture(t),module=new URL(process.env.KCODER_BOOTSTRAP_GATEWAY_MODULE || './gateway-process.mjs',import.meta.url).href;
 const code=`import{startGateway}from${JSON.stringify(module)};const controller=new AbortController();let uncaught=false;
 process.once('uncaughtException',()=>{uncaught=true;controller.abort();});
 try{await startGateway({gatewayScript:${JSON.stringify(join(root,'gateway.mjs'))},cwd:${JSON.stringify(root)},signal:controller.signal,timeoutMs:1000,loginTimeoutMs:1000,stopGraceMs:50,env:{HOME:${JSON.stringify(root)},KCODER_CONFIG_DIR:${JSON.stringify(root)},KCODER_STUDIO_DATA_DIR:${JSON.stringify(root)},KCODER_BOOTSTRAP_MODE:${JSON.stringify(mode)}}});console.log(JSON.stringify({rejected:false,uncaught}));}
 catch(error){console.log(JSON.stringify({rejected:true,uncaught,message:error.message}));}`;
 const result=await run(process.execPath,['--input-type=module','-e',code],{timeout:3000,maxBuffer:1024*1024});
 const observed=JSON.parse(result.stdout.trim());assert.equal(observed.rejected,true);assert.equal(observed.uncaught,false);
});

test('main preserves the original operator Relay default behind desktop-specific overrides',async t=>{
 const root=await fixture(t);
 const result=await run(process.execPath,['--experimental-vm-modules',new URL('./fixtures/bootstrap-main-probe.mjs',import.meta.url).pathname,root],{timeout:12000,maxBuffer:1024*1024});
 assert.equal(JSON.parse(result.stdout.trim()).relayDefault,'https://owned-operator.invalid');
});

test('known desktop credentials cannot leak through split stdout or encoded stderr diagnostics',async t=>{
 const root=await fixture(t),module=new URL(process.env.KCODER_BOOTSTRAP_GATEWAY_MODULE || './gateway-process.mjs',import.meta.url).href;
 const code=`import{startGateway}from${JSON.stringify(module)};let stdout='',stderr='';const token='owned-stdio-~token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
 const gateway=await startGateway({token,gatewayScript:${JSON.stringify(join(root,'gateway.mjs'))},cwd:${JSON.stringify(root)},timeoutMs:1000,stopGraceMs:50,env:{HOME:${JSON.stringify(root)},KCODER_STUDIO_DATA_DIR:${JSON.stringify(root)},KCODER_BOOTSTRAP_MODE:'log-token'},onStdout:chunk=>{stdout+=chunk;},onStderr:chunk=>{stderr+=chunk;}});await gateway.stop();
 console.log(JSON.stringify({raw:stdout.includes(token),encoded:stderr.includes(new URLSearchParams({token}).toString().slice(6)),banner:stdout.includes('KCoder Studio: http://127.0.0.1:')}));`;
 const result=await run(process.execPath,['--input-type=module','-e',code],{timeout:3000,maxBuffer:1024*1024});
 assert.deepEqual(JSON.parse(result.stdout.trim()),{raw:false,encoded:false,banner:true});
});

for(const scenario of ['refresh-error','window-closed','initial-crash','quit-menu'])test(`actual main keeps process recovery independent of ${scenario}`,async t=>{
 const root=await fixture(t);
 const result=await run(process.execPath,['--experimental-vm-modules',new URL('./fixtures/bootstrap-main-probe.mjs',import.meta.url).pathname,root,scenario],{timeout:12000,maxBuffer:1024*1024});
 const observed=JSON.parse(result.stdout.trim());assert.equal(observed.starts,2);assert.equal(observed.exitedBeforeQuit,false);assert.equal(observed.exitFacts.code,0);if(scenario==='quit-menu')assert.equal(observed.dialogCount,0);
});

for(const [scenario,starts,exitCode] of [
 ['storage-stop-pending',2,0],
 ['storage-stop-relaunch',2,0],
 ['storage-stop-unconfirmed',1,1],
])test(`actual main migration shutdown settles ${scenario} without a late restart`,async t=>{
 const root=await fixture(t);
 const result=await run(process.execPath,['--experimental-vm-modules',new URL('./fixtures/bootstrap-main-probe.mjs',import.meta.url).pathname,root,scenario],{timeout:12000,maxBuffer:1024*1024});
 const observed=JSON.parse(result.stdout.trim());
 assert.equal(observed.syntheticElectron,true);assert.equal(observed.realOwnedGatewayProcesses,true);
 assert.equal(observed.starts,starts);assert.equal(observed.startsBeforeQuit,starts);
 assert.equal(observed.exitFacts.code,exitCode);assert.deepEqual(observed.exitFacts.ownedAlive,[]);
 assert.equal(observed.relaunchCalls,0,'migration stop must revoke the host relaunch intent');
});

for(const mode of ['split-ready','exit-token'])test(`real Gateway ${mode} keeps framing and credentials safe`,async t=>{
 const root=await fixture(t),module=new URL(process.env.KCODER_BOOTSTRAP_GATEWAY_MODULE||'./gateway-process.mjs',import.meta.url).href;
 const code=`import{startGateway}from${JSON.stringify(module)};const token='owned-framing-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';let success=false,message='';try{const gateway=await startGateway({token,gatewayScript:${JSON.stringify(join(root,'gateway.mjs'))},cwd:${JSON.stringify(root)},timeoutMs:1000,stopGraceMs:50,env:{HOME:${JSON.stringify(root)},KCODER_STUDIO_DATA_DIR:${JSON.stringify(root)},KCODER_BOOTSTRAP_MODE:${JSON.stringify(mode)}}});success=true;await gateway.stop();}catch(error){message=error.message;}console.log(JSON.stringify({success,leak:message.includes(token)}));`;
 const result=await run(process.execPath,['--input-type=module','-e',code],{timeout:3000,maxBuffer:1024*1024});assert.deepEqual(JSON.parse(result.stdout.trim()),{success:mode==='split-ready',leak:false});
});

for(const scenario of ['profile-dev','profile-package'])test(`actual ${scenario} forwards a launch-only profile and retains an existing overlay`,async t=>{
 const root=await fixture(t),overlay=join(root,'desktop-profile-overlay.json'),original='{"original":"preserve"}\n';await writeFile(overlay,original,{mode:0o600});
 const result=await run(process.execPath,['--experimental-vm-modules',new URL('./fixtures/bootstrap-main-probe.mjs',import.meta.url).pathname,root,scenario],{timeout:12000,maxBuffer:1024*1024});
 const observed=JSON.parse(result.stdout.trim());assert.equal(observed.profileLaunchInput.profile,'owned-main-profile');assert.equal(observed.profileLaunchInput.host,'1');assert.equal(observed.profileLaunchInput.store,join(root,'servers.json'));assert.equal(observed.profileLaunchInput.inline,undefined);assert.equal(await readFile(overlay,'utf8'),original);assert.equal(observed.starts,1);
});
