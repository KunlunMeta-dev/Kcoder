import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { prepareClientIdentity, prepareInstanceIdentityFile, readRegisteredClientIdentity,
  saveRegisteredClientIdentity } from '../src/client-identity.mjs';

const relayUrl='https://relay.example.test',gatewaySecret='owned-source-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const assignment={id:'owned-source-gateway',secret:'owned-registration-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'};
const operationId='owned-source-proof';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'relay-offline-source-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const identityFile=join(root,'source','client-identity.json');
  const pending=await prepareClientIdentity({identityFile,relayUrl,gatewaySecret});
  await saveRegisteredClientIdentity({identityFile,relayUrl,gatewaySecret,...pending,...assignment});
  return {root,identityFile};
}

function observation(){
  const calls=[];
  const observeMetadata=(path,kind)=>{
    const value={identity:JSON.stringify({opaque128:'fedcba98765432100123456789abcdef',path}),
      links:kind==='directory'?null:String(statSync(path,{bigint:true}).nlink)};
    calls.push({path,kind,value});return value;
  };
  return {calls,observeMetadata};
}

function prepare(identityFile,extra={}){
  return prepareInstanceIdentityFile({identityFile,relayUrl,gatewaySecret,
    relocation:{operationId,phase:'prepareSource',validateOffline:()=>true,...extra}});
}

test('source metadata injection preserves complete opaque identities and the original Relay reference bytes',async t=>{
  const {identityFile}=await fixture(t),observed=observation();
  const before=await readFile(identityFile+'.state-v2/reference.json');
  const value=await prepare(identityFile,{observeMetadata:observed.observeMetadata});
  assert.equal(value.operationId,operationId);assert.equal(value.status,'registered');
  assert.deepEqual(observed.calls.map(({path,kind})=>[path,kind]),[
    [identityFile,'file'],[value.paths.referenceDirectory,'directory'],[value.paths.epochDirectory,'directory'],
  ]);
  for(const [kind,path] of Object.entries(value.paths)){
    assert.deepEqual(value.identities[kind],observed.calls.find(call=>call.path===path).value);
    assert.equal(Object.hasOwn(value.identities[kind],'dev'),false);
  }
  assert.deepEqual(await readFile(identityFile+'.state-v2/reference.json'),before);
  assert.deepEqual(await readRegisteredClientIdentity({identityFile,relayUrl,gatewaySecret}),assignment);
});

test('source preparation without injection retains the standalone Node metadata contract',{
  skip:process.platform==='win32'?'standalone directory FD proof requires Unix; Windows uses Native metadata':false,
},async t=>{
  const {identityFile}=await fixture(t),value=await prepare(identityFile);
  for(const [kind,path] of Object.entries(value.paths)){
    const info=await stat(path,{bigint:true});
    assert.deepEqual(value.identities[kind],{dev:String(info.dev),ino:String(info.ino)});
  }
});

test('metadata observation failure cannot announce a source proof and the same operation can retry',async t=>{
  const {identityFile}=await fixture(t),calls=[];
  const original=await readFile(identityFile+'.state-v2/reference.json');
  const error=Object.assign(new Error('owned native observation failed'),{code:'OWNED_METADATA_FAILURE'});
  await assert.rejects(prepare(identityFile,{observeMetadata:(path,kind)=>{
    calls.push([path,kind]);throw error;
  }}),failure=>failure===error);
  assert.deepEqual(calls,[[identityFile,'file']]);
  assert.deepEqual(await readFile(identityFile+'.state-v2/reference.json'),original);
  assert.equal((await prepare(identityFile,{observeMetadata:observation().observeMetadata})).operationId,operationId);
});

test('injected metadata never bypasses the original epoch reference validation',async t=>{
  const {identityFile}=await fixture(t),path=identityFile+'.state-v2/reference.json';
  const reference=JSON.parse(await readFile(path));
  reference.ino=String(BigInt(reference.ino)+1n);
  await writeFile(path,JSON.stringify(reference)+'\n',{mode:0o600});
  const observed=observation();
  await assert.rejects(prepare(identityFile,{observeMetadata:observed.observeMetadata}),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  assert.equal(observed.calls.length,0);
});

test('metadata injection cannot initialize a missing source identity',async t=>{
  const {root}=await fixture(t),identityFile=join(root,'absent','identity.json'),observed=observation();
  await assert.rejects(prepare(identityFile,{observeMetadata:observed.observeMetadata}),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
  assert.equal(observed.calls.length,0);
  await assert.rejects(stat(identityFile+'.state-v2'),{code:'ENOENT'});
});

test('an adopted alias observes only its existing reference and shared epoch without recreating a projection',async t=>{
  const {root}=await fixture(t),identityFile=join(root,'adopted','relay','client-identity.json');
  const legacyIdentityFile=join(root,'adopted','desktop-relay','client-identity.json');
  await mkdir(dirname(legacyIdentityFile),{recursive:true,mode:0o700});
  await writeFile(legacyIdentityFile,JSON.stringify({version:1,relayOrigin:relayUrl,
    gatewaySecretHash:createHash('sha256').update(gatewaySecret).digest('hex'),...assignment}),{mode:0o600});
  await prepareInstanceIdentityFile({identityFile,legacyIdentityFile,relayUrl,gatewaySecret});
  const observed=observation();
  const value=await prepare(legacyIdentityFile,{sharedIdentityFile:identityFile,observeMetadata:observed.observeMetadata});
  assert.equal(value.paths.projection,null);assert.equal(value.identities.projection,null);
  assert.equal(value.sharedIdentityFile,identityFile);
  assert.deepEqual(observed.calls.map(call=>call.kind),['directory','directory']);
  await assert.rejects(stat(legacyIdentityFile),{code:'ENOENT'});
});

test('later-move source observation includes the exact existing receipt directory and file',async t=>{
  const {root,identityFile}=await fixture(t),target=join(root,'target','client-identity.json');
  await prepareInstanceIdentityFile({identityFile:target,legacyIdentityFile:identityFile,relayUrl,gatewaySecret,
    relocation:{operationId:'previous-owned-move',validateOffline:()=>true}});
  const receipt=await readFile(target+'.relocation-v1/reference.json'),observed=observation();
  const value=await prepare(target,{observeMetadata:observed.observeMetadata});
  assert.deepEqual(observed.calls.map(call=>call.kind),['file','directory','directory','directory','file']);
  assert.equal(value.paths.transferReceiptFile,join(target+'.relocation-v1','reference.json'));
  assert.deepEqual(value.identities.transferReceiptFile,observed.calls[4].value);
  assert.deepEqual(value.transferReceipt,JSON.parse(receipt));
  assert.deepEqual(await readFile(value.paths.transferReceiptFile),receipt);
});
