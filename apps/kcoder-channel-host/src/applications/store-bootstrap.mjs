import { DatabaseSync } from 'node:sqlite';
import { constants,openSync,closeSync,lstatSync,fstatSync,readSync,writeSync,ftruncateSync,fsyncSync,mkdirSync,readdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ChannelError,requireValue } from '../errors.mjs';
import { canonical,digest,identifier } from '../validation.mjs';

import { STORE_SCHEMA_VERSION as VERSION, STORE_SCHEMA_SQL as SQL } from './migrations/v0004-baseline.mjs';
const APPLICATION_ID=0x4b434348;
const schemaStages=new Set(['APPLICATION_ID','USER_VERSION','SCHEMA_ROWS','BINDING_SCHEMA','META','QUERY']);
class StoreSchemaFailure extends ChannelError {
 constructor(code,stage,sqliteCode,recovery='none'){super(code,recovery);this.stage=stage;this.sqliteCode=Number.isSafeInteger(sqliteCode)&&sqliteCode>=0&&sqliteCode<=65535?sqliteCode:null;}
}
// Diagnostic stage only; the public corruption code and refusal remain intact.
export function storeSchemaFailureStage(error){
 if(!(error instanceof StoreSchemaFailure)||!schemaStages.has(error.stage))return null;
 return error.stage==='QUERY'&&error.sqliteCode!==null?'QUERY_'+error.sqliteCode:error.stage;
}
function requireSchema(condition,stage){if(!condition)throw new StoreSchemaFailure('STORE_SCHEMA_CORRUPT',stage);}


