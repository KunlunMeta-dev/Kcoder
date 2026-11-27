import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { chmod, cp, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayDeviceAuth } from '../gateway-device-auth.js';
import { loadStorageNative } from '../storage-lease.mjs';
import { ChannelStore } from '../../../kcoder-channel-host/src/channels/store.mjs';
import { createFixtureStore } from '../../../kcoder-channel-host/test/store-fixture.mjs';
import * as relay from '../../../kcoder-relay/src/client-identity.mjs';
import { dispatchGatewayStorageDomains } from './gateway-storage-domains.mjs';
import { loadProductAccountCookieScopeRoot, PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE } from '../gateway-product-account.js';

const entry=fileURLToPath(new URL('./gateway-storage-domains.mjs',import.meta.url));
const operationId='owned-operation',primaryName='kcoder-storage-writers.lock',secondaryName='kcoder-storage-instances.lock';
const relayUrl='https://relay.example.test',secret='original-private-gateway-secret-01234567890123456789';

async function fixture(t){
  const root=await mkdtemp(join(await realpath(tmpdir()),'gateway-owner-child-'));
  const source=join(root,'Source'),finalTarget=join(root,'Target'),native=await loadStorageNative(),leases=[],roots=[];
  t.after(()=>{for(const lease of leases)native.close(lease);return rm(root,{recursive:true,force:true});});
  const identity=async path=>{const info=await stat(path,{bigint:true});return JSON.stringify({device:String(info.dev),inode:String(info.ino)});};
  for(const directory of [source,finalTarget]){
    await mkdir(directory,{mode:0o700});
    const lease=native.tryExclusive(directory,primaryName,false);assert.ok(lease);leases.push(lease);
    const secondary=native.tryShared(directory,secondaryName,false);assert.ok(secondary);native.close(secondary);
    roots.push({root:directory,directoryIdentity:await identity(directory),primaryIdentity:await identity(join(directory,primaryName)),
      secondaryIdentity:await identity(join(directory,secondaryName))});
  }
  return {root,source,finalTarget,native,leases,roots};
}

async function child(t,f,payload,accept=()=>true){
  const processChild=spawn(process.execPath,[entry],{stdio:['pipe','pipe','pipe']});
  const exit=once(processChild,'exit');let stderr='';
  processChild.stdin.on('error',()=>{});
  processChild.stderr.setEncoding('utf8');processChild.stderr.on('data',part=>{stderr=(stderr+part).slice(-8192);});
  t.after(async()=>{
    processChild.stdin.destroy();
    if(processChild.exitCode===null&&processChild.signalCode===null)processChild.kill('SIGKILL');
    await exit;
  });
  const frames=[],reader=createInterface({input:processChild.stdout})[Symbol.asyncIterator]();
  const send=frame=>processChild.stdin.write(JSON.stringify(frame)+'\n');
  send({type:'initialize',version:1,operationId,roots:f.roots,payload});
  let value;
  while(true){
    let timer,received;
    try{received=await Promise.race([reader.next(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('owner child deadline')),15000);})]);}
    finally{clearTimeout(timer);}
    if(received.done)break;
    const frame=JSON.parse(received.value);frames.push(frame);
    assert.equal(frame.operationId,operationId);assert.equal(frame.version,1);
    if(frame.type==='validateFences'||frame.type==='validateOffline'){
      for(const lease of f.leases)f.native.verify(lease);
      if(frame.type==='validateFences')assert.deepEqual(frame.facts,f.roots);
      const allowed=frame.type==='validateFences'||accept(frame.facts);
      send({type:allowed?'validated':'rejected',version:1,operationId,sequence:frame.sequence});
    }else if(frame.type==='completed')value=frame.value;
    else assert.equal(frame.type,'ready');
  }
  const [code]=await exit;
  return {code,stderr,value,frames};
}

