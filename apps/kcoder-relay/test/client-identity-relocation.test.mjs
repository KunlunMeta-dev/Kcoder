import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareClientIdentity, prepareInstanceIdentityFile, readClientIdentitySnapshot, readClientIdentityState,
  readRegisteredClientIdentity, revokeClientIdentity, saveRegisteredClientIdentity, verifyInstanceIdentityRelocation } from '../src/client-identity.mjs';

const relayUrl='https://relay.example.test',gatewaySecret='original-owned-gateway-secret-01234567890123456789',secret='original-relay-issued-secret-01234567890123456789';
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'kcoder-relay-relocation-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=join(directory,'source','client-identity.json'),finalTarget=join(directory,'target','client-identity.json');
  const {enrollmentToken}=await prepareClientIdentity({identityFile:source,relayUrl,gatewaySecret});
  await saveRegisteredClientIdentity({identityFile:source,relayUrl,gatewaySecret,enrollmentToken,id:'original-gateway',secret});
  return {directory,source,finalTarget,options:{identityFile:finalTarget,legacyIdentityFile:source,relayUrl,gatewaySecret,
    relocation:{operationId:'original-operation',validateOffline:()=>{}}}};
}

test('offline owner preserves the exact generation/registration chain in an independent target',async t=>{
  const f=await fixture(t),original=await readClientIdentitySnapshot({identityFile:f.source});
  const sourceReference=await readFile(join(f.source+'.state-v2','reference.json'));
  assert.equal(await prepareInstanceIdentityFile(f.options),f.finalTarget);
  assert.deepEqual(await readClientIdentitySnapshot({identityFile:f.finalTarget}),original);
  assert.deepEqual(await readFile(join(f.source+'.state-v2','reference.json')),sourceReference);
  assert.equal((await readRegisteredClientIdentity({identityFile:f.finalTarget,relayUrl,gatewaySecret})).id,'original-gateway');
  assert.equal(await prepareInstanceIdentityFile(f.options),f.finalTarget);
  await assert.rejects(prepareInstanceIdentityFile({...f.options,relocation:{...f.options.relocation,operationId:'other-operation'}}),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  await rm(dirname(f.source),{recursive:true});
  assert.equal((await readRegisteredClientIdentity({identityFile:f.finalTarget,relayUrl,gatewaySecret})).secret,secret);
});

test('revocation is retained and never becomes a fresh registration',async t=>{
  const f=await fixture(t);await revokeClientIdentity({identityFile:f.source});
  await prepareInstanceIdentityFile(f.options);
  assert.equal((await readClientIdentityState({identityFile:f.finalTarget})).status,'revoked');
  await assert.rejects(readRegisteredClientIdentity({identityFile:f.finalTarget,relayUrl,gatewaySecret}),{code:'RELAY_IDENTITY_REVOKED'});
  const empty=join(f.directory,'denied-source','client-identity.json'),destination=join(f.directory,'denied-target','client-identity.json');
  await revokeClientIdentity({identityFile:empty});
  await prepareInstanceIdentityFile({...f.options,legacyIdentityFile:empty,identityFile:destination});
  assert.deepEqual(await readClientIdentityState({identityFile:destination}),{status:'revoked',relayOrigin:null});
});

test('source revocation after preflight blocks publication and the old operation cannot replay it',async t=>{
  const f=await fixture(t);let calls=0;
  const changed={...f.options,relocation:{...f.options.relocation,validateOffline:async()=>{if(++calls===3)await revokeClientIdentity({identityFile:f.source});}}};
  await assert.rejects(prepareInstanceIdentityFile(changed),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  await assert.rejects(prepareInstanceIdentityFile(f.options),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  assert.equal(await readClientIdentityState({identityFile:f.finalTarget}),null);
});

test('lost target acknowledgement reconciles only the same operation and never overwrites unknown preparation',async t=>{
  const f=await fixture(t);let calls=0;
  await assert.rejects(prepareInstanceIdentityFile({...f.options,relocation:{...f.options.relocation,validateOffline:()=>{if(++calls===4)throw Error('lost-ack');}}}),/lost-ack/);
  const receipt=await readFile(join(f.finalTarget+'.relocation-v1','reference.json'));
  await prepareInstanceIdentityFile(f.options);
  assert.deepEqual(await readFile(join(f.finalTarget+'.relocation-v1','reference.json')),receipt);
  const unknown=join(f.directory,'unknown','client-identity.json');
  await mkdir(unknown+'.relocation-v1',{recursive:true,mode:0o700});
  await writeFile(join(unknown+'.relocation-v1','reference.json'),'{"unknown":true}',{mode:0o600});
  await assert.rejects(prepareInstanceIdentityFile({...f.options,identityFile:unknown}),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  assert.equal(await readFile(join(unknown+'.relocation-v1','reference.json'),'utf8'),'{"unknown":true}');
});

test('legacy owner upgrade retains the seed and remains usable when the target is discarded',async t=>{
  const f=await fixture(t),source=join(f.directory,'legacy','identity.json');
  await mkdir(dirname(source),{mode:0o700});
  const bytes=JSON.stringify({version:1,relayOrigin:relayUrl,gatewaySecretHash:createHash('sha256').update(gatewaySecret).digest('hex'),id:'legacy-gateway',secret});
  await writeFile(source,bytes,{mode:0o600});
  await assert.rejects(prepareInstanceIdentityFile({...f.options,legacyIdentityFile:source}),{code:'RELAY_IDENTITY_SOURCE_PREPARATION_REQUIRED'});
  const prepared=await prepareInstanceIdentityFile({identityFile:source,relayUrl,gatewaySecret,
    relocation:{...f.options.relocation,phase:'prepareSource'}});
  assert.equal(await readFile(join(prepared.paths.epochDirectory,'legacy-seed.json'),'utf8'),bytes);
  const projection=await readFile(source);
  await prepareInstanceIdentityFile({...f.options,legacyIdentityFile:source});
  assert.deepEqual(await readFile(source),projection);
  await rm(dirname(f.finalTarget),{recursive:true});
  assert.equal((await readRegisteredClientIdentity({identityFile:source,relayUrl,gatewaySecret})).id,'legacy-gateway');
});

test('source preparation never initializes a missing identity or excludes an unknown epoch tree',async t=>{
  const f=await fixture(t),source=join(f.directory,'absent','identity.json');
  await assert.rejects(prepareInstanceIdentityFile({identityFile:source,relayUrl,gatewaySecret,relocation:{...f.options.relocation,phase:'prepareSource'}}),
    {code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  await assert.rejects(stat(source),{code:'ENOENT'});
  await assert.rejects(stat(source+'.state-v2'),{code:'ENOENT'});
  const options={identityFile:f.source,relayUrl,gatewaySecret,relocation:{...f.options.relocation,phase:'prepareSource'}};
  const prepared=await prepareInstanceIdentityFile(options);
  const unknown=join(dirname(f.source),'.relay-identity-generation-'+'a'.repeat(64));
  await mkdir(unknown,{mode:0o700});await writeFile(join(unknown,'original-persistent-data'),'keep',{mode:0o600});
  const same=await prepareInstanceIdentityFile(options);
  assert.deepEqual(same,prepared);assert.equal(Object.values(same.paths).includes(unknown),false);
  await writeFile(join(prepared.paths.epochDirectory,'unknown-persistent-data'),'preserve',{mode:0o600});
  await assert.rejects(prepareInstanceIdentityFile(options),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  assert.equal(await readFile(join(prepared.paths.epochDirectory,'unknown-persistent-data'),'utf8'),'preserve');
});

test('the legacy startup API can preserve its original seed without changing default adoption',async t=>{
  const f=await fixture(t),source=join(f.directory,'old','identity.json'),target=join(f.directory,'preserved','identity.json');
  await mkdir(dirname(source),{mode:0o700});
  await writeFile(source,JSON.stringify({version:1,relayOrigin:relayUrl,gatewaySecretHash:createHash('sha256').update(gatewaySecret).digest('hex'),id:'legacy-gateway',secret}),{mode:0o600});
  await prepareInstanceIdentityFile({identityFile:target,legacyIdentityFile:source,relayUrl,gatewaySecret,preserveSource:true});
  assert.ok(await stat(source));
  assert.equal((await readRegisteredClientIdentity({identityFile:target,relayUrl,gatewaySecret})).id,'legacy-gateway');
});

test('completed transfer verification reads the original receipts without publishing or reconciling them',async t=>{
  const f=await fixture(t);await prepareInstanceIdentityFile(f.options);
  const snapshot=async root=>{
    const result=[];
    for(const name of (await readdir(root)).sort()){
      const path=join(root,name),info=await stat(path,{bigint:true});
      result.push([name,String(info.ino),String(info.size),String(info.mtimeNs),info.isDirectory()?await snapshot(path):(await readFile(path)).toString('hex')]);
    }
    return result;
  };
  const options={...f.options,operationId:f.options.relocation.operationId,validateOffline:()=>true};
  const before=await snapshot(f.directory);
  const value=await verifyInstanceIdentityRelocation(options);
  assert.equal(value.status,'registered');assert.equal(value.generation.length,64);
  assert.deepEqual(await snapshot(f.directory),before);
  await assert.rejects(verifyInstanceIdentityRelocation({...options,operationId:'other-operation'}),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  const receipt=join(f.finalTarget+'.relocation-v1','reference.json');
  await writeFile(receipt,'{"unknown":true}\n');
  await assert.rejects(verifyInstanceIdentityRelocation(options),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  assert.equal(await readFile(receipt,'utf8'),'{"unknown":true}\n');
});

test('later offline moves expose only the current owned receipt and keep one generation without a mapping chain',async t=>{
  const f=await fixture(t),original=await readClientIdentitySnapshot({identityFile:f.source});
  await prepareInstanceIdentityFile(f.options);
  let source=f.finalTarget;
  for(const [index,name] of ['third','fourth'].entries()){
    const operationId=`later-move-${index}`,identityFile=join(f.directory,name,'client-identity.json');
    const options={identityFile,legacyIdentityFile:source,relayUrl,gatewaySecret,
      relocation:{operationId,validateOffline:()=>true}};
    const receiptPath=source+'.relocation-v1',receiptBytes=await readFile(join(receiptPath,'reference.json'));
    const prepared=await prepareInstanceIdentityFile({identityFile:source,relayUrl,gatewaySecret,
      relocation:{...options.relocation,phase:'prepareSource'}});
    assert.equal(prepared.paths.transferReceiptDirectory,receiptPath);
    assert.equal(prepared.paths.transferReceiptFile,join(receiptPath,'reference.json'));
    assert.ok(prepared.identities.transferReceiptDirectory.ino);
    assert.ok(prepared.identities.transferReceiptFile.ino);
    await prepareInstanceIdentityFile(options);
    await verifyInstanceIdentityRelocation({...options,operationId,validateOffline:()=>true});
    assert.deepEqual(await readFile(join(receiptPath,'reference.json')),receiptBytes);
    assert.deepEqual(await readClientIdentitySnapshot({identityFile}),original);
    const current=JSON.parse(await readFile(join(identityFile+'.relocation-v1','reference.json')));
    assert.equal(current.operationId,operationId);
    assert.deepEqual(Object.keys(current).sort(),['domain','finalTarget','operationId','source','sourceIdentity','version']);
    assert.equal((await readdir(dirname(identityFile))).filter(name=>name.endsWith('.relocation-v1')).length,1);
    assert.equal((await readdir(dirname(identityFile))).filter(name=>name.startsWith('.relay-identity-generation-')).length,1);
    source=identityFile;
  }
  await revokeClientIdentity({identityFile:source});
  const identityFile=join(f.directory,'revoked-target','client-identity.json');
  await prepareInstanceIdentityFile({identityFile,legacyIdentityFile:source,relayUrl,gatewaySecret,
    relocation:{operationId:'move-revoked-tail',validateOffline:()=>true}});
  assert.equal((await readClientIdentityState({identityFile})).status,'revoked');
  await assert.rejects(readRegisteredClientIdentity({identityFile,relayUrl,gatewaySecret}),{code:'RELAY_IDENTITY_REVOKED'});
});

test('source preparation preserves and refuses an unknown prior receipt or unrecognized receipt content',async t=>{
  const f=await fixture(t);await prepareInstanceIdentityFile(f.options);
  const directory=f.finalTarget+'.relocation-v1',path=join(directory,'reference.json');
  const original=await readFile(path),options={identityFile:f.finalTarget,relayUrl,gatewaySecret,
    relocation:{operationId:'next-move',phase:'prepareSource',validateOffline:()=>true}};
  for(const change of [value=>({...value,unknown:true}),value=>({...value,finalTarget:f.source}),
    value=>({...value,sourceIdentity:{...value.sourceIdentity,decision:'f'.repeat(64)}})]){
    const bytes=JSON.stringify(change(JSON.parse(original)));
    await writeFile(path,bytes,{mode:0o600});
    await assert.rejects(prepareInstanceIdentityFile(options),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
    assert.equal(await readFile(path,'utf8'),bytes);
  }
  await writeFile(path,original,{mode:0o600});
  await writeFile(join(directory,'unknown-persistent-data'),'preserve',{mode:0o600});
  await assert.rejects(prepareInstanceIdentityFile(options),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  assert.equal(await readFile(join(directory,'unknown-persistent-data'),'utf8'),'preserve');
});

for(const revokeAlias of [false,true])test(`real legacy adoption keeps one epoch through two stopped moves and revocation from ${revokeAlias?'legacy alias':'current identity'}`,async t=>{
  const f=await fixture(t),sourceRoot=join(f.directory,`adopted-${revokeAlias}`);
  const names={current:'relay/client-identity.json',alias:'desktop-relay/client-identity.json'};
  let current=join(sourceRoot,names.current),alias=join(sourceRoot,names.alias);
  await mkdir(dirname(alias),{recursive:true,mode:0o700});
  await writeFile(alias,JSON.stringify({version:1,relayOrigin:relayUrl,
    gatewaySecretHash:createHash('sha256').update(gatewaySecret).digest('hex'),id:'legacy-original-gateway',secret}),{mode:0o600});
  await prepareInstanceIdentityFile({identityFile:current,legacyIdentityFile:alias,relayUrl,gatewaySecret});
  await assert.rejects(stat(alias),{code:'ENOENT'});
  const original=await readClientIdentitySnapshot({identityFile:current});
  for(let move=0;move<2;move++){
    const targetRoot=join(f.directory,`alias-target-${revokeAlias}-${move}`),target=join(targetRoot,names.current),targetAlias=join(targetRoot,names.alias);
    const operationId=`shared-alias-${move}`,authority=()=>true;
    await prepareInstanceIdentityFile({identityFile:current,relayUrl,gatewaySecret,
      relocation:{operationId,phase:'prepareSource',validateOffline:authority}});
    const sourceAlias=await prepareInstanceIdentityFile({identityFile:alias,relayUrl,gatewaySecret,
      relocation:{operationId,phase:'prepareSource',sharedIdentityFile:current,validateOffline:authority}});
    assert.equal(sourceAlias.sharedIdentityFile,current);
    assert.equal(sourceAlias.paths.projection,null);
    await prepareInstanceIdentityFile({identityFile:target,legacyIdentityFile:current,relayUrl,gatewaySecret,
      relocation:{operationId,validateOffline:authority}});
    const aliasOptions={identityFile:targetAlias,legacyIdentityFile:alias,relayUrl,gatewaySecret,
      relocation:{operationId,sharedIdentityFile:target,sourceSharedIdentityFile:current,validateOffline:authority}};
    await prepareInstanceIdentityFile(aliasOptions);
    await prepareInstanceIdentityFile(aliasOptions);
    await verifyInstanceIdentityRelocation({...aliasOptions,operationId,validateOffline:authority,
      sharedIdentityFile:target,sourceSharedIdentityFile:current});
    await prepareInstanceIdentityFile({identityFile:target,legacyIdentityFile:targetAlias,relayUrl,gatewaySecret});
    assert.deepEqual(await readClientIdentitySnapshot({identityFile:targetAlias}),original);
    assert.deepEqual(await readClientIdentitySnapshot({identityFile:target}),original);
    const reference=JSON.parse(await readFile(target+'.state-v2/reference.json'));
    const secondary=JSON.parse(await readFile(targetAlias+'.state-v2/reference.json'));
    assert.equal(secondary.epoch,reference.epoch);
    assert.equal(secondary.generation,reference.generation);
    await assert.rejects(stat(targetAlias),{code:'ENOENT'});
    current=target;alias=targetAlias;
  }
  await revokeClientIdentity({identityFile:revokeAlias?alias:current});
  for(const identityFile of [current,alias])await assert.rejects(readRegisteredClientIdentity({identityFile,relayUrl,gatewaySecret}),{code:'RELAY_IDENTITY_REVOKED'});
});

test('an offline alias never adopts a different real epoch even with identical assignment bytes',async t=>{
  const f=await fixture(t),other=join(f.directory,'other-epoch','client-identity.json');
  const {enrollmentToken}=await prepareClientIdentity({identityFile:other,relayUrl,gatewaySecret});
  await saveRegisteredClientIdentity({identityFile:other,relayUrl,gatewaySecret,enrollmentToken,id:'original-gateway',secret});
  await assert.rejects(prepareInstanceIdentityFile({identityFile:f.source,relayUrl,gatewaySecret,
    relocation:{operationId:'reject-foreign-epoch',phase:'prepareSource',sharedIdentityFile:other,validateOffline:()=>true}}),
  {code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  const target=join(f.directory,'unknown-alias','client-identity.json');
  await assert.rejects(prepareInstanceIdentityFile({identityFile:target,legacyIdentityFile:f.source,relayUrl,gatewaySecret,
    relocation:{operationId:'reject-foreign-epoch',sharedIdentityFile:f.finalTarget,sourceSharedIdentityFile:other,validateOffline:()=>true}}),
  {code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  await assert.rejects(stat(dirname(target)),{code:'ENOENT'});
});
