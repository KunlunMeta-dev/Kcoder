import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, mkdir, cp, rename, rm } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute, relative } from 'node:path';

const inventoryName='files.sha256.json';
function validPath(path){
  return typeof path==='string' && path.length>0 && path.length<=2048 && !/[\\:\0]/.test(path)
    && path.split('/').every(part=>part && part!=='.' && part!=='..' && !/[ .]$/.test(part) && part!=='__pycache__' && !part.endsWith('.pyc'));
}
async function digest(path){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}
async function plain(path){const meta=await lstat(path);if(meta.isSymbolicLink()||(!meta.isFile()&&!meta.isDirectory()))throw new Error('Linked or non-regular runtime resource');return meta;}
export async function verifyComputerUseRuntime(source,expectedHash){
  if(!isAbsolute(source)||!/^[a-f0-9]{64}$/.test(expectedHash??''))throw new Error('Runtime source and trusted inventory digest are required');
  source=resolve(source);await plain(source);
  const path=join(source,inventoryName);const stat=await plain(path);
  if(!stat.isFile()||stat.size>8*1024*1024)throw new Error('Invalid runtime inventory size');
  if(await digest(path)!==expectedHash)throw new Error('Runtime inventory digest mismatch');
  const inventory=JSON.parse(await readFile(path,'utf8'));
  if(inventory.schemaVersion!==1||!inventory.files||Array.isArray(inventory.files)||typeof inventory.files!=='object')throw new Error('Invalid runtime inventory');
  const entries=Object.entries(inventory.files);
  if(!entries.length||entries.length>30000)throw new Error('Invalid runtime resource count');
  let total=0;
  for(const [name,entry]of entries){
    if(!validPath(name)||name===inventoryName||!Number.isSafeInteger(entry?.bytes)||entry.bytes<0||entry.bytes>512*1024*1024||!/^[a-f0-9]{64}$/.test(entry.sha256??''))throw new Error('Invalid runtime entry');
    total+=entry.bytes;if(total>2*1024*1024*1024)throw new Error('Runtime exceeds byte limit');
  }
  const actual=new Set();
  async function walk(directory,prefix='',depth=0){
    if(depth>32)throw new Error('Runtime nesting limit');
    for(const name of await readdir(directory)){
      const relative=prefix?`${prefix}/${name}`:name;
      if(!validPath(relative))throw new Error('Invalid runtime resource path');
      const path=join(directory,name);const stat=await plain(path);
      if(stat.isDirectory())await walk(path,relative,depth+1);
      else{actual.add(relative);if(actual.size>30001)throw new Error('Runtime file limit');}
    }
  }
  await walk(source);actual.delete(inventoryName);
  if(actual.size!==entries.length||entries.some(([name])=>!actual.has(name)))throw new Error('Runtime file set mismatch');
  for(const[name,entry]of entries){const path=join(source,name);if((await plain(path)).size!==entry.bytes||await digest(path)!==entry.sha256)throw new Error(`Runtime resource mismatch: ${name}`);}
  const manifest=JSON.parse((await readFile(join(source,'runtime-manifest.json'),'utf8')).replace(/^\uFEFF/,''));
  if(manifest.inputTrackingVersion!==1)throw new Error('Unsupported desktop input tracking protocol; update bundled component');
  if(manifest.clipboardRecoveryVersion!==1)throw new Error('Unsupported desktop clipboard recovery protocol; update bundled component');
  const python=manifest.python?.replaceAll('\\','/');
  if(manifest.schemaVersion!==1||!/^3\.14\.\d+$/.test(manifest.pythonVersion??'')||!validPath(python)||!python.startsWith('runtime/')||!python.endsWith('/python.exe'))throw new Error('Invalid runtime interpreter');
  for(const name of [python,'launch.py','worker.toml','runtime-manifest.json','source/src/windows_mcp/kcoder_clipboard.py','source/src/windows_mcp/kcoder_clipboard_guard.py'])if(!actual.has(name))throw new Error(`Missing runtime resource: ${name}`);
  return {files:entries.length,bytes:total,pythonVersion:manifest.pythonVersion,status:manifest.status};
}
export async function stageComputerUseRuntime({source,destination,expectedHash,allowPrototype=false}){
  const verified=await verifyComputerUseRuntime(source,expectedHash);
  if(!allowPrototype && verified.status!=='release-ready')throw new Error('Computer Use runtime has not passed release readiness audit');
  if(!isAbsolute(destination))throw new Error('Absolute staging destination required');
  const inside=relative(resolve(source),resolve(destination));
  if(!inside || (!inside.startsWith('..') && !isAbsolute(inside)))throw new Error('Runtime destination must not be inside source');
  const existing=await lstat(destination).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  if(existing)throw new Error('Runtime staging destination already exists');
  await mkdir(dirname(destination),{recursive:true});
  const temporary=`${destination}.staging-${randomUUID()}`;
  try{
    await cp(source,temporary,{recursive:true,dereference:false,errorOnExist:true,force:false});
    await verifyComputerUseRuntime(temporary,expectedHash);
    await rename(temporary,destination);
    return verified;
  }finally{await rm(temporary,{recursive:true,force:true});}
}
