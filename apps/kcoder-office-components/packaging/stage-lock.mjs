// Build-only staging mutex. Never import this module into the generated runtime.
import { constants } from 'node:fs';
import { mkdir,lstat,open,link,realpath } from 'node:fs/promises';
import { dirname,basename,join,parse,relative,resolve,sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { runInThisContext } from 'node:vm';
import process from 'node:process';

const APPLICATION_ID=0x4f53544c,MAX_DATABASE_BYTES=64*1024;
const registryKey=Symbol.for('kcoder.office-stage.sqlite-lock.v1');
if(!process[registryKey])Object.defineProperty(process,registryKey,{value:{paths:new Set(),inodes:new Map(),unidentified:[],draining:false,failure:null}});
const registry=process[registryKey];
const fail=code=>Object.assign(new Error(code),{code});
const unsafe=()=>fail('OFFICE_RESOURCE_UNSAFE');
const busy=()=>fail('OFFICE_RESOURCE_STAGE_BUSY');
const same=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const identity=info=>({dev:String(info.dev),ino:String(info.ino)});
const matches=(info,value)=>!!info&&String(info.dev)===value?.dev&&String(info.ino)===value?.ino;
const current=async path=>lstat(path,{bigint:true}).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const owned=info=>typeof process.getuid!=='function'||info.uid===BigInt(process.getuid());
function ordinaryFile(info,links=1n){
 if(!info?.isFile()||info.isSymbolicLink()||info.nlink!==links||info.ino===0n||!owned(info))throw unsafe();
 if(process.platform!=='win32'&&(info.mode&0o077n)!==0n)throw unsafe();
}
function ordinaryDirectory(info,privateOnly=false){
 if(!info?.isDirectory()||info.isSymbolicLink()||!owned(info)||info.ino===0n)throw unsafe();
 if(process.platform!=='win32'&&(info.mode&(privateOnly?0o077n:0o022n))!==0n)throw unsafe();
}
async function buildParent(path){
 const root=parse(path).root;let cursor=root;
 for(const part of relative(root,path).split(sep).filter(Boolean)){
  cursor=join(cursor,part);let info=await current(cursor);
  if(!info){try{await mkdir(cursor,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}info=await current(cursor);}
  if(!info.isDirectory()||info.isSymbolicLink())throw unsafe();
 }
 const info=await current(path);ordinaryDirectory(info);
 if(relative(await realpath(path),path)!=='')throw unsafe();
 return info;
}
async function syncDirectory(path,expected){
 // POSIX directory fsync orders new names before their SQLite receipt. Windows
 // directory-handle durability requires separate host verification.
 if(process.platform==='win32')return;
 const handle=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|(constants.O_NOFOLLOW??0));
 try{if(!same(expected,await handle.stat({bigint:true})))throw unsafe();await handle.sync();}
 finally{await handle.close();}
}
function payloadValid(value,target){
 return value&&typeof value==='object'&&!Array.isArray(value)&&value.protocol==='kcoder-office-stage-v1'
  &&Object.keys(value).sort().join(',')==='database,directory,nonce,notice,parent,protocol,target'
  &&value.target===target&&/^[a-f0-9]{64}$/.test(value.nonce??'')
  &&['database','directory','parent','notice'].every(key=>value[key]&&Object.keys(value[key]).sort().join(',')==='dev,ino'
   &&/^\d+$/.test(value[key].dev)&&/^[1-9]\d*$/.test(value[key].ino));
}
async function readNotice(path){
 const before=await current(path);if(!before)return null;
 if(!before.isFile()||before.isSymbolicLink()||![1n,2n].includes(before.nlink)||before.size>4096n||!owned(before))throw unsafe();
 let handle;
 try{
  handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  const held=await handle.stat({bigint:true});
  if(!same(before,held)||held.nlink!==before.nlink||held.size!==before.size)throw unsafe();
  const bytes=await handle.readFile();if(bytes.length!==Number(held.size)||!same(held,await current(path)))throw unsafe();
  try{return {value:JSON.parse(bytes),info:held,bytes};}catch{return {value:null,info:held,bytes};}
 }finally{await handle?.close();}
}
async function sidecars(database){
 for(const suffix of ['-journal','-wal','-shm']){
  const info=await current(database+suffix);if(!info)continue;
  ordinaryFile(info);
  if(suffix!=='-journal'||info.size>BigInt(MAX_DATABASE_BYTES))throw unsafe();
 }
}
function isBusy(error){return error?.errcode===5||error?.errcode===6||/database (?:is )?(?:locked|busy)/i.test(error?.message??'');}

/** A persistent notice excludes legacy builders; the SQLite transaction owns liveness. */
export async function acquireOfficeStageLock(destination,{signal}={}){
 if(!isMainThread||runInThisContext('globalThis')!==globalThis)throw fail('OFFICE_RESOURCE_BUILD_REALM_UNAVAILABLE');
 if(registry.failure)throw registry.failure;
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(major<22||major===22&&minor<13)throw fail('OFFICE_RESOURCE_BUILD_NODE_UNAVAILABLE');
 let DatabaseSync;
 try{({DatabaseSync}=await import('node:sqlite'));}catch{throw fail('OFFICE_RESOURCE_BUILD_NODE_UNAVAILABLE');}
 const target=resolve(destination),parent=dirname(target),name=basename(target);
 if(!name||target===parent)throw fail('OFFICE_RESOURCE_INVALID');
 const parentInfo=await buildParent(parent),key=process.platform==='win32'?target.toLowerCase():target;
 if(registry.failure)throw registry.failure;
 if(registry.draining||registry.paths.has(key))throw busy();registry.paths.add(key);
 const directory=join(parent,'.'+name+'.office-stage.v1'),database=join(directory,'authority.sqlite');
 const noticePath=join(parent,'.'+name+'.office-stage.lock');
 let guard,db,inodeKey,entry,binding,directoryInfo,databaseInfo,released=false,releaseFailure,releasePending;
 async function assertCurrent(checkCancellation=true){
  if(registry.failure)throw registry.failure;
  if(checkCancellation)signal?.throwIfAborted();
  const p=await current(parent),d=await current(directory),f=await current(database);
  ordinaryDirectory(p);ordinaryDirectory(d,true);ordinaryFile(f);
  if(!same(parentInfo,p)||!same(directoryInfo,d)||!same(databaseInfo,f)||!same(databaseInfo,await guard.stat({bigint:true})))throw unsafe();
  await sidecars(database);
 }
 async function verifyPublished(checkCancellation=true){
  await assertCurrent(checkCancellation);
  const notice=await readNotice(noticePath),template=await readNotice(join(directory,'notice-'+binding.nonce+'.json'));
  if(notice)ordinaryFile(notice.info,2n);if(template)ordinaryFile(template.info,2n);
  if(!notice||!template||notice.info.nlink!==2n||template.info.nlink!==2n||!same(notice.info,template.info)
    ||!matches(notice.info,binding.notice)||!notice.bytes.equals(template.bytes)
    ||!payloadValid(notice.value,name)||JSON.stringify(notice.value)!==JSON.stringify(binding))throw unsafe();
 }
 function release(){return releasePending??=Promise.resolve().then(finishRelease);}
 async function finishRelease(){
  if(releaseFailure)throw releaseFailure;if(released)return;
  try{
   if(db){try{db.exec('ROLLBACK');}catch{}db.close();}
   // Closing any extra DB fd while SQLite is live can cancel POSIX record locks.
   for(const handle of [guard,...(entry?.deferred??[])])await handle?.close();
  }catch(error){
   if(entry)entry.retained={db,guard};
   releaseFailure=fail('OFFICE_RESOURCE_LOCK_RELEASE_UNCONFIRMED');registry.failure=releaseFailure;throw releaseFailure;
  }
  registry.paths.delete(key);if(inodeKey&&registry.inodes.get(inodeKey)===entry)registry.inodes.delete(inodeKey);
  if(registry.inodes.size===0&&registry.paths.size===0){
   registry.draining=true;
   try{for(const handle of registry.unidentified)await handle.close();registry.unidentified.length=0;}
   catch{releaseFailure=fail('OFFICE_RESOURCE_LOCK_RELEASE_UNCONFIRMED');registry.failure=releaseFailure;throw releaseFailure;}
   finally{registry.draining=false;}
  }
  released=true;
 }
 try{
  signal?.throwIfAborted();
  const existing=await readNotice(noticePath);
  if(existing&&!payloadValid(existing.value,name))throw busy();
  if(existing)ordinaryFile(existing.info,2n);
  try{await mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  directoryInfo=await current(directory);ordinaryDirectory(directoryInfo,true);
  await syncDirectory(parent,parentInfo);
  const before=await current(database);
  if(before)ordinaryFile(before);
  if(existing&&(!matches(before,existing.value.database)||!matches(directoryInfo,existing.value.directory)||!matches(parentInfo,existing.value.parent)))throw unsafe();
  if(before&&registry.inodes.has(String(before.dev)+':'+String(before.ino)))throw busy();
  if(!before){try{guard=await open(database,'wx+',0o600);}catch(error){if(error.code!=='EEXIST')throw error;}}
  guard??=await open(database,constants.O_RDWR|(constants.O_NOFOLLOW??0));
  try{databaseInfo=await guard.stat({bigint:true});}
  catch(error){if(registry.inodes.size||registry.paths.size>1){registry.unidentified.push(guard);guard=undefined;}throw error;}
  inodeKey=String(databaseInfo.dev)+':'+String(databaseInfo.ino);
  const holder=registry.inodes.get(inodeKey);
  if(holder){holder.deferred.push(guard);guard=undefined;ordinaryFile(databaseInfo);if(before&&!same(before,databaseInfo))throw unsafe();throw busy();}
  ordinaryFile(databaseInfo);if(databaseInfo.size>BigInt(MAX_DATABASE_BYTES)||before&&!same(before,databaseInfo))throw unsafe();
  entry={deferred:[]};registry.inodes.set(inodeKey,entry);
  await syncDirectory(directory,directoryInfo);
  await assertCurrent();
  db=new DatabaseSync(database);
  db.exec('PRAGMA busy_timeout=0;PRAGMA locking_mode=EXCLUSIVE;PRAGMA synchronous=FULL;BEGIN EXCLUSIVE');
  if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete')throw unsafe();
  const app=db.prepare('PRAGMA application_id').get().application_id;
  const tables=db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  if(app===0&&tables.length===0){
   if(existing)throw unsafe();
   db.exec(`PRAGMA application_id=${APPLICATION_ID};PRAGMA user_version=1;CREATE TABLE stage_mutex(id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL,probe TEXT NOT NULL)`);
   const nonce=randomBytes(32).toString('hex'),templatePath=join(directory,'notice-'+nonce+'.json');
   const template=await open(templatePath,'wx+',0o600);
   try{
    const info=await template.stat({bigint:true});ordinaryFile(info);
    binding={protocol:'kcoder-office-stage-v1',target:name,nonce,database:identity(databaseInfo),directory:identity(directoryInfo),parent:identity(parentInfo),notice:identity(info)};
    await template.writeFile(JSON.stringify(binding)+'\n');await template.sync();
   }finally{await template.close();}
   await syncDirectory(directory,directoryInfo);
   db.prepare('INSERT INTO stage_mutex VALUES(1,?,?)').run(JSON.stringify(binding),'');
  }else{
   if(app!==APPLICATION_ID||db.prepare('PRAGMA user_version').get().user_version!==1||tables.length!==1||tables[0].name!=='stage_mutex')throw unsafe();
   const row=db.prepare('SELECT binding FROM stage_mutex WHERE id=1').get();
   try{binding=JSON.parse(row?.binding);}catch{throw unsafe();}
   if(!payloadValid(binding,name)||!matches(databaseInfo,binding.database)||!matches(directoryInfo,binding.directory)||!matches(parentInfo,binding.parent))throw unsafe();
  }
  const challenge=randomBytes(32).toString('hex');
  db.prepare('UPDATE stage_mutex SET probe=? WHERE id=1').run(challenge);db.exec('COMMIT');
  // Bind SQLite's actual open file to the pinned fd, including an open-time ABA copy.
  const size=(await guard.stat({bigint:true})).size;
  if(size>BigInt(MAX_DATABASE_BYTES))throw unsafe();
  const bytes=Buffer.alloc(Number(size));const read=await guard.read(bytes,0,bytes.length,0);
  if(read.bytesRead!==bytes.length||!bytes.includes(Buffer.from(challenge)))throw unsafe();
  await assertCurrent();
  const templatePath=join(directory,'notice-'+binding.nonce+'.json'),template=await readNotice(templatePath);
  if(!template||!matches(template.info,binding.notice)||JSON.stringify(template.value)!==JSON.stringify(binding))throw unsafe();
  if(!await current(noticePath)&&template.info.nlink!==1n)throw unsafe();
  try{await link(templatePath,noticePath);}catch(error){if(error.code!=='EEXIST')throw error;}
  await verifyPublished();
  await syncDirectory(parent,parentInfo);
  if(db.prepare('PRAGMA locking_mode').get().locking_mode!=='exclusive')throw unsafe();
  db.exec('BEGIN EXCLUSIVE');
  return {assertCurrent:()=>verifyPublished(),assertCleanupOwnership:()=>verifyPublished(false),release};
 }catch(error){await release();if(isBusy(error))throw busy();throw error;}
}
