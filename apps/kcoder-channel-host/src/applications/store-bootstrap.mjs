import { DatabaseSync } from 'node:sqlite';
import { constants,openSync,closeSync,lstatSync,fstatSync,readSync,writeSync,ftruncateSync,fsyncSync,mkdirSync,readdirSync } from 'node:fs';
import { resolve,join,dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChannelError,requireValue } from '../errors.mjs';
import { canonical,digest,identifier } from '../validation.mjs';
import { existingSqliteFileUri } from '../sqlite-file-uri.mjs';

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
const historicalIdentity=value=>value&&typeof value==='object'&&['dev','ino'].every(key=>typeof value[key]==='string'&&/^[0-9]+$/.test(value[key]));
const nofollow=constants.O_NOFOLLOW??0;
function present(path){try{return lstatSync(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function closeAll(actions){
  let failure;
  for(const action of actions){try{action();}catch(error){failure??=error;}}
  return failure;
}
function withCleanup(action,cleanup){
  let failed=false;
  try{return action();}catch(error){failed=true;throw error;}
  finally{
    const failure=closeAll(typeof cleanup==='function'?cleanup():cleanup);
    if(failure&&!failed){const error=new ChannelError('STORE_CLOSE_UNCONFIRMED','reconcile_original');error.cause=failure;throw error;}
  }
}
function sqliteMutation(action){
  try{return action();}catch(error){
    if(error?.errcode===13){const capacity=new ChannelError('STORE_CAPACITY_EXCEEDED','repair_configuration');capacity.cause=error;throw capacity;}
    throw error;
  }
}
function ensureStorageEntry(stat,directory,nativeProof,path){
  requireValue(stat&&!stat.isSymbolicLink()&&(directory?stat.isDirectory():stat.isFile())&&(directory||stat.nlink===1n),directory?'UNSAFE_STORE_DIRECTORY':'UNSAFE_STORE_FILE');
  if(process.platform==='win32')requireValue(nativeProof?.(path)===true&&stat.ino!==0n,'NATIVE_STORE_IDENTITY_REQUIRED');
}
function namedMatches(path,named,held,directory,nativeProof){
  if(same(identity(named),identity(held)))return true;
  if(process.platform!=='win32'||named.dev!==0n||named.ino!==held.ino)return false;
  // Node 22 can omit the named volume number on Windows. Query the current
  // name through another handle; never discard the held volume or FileID pin.
  const fd=openSync(path,constants.O_RDONLY|nofollow|(directory?(constants.O_DIRECTORY??0):0));
  try{const current=fstatSync(fd,{bigint:true});ensureStorageEntry(current,directory,nativeProof,path);return same(identity(current),identity(held));}
  finally{closeSync(fd);}
}
export function verifyPrivateStoreRoot(directory,nativeProof,{create=false}={}){
  const root=resolve(directory);
  if(create&&!present(root)){try{mkdirSync(root);}catch(error){if(error.code==='ENOENT')throw new ChannelError('STORE_DIRECTORY_MISSING','repair_configuration');throw error;}}
  const stat=present(root);requireValue(stat,'STORE_DIRECTORY_MISSING','repair_configuration');ensureStorageEntry(stat,true,nativeProof,root);return root;
}
function anchor(path,directory,nativeProof){
  const stat=present(path);requireValue(stat,'STORE_BINDING_OR_DATA_MISSING','repair_configuration');ensureStorageEntry(stat,directory,nativeProof,path);
  const fd=openSync(path,constants.O_RDONLY|nofollow|(directory?(constants.O_DIRECTORY??0):0));
  try{const opened=fstatSync(fd,{bigint:true});requireValue(namedMatches(path,stat,opened,directory,nativeProof),'STORE_IDENTITY_CHANGED','repair_configuration');return {path,fd,identity:identity(opened),directory};}
  catch(error){closeAll([()=>closeSync(fd)]);throw error;}
}
function verifyAnchor(value,nativeProof){
  const named=present(value.path);requireValue(named,'STORE_BINDING_OR_DATA_MISSING','repair_configuration');
  const held=fstatSync(value.fd,{bigint:true});ensureStorageEntry(named,value.directory,nativeProof,value.path);ensureStorageEntry(held,value.directory,nativeProof,value.path);
  requireValue(namedMatches(value.path,named,held,value.directory,nativeProof)&&same(identity(held),value.identity),'STORE_IDENTITY_CHANGED','repair_configuration');
}
function verifySidecars(path,nativeProof){
  for(const suffix of ['-wal','-shm','-journal']){const named=path+suffix,stat=present(named);if(stat)ensureStorageEntry(stat,false,nativeProof,named);}
}
function readJson(value,maxBytes=16384){
  const stat=fstatSync(value.fd,{bigint:true});requireValue(stat.size>0n&&stat.size<=BigInt(maxBytes),'STORE_BINDING_UNCONFIRMED','repair_configuration');
  const data=Buffer.alloc(Number(stat.size));
  try{let offset=0;while(offset<data.length){const count=readSync(value.fd,data,offset,data.length-offset,offset);requireValue(count>0,'STORE_BINDING_UNCONFIRMED','repair_configuration');offset+=count;}const after=fstatSync(value.fd,{bigint:true});requireValue(stat.size===after.size&&stat.mtimeNs===after.mtimeNs,'STORE_BINDING_CHANGED','repair_configuration');return JSON.parse(data.toString('utf8'));}
  catch(error){if(error instanceof ChannelError)throw error;throw new ChannelError('STORE_BINDING_UNCONFIRMED','repair_configuration');}
}
function sqlite(path,mode){
  try{return new DatabaseSync(existingSqliteFileUri(path,mode),{readOnly:mode==='ro'});}catch{throw new ChannelError('STORE_OPEN_UNAVAILABLE','repair_configuration');}
}
function createFile(path){return openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|nofollow);}
function writeJson(fd,value){
  const data=Buffer.from(canonical(value));let offset=0;
  while(offset<data.length){const count=writeSync(fd,data,offset,data.length-offset,offset);requireValue(Number.isInteger(count)&&count>0&&count<=data.length-offset,'STORE_BINDING_WRITE_UNCONFIRMED','repair_configuration');offset+=count;}
  ftruncateSync(fd,data.length);fsyncSync(fd);
}
function configureCapacity(db,maxMetadataBytes){
  const pageSize=db.prepare('PRAGMA page_size').get().page_size;
  const limit=Math.max(64,Math.floor(maxMetadataBytes/pageSize));
  const configured=db.prepare('PRAGMA max_page_count='+limit).get().max_page_count;
  requireValue(configured<=limit,'STORE_CAPACITY_EXCEEDED','repair_configuration');
}
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
    return withCleanup(()=>{requireValue(existing.binding.initializationId===initializationId,'STORE_ALREADY_BOUND','reconcile_original');return {root,bindingPath,initializationId};},[()=>existing.close()]);
  }
  verifyPrivateStoreRoot(root,nativeWindowsProof,{create:true});
  requireValue(readdirSync(root).length===0,'STORE_INITIALIZATION_UNCONFIRMED','repair_configuration');
  const rootAnchor=anchor(root,true,nativeWindowsProof),files=[];
  return withCleanup(()=>{
    const paths={db:join(root,'connectivity.sqlite3'),lock:join(root,'connectivity.lock'),ready:join(root,'connectivity.ready.json')};
    for(const kind of ['lock','db','ready']){const fd=createFile(paths[kind]);files.push({kind,fd,path:paths[kind]});fsyncSync(fd);}
    const binding={version:1,namespaceId:namespaceId??randomUUID(),initializationId,schemaVersion:VERSION,schemaHash:expectedSchema,root:rootAnchor.identity,...Object.fromEntries(files.map(value=>[value.kind,identity(fstatSync(value.fd,{bigint:true}))]))};
    const bindingFd=createFile(bindingPath);files.push({kind:'binding',fd:bindingFd,path:bindingPath});writeJson(bindingFd,binding);
    verifyAnchor(rootAnchor,nativeWindowsProof);
    const db=sqlite(paths.db,'rw');
    withCleanup(()=>{
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA application_id='+APPLICATION_ID+'; PRAGMA user_version='+VERSION+';');
      configureCapacity(db,maxMetadataBytes);
      db.exec('BEGIN IMMEDIATE');
      try{for(const sql of SQL)db.exec(sql);const insert=db.prepare('INSERT INTO meta VALUES(?,?)');for(const[key,value]of Object.entries({binding_hash:digest(binding),initialization_id:initializationId,namespace_id:binding.namespaceId,schema_version:VERSION}))insert.run(key,value);db.exec('COMMIT');}
      catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
      verifyDatabase(db,binding);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    },[()=>db.close()]);
    writeJson(files.find(value=>value.kind==='ready').fd,readyValue(binding,identity(fstatSync(bindingFd,{bigint:true}))));
    // Windows cannot fsync a directory handle. Every created file and the ready
    // receipt are flushed above; the native owner verifies and commits that
    // same store before granting Ready. POSIX also flushes the sibling binding's parent.
    if(process.platform!=='win32'){
      fsyncSync(rootAnchor.fd);
      const parent=openSync(dirname(root),constants.O_RDONLY|(constants.O_DIRECTORY??0)|(constants.O_NOFOLLOW??0));
      withCleanup(()=>fsyncSync(parent),[()=>closeSync(parent)]);
    }
    return {root,bindingPath,initializationId};
  },()=>[...files.map(file=>()=>closeSync(file.fd)),()=>closeSync(rootAnchor.fd)]);
}