test('strict schema rejects every entry before a business probe, including duplicates and unknown fields',async()=>{
  let checks=0;
  const context={operationId,validateOffline:()=>{checks++;return true;}},valid={kind:'mobile',source:'/never-open-source',finalTarget:'/never-open-target'};
  for(const payload of [
    {version:1,phase:'relocate',domains:[valid,{...valid,kind:'unknown'}]},
    {version:1,phase:'relocate',domains:[{...valid,kind:'channels',sourceReadDirectory:'relative'}]},
    {version:1,phase:'relocate',domains:[{...valid,kind:'channels',sourceReadDirectory:valid.source}]},
    {version:1,phase:'relocate',domains:[valid,valid]},
    {version:1,phase:'relocate',domains:[{kind:'mobile',source:valid.source}]},
    {version:1,phase:'relocate',domains:[{...valid,stopped:true}]},
    {version:1,phase:'relocate',domains:[],allow:true},
    {version:1,phase:'relocate',domains:[{kind:'sealed',source:valid.source,finalTarget:valid.finalTarget,namespaceId:'namespace'}]},
    {version:1,phase:'relocate',domains:[{...valid,kind:'relay',relayUrl,sourceIdentityFile:'../../outside'}]},
    {version:1,domains:[]},
  ])await assert.rejects(dispatchGatewayStorageDomains(payload,context),error=>['GATEWAY_OFFLINE_PAYLOAD_INVALID','GATEWAY_RELOCATION_INVALID_PATH'].includes(error.code));
  assert.equal(checks,0);
});

test('real one-shot child completes an empty plan through the existing fence protocol',async t=>{
  const f=await fixture(t),result=await child(t,f,{version:1,phase:'relocate',domains:[]});
  assert.equal(result.code,0,result.stderr);
  assert.deepEqual(result.value,{version:1,phase:'relocate',operationId,domains:[]});
  assert.deepEqual(result.frames.map(frame=>frame.type),['validateFences','validateFences','ready','validateFences','validateFences','completed']);
});

test('absent domains are reported without creating a profile or store',async t=>{
  const f=await fixture(t),domains=[
    {kind:'mobile',source:f.source,finalTarget:f.finalTarget},
    {kind:'channels',source:join(f.source,'channels'),finalTarget:join(f.finalTarget,'channels')},
    {kind:'relay',source:f.source,finalTarget:f.finalTarget,relayUrl},
    {kind:'sealed',source:join(f.source,'sealed'),finalTarget:join(f.finalTarget,'sealed'),namespaceId:'namespace',initializationId:'original-init'},
  ];
  const result=await child(t,f,{version:1,phase:'relocate',domains});assert.equal(result.code,0,result.stderr);
  assert.deepEqual(result.value.domains.map(row=>row.state),['absent','absent','absent','absent']);
  await assert.rejects(stat(join(f.source,'mobile-device-auth')),{code:'ENOENT'});
  await assert.rejects(stat(join(f.finalTarget,'channels')),{code:'ENOENT'});
  assert.equal(result.frames.some(frame=>frame.facts?.purpose==='nativeStoreLease'),false);
});

test('product account cookie scope freezes one seed and verifies the raw copied target',async t=>{
  const f=await fixture(t),domain={kind:'productAccountCookieScope',source:f.source,finalTarget:f.finalTarget};
  const source=await child(t,f,{version:1,phase:'prepareSource',domains:[domain]},facts=>{
    if(facts.domain==='gateway-product-account-cookie-scope'&&facts.purpose==='productAccountScopeSource'){
      assert.equal(facts.operationId,operationId);assert.equal(facts.source,f.source);assert.equal(facts.finalTarget,f.finalTarget);
    }
    return true;
  });
  assert.equal(source.code,0,source.stderr);
  assert.deepEqual(source.value.domains.map(row=>row.state),['prepared']);
  const frozen=await readFile(join(f.source,PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE));
  await copyFile(join(f.source,PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE),join(f.finalTarget,PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE));
  const result=await child(t,f,{version:1,phase:'relocate',domains:[domain]},facts=>{
    if(facts.domain==='gateway-product-account-cookie-scope'&&facts.purpose==='productAccountScopePublished'){
      assert.equal(facts.operationId,operationId);assert.equal(facts.source,f.source);assert.equal(facts.finalTarget,f.finalTarget);
    }
    return true;
  });
  assert.equal(result.code,0,result.stderr);
  assert.deepEqual(result.value.domains.map(row=>row.state),['prepared']);
  assert.deepEqual(await readFile(join(f.source,PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE)),frozen);
  const target=JSON.parse(await readFile(join(f.finalTarget,PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE),'utf8'));
  assert.deepEqual(target,{version:1,scopeRoot:f.source});
  assert.deepEqual(await readFile(join(f.finalTarget,PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE)),frozen);
  assert.equal(await loadProductAccountCookieScopeRoot(f.finalTarget),f.source);
  const targetPath=join(f.finalTarget,PRODUCT_ACCOUNT_COOKIE_SCOPE_FILE),before=await readFile(targetPath),info=await stat(targetPath,{bigint:true});
  const verified=await child(t,f,{version:1,phase:'verify',domains:[domain]});
  assert.equal(verified.code,0,verified.stderr);assert.equal(verified.value.phase,'verify');
  assert.deepEqual(verified.value.domains[0].value,{version:1,state:'verified'});
  assert.deepEqual(await readFile(targetPath),before);assert.equal((await stat(targetPath,{bigint:true})).mtimeNs,info.mtimeNs);
});

