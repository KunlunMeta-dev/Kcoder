import { constants, closeSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existingSqliteFileUri } from '../sqlite-file-uri.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireValue=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const sameNamed=(named,opened)=>named.ino===opened.ino&&
  (named.dev===opened.dev||process.platform==='win32'&&named.dev===0n);
function file(path,directory=false){
  const named=lstatSync(path,{bigint:true});
  requireValue(!named.isSymbolicLink()&&(directory?named.isDirectory():named.isFile()&&named.nlink===1n),'CHANNEL_RELOCATION_UNSAFE_STORAGE');
  const flags=constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(directory?(constants.O_DIRECTORY??0):0);
  const fd=openSync(path,flags);
  try{const info=fstatSync(fd,{bigint:true});requireValue(sameNamed(named,info),'CHANNEL_RELOCATION_IDENTITY_CHANGED');return {path,fd,flags,info};}
  catch(error){closeSync(fd);throw error;}
}
function verify(anchor){
  const named=lstatSync(anchor.path,{bigint:true});
  requireValue(!named.isSymbolicLink()&&sameNamed(named,anchor.info)&&same(anchor.info,fstatSync(anchor.fd,{bigint:true})),'CHANNEL_RELOCATION_IDENTITY_CHANGED');
  const current=openSync(anchor.path,anchor.flags);
  try{requireValue(same(anchor.info,fstatSync(current,{bigint:true})),'CHANNEL_RELOCATION_IDENTITY_CHANGED');}
  finally{closeSync(current);}
}
function readDirectories({source,finalTarget,sourceReadDirectory,targetReadDirectory},target){
  const directories=target?[sourceReadDirectory,targetReadDirectory]:[sourceReadDirectory];
  requireValue(directories.every(path=>typeof path==='string'&&resolve(path)===path&&path!==source&&path!==finalTarget)&&
    (!target||sourceReadDirectory!==targetReadDirectory),'CHANNEL_RELOCATION_SOURCE_PROOF_REQUIRED');
  return directories;
}
function snapshot(db,maxBytes){
  requireValue(db.prepare('PRAGMA page_size').get().page_size*db.prepare('PRAGMA page_count').get().page_count<=maxBytes,'CHANNEL_RELOCATION_CAPACITY_EXCEEDED');
  requireValue(db.prepare('PRAGMA user_version').get().user_version===3,'CHANNEL_STORAGE_VERSION_UNSUPPORTED');
  requireValue(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok','CHANNEL_RELOCATION_DATABASE_CORRUPT');
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
  const tables=schema.filter(row=>row.type==='table');
  requireValue(tables.map(row=>row.name).sort().join(',')==='bindings,chats,connections,contexts,credentials,inbox,metadata,outbox','CHANNEL_RELOCATION_SCHEMA_UNSUPPORTED');
  const contents=tables.map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()]);
  const installationId=db.prepare("SELECT value FROM metadata WHERE key='installationId'").get()?.value;
  requireValue(typeof installationId==='string'&&installationId.length>0,'CHANNEL_STORAGE_METADATA_INVALID');
  return {installationId,contentsHash:hash({schema,contents})};
}

/** Native holds the original SQLite leases through this call. Node reads only
 * their operation-owned copies: opening an original, even read-only, can alter
 * SHM or checkpoint WAL on close. Every business row remains part of comparison. */