/** Holds original directory/file handles and never creates, chmods or repairs an existing store. */
export function openStoreFiles(directory,{nativeWindowsProof,assertExclusiveLease,expectedNamespaceId,maxMetadataBytes=64*1024*1024}={}){
  const root=verifyPrivateStoreRoot(directory,nativeWindowsProof),anchors=[],verifiedVersions=new WeakMap();let reader,writer,closed=false,inTransaction=false,writerUnconfirmed=false;
  try{
    const rootAnchor=anchor(root,true,nativeWindowsProof);anchors.push(rootAnchor);
    const bound=anchor(root+'.binding.json',false,nativeWindowsProof);anchors.push(bound);const binding=readJson(bound);
    requireValue(binding?.version===1&&binding.schemaVersion===VERSION&&['root','db','lock','ready'].every(key=>historicalIdentity(binding[key])),'STORE_BINDING_CHANGED','repair_configuration');
    requireValue(expectedNamespaceId===undefined||binding.namespaceId===expectedNamespaceId,'STORE_NATIVE_NAMESPACE_MISMATCH','repair_configuration');
    for(const[kind,name]of [['db','connectivity.sqlite3'],['lock','connectivity.lock'],['ready','connectivity.ready.json']]){
      const value=anchor(join(root,name),false,nativeWindowsProof);value.kind=kind;anchors.push(value);
    }
    // Persisted FileIDs are initialization history. The Native profile kernel lease
    // excludes writers; these anchors protect the current open lifetime.
    const readyAnchor=anchors.find(value=>value.kind==='ready'),ready=readJson(readyAnchor);
    requireValue(historicalIdentity(ready.bindingIdentity)&&canonical(ready)===canonical(readyValue(binding,ready.bindingIdentity)),'STORE_READY_UNCONFIRMED','repair_configuration');
    const path=join(root,'connectivity.sqlite3');verifySidecars(path,nativeWindowsProof);reader=sqlite(path,'ro');verifySidecars(path,nativeWindowsProof);verifyDatabase(reader,binding,verifiedVersions);
    const pageSize=reader.prepare('PRAGMA page_size').get().page_size,pageCount=reader.prepare('PRAGMA page_count').get().page_count;requireValue(pageCount*pageSize<=maxMetadataBytes,'STORE_CAPACITY_EXCEEDED');
    const verify=()=>{
      requireValue(!closed,'STORE_CLOSED');for(const value of anchors)verifyAnchor(value,nativeWindowsProof);
      verifySidecars(path,nativeWindowsProof);
      requireValue(canonical(readJson(bound))===canonical(binding)&&canonical(readJson(readyAnchor))===canonical(ready),'STORE_BINDING_CHANGED','repair_configuration');
      // SQLite invalidates this structural evidence on another connection's
      // commit. Business rows, file anchors and the live lease are never cached.
      verifyDatabase(inTransaction?writer:reader,binding,verifiedVersions);
    };
    const assertOwnership=()=>{verify();requireValue(typeof assertExclusiveLease==='function'&&assertExclusiveLease()===true,'NATIVE_STORE_LEASE_REQUIRED');};
    const write=()=>{
      assertOwnership();
      requireValue(!writerUnconfirmed,'STORE_WRITER_UNCONFIRMED','reconcile_original');
      if(!writer){
        const candidate=sqlite(path,'rw');
        try{verifyDatabase(candidate,binding,verifiedVersions);for(const value of anchors)verifyAnchor(value,nativeWindowsProof);candidate.exec('PRAGMA busy_timeout=50; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=64;');configureCapacity(candidate,maxMetadataBytes);writer=candidate;}
        catch(error){if(closeAll([()=>candidate.close()])){writer=candidate;writerUnconfirmed=true;}throw error;}
      }
      // data_version does not change for this connection's own writes.
      verifiedVersions.delete(writer);
      return writer;
    };
    const db={
      prepare(sql){return {
        get(...args){verify();return (inTransaction?writer:reader).prepare(sql).get(...args);},
        all(...args){verify();return (inTransaction?writer:reader).prepare(sql).all(...args);},
        run(...args){return sqliteMutation(()=>write().prepare(sql).run(...args));},
      };},
      exec(sql){
        const command=sql.trim().toUpperCase();
        if(command==='ROLLBACK'){
          try{writer?.exec(sql);}catch(error){
            // Recent runtimes can prove SQLite already rolled back after FULL/IOERR.
            // An absent or still-active transaction proof closes only the writer lane.
            let rolledBack=false;try{rolledBack=writer?.isTransaction===false;}catch{}
            if(!rolledBack){writerUnconfirmed=true;const failed=closeAll([()=>writer?.close()]);if(!failed){verifiedVersions.delete(writer);writer=undefined;}throw error;}
          }finally{inTransaction=false;}
          return;
        }
        const connection=write();sqliteMutation(()=>connection.exec(sql));
        if(command==='BEGIN IMMEDIATE')inTransaction=true;else if(command==='COMMIT')inTransaction=false;
      },
    };
    const close=()=>{
      if(closed)return;closed=true;let failed=false;
      for(const action of [()=>writer?.close(),()=>reader?.close(),...anchors.map(value=>()=>closeSync(value.fd))]){try{action();}catch{failed=true;}}
      requireValue(!failed,'STORE_CLOSE_UNCONFIRMED','reconcile_original');
    };
    return {root,db,binding,verify,assertOwnership,close};
  }catch(error){closeAll([()=>writer?.close(),()=>reader?.close(),...anchors.map(value=>()=>closeSync(value.fd))]);throw error;}
}