test('actual child dispatch preserves pairing, channel identity and Relay registration without business startup',async t=>{
  const f=await fixture(t),auth=createGatewayDeviceAuth({directory:f.source,identity:'original-gateway'}),paired=await auth.pair('Original phone');
  const ledger=await readFile(join(f.source,'mobile-device-auth/devices.json'));
  await cp(join(f.source,'mobile-device-auth'),join(f.finalTarget,'mobile-device-auth'),{recursive:true});
  await chmod(join(f.finalTarget,'mobile-device-auth'),0o700);
  const channelsSource=join(f.source,'channels'),channelsTarget=join(f.finalTarget,'channels'),channels=new ChannelStore(channelsSource);
  const installationId=channels.installationId;channels.close();
  await cp(channelsSource,channelsTarget,{recursive:true});await chmod(channelsTarget,0o700);
  const sourceReadDirectory=join(f.root,'SourceRead'),targetReadDirectory=join(f.root,'TargetRead');
  await cp(channelsSource,sourceReadDirectory,{recursive:true});await chmod(sourceReadDirectory,0o700);
  await cp(channelsTarget,targetReadDirectory,{recursive:true});await chmod(targetReadDirectory,0o700);
  for(const directory of [f.source,f.finalTarget]){
    await mkdir(join(directory,'desktop-relay'),{mode:0o700});await writeFile(join(directory,'desktop-relay/gateway-secret'),secret+'\n',{mode:0o600});
  }
  const identityFile=join(f.source,'relay/client-identity.json');
  const {enrollmentToken}=await relay.prepareClientIdentity({identityFile,relayUrl,gatewaySecret:secret});
  await relay.saveRegisteredClientIdentity({identityFile,relayUrl,gatewaySecret:secret,enrollmentToken,id:'original-gateway',secret:'original-relay-issued-secret-01234567890123456789'});
  const selected=[{kind:'mobile',source:f.source,finalTarget:f.finalTarget},
    {kind:'channels',source:channelsSource,finalTarget:channelsTarget,sourceReadDirectory,targetReadDirectory},{kind:'relay',source:f.source,finalTarget:f.finalTarget,relayUrl}];
  const expected=[['gateway-device-pairing',f.source,f.finalTarget],['gateway-channels',channelsSource,channelsTarget],['gateway-relay',f.source,f.finalTarget],
    ['gateway-relay-identity',identityFile,join(f.finalTarget,'relay/client-identity.json')]];
  const result=await child(t,f,{version:1,phase:'relocate',domains:selected},facts=>{
    assert.equal(facts.operationId,operationId);
    assert.ok(expected.some(([domain,source,finalTarget])=>facts.domain===domain&&facts.source===source&&facts.finalTarget===finalTarget));
    assert.equal(facts.purpose,undefined);return true;
  });
  assert.equal(result.code,0,result.stderr);
  assert.deepEqual(result.value.domains.map(row=>row.state),['prepared','prepared','prepared']);
  assert.equal(result.value.domains[1].value.installationId,installationId);assert.equal(result.value.domains[2].value.id,'original-gateway');
  assert.deepEqual(await readFile(join(f.source,'mobile-device-auth/devices.json')),ledger);
  const moved=createGatewayDeviceAuth({directory:f.finalTarget,identity:'original-gateway'});
  assert.equal((await moved.inspectAccessAuthorization(paired.accessToken)).authorizationGeneration,paired.authorizationGeneration);
  assert.equal(JSON.stringify(result.frames).includes(secret),false);
  const verified=await child(t,f,{version:1,phase:'verify',domains:selected},facts=>
    expected.some(([domain,source,finalTarget])=>facts.domain===domain&&facts.source===source&&facts.finalTarget===finalTarget));
  assert.equal(verified.code,0,verified.stderr);assert.equal(verified.value.phase,'verify');
  assert.deepEqual(verified.value.domains.map(row=>row.value),result.value.domains.map(row=>row.value));
});