const schemaRows=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
const expectedSchema=(()=>{const db=new DatabaseSync(':memory:');try{for(const sql of SQL)db.exec(sql);return digest(schemaRows(db));}finally{db.close();}})();
const identity=stat=>({dev:String(stat.dev),ino:String(stat.ino)});
const same=(left,right)=>left?.dev===right?.dev&&left?.ino===right?.ino;
const nofollow=constants.O_NOFOLLOW??0;
function present(path){try{return lstatSync(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function ensurePrivate(stat,directory,nativeProof,path){
  requireValue(stat&&!stat.isSymbolicLink()&&(directory?stat.isDirectory():stat.isFile())&&(directory||stat.nlink===1n),directory?'UNSAFE_STORE_DIRECTORY':'UNSAFE_STORE_FILE');
  if(process.platform==='win32')requireValue(nativeProof?.(path)===true&&stat.ino!==0n,'NATIVE_PRIVATE_DIRECTORY_REQUIRED');
  else requireValue(stat.uid===BigInt(process.getuid())&&(stat.mode&0o077n)===0n,directory?'STORE_DIRECTORY_NOT_PRIVATE':'STORE_FILE_NOT_PRIVATE');
}
export function verifyPrivateStoreRoot(directory,nativeProof,{create=false}={}){
  const root=resolve(directory);
  if(create&&!present(root))mkdirSync(root,{mode:0o700});
  const stat=present(root);requireValue(stat,'STORE_DIRECTORY_MISSING','repair_configuration');ensurePrivate(stat,true,nativeProof,root);return root;
}
function anchor(path,directory,nativeProof){
  const stat=present(path);requireValue(stat,'STORE_BINDING_OR_DATA_MISSING','repair_configuration');ensurePrivate(stat,directory,nativeProof,path);
  const fd=openSync(path,constants.O_RDONLY|nofollow|(directory?(constants.O_DIRECTORY??0):0));
  const opened=fstatSync(fd,{bigint:true});
  try{requireValue(same(identity(stat),identity(opened)),'STORE_IDENTITY_CHANGED');return {path,fd,identity:identity(opened),directory};}catch(error){closeSync(fd);throw error;}
}
function verifyAnchor(value,nativeProof){
  const named=present(value.path),held=fstatSync(value.fd,{bigint:true});ensurePrivate(named,value.directory,nativeProof,value.path);ensurePrivate(held,value.directory,nativeProof,value.path);
  requireValue(same(identity(named),value.identity)&&same(identity(held),value.identity),'STORE_IDENTITY_CHANGED','repair_configuration');
}
function verifySidecars(path,nativeProof){
  for(const suffix of ['-wal','-shm','-journal']){const named=path+suffix,stat=present(named);if(stat)ensurePrivate(stat,false,nativeProof,named);}
}
function readJson(value,maxBytes=16384){
  const stat=fstatSync(value.fd,{bigint:true});requireValue(stat.size>0n&&stat.size<=BigInt(maxBytes),'STORE_BINDING_UNCONFIRMED','repair_configuration');
  const data=Buffer.alloc(Number(stat.size));
  try{let offset=0;while(offset<data.length){const count=readSync(value.fd,data,offset,data.length-offset,offset);requireValue(count>0,'STORE_BINDING_UNCONFIRMED');offset+=count;}const after=fstatSync(value.fd,{bigint:true});requireValue(stat.size===after.size&&stat.mtimeNs===after.mtimeNs,'STORE_BINDING_CHANGED');return JSON.parse(data.toString('utf8'));}
  catch(error){if(error instanceof ChannelError)throw error;throw new ChannelError('STORE_BINDING_UNCONFIRMED','repair_configuration');}
}
function sqlite(path,mode){
  const uri=pathToFileURL(path);uri.searchParams.set('mode',mode);
  try{return new DatabaseSync(uri.href,{readOnly:mode==='ro'});}catch{throw new ChannelError('STORE_OPEN_UNAVAILABLE','repair_configuration');}
}
function createFile(path){return openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|nofollow,0o600);}
function writeJson(fd,value){const data=Buffer.from(canonical(value));writeSync(fd,data,0,data.length,0);ftruncateSync(fd,data.length);fsyncSync(fd);}
function readyValue(binding,bindingIdentity){return {version:1,namespaceId:binding.namespaceId,bindingHash:digest(binding),bindingIdentity};}
function verifyDatabase(db,binding,verifiedVersions){
  try{
    const version=verifiedVersions?db.prepare('PRAGMA data_version').get().data_version:null;
    if(verifiedVersions?.get(db)===version)return;
    requireSchema(db.prepare('PRAGMA application_id').get().application_id===APPLICATION_ID,'APPLICATION_ID');
    requireSchema(String(db.prepare('PRAGMA user_version').get().user_version)===VERSION,'USER_VERSION');
    requireSchema(digest(schemaRows(db))===expectedSchema,'SCHEMA_ROWS');
    requireSchema(binding.schemaHash===expectedSchema,'BINDING_SCHEMA');
    const rows=db.prepare('SELECT key,value FROM meta ORDER BY key').all();
    const expected={binding_hash:digest(binding),initialization_id:binding.initializationId,namespace_id:binding.namespaceId,schema_version:VERSION};
    if(!(rows.length===Object.keys(expected).length&&rows.every(row=>Object.hasOwn(expected,row.key)&&expected[row.key]===row.value)))throw new StoreSchemaFailure('STORE_META_CORRUPT','META');
    verifiedVersions?.set(db,version);
  }catch(error){if(error instanceof ChannelError)throw error;throw new StoreSchemaFailure('STORE_SCHEMA_CORRUPT','QUERY',error?.errcode,'repair_configuration');}
}

/** Explicit initialization only. Existing committed namespaces are never adopted or repaired. */
export function createStoreFiles(directory,{initializationId=randomUUID(),namespaceId,nativeWindowsProof,assertExclusiveLease,maxMetadataBytes=64*1024*1024}={}){
  requireValue(typeof assertExclusiveLease==='function'&&assertExclusiveLease()===true,'NATIVE_STORE_LEASE_REQUIRED');identifier(initializationId);
  if(namespaceId!==undefined)identifier(namespaceId);
  const root=resolve(directory),bindingPath=root+'.binding.json';
  if(present(bindingPath)){
    const existing=openStoreFiles(root,{nativeWindowsProof,assertExclusiveLease,maxMetadataBytes,expectedNamespaceId:namespaceId});
    try{requireValue(existing.binding.initializationId===initializationId,'STORE_ALREADY_BOUND','reconcile_original');return {root,bindingPath,initializationId};}finally{existing.close();}
  }
  verifyPrivateStoreRoot(root,nativeWindowsProof,{create:true});
  requireValue(readdirSync(root).length===0,'STORE_INITIALIZATION_UNCONFIRMED','repair_configuration');
  const rootAnchor=anchor(root,true,nativeWindowsProof),files=[];
  try{
    const paths={db:join(root,'connectivity.sqlite3'),lock:join(root,'connectivity.lock'),ready:join(root,'connectivity.ready.json')};
    for(const kind of ['lock','db','ready']){const fd=createFile(paths[kind]);files.push({kind,fd,path:paths[kind]});fsyncSync(fd);}
    const binding={version:1,namespaceId:namespaceId??randomUUID(),initializationId,schemaVersion:VERSION,schemaHash:expectedSchema,root:rootAnchor.identity,...Object.fromEntries(files.map(value=>[value.kind,identity(fstatSync(value.fd,{bigint:true}))]))};
    const bindingFd=createFile(bindingPath);files.push({kind:'binding',fd:bindingFd,path:bindingPath});writeJson(bindingFd,binding);
    verifyAnchor(rootAnchor,nativeWindowsProof);
    const db=sqlite(paths.db,'rw');
    try{
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA application_id='+APPLICATION_ID+'; PRAGMA user_version='+VERSION+';');
      const pageSize=db.prepare('PRAGMA page_size').get().page_size;db.exec('PRAGMA max_page_count='+Math.max(64,Math.floor(maxMetadataBytes/pageSize)));
      db.exec('BEGIN IMMEDIATE');
      try{for(const sql of SQL)db.exec(sql);const insert=db.prepare('INSERT INTO meta VALUES(?,?)');for(const[key,value]of Object.entries({binding_hash:digest(binding),initialization_id:initializationId,namespace_id:binding.namespaceId,schema_version:VERSION}))insert.run(key,value);db.exec('COMMIT');}
      catch(error){db.exec('ROLLBACK');throw error;}
      verifyDatabase(db,binding);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }finally{db.close();}
    writeJson(files.find(value=>value.kind==='ready').fd,readyValue(binding,identity(fstatSync(bindingFd,{bigint:true}))));
    // Windows cannot fsync a directory handle. Every created file and the ready
    // receipt are flushed above; the native owner verifies and commits that
    // same store before granting Ready. POSIX retains its directory fsync.
    if(process.platform!=='win32')fsyncSync(rootAnchor.fd);
    return {root,bindingPath,initializationId};
  }finally{for(const file of files)closeSync(file.fd);closeSync(rootAnchor.fd);}
}

/** Holds original directory/file handles and never creates, chmods or repairs an existing store. */
export function openStoreFiles(directory,{nativeWindowsProof,assertExclusiveLease,expectedNamespaceId,maxMetadataBytes=64*1024*1024}={}){
  const root=verifyPrivateStoreRoot(directory,nativeWindowsProof),anchors=[],verifiedVersions=new WeakMap();let reader,writer,closed=false,inTransaction=false;
  try{
    const rootAnchor=anchor(root,true,nativeWindowsProof);anchors.push(rootAnchor);
    const bound=anchor(root+'.binding.json',false,nativeWindowsProof);anchors.push(bound);const binding=readJson(bound);
    requireValue(binding?.version===1&&binding.schemaVersion===VERSION&&same(binding.root,rootAnchor.identity),'STORE_BINDING_CHANGED','repair_configuration');
    requireValue(expectedNamespaceId===undefined||binding.namespaceId===expectedNamespaceId,'STORE_NATIVE_NAMESPACE_MISMATCH','repair_configuration');
    for(const[kind,name]of [['db','connectivity.sqlite3'],['lock','connectivity.lock'],['ready','connectivity.ready.json']]){
      const value=anchor(join(root,name),false,nativeWindowsProof);value.kind=kind;anchors.push(value);requireValue(same(value.identity,binding[kind]),'STORE_BINDING_CHANGED');
    }
    const readyAnchor=anchors.find(value=>value.kind==='ready');requireValue(canonical(readJson(readyAnchor))===canonical(readyValue(binding,bound.identity)),'STORE_READY_UNCONFIRMED','repair_configuration');
    const path=join(root,'connectivity.sqlite3');verifySidecars(path,nativeWindowsProof);reader=sqlite(path,'ro');verifySidecars(path,nativeWindowsProof);verifyDatabase(reader,binding,verifiedVersions);
    const pageSize=reader.prepare('PRAGMA page_size').get().page_size,pageCount=reader.prepare('PRAGMA page_count').get().page_count;requireValue(pageCount*pageSize<=maxMetadataBytes,'STORE_CAPACITY_EXCEEDED');
    const verify=()=>{
      requireValue(!closed,'STORE_CLOSED');for(const value of anchors)verifyAnchor(value,nativeWindowsProof);
      verifySidecars(path,nativeWindowsProof);
      requireValue(canonical(readJson(bound))===canonical(binding)&&canonical(readJson(readyAnchor))===canonical(readyValue(binding,bound.identity)),'STORE_BINDING_CHANGED');
      // SQLite invalidates this structural evidence on another connection's
      // commit. Business rows, file anchors and the live lease are never cached.
      verifyDatabase(inTransaction?writer:reader,binding,verifiedVersions);
    };
    const assertOwnership=()=>{verify();requireValue(typeof assertExclusiveLease==='function'&&assertExclusiveLease()===true,'NATIVE_STORE_LEASE_REQUIRED');};
    const write=()=>{
      assertOwnership();
      if(!writer){writer=sqlite(path,'rw');verifyDatabase(writer,binding,verifiedVersions);for(const value of anchors)verifyAnchor(value,nativeWindowsProof);writer.exec('PRAGMA busy_timeout=50; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=64;');}
      // data_version does not change for this connection's own writes.
      verifiedVersions.delete(writer);
      return writer;
    };
    const db={
      prepare(sql){return {
        get(...args){verify();return (inTransaction?writer:reader).prepare(sql).get(...args);},
        all(...args){verify();return (inTransaction?writer:reader).prepare(sql).all(...args);},
        run(...args){return write().prepare(sql).run(...args);},
      };},
      exec(sql){
        const command=sql.trim().toUpperCase();
        if(command==='ROLLBACK'){try{writer?.exec(sql);}finally{inTransaction=false;}return;}
        const connection=write();connection.exec(sql);
        if(command==='BEGIN IMMEDIATE')inTransaction=true;else if(command==='COMMIT')inTransaction=false;
      },
    };
    const close=()=>{
      if(closed)return;closed=true;let failed=false;
      for(const action of [()=>writer?.close(),()=>reader?.close(),...anchors.map(value=>()=>closeSync(value.fd))]){try{action();}catch{failed=true;}}
      requireValue(!failed,'STORE_CLOSE_UNCONFIRMED','reconcile_original');
    };
    return {root,db,binding,verify,assertOwnership,close};
  }catch(error){try{writer?.close();}catch{}try{reader?.close();}catch{}for(const value of anchors)closeSync(value.fd);throw error;}
}
