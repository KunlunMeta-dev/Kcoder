import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { prepareClientIdentity, prepareInstanceIdentityFile, readRegisteredClientIdentity,
  revokeClientIdentity, saveRegisteredClientIdentity } from '../src/client-identity.mjs';

const relayUrl='https://relay.example.test',gatewaySecret='owned-internal-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const assignment={id:'owned-windows-snapshot',secret:'owned-control-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'};

async function windowsSnapshots(t){
  const root=await fs.mkdtemp(join(tmpdir(),'relay-windows-snapshot-'));
  const options={identityFile:join(root,'private','identity.json'),relayUrl,gatewaySecret};
  const identityFile=options.identityFile;
  const originalPlatform=Object.getOwnPropertyDescriptor(process,'platform');
  Object.defineProperty(process,'platform',{...originalPlatform,value:'win32'});
  const lstat=fs.lstat,open=fs.open,mkdtemp=fs.mkdtemp;
  let changedInode=false,changedVolume=false,markerOpens=0;
  const shape=(info,bigint,named,wrongVolume=false,wrongInode=false)=>{
    if(!info.isFile())return info;
    const inode=BigInt(info.ino)%(1n<<40n)*4n+(1n<<54n)+(wrongInode?1n:0n);
    return Object.assign(Object.create(Object.getPrototypeOf(info)),info,{
      dev:named?(bigint?0n:0):wrongVolume?(bigint?info.dev+1n:info.dev+1):info.dev,
      ino:bigint?inode:Number(inode),
    });
  };
  const mocks=[
    t.mock.method(fs,'mkdtemp',async(prefix,options)=>mkdtemp(
      originalPlatform.value==='win32'?prefix:prefix.replaceAll('\\','/'),options)),
    t.mock.method(fs,'lstat',async(path,options)=>shape(await lstat(path,options),options?.bigint,true,
      false,changedInode&&path===identityFile)),
    t.mock.method(fs,'open',async(...args)=>{
      const file=await open(...args),stat=file.stat.bind(file);
      const wrongVolume=changedVolume&&args[0]===options.identityFile&&++markerOpens===2;
      t.mock.method(file,'stat',async options=>shape(await stat(options),options?.bigint,false,wrongVolume));
      return file;
    }),
  ];
  syncBuiltinESMExports();
  t.after(async()=>{
    for(const mock of mocks)mock.mock.restore();syncBuiltinESMExports();
    Object.defineProperty(process,'platform',originalPlatform);
    await fs.rm(root,{recursive:true,force:true});
  });
  const pending=await prepareClientIdentity(options);
  await saveRegisteredClientIdentity({...options,...pending,...assignment});
  return {root,options,changeInode:()=>{changedInode=true;},changeVolume:()=>{changedVolume=true;markerOpens=0;}};
}

test('Windows path snapshots with no volume and large exact file indices retain registration, adoption and revocation',async t=>{
  const {root,options}=await windowsSnapshots(t);
  assert.deepEqual(await readRegisteredClientIdentity(options),assignment);
  const legacy=join(root,'legacy','identity.json'),target=join(root,'adopted','identity.json');
  await fs.mkdir(dirname(legacy),{recursive:true,mode:0o700});
  await fs.mkdir(dirname(target),{recursive:true,mode:0o700});
  await fs.writeFile(legacy,JSON.stringify({version:1,relayOrigin:relayUrl,
    gatewaySecretHash:createHash('sha256').update(gatewaySecret).digest('hex'),...assignment})+'\n',{mode:0o600});
  await prepareInstanceIdentityFile({identityFile:target,legacyIdentityFile:legacy,relayUrl,gatewaySecret});
  assert.deepEqual(await readRegisteredClientIdentity({identityFile:target,relayUrl,gatewaySecret}),assignment);
  await assert.rejects(fs.lstat(legacy),{code:'ENOENT'});
  await revokeClientIdentity(options);
  await assert.rejects(readRegisteredClientIdentity(options),{code:'RELAY_IDENTITY_REVOKED'});
});

test('Windows named reopen rejects another real volume even when the path file index matches',async t=>{
  const {options,changeVolume}=await windowsSnapshots(t);changeVolume();
  await assert.rejects(readRegisteredClientIdentity(options),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
});

test('Windows named snapshot rejects an adjacent file index beyond Number precision',async t=>{
  const {options,changeInode}=await windowsSnapshots(t);changeInode();
  await assert.rejects(readRegisteredClientIdentity(options),{code:'RELAY_IDENTITY_RECOVERY_REQUIRED'});
});

test('identity registration and revocation use owned Unicode paths longer than 260 characters',async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'relay-native-long-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const identityFile=join(root,...Array(10).fill('owned-中文-identity-segment'),'identity.json');
  assert.ok(identityFile.length>260);
  const options={identityFile,relayUrl,gatewaySecret},pending=await prepareClientIdentity(options);
  await saveRegisteredClientIdentity({...options,...pending,...assignment});
  assert.deepEqual(await readRegisteredClientIdentity(options),assignment);
  const reference=JSON.parse(await fs.readFile(identityFile+'.state-v2/reference.json'));
  assert.equal(reference.epoch,join(dirname(identityFile),'.relay-identity-generation-'+reference.generation));
  await revokeClientIdentity(options);
  await assert.rejects(readRegisteredClientIdentity(options),{code:'RELAY_IDENTITY_REVOKED'});
});
