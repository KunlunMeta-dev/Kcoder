import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { readRelayPrivateText } from './gateway-relay-instance.js';

async function fixture(t,long=false){
  const root=await fs.mkdtemp(join(tmpdir(),'gateway-relay-private-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const path=long?join(root,...Array(10).fill('owned-中文-private-segment'),'gateway-secret'):join(root,'gateway-secret');
  await fs.mkdir(dirname(path),{recursive:true});
  const text='owned-中文-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ\n';
  await fs.writeFile(path,text,{flag:'wx'});
  return {root,path,text};
}

test('Gateway private text reads bounded owned UTF-8 bytes without changing the source',async t=>{
  const {root,path,text}=await fixture(t),before=await fs.stat(path,{bigint:true});
  assert.equal(await readRelayPrivateText(path),text);
  const after=await fs.stat(path,{bigint:true});
  assert.equal(after.mtimeNs,before.mtimeNs);assert.equal(after.ctimeNs,before.ctimeNs);
  assert.equal(await readRelayPrivateText(join(root,'absent')),null);
});

test('Gateway private text reads an owned Unicode path longer than 260 characters',async t=>{
  const {path,text}=await fixture(t,true);assert.ok(path.length>260);
  assert.equal(await readRelayPrivateText(path),text);
});

test('Gateway private text retains single-link and size refusal without mode restrictions',async t=>{
  const {root,path}=await fixture(t),alias=join(root,'unapproved-alias');
  await fs.link(path,alias);
  await assert.rejects(readRelayPrivateText(path),/bounded single-link regular file/);
  await fs.unlink(alias);await fs.writeFile(path,Buffer.alloc(4097));
  await assert.rejects(readRelayPrivateText(path),/bounded single-link regular file|size limit/);
  if(process.platform!=='win32'){
    await fs.writeFile(path,'owned');await fs.chmod(path,0o644);
    assert.equal(await readRelayPrivateText(path),'owned');
  }
});

test('Gateway private text refuses a same-byte replacement made during its held read',async t=>{
  const {path,text}=await fixture(t),open=fs.open;let replaced=false;
  const mocked=t.mock.method(fs,'open',async(...args)=>{
    const file=await open(...args),read=file.read.bind(file);
    if(args[0]===path&&!replaced)t.mock.method(file,'read',async(...args)=>{
      const result=await read(...args);
      if(!replaced){replaced=true;await fs.rename(path,path+'.retained');await fs.writeFile(path,text,{flag:'wx'});}
      return result;
    });
    return file;
  });
  syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
  await assert.rejects(readRelayPrivateText(path),/changed while reading/);
});

test('Gateway Windows snapshots require exact large file indices and a named handle on the held volume',async t=>{
  const {path,text}=await fixture(t),lstat=fs.lstat,open=fs.open;
  const platform=Object.getOwnPropertyDescriptor(process,'platform');
  Object.defineProperty(process,'platform',{...platform,value:'win32'});
  let mode='normal',opens=0;
  const shape=(info,bigint,named,wrongVolume)=>Object.assign(Object.create(Object.getPrototypeOf(info)),info,{
    dev:named?(bigint?0n:0):wrongVolume?(bigint?info.dev+1n:info.dev+1):info.dev,
    ino:bigint?(1n<<54n)+(named&&mode==='inode'?1n:0n):Number((1n<<54n)+(named&&mode==='inode'?1n:0n)),
  });
  const mocks=[
    t.mock.method(fs,'lstat',async(...args)=>shape(await lstat(...args),args[1]?.bigint,true,false)),
    t.mock.method(fs,'open',async(...args)=>{
      const file=await open(...args),stat=file.stat.bind(file),wrongVolume=mode==='volume'&&++opens===2;
      t.mock.method(file,'stat',async options=>shape(await stat(options),options?.bigint,false,wrongVolume));return file;
    }),
  ];
  syncBuiltinESMExports();t.after(()=>{
    for(const mock of mocks)mock.mock.restore();syncBuiltinESMExports();Object.defineProperty(process,'platform',platform);
  });
  assert.equal(await readRelayPrivateText(path),text);
  mode='volume';opens=0;await assert.rejects(readRelayPrivateText(path),/changed while reading/);
  mode='inode';await assert.rejects(readRelayPrivateText(path),/changed while opening/);
});
