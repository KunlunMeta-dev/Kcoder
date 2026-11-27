import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as relay from '../../kcoder-relay/src/client-identity.mjs';
import { prepareGatewayRelayStorage } from '../src/migrations/gateway-storage-domains.mjs';

const gatewaySecret='original-gateway-secret-012345678901234567890',relayUrl='https://relay.example.test';
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'kcoder-gateway-domains-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),finalTarget=join(root,'target');
  for(const directory of [source,finalTarget]){
    await mkdir(join(directory,'desktop-relay'),{recursive:true,mode:0o700});
    await writeFile(join(directory,'desktop-relay/gateway-secret'),gatewaySecret+'\n',{mode:0o600});
  }
  const identityFile=join(source,'relay/client-identity.json');
  const {enrollmentToken}=await relay.prepareClientIdentity({identityFile,relayUrl,gatewaySecret});
  await relay.saveRegisteredClientIdentity({identityFile,relayUrl,gatewaySecret,enrollmentToken,id:'original-gateway',secret:'original-assigned-secret-012345678901234567890'});
  return {source,finalTarget,options:{source,finalTarget,relayUrl,operationId:'original-operation',validateOffline:()=>{},loadRuntime:()=>relay}};
}

test('Gateway adapter uses the original secret and Relay owner without registration',async t=>{
  const f=await fixture(t),secretPath=join(f.finalTarget,'desktop-relay/gateway-secret');
  const result=await prepareGatewayRelayStorage(f.options);
  assert.equal(result.id,'original-gateway');assert.equal(result.status,'registered');
  assert.equal(await readFile(secretPath,'utf8'),gatewaySecret+'\n');
  assert.equal(JSON.stringify(result).includes(gatewaySecret),false);
});

test('missing or different copied secret is never replaced',async t=>{
  const f=await fixture(t),secretPath=join(f.finalTarget,'desktop-relay/gateway-secret');
  await writeFile(secretPath,'different-secret');
  await assert.rejects(prepareGatewayRelayStorage(f.options),{code:'GATEWAY_RELOCATION_SECRET_MISMATCH'});
  assert.equal(await readFile(secretPath,'utf8'),'different-secret');
  await rm(secretPath);
  await assert.rejects(prepareGatewayRelayStorage(f.options),{code:'GATEWAY_RELOCATION_SECRET_MISMATCH'});
  await assert.rejects(readFile(secretPath),{code:'ENOENT'});
});

test('old Relay runtimes and caller-supplied stopped flags cannot enter preparation',async t=>{
  const f=await fixture(t);let called=false;
  await assert.rejects(prepareGatewayRelayStorage({...f.options,loadRuntime:()=>({prepareInstanceIdentityFile:()=>{called=true;}})}),
    {code:'GATEWAY_RELOCATION_RUNTIME_UPDATE_REQUIRED'});
  assert.equal(called,false);
  await assert.rejects(prepareGatewayRelayStorage({...f.options,validateOffline:undefined,stopped:true}),{code:'GATEWAY_RELOCATION_AUTHORITY_REQUIRED'});
});
