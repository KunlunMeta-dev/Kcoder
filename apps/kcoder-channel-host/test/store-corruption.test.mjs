import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,statSync,readdirSync,chmodSync,copyFileSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { ConnectivityStore } from '../src/applications/store.mjs';
import { storeSchemaFailureStage } from '../src/applications/store-bootstrap.mjs';
import { publicError } from '../src/errors.mjs';
import { createFixtureStore,removeFixtureStore } from './store-fixture.mjs';
const scope={accountId:'owner',targetId:'target',workspaceId:null,identityGeneration:'1',targetRevision:'1'};
const event={platform:'qq',channelId:'channel',tenantId:'tenant',botId:'bot',eventId:'event',senderId:'sender',conversationId:'conversation',chatKind:'private',kind:'message',text:'original',attachments:[]};
function uri(path,mode='rw'){const value=pathToFileURL(path);value.searchParams.set('mode',mode);return value.href;}
function fixture(t,prefix='kcoder-sealed-store-'){
 const root=mkdtempSync(join(tmpdir(),prefix)),initializationId='original-initialization';let store=createFixtureStore(root,{initializationId});
 t.after(()=>{try{store?.close();}finally{removeFixtureStore(root);}});return {root,initializationId,get store(){return store;},close(){store.close();store=null;}};
}
test('existing open never creates a directory or database when any required namespace is missing',t=>{
 const parent=mkdtempSync(join(tmpdir(),'kcoder-no-implicit-create-')),root=join(parent,'missing');t.after(()=>rmSync(parent,{recursive:true,force:true}));
 assert.throws(()=>ConnectivityStore.open(root),/STORE_DIRECTORY_MISSING/);assert.equal(existsSync(root),false);
 mkdirSync(root,{mode:0o700});assert.throws(()=>ConnectivityStore.open(root),/STORE_BINDING_OR_DATA_MISSING/);assert.deepEqual(readdirSync(root),[]);
});
test('URI mode=rw reads and writes an existing real database with spaces and Chinese filenames',t=>{
 const f=fixture(t,'kcoder-资料 空格-');f.store.putEntity('probe',scope,'original',{value:'original'});
 const path=join(f.root,'connectivity.sqlite3'),db=new DatabaseSync(uri(path));
 try{
  const original=db.prepare("SELECT value_json FROM entities WHERE id='original'").get();assert.equal(JSON.parse(original.value_json).value,'original');
  db.prepare("UPDATE entities SET value_json=? WHERE id='original'").run('{"value":"updated"}');
  assert.equal(f.store.readEntity('probe',scope,'original').value,'updated');assert.equal(statSync(db.prepare('PRAGMA database_list').get().file).ino,statSync(path).ino);
  assert.ok(existsSync(path+'-wal'));assert.ok(readdirSync(f.root).every(name=>!name.includes('?mode=')&&!name.startsWith('file:')));
 }finally{db.close();}
 const missing=join(f.root,'缺失 文件.sqlite');assert.throws(()=>new DatabaseSync(uri(missing)));assert.equal(existsSync(missing),false);
});
test('read/reconnect leaves schema_version, data_version, total_changes and permissions unchanged',t=>{
 const f=fixture(t);f.store.putEntity('probe',scope,'original',{value:'original'});f.close();
 const path=join(f.root,'connectivity.sqlite3'),observer=new DatabaseSync(uri(path,'ro'));
 const snapshot=()=>({schema:observer.prepare('PRAGMA schema_version').get().schema_version,data:observer.prepare('PRAGMA data_version').get().data_version,changes:observer.prepare('SELECT total_changes() AS value').get().value,mode:statSync(path).mode});
 const before=snapshot();let reader;
 try{reader=ConnectivityStore.open(f.root);assert.equal(reader.readEntity('probe',scope,'original').value,'original');reader.listEntities('probe',scope);reader.close();assert.deepEqual(snapshot(),before);}
 finally{reader?.close();observer.close();}
});
for(const version of [0,3,5])test('unsupported sealed-store version '+version+' is preserved without implicit initialization',t=>{
 const f=fixture(t);f.store.putEntity('probe',scope,'kept',{value:'original'});f.close();
 const path=join(f.root,'connectivity.sqlite3'),db=new DatabaseSync(uri(path));
 try{db.exec('PRAGMA user_version='+version);}finally{db.close();}
 assert.throws(()=>ConnectivityStore.open(f.root),/STORE_SCHEMA_CORRUPT/);
 const check=new DatabaseSync(uri(path,'ro'));
 try{
  assert.equal(check.prepare('PRAGMA user_version').get().user_version,version);
  assert.equal(JSON.parse(check.prepare("SELECT value_json FROM entities WHERE id='kept'").get().value_json).value,'original');
 }finally{check.close();}
});
for(const table of ['meta','entities','operations','inbox','outbox','leases'])test('missing committed '+table+' table is corruption, never an empty migration',t=>{
 const f=fixture(t);f.store.beginOperation(scope,'original-operation','save',{intent:'original'});const path=join(f.root,'connectivity.sqlite3');
 const attacker=new DatabaseSync(uri(path));attacker.exec('DROP TABLE '+table);attacker.close();
 assert.throws(()=>f.store.beginOperation(scope,'original-operation','save',{intent:'original'}),/STORE_SCHEMA_CORRUPT/);f.close();
 assert.throws(()=>ConnectivityStore.open(f.root),/STORE_SCHEMA_CORRUPT/);assert.throws(()=>ConnectivityStore.create(f.root,{initializationId:f.initializationId,assertExclusiveLease:()=>true}),/STORE_SCHEMA_CORRUPT/);
 const check=new DatabaseSync(uri(path,'ro'));try{assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name=?").get(table).n,0);}finally{check.close();}
});
for(const key of ['binding_hash','initialization_id','namespace_id','schema_version'])test('missing committed meta row '+key+' never gets INSERT OR IGNORE repair',t=>{
 const f=fixture(t),path=join(f.root,'connectivity.sqlite3'),attacker=new DatabaseSync(uri(path));attacker.prepare('DELETE FROM meta WHERE key=?').run(key);attacker.close();
 assert.throws(()=>f.store.listEntities('connection',scope),/STORE_META_CORRUPT/);f.close();assert.throws(()=>ConnectivityStore.open(f.root),/STORE_META_CORRUPT/);
 const check=new DatabaseSync(uri(path,'ro'));try{assert.equal(check.prepare('SELECT COUNT(*) AS n FROM meta WHERE key=?').get(key).n,0);}finally{check.close();}
});
test('deleting a committed DB refuses original operation retries and explicit create without recreating it',t=>{
 const f=fixture(t);f.store.putEntity('connection',scope,'app',{kind:'agentmail'});f.store.beginOperation(scope,'op','send',{original:true});
 const path=join(f.root,'connectivity.sqlite3');rmSync(path);
 assert.throws(()=>f.store.beginOperation(scope,'op','send',{original:true}));assert.throws(()=>f.store.readEntity('connection',scope,'app'));assert.equal(existsSync(path),false);f.close();
 assert.throws(()=>ConnectivityStore.open(f.root));assert.throws(()=>ConnectivityStore.create(f.root,{initializationId:f.initializationId,assertExclusiveLease:()=>true}));assert.equal(existsSync(path),false);
});
test('a same-content copied database is not adopted under the original file identity',t=>{
 const f=fixture(t);f.store.putEntity('probe',scope,'original',{value:'kept'});f.close();const path=join(f.root,'connectivity.sqlite3');renameSync(path,path+'.original');copyFileSync(path+'.original',path);chmodSync(path,0o600);
 assert.throws(()=>ConnectivityStore.open(f.root),/STORE_BINDING_CHANGED/);
});
test('a WAL symlink cannot redirect SQLite side effects to another owned fixture file',t=>{
 const f=fixture(t);f.close();const path=join(f.root,'connectivity.sqlite3-wal'),peer=join(f.root,'peer.txt');rmSync(path,{force:true});writeFileSync(peer,'peer-original',{mode:0o600});symlinkSync(peer,path);
 assert.throws(()=>ConnectivityStore.open(f.root),/UNSAFE_STORE_FILE/);assert.equal(readFileSync(peer,'utf8'),'peer-original');
});
for(const name of ['connectivity.lock','connectivity.ready.json'])test('deleting the original '+name+' anchor never recreates or reclaims it',t=>{
 const f=fixture(t),path=join(f.root,name);rmSync(path);assert.throws(()=>f.store.readEntity('connection',scope,'connection'));assert.equal(existsSync(path),false);f.close();assert.throws(()=>ConnectivityStore.open(f.root));assert.equal(existsSync(path),false);
});
test('replacing a same-content binding is rejected by held handles and cross-bound ready identity',t=>{
 const f=fixture(t),path=f.root+'.binding.json',source=readFileSync(path);renameSync(path,path+'.original');writeFileSync(path,source,{mode:0o600});
 t.after(()=>rmSync(path+'.original',{force:true}));assert.throws(()=>f.store.listEntities('connection',scope),/STORE_IDENTITY_CHANGED/);f.close();assert.throws(()=>ConnectivityStore.open(f.root),/STORE_READY_UNCONFIRMED/);
});
test('directory replacement cannot silently rebind the old instance or a reconnect',t=>{
 const f=fixture(t),moved=f.root+'.original';renameSync(f.root,moved);mkdirSync(f.root,{mode:0o700});t.after(()=>rmSync(moved,{recursive:true,force:true}));
 assert.throws(()=>f.store.listEntities('connection',scope),/STORE_IDENTITY_CHANGED/);f.close();assert.throws(()=>ConnectivityStore.open(f.root),/STORE_BINDING_CHANGED/);assert.deepEqual(readdirSync(f.root),[]);
});
test('opening a committed file with broadened permissions refuses rather than chmod repairing it',t=>{
 const f=fixture(t),path=join(f.root,'connectivity.sqlite3');f.close();chmodSync(path,0o644);assert.throws(()=>ConnectivityStore.open(f.root),/STORE_FILE_NOT_PRIVATE/);assert.equal(statSync(path).mode&0o777,0o644);
});
test('explicit create retries only the original completed initialization and does not alter its namespace',t=>{
 const f=fixture(t);f.store.putEntity('probe',scope,'original',{value:'kept'});const namespace=f.store.storage.binding.namespaceId;f.close();
 const reopened=ConnectivityStore.create(f.root,{initializationId:f.initializationId,assertExclusiveLease:()=>true});try{assert.equal(reopened.storage.binding.namespaceId,namespace);assert.equal(reopened.readEntity('probe',scope,'original').value,'kept');}finally{reopened.close();}
 assert.throws(()=>ConnectivityStore.create(f.root,{initializationId:'different',assertExclusiveLease:()=>true}),/STORE_ALREADY_BOUND/);
});
test('without native exclusive lease a pure open reads but cannot authorize persistent mutations',t=>{
 const f=fixture(t);f.store.putEntity('probe',scope,'original',{value:'kept'});f.close();const reader=ConnectivityStore.open(f.root);
 try{assert.equal(reader.readEntity('probe',scope,'original').value,'kept');assert.throws(()=>reader.putEntity('probe',scope,'new',{value:'forbidden'}),/NATIVE_STORE_LEASE_REQUIRED/);assert.equal(reader.readEntity('probe',scope,'new'),null);}finally{reader.close();}
});
test('an entire self-consistent namespace cannot be adopted as a different native profile',t=>{
 const f=fixture(t);const originalNamespace=f.store.storage.binding.namespaceId;f.close();
 assert.throws(()=>ConnectivityStore.open(f.root,{expectedNamespaceId:'other-native-profile-namespace'}),/STORE_NATIVE_NAMESPACE_MISMATCH/);
 const correct=ConnectivityStore.open(f.root,{expectedNamespaceId:originalNamespace});correct.close();
});

test('schema diagnostic keeps the public refusal and exposes only a fixed stage',t=>{
 const f=fixture(t),path=join(f.root,'connectivity.sqlite3'),attacker=new DatabaseSync(uri(path));
 attacker.exec('PRAGMA application_id=0');attacker.close();
 assert.throws(()=>f.store.listEntities('connection',scope),error=>{
  assert.equal(storeSchemaFailureStage(error),'APPLICATION_ID');
  assert.deepEqual(publicError(error),{code:'STORE_SCHEMA_CORRUPT',recovery:'none',messageKey:'connectivity.store_schema_corrupt'});
  return true;
 });
 assert.equal(storeSchemaFailureStage({stage:'APPLICATION_ID',code:'STORE_SCHEMA_CORRUPT'}),null);
});