function relocationRows(db){
  // The frozen schema has rowid tables. Preserve their complete contents,
  // including unknown execution/delivery receipts and outstanding leases.
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all()
    .map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'"'+(name==='meta'?" WHERE key<>'binding_hash'":'')+' ORDER BY rowid').all()]));
}

/** The original coordinator owns admission; this store has no internal addresses to convert. */
export function relocateStoreFiles(options={}){return verifyStoreRelocation(options);}

/** Verify the stopped copy without rewriting binding, Ready, SQLite or old receipts. */
export function verifyStoreRelocation({source,finalTarget,operationId,expectedNamespaceId,expectedInitializationId,
  validateOffline,assertExclusiveLease,nativeWindowsProof,maxMetadataBytes=64*1024*1024}={}){
  identifier(operationId);identifier(expectedNamespaceId);identifier(expectedInitializationId);
  requireValue(/^[A-Za-z0-9_-]{1,128}$/.test(operationId)&&typeof source==='string'&&resolve(source)===source&&
    typeof finalTarget==='string'&&resolve(finalTarget)===finalTarget&&source!==finalTarget,'STORE_RELOCATION_INVALID');
  const facts=Object.freeze({domain:'native-application-store',source,finalTarget,operationId});
  const authority=()=>{
    requireValue(typeof validateOffline==='function'&&typeof assertExclusiveLease==='function','STORE_RELOCATION_AUTHORITY_REQUIRED');
    const value=validateOffline(facts);requireValue(value!==false&&(!value||typeof value.then!=='function'),'STORE_RELOCATION_AUTHORITY_REQUIRED');
    requireValue(assertExclusiveLease(facts)===true,'NATIVE_STORE_LEASE_REQUIRED');
  };
  authority();
  const stores=[],anchors=[];
  return withCleanup(()=>{
    for(const root of [source,finalTarget])stores.push(openStoreFiles(root,{nativeWindowsProof,assertExclusiveLease,expectedNamespaceId,maxMetadataBytes}));
    const [original,target]=stores;
    requireValue(!same(identity(present(source)),identity(present(finalTarget))),'STORE_RELOCATION_ALIASED_SOURCE');
    for(const store of stores){store.assertOwnership();requireValue(store.binding.initializationId===expectedInitializationId,'STORE_RELOCATION_INITIALIZATION_MISMATCH');
      requireValue(store.db.prepare('PRAGMA integrity_check').get().integrity_check==='ok','STORE_RELOCATION_DATABASE_CORRUPT');}
    requireValue(canonical(original.binding)===canonical(target.binding),'STORE_RELOCATION_COPY_MISMATCH');
    // Old owner receipts remain exact compatibility bytes, never current FileID authority.
    const receipts=[source,finalTarget].map(root=>{
      if(!present(root+'.relocation.json'))return null;
      const value=anchor(root+'.relocation.json',false,nativeWindowsProof);anchors.push(value);
      const receipt=readJson(value,128*1024);
      requireValue(receipt.version===1&&typeof receipt.operationId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(receipt.operationId)&&
        canonical(receipt.binding)===canonical(original.binding),'STORE_RELOCATION_OPERATION_CONFLICT','reconcile_original');
      return canonical(receipt);
    });
    requireValue(receipts[0]===receipts[1],'STORE_RELOCATION_COPY_MISMATCH');
    const rowsHash=digest(relocationRows(original.db)),sourceBindingHash=digest(original.binding);
    requireValue(digest(relocationRows(target.db))===rowsHash,'STORE_RELOCATION_COPY_MISMATCH');
    authority();for(const store of stores)store.assertOwnership();for(const value of anchors)verifyAnchor(value,nativeWindowsProof);
    return {operationId,root:finalTarget,namespaceId:target.binding.namespaceId,initializationId:target.binding.initializationId,
      bindingHash:digest(target.binding),sourceBindingHash,rowsHash};
  },()=>[...stores.map(store=>()=>store.close()),...anchors.map(value=>()=>closeSync(value.fd))]);
}
