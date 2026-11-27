import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { ConnectivityStore } from '../src/applications/store.mjs';
import { relocateStoreFiles, verifyStoreRelocation } from '../src/applications/store-bootstrap.mjs';
import { createFixtureStore } from './store-fixture.mjs';

const scope={accountId:'alice',targetId:'local',workspaceId:'project',identityGeneration:'generation-7',targetRevision:'9'};

test('binding convergence keeps a copied sealed store byte-identical under its Native lease',t=>{
  const f=fixture(t);
  const names=['connectivity.sqlite3','connectivity.ready.json'];
  const before=[readFileSync(f.finalTarget+'.binding.json'),...names.map(name=>readFileSync(join(f.finalTarget,name)))];
  const target=ConnectivityStore.open(f.finalTarget,{assertExclusiveLease:()=>true});
  try{
    assert.equal(target.beginOperation(scope,'original-accepted-operation','external-send',{businessId:'message-17'}).fresh,false);
    assert.equal(target.storage.db.prepare('SELECT state FROM outbox WHERE id=?').get('send-17').state,'unknown');
  }finally{target.close();}
  assert.deepEqual([readFileSync(f.finalTarget+'.binding.json'),...names.map(name=>readFileSync(join(f.finalTarget,name)))],before);
});
function fixture(t,{long=false,namespaced=false}={}){
  const root=mkdtempSync(join(tmpdir(),'kcoder-sealed-relocation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const parent=long?join(root,...Array(24).fill('中文 空格😀')):root;
  if(long)mkdirSync(parent,{recursive:true,mode:0o700});
  const path=value=>namespaced?toNamespacedPath(value):value;
  const source=path(join(parent,'source')),finalTarget=path(join(parent,'target'));
  const store=createFixtureStore(source);
  store.beginOperation(scope,'original-accepted-operation','external-send',{businessId:'message-17'});
  store.storage.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?,?,?)').run('owner','send-17',JSON.stringify(scope),'original-intent','unknown',17,'{"body":"retained"}','lease-7',0,'{"externalOutcome":"unknown"}');
  const {namespaceId,initializationId}=store.storage.binding;store.close();
  cpSync(source,finalTarget,{recursive:true});chmodSync(finalTarget,0o700);copyFileSync(source+'.binding.json',finalTarget+'.binding.json');
  const options={source,finalTarget,operationId:'original-migration-operation',expectedNamespaceId:namespaceId,
    expectedInitializationId:initializationId,validateOffline:()=>{},assertExclusiveLease:()=>true,
    nativeWindowsProof:process.platform==='win32'?()=>true:undefined};
  return {source,finalTarget,options};
}

for(const namespaced of [false,true])test(`Windows SQLite relocation reads Unicode long paths with ${namespaced?'extended':'ordinary'} spelling`,
  {skip:process.platform!=='win32'},t=>{
    // This tests Node/SQLite path handling. Unit proof ports do not establish
    // the independent Native lease and ACL acceptance of an installed package.
    const f=fixture(t,{long:true,namespaced});
    assert.ok(f.source.length>260);
    const original=readFileSync(f.source+'.binding.json');
    const result=verifyStoreRelocation(f.options);
    assert.equal(result.namespaceId,f.options.expectedNamespaceId);
    const store=ConnectivityStore.open(f.finalTarget,{assertExclusiveLease:()=>true,nativeWindowsProof:()=>true});
    try{
      assert.equal(store.storage.db.prepare('SELECT state FROM outbox WHERE id=?').get('send-17').state,'unknown');
    }finally{store.close();}
    assert.deepEqual(readFileSync(f.source+'.binding.json'),original);
  });

test('sealed owner verifies copies and preserves namespace, operation and unknown delivery receipts',t=>{
  const f=fixture(t),sourceBytes=readFileSync(f.source+'.binding.json');
  const result=relocateStoreFiles(f.options);
  assert.equal(result.namespaceId,f.options.expectedNamespaceId);
  const target=ConnectivityStore.open(f.finalTarget,{assertExclusiveLease:()=>true});t.after(()=>target.close());
  assert.equal(target.storage.binding.initializationId,f.options.expectedInitializationId);
  assert.equal(target.beginOperation(scope,'original-accepted-operation','external-send',{businessId:'message-17'}).fresh,false);
  assert.deepEqual({...target.storage.db.prepare('SELECT state,lease,result_json FROM outbox WHERE id=?').get('send-17')},
    {state:'unknown',lease:'lease-7',result_json:'{"externalOutcome":"unknown"}'});
  assert.deepEqual(readFileSync(f.source+'.binding.json'),sourceBytes);
  assert.deepEqual(relocateStoreFiles(f.options),result);
  assert.equal(existsSync(f.finalTarget+'.relocation.json'),false);
  assert.equal(relocateStoreFiles({...f.options,operationId:'coordinator-owned-operation'}).bindingHash,result.bindingHash);
});

test('read-only verification failure leaves no partially published binding or second ledger',t=>{
  const f=fixture(t);let calls=0;
  const paths=[f.finalTarget+'.binding.json',join(f.finalTarget,'connectivity.ready.json'),join(f.finalTarget,'connectivity.sqlite3')];
  const before=paths.map(path=>readFileSync(path));
  assert.throws(()=>relocateStoreFiles({...f.options,validateOffline:()=>{if(++calls===2)throw Error('lost-observation');}}),/lost-observation/);
  assert.deepEqual(paths.map(path=>readFileSync(path)),before);
  assert.equal(existsSync(f.finalTarget+'.relocation.json'),false);
  assert.deepEqual(relocateStoreFiles(f.options),verifyStoreRelocation(f.options));
});

test('legacy relocation bytes survive two later moves without adding another receipt',t=>{
  const f=fixture(t),binding=JSON.parse(readFileSync(f.source+'.binding.json','utf8'));
  const legacy={version:1,operationId:'old-move',source:'old-source',finalTarget:f.source,binding};
  const bytes=Buffer.from(JSON.stringify(legacy));
  writeFileSync(f.source+'.relocation.json',bytes,{mode:0o600});
  writeFileSync(f.finalTarget+'.relocation.json',bytes,{mode:0o600});
  relocateStoreFiles(f.options);
  const next=f.finalTarget+'-next';
  cpSync(f.finalTarget,next,{recursive:true});chmodSync(next,0o700);
  copyFileSync(f.finalTarget+'.binding.json',next+'.binding.json');
  copyFileSync(f.finalTarget+'.relocation.json',next+'.relocation.json');
  relocateStoreFiles({...f.options,source:f.finalTarget,finalTarget:next,operationId:'second-move'});
  assert.deepEqual(readFileSync(next+'.binding.json'),readFileSync(f.source+'.binding.json'));
  assert.deepEqual(readFileSync(next+'.relocation.json'),bytes);
  assert.deepEqual(readFileSync(join(next,'connectivity.ready.json')),readFileSync(join(f.source,'connectivity.ready.json')));
});

test('even the original operation preserves unrecognized prepared binding bytes',t=>{
  const f=fixture(t);relocateStoreFiles(f.options);
  writeFileSync(f.finalTarget+'.binding.json','{"unknown":true}');
  assert.throws(()=>relocateStoreFiles(f.options),/STORE_BINDING_CHANGED/);
  assert.equal(readFileSync(f.finalTarget+'.binding.json','utf8'),'{"unknown":true}');
});

test('a changed source and an unknown preparation are preserved and never adopted',t=>{
  const f=fixture(t);
  writeFileSync(f.finalTarget+'.relocation.json','{"unknown":true}',{mode:0o600});
  assert.throws(()=>relocateStoreFiles(f.options),/STORE_RELOCATION_OPERATION_CONFLICT/);
  assert.equal(readFileSync(f.finalTarget+'.relocation.json','utf8'),'{"unknown":true}');
  rmSync(f.finalTarget+'.relocation.json');
  const source=ConnectivityStore.open(f.source,{assertExclusiveLease:()=>true});
  source.beginOperation(scope,'new-source-operation','read',{changed:true});source.close();
  assert.throws(()=>relocateStoreFiles(f.options),/STORE_RELOCATION_COPY_MISMATCH/);
});

test('the Native lease and the executor callback are both required',t=>{
  const f=fixture(t);
  assert.throws(()=>relocateStoreFiles({...f.options,assertExclusiveLease:()=>false}),/NATIVE_STORE_LEASE_REQUIRED/);
  assert.throws(()=>relocateStoreFiles({...f.options,validateOffline:undefined}),/STORE_RELOCATION_AUTHORITY_REQUIRED/);
  assert.throws(()=>relocateStoreFiles({...f.options,validateOffline:()=>{throw Error('owner-still-active');}}),/owner-still-active/);
});

test('final sealed verification never completes a missing edge or changes ready and binding files',t=>{
  const f=fixture(t);assert.equal(verifyStoreRelocation(f.options).namespaceId,f.options.expectedNamespaceId);
  const receipt=relocateStoreFiles(f.options);
  const paths=[f.source+'.binding.json',f.finalTarget+'.binding.json',join(f.finalTarget,'connectivity.ready.json'),join(f.finalTarget,'connectivity.sqlite3')];
  const snapshot=()=>paths.map(path=>[path,String(statSync(path,{bigint:true}).mtimeNs),readFileSync(path).toString('hex')]),before=snapshot();
  assert.deepEqual(verifyStoreRelocation(f.options),receipt);assert.deepEqual(snapshot(),before);
  assert.throws(()=>verifyStoreRelocation({...f.options,assertExclusiveLease:()=>false}),/NATIVE_STORE_LEASE_REQUIRED/);
  writeFileSync(f.finalTarget+'.relocation.json','{"unknown":true}',{mode:0o600});
  assert.throws(()=>verifyStoreRelocation(f.options),/STORE_RELOCATION_OPERATION_CONFLICT/);
  assert.equal(readFileSync(f.finalTarget+'.relocation.json','utf8'),'{"unknown":true}');
});
