import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ChannelStore } from '../src/channels/store.mjs';
import { verifyChannelStoreRelocation, verifyChannelStoreRelocationSource } from '../src/channels/store-relocation.mjs';

function fixture(t,{long=false,namespaced=false}={}){
  const owned=mkdtempSync(join(tmpdir(),'kcoder-channel-relocation-'));t.after(()=>rmSync(owned,{recursive:true,force:true}));
  const parent=long?join(owned,...Array(24).fill('中文 空格😀'),'literal # % + & ='):owned;
  if(long)mkdirSync(parent,{recursive:true,mode:0o700});
  const root=namespaced?toNamespacedPath(parent):parent;
  const source=join(root,'source'),finalTarget=join(root,'target'),store=new ChannelStore(source);
  const connection=store.saveConnection({id:'connection-7',platform:'feishu',label:'Original',configuration:{appId:'original-app'},enabled:false});
  const chat=store.observeChat(connection.id,{platform:'feishu',conversationId:'chat-7',messageId:'message-7',text:'original input',occurredAtMs:7});
  store.db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?,?)').run('input-7',chat.id,'{"id":"original-event"}','accepted','{"result":"unknown"}','{"threadId":"original-thread"}',7);
  store.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?)').run('send-7',chat.id,'{"body":"original"}','unknown','{"receipt":"unknown"}');
  const installationId=store.installationId;store.close();cpSync(source,finalTarget,{recursive:true});chmodSync(finalTarget,0o700);
  return {root,source,finalTarget,installationId,reads:0,options:{source,finalTarget,operationId:'original-operation',validateOffline:()=>{}}};
}

function reads(f){
  const sourceReadDirectory=join(f.root,`source-read-${++f.reads}`),targetReadDirectory=join(f.root,`target-read-${f.reads}`);
  for(const [source,target] of [[f.source,sourceReadDirectory],[f.finalTarget,targetReadDirectory]]){
    cpSync(source,target,{recursive:true});chmodSync(target,0o700);
  }
  return {...f.options,sourceReadDirectory,targetReadDirectory};
}

const snapshot=directory=>readdirSync(directory).sort().map(name=>{
  const path=join(directory,name),info=statSync(path,{bigint:true});
  return [name,String(info.ino),String(info.mtimeNs),readFileSync(path).toString('hex')];
});

for(const namespaced of [false,true])test(`Windows channel database and read copies keep long URI filenames (${namespaced?'extended':'ordinary'})`,
  {skip:process.platform!=='win32'},t=>{
    // Actual Node/SQLite path acceptance, separate from Native lease/ACL evidence.
    const f=fixture(t,{long:true,namespaced}),before=snapshot(f.source),options=reads(f);
    assert.ok(f.source.length>260);
    assert.equal(verifyChannelStoreRelocationSource(options).installationId,f.installationId);
    assert.equal(verifyChannelStoreRelocation(options).installationId,f.installationId);
    assert.deepEqual(snapshot(f.source),before);
    const copy=new ChannelStore(options.targetReadDirectory);
    try{assert.equal(copy.db.prepare("SELECT receipt FROM outbox WHERE id='send-7'").get().receipt,'{"receipt":"unknown"}');}
    finally{copy.close();}
  });

test('the stopped channel database keeps its installation, business IDs and every unsettled receipt',t=>{
  const f=fixture(t),result=verifyChannelStoreRelocation(reads(f));
  assert.equal(result.installationId,f.installationId);
  const target=new ChannelStore(f.finalTarget);
  try{
    assert.deepEqual({...target.db.prepare('SELECT id,state,receipt FROM outbox').get()},{id:'send-7',state:'unknown',receipt:'{"receipt":"unknown"}'});
    assert.deepEqual({...target.db.prepare('SELECT id,state,result,binding_revision FROM inbox').get()},
      {id:'input-7',state:'accepted',result:'{"result":"unknown"}',binding_revision:7});
    assert.deepEqual(verifyChannelStoreRelocation(reads(f)),result);
  }finally{target.close();}
});

test('a busy read copy, changed business rows and missing source proof block verification',t=>{
  const f=fixture(t),options=reads(f),source=new ChannelStore(options.sourceReadDirectory);
  try{
    source.db.exec('BEGIN IMMEDIATE');
    assert.throws(()=>verifyChannelStoreRelocation(options),/locked/);
    source.db.exec('ROLLBACK');
  }finally{source.close();}
  const target=new ChannelStore(f.finalTarget);target.db.prepare("UPDATE outbox SET state='sent' WHERE id='send-7'").run();target.close();
  assert.throws(()=>verifyChannelStoreRelocation(reads(f)),/CHANNEL_RELOCATION_COPY_MISMATCH/);
  assert.throws(()=>verifyChannelStoreRelocation(f.options),/CHANNEL_RELOCATION_SOURCE_PROOF_REQUIRED/);
  assert.throws(()=>verifyChannelStoreRelocation({...f.options,validateOffline:undefined}),/CHANNEL_RELOCATION_AUTHORITY_REQUIRED/);
});

test('source preflight uses the real schema and leaves every persistent byte unchanged',t=>{
  const f=fixture(t),before=snapshot(f.source);
  assert.equal(verifyChannelStoreRelocationSource(reads(f)).installationId,f.installationId);
  assert.deepEqual(snapshot(f.source),before);
  const original=new ChannelStore(f.source);original.db.exec('PRAGMA user_version=999');original.close();
  assert.throws(()=>verifyChannelStoreRelocationSource(reads(f)),/CHANNEL_STORAGE_VERSION_UNSUPPORTED/);
});

for(const retainShm of [true,false])test(`crash WAL is read only through owned copies with original SHM ${retainShm?'present':'absent'}`,t=>{
  const f=fixture(t),module=new URL('../src/channels/store.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',
    `import{ChannelStore}from${JSON.stringify(module)};const store=new ChannelStore(process.argv[1]);\
     store.db.exec('PRAGMA wal_autocheckpoint=0');\
     store.db.prepare("UPDATE outbox SET state='unknown',receipt=? WHERE id='send-7'").run('{"receipt":"crash-unknown"}');\
     process.exit(0);`,f.source],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  if(!retainShm)rmSync(join(f.source,'channels.sqlite3-shm'));
  rmSync(f.finalTarget,{recursive:true});cpSync(f.source,f.finalTarget,{recursive:true});chmodSync(f.finalTarget,0o700);
  const before=snapshot(f.source),targetBefore=snapshot(f.finalTarget),options=reads(f);
  assert.ok(before.some(row=>row[0]==='channels.sqlite3-wal'));
  verifyChannelStoreRelocationSource(options);
  verifyChannelStoreRelocation(options);
  assert.deepEqual(snapshot(f.source),before);assert.deepEqual(snapshot(f.finalTarget),targetBefore);
  const observed=new ChannelStore(options.targetReadDirectory);
  try{assert.equal(observed.db.prepare("SELECT receipt FROM outbox WHERE id='send-7'").get().receipt,'{"receipt":"crash-unknown"}');}
  finally{observed.close();}
});