export function verifyChannelStoreRelocation({source,finalTarget,sourceReadDirectory,targetReadDirectory,operationId,validateOffline,maxBytes=256*1024*1024}={}){
  requireValue(typeof source==='string'&&resolve(source)===source&&typeof finalTarget==='string'&&resolve(finalTarget)===finalTarget&&source!==finalTarget&&
    typeof operationId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(operationId)&&typeof validateOffline==='function','CHANNEL_RELOCATION_AUTHORITY_REQUIRED');
  const facts=Object.freeze({domain:'gateway-channels',source,finalTarget,operationId});
  const authority=()=>{const result=validateOffline(facts);requireValue(result!==false&&(!result||typeof result.then!=='function'),'CHANNEL_RELOCATION_AUTHORITY_REQUIRED');};
  const anchors=[],databases=[];let failed=false;
  try{
    authority();
    for(const directory of readDirectories({source,finalTarget,sourceReadDirectory,targetReadDirectory},true)){
      const root=file(directory,true);anchors.push(root);
      const path=join(directory,'channels.sqlite3'),dbFile=file(path);anchors.push(dbFile);
      for(const suffix of ['-wal','-shm','-journal']){
        try{anchors.push(file(path+suffix));}catch(error){if(error.code!=='ENOENT')throw error;}
      }
      const db=new DatabaseSync(existingSqliteFileUri(path,'rw')),entry={db,locked:false};databases.push(entry);
      // Native already excludes original writers. This transaction also keeps
      // the disposable read copy stable across its complete row comparison.
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      entry.locked=true;
    }
    requireValue(!same(anchors[0].info,anchors.find(value=>value.path===targetReadDirectory).info),'CHANNEL_RELOCATION_IDENTITY_CHANGED');
    authority();for(const value of anchors)verify(value);
    const before=snapshot(databases[0].db,maxBytes),after=snapshot(databases[1].db,maxBytes);
    requireValue(before.installationId===after.installationId&&before.contentsHash===after.contentsHash,'CHANNEL_RELOCATION_COPY_MISMATCH');
    authority();for(const value of anchors)verify(value);
    return {...facts,...before};
  }catch(error){failed=true;throw error;}finally{
    let failure;
    for(const {db,locked} of databases.reverse()){
      if(locked)try{db.exec('ROLLBACK');}catch(error){failure??=error;}
      try{db.close();}catch(error){failure??=error;}
    }
    for(const value of anchors.reverse())try{closeSync(value.fd);}catch(error){failure??=error;}
    if(failure&&!failed)throw Object.assign(Error('CHANNEL_RELOCATION_CLOSE_UNCONFIRMED'),{cause:failure});
  }
}

/** The Native caller retains the original source lease before inventory and
 * through publication. SQLite may modify only this disposable read directory. */
export function verifyChannelStoreRelocationSource({source,finalTarget,sourceReadDirectory,operationId,validateOffline,maxBytes=256*1024*1024}={}){
  requireValue(typeof source==='string'&&resolve(source)===source&&typeof finalTarget==='string'&&resolve(finalTarget)===finalTarget&&source!==finalTarget&&
    typeof operationId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(operationId)&&typeof validateOffline==='function','CHANNEL_RELOCATION_AUTHORITY_REQUIRED');
  const facts=Object.freeze({domain:'gateway-channels',source,finalTarget,operationId});
  const authority=()=>{const value=validateOffline(facts);requireValue(value!==false&&(!value||typeof value.then!=='function'),'CHANNEL_RELOCATION_AUTHORITY_REQUIRED');};
  const anchors=[];let db,locked=false,failed=false;
  try{
    authority();
    const [directory]=readDirectories({source,finalTarget,sourceReadDirectory},false);
    anchors.push(file(directory,true));
    const path=join(directory,'channels.sqlite3');anchors.push(file(path));
    for(const suffix of ['-wal','-shm','-journal'])try{anchors.push(file(path+suffix));}catch(error){if(error.code!=='ENOENT')throw error;}
    db=new DatabaseSync(existingSqliteFileUri(path,'rw'));
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');locked=true;
    authority();for(const anchor of anchors)verify(anchor);
    const value=snapshot(db,maxBytes);
    authority();for(const anchor of anchors)verify(anchor);
    return {...facts,...value};
  }catch(error){failed=true;throw error;}finally{
    let failure;
    if(locked)try{db.exec('ROLLBACK');}catch(error){failure??=error;}
    if(db)try{db.close();}catch(error){failure??=error;}
    for(const anchor of anchors.reverse())try{closeSync(anchor.fd);}catch(error){failure??=error;}
    if(failure&&!failed)throw Object.assign(Error('CHANNEL_RELOCATION_CLOSE_UNCONFIRMED'),{cause:failure});
  }
}