test('a global fence alone cannot authorize the sealed Native lease',async t=>{
  const f=await fixture(t),source=join(f.source,'sealed'),finalTarget=join(f.finalTarget,'sealed');
  // The fixture creates bytes only; it supplies no production Native relocation
  // authority. The live parent must reject the child's separate lease request.
  const store=createFixtureStore(source),{namespaceId,initializationId}=store.storage.binding;store.close();
  await cp(source,finalTarget,{recursive:true});await chmod(finalTarget,0o700);await copyFile(source+'.binding.json',finalTarget+'.binding.json');
  const original=await readFile(finalTarget+'.binding.json');let nativeChecks=0;
  const result=await child(t,f,{version:1,phase:'relocate',domains:[{kind:'sealed',source,finalTarget,namespaceId,initializationId}]},facts=>{
    if(facts.purpose==='nativeStoreLease'){nativeChecks++;return false;}return true;
  });
  assert.equal(result.code,1);assert.match(result.stderr,/STORAGE_OFFLINE_PARENT_REJECTED/);assert.equal(nativeChecks,1);
  assert.equal(result.value,undefined);assert.deepEqual(await readFile(finalTarget+'.binding.json'),original);
  await assert.rejects(stat(finalTarget+'.relocation.json'),{code:'ENOENT'});
});

test('a directory named for a store never causes unknown data to be initialized',async t=>{
  const f=await fixture(t),source=join(f.source,'channels'),finalTarget=join(f.finalTarget,'channels');
  await mkdir(source,{mode:0o700});await mkdir(finalTarget,{mode:0o700});
  for(const root of [source,finalTarget])await writeFile(join(root,'channels.sqlite3'),'unknown original bytes',{mode:0o600});
  const result=await child(t,f,{version:1,phase:'relocate',domains:[{kind:'channels',source,finalTarget}]});
  assert.equal(result.code,1);assert.equal(result.value,undefined);
  assert.equal(await readFile(join(source,'channels.sqlite3'),'utf8'),'unknown original bytes');
  assert.equal(await readFile(join(finalTarget,'channels.sqlite3'),'utf8'),'unknown original bytes');
});

test('source preparation settles only the observed Relay identity before inventory and reports exact owned paths',async t=>{
  const f=await fixture(t),identityFile=join(f.source,'relay/client-identity.json');
  await mkdir(join(f.source,'relay'),{mode:0o700});await mkdir(join(f.source,'desktop-relay'),{mode:0o700});
  await writeFile(join(f.source,'desktop-relay/gateway-secret'),secret+'\n',{mode:0o600});
  const {createHash}=await import('node:crypto');
  await writeFile(identityFile,JSON.stringify({version:1,relayOrigin:relayUrl,gatewaySecretHash:createHash('sha256').update(secret).digest('hex'),
    id:'original-gateway',secret:'original-issued-registration-secret-01234567890123456789'}),{mode:0o600});
  const domains=[{kind:'relay',source:f.source,finalTarget:f.finalTarget,relayUrl},{kind:'mobile',source:f.source,finalTarget:f.finalTarget}];
  const result=await child(t,f,{version:1,phase:'prepareSource',domains},facts=>{
    if(facts.domain==='gateway-relay-identity-source')assert.deepEqual(facts,{domain:'gateway-relay-identity-source',source:identityFile,finalTarget:identityFile,operationId});
    else assert.ok(['gateway-relay','gateway-device-pairing'].includes(facts.domain));
    return true;
  });
  assert.equal(result.code,0,result.stderr);assert.equal(result.value.phase,'prepareSource');
  const value=result.value.domains[0].value;
  assert.equal(value.paths.projection,identityFile);assert.equal(value.paths.referenceDirectory,identityFile+'.state-v2');
  const metadataLease=f.native.tryExclusive(f.source,secondaryName,false);assert.ok(metadataLease);
  try{for(const [kind,path] of Object.entries(value.paths)){
    const info=await stat(path,{bigint:true});
    const observed=JSON.parse(f.native.observeEntry(metadataLease,relative(f.source,path),info.isDirectory()?'directory':'file'));
    assert.deepEqual(value.identities[kind],observed);
    assert.equal(observed.links,info.isDirectory()?null:String(info.nlink));
  }}finally{f.native.close(metadataLease);}
  assert.equal(JSON.stringify(result.frames).includes('original-issued-registration-secret'),false);
  assert.equal(await readFile(join(f.source,'desktop-relay/gateway-secret'),'utf8'),secret+'\n');
  await assert.rejects(stat(join(f.finalTarget,'relay')),{code:'ENOENT'});
  const resumed=await child(t,f,{version:1,phase:'prepareSource',domains});
  assert.equal(resumed.code,0,resumed.stderr);assert.deepEqual(resumed.value.domains[0].value,value);
});

