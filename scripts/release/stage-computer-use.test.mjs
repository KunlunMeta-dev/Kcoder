import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyComputerUseRuntime,stageComputerUseRuntime } from './stage-computer-use.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(root,status='prototype',noticeStatus='complete',clipboardVersion=1,clearVersion=1){
 await mkdir(join(root,'runtime/python'),{recursive:true});
 await mkdir(join(root,'source/src/windows_mcp'),{recursive:true});
 const files={'runtime/python/python.exe':'binary','launch.py':'launcher','source/src/windows_mcp/kcoder_clipboard.py':'wrapper','source/src/windows_mcp/kcoder_clipboard_guard.py':'guard','source/src/windows_mcp/kcoder_clear.py':'clear','worker.toml':'[server]\ntransport="stdio"',
  'runtime-manifest.json':JSON.stringify({schemaVersion:1,inputTrackingVersion:1,...(clipboardVersion===null?{}:{clipboardRecoveryVersion:clipboardVersion}),...(clearVersion===null?{}:{clearTextVersion:clearVersion}),status,pythonVersion:'3.14.6',python:'runtime/python/python.exe'})};
 if(status==='release-ready'){
  files['runtime/python/LICENSE.txt']='fixture notice';
  files['runtime/python/python.dll']='fixture native';
  const notice={path:'runtime/python/LICENSE.txt',sha256:hash(files['runtime/python/LICENSE.txt'])};
  const binary={path:'runtime/python/python.dll',sha256:hash(files['runtime/python/python.dll'])};
  files['third-party-notices.json']=JSON.stringify({schemaVersion:1,reviewStatus:noticeStatus,missingNotices:[],packages:[{files:[notice]}]});
  files['runtime-notices.json']=JSON.stringify({schemaVersion:1,reviewStatus:noticeStatus,nativeAttributionReviewRequired:false,pythonLicense:notice.path,notices:[notice],nativeBinaries:[binary]});
 }
 const inventory={schemaVersion:1,files:{}};
 for(const[name,text]of Object.entries(files)){await writeFile(join(root,name),text);inventory.files[name]={bytes:Buffer.byteLength(text),sha256:hash(text)};}
 const text=JSON.stringify(inventory);await writeFile(join(root,'files.sha256.json'),text);return hash(text);
}
test('prototype is auditable but cannot enter production package',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'kcoder-cu-stage-'));
 try{const source=join(temp,'source');const pin=await fixture(source);assert.equal((await verifyComputerUseRuntime(source,pin)).files,7);
 await assert.rejects(stageComputerUseRuntime({source,destination:join(temp,'out'),expectedHash:pin}),/readiness/);
 await stageComputerUseRuntime({source,destination:join(temp,'dev'),expectedHash:pin,allowPrototype:true});
 assert.equal((await readFile(join(temp,'dev/launch.py'),'utf8')),'launcher');
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('release-ready exact files stage atomically and tampering is rejected',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'kcoder-cu-stage-'));
 try{const source=join(temp,'source');const pin=await fixture(source,'release-ready');const destination=join(temp,'resources/computer-use');
 await stageComputerUseRuntime({source,destination,expectedHash:pin});await verifyComputerUseRuntime(destination,pin);
 await assert.rejects(stageComputerUseRuntime({source,destination,expectedHash:pin}),/already exists/);
 await writeFile(join(source,'extra.pth'),'bad');await assert.rejects(verifyComputerUseRuntime(source,pin),/file set/);
 await rm(join(source,'extra.pth'));await writeFile(join(source,'launch.py'),'tampered');await assert.rejects(verifyComputerUseRuntime(source,pin),/resource mismatch/);
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('old or unknown clipboard workers cannot enter even a development package',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'kcoder-cu-protocol-'));
 try{for(const version of [null,0,2]){
  const source=join(temp,`source-${version}`);const pin=await fixture(source,'prototype','complete',version);
  await assert.rejects(stageComputerUseRuntime({source,destination:join(temp,`out-${version}`),expectedHash:pin,allowPrototype:true}),/clipboard recovery protocol/);
 }}finally{await rm(temp,{recursive:true,force:true});}
});

test('self-consistent inventory still requires clipboard helper implementation files',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'kcoder-cu-helper-'));
 try{const source=join(temp,'source');await fixture(source);
 const missing='source/src/windows_mcp/kcoder_clipboard_guard.py';
 const path=join(source,'files.sha256.json');const inventory=JSON.parse(await readFile(path,'utf8'));
 delete inventory.files[missing];await rm(join(source,missing));
 const bytes=JSON.stringify(inventory);await writeFile(path,bytes);
 await assert.rejects(verifyComputerUseRuntime(source,hash(bytes)),/Missing runtime resource/);
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('clear capability and its sealed helper are required before staging', async () => {
 const temp=await mkdtemp(join(tmpdir(),'kcoder-cu-clear-'));
 try {
  for(const version of [null,0,2]) {
   const source=join(temp,`source-${version}`);const pin=await fixture(source,'prototype','complete',1,version);
   await assert.rejects(verifyComputerUseRuntime(source,pin),/verified text clearing/);
  }
  const source=join(temp,'missing-helper');await fixture(source);
  const missing='source/src/windows_mcp/kcoder_clear.py';
  const path=join(source,'files.sha256.json');const inventory=JSON.parse(await readFile(path,'utf8'));
  delete inventory.files[missing];await rm(join(source,missing));
  const bytes=JSON.stringify(inventory);await writeFile(path,bytes);
  await assert.rejects(verifyComputerUseRuntime(source,hash(bytes)),/Missing runtime resource/);
 } finally { await rm(temp,{recursive:true,force:true}); }
});