test('source preparation rejects a sealed store without fresh Native source-owner proof before copying',async t=>{
  const f=await fixture(t),source=join(f.source,'sealed'),finalTarget=join(f.finalTarget,'sealed');
  const store=createFixtureStore(source),{namespaceId,initializationId}=store.storage.binding;store.close();
  const original=await readFile(source+'.binding.json');
  const result=await child(t,f,{version:1,phase:'prepareSource',domains:[{kind:'sealed',source,finalTarget,namespaceId,initializationId}]},facts=>facts.purpose!=='nativeStoreSource');
  assert.equal(result.code,1);assert.match(result.stderr,/CONNECTIVITY_RELOCATION_SOURCE_PROOF_REQUIRED/);
  assert.deepEqual(await readFile(source+'.binding.json'),original);
  await assert.rejects(stat(finalTarget),{code:'ENOENT'});
});

test('the actual owner child keeps adopted aliases on one target epoch with no extra projection',async t=>{
  const f=await fixture(t),legacy=join(f.source,'desktop-relay/client-identity.json'),current=join(f.source,'relay/client-identity.json');
  await mkdir(join(f.source,'desktop-relay'),{mode:0o700});
  await writeFile(join(f.source,'desktop-relay/gateway-secret'),secret,{mode:0o600});
  await writeFile(legacy,JSON.stringify({version:1,relayOrigin:relayUrl,
    gatewaySecretHash:(await import('node:crypto')).createHash('sha256').update(secret).digest('hex'),
    id:'original-alias-gateway',secret:'original-relay-issued-secret-01234567890123456789'}),{mode:0o600});
  await relay.prepareInstanceIdentityFile({identityFile:current,legacyIdentityFile:legacy,relayUrl,gatewaySecret:secret});
  await assert.rejects(stat(legacy),{code:'ENOENT'});
  const canonical={kind:'relay',source:f.source,finalTarget:f.finalTarget,relayUrl,sourceIdentityFile:'relay/client-identity.json'};
  const alias={...canonical,sourceIdentityFile:'desktop-relay/client-identity.json',sharedIdentityFile:canonical.sourceIdentityFile};
  const prepared=await child(t,f,{version:1,phase:'prepareSource',domains:[canonical,alias]});
  assert.equal(prepared.code,0,prepared.stderr);
  assert.equal(prepared.value.domains[1].value.sharedIdentityFile,current);
  assert.equal(prepared.value.domains[1].value.paths.projection,null);
  for(const name of ['relay','desktop-relay'])await mkdir(join(f.finalTarget,name),{mode:0o700});
  await copyFile(join(f.source,'desktop-relay/gateway-secret'),join(f.finalTarget,'desktop-relay/gateway-secret'));
  for(const phase of ['relocate','relocate','verify']){
    const result=await child(t,f,{version:1,phase,domains:[canonical,alias]});
    assert.equal(result.code,0,result.stderr);
  }
  const target=join(f.finalTarget,canonical.sourceIdentityFile),targetAlias=join(f.finalTarget,alias.sourceIdentityFile);
  const a=JSON.parse(await readFile(target+'.state-v2/reference.json')),b=JSON.parse(await readFile(targetAlias+'.state-v2/reference.json'));
  assert.equal(a.epoch,b.epoch);assert.equal(a.generation,b.generation);
  await assert.rejects(stat(targetAlias),{code:'ENOENT'});
  await relay.prepareInstanceIdentityFile({identityFile:target,legacyIdentityFile:targetAlias,relayUrl,gatewaySecret:secret});
  await relay.revokeClientIdentity({identityFile:targetAlias});
  for(const identityFile of [target,targetAlias])await assert.rejects(relay.readRegisteredClientIdentity({identityFile,relayUrl,gatewaySecret:secret}),{code:'RELAY_IDENTITY_REVOKED'});
});
