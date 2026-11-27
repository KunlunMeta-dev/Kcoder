import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStoreFiles } from '../src/applications/store-bootstrap.mjs';
import { createFixtureStore, removeFixtureStore } from './store-fixture.mjs';

test('Windows named volume omission retains exact handle identity and Native proof',t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'kcoder-store-windows-identity-'));
  createFixtureStore(root).close();t.after(()=>removeFixtureStore(root));
  const platform=Object.getOwnPropertyDescriptor(process,'platform');
  const lstat=fs.lstatSync,fstat=fs.fstatSync;
  let mode='omitted',reads=0;
  const shape=(stat,dev)=>Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{dev});
  const named=t.mock.method(fs,'lstatSync',(...args)=>{
    const stat=lstat(...args);
    return shape(stat,mode==='wrong-named'?stat.dev+1n:0n);
  });
  const held=t.mock.method(fs,'fstatSync',(...args)=>{
    const stat=fstat(...args);reads++;
    return mode==='wrong-current-handle'&&reads===2?shape(stat,stat.dev+1n):stat;
  });
  Object.defineProperty(process,'platform',{...platform,value:'win32'});syncBuiltinESMExports();
  try{
    const store=openStoreFiles(root,{nativeWindowsProof:()=>true});
    store.verify();store.close();
    assert.throws(()=>openStoreFiles(root,{nativeWindowsProof:()=>false}),/NATIVE_STORE_IDENTITY_REQUIRED/);
    mode='wrong-named';reads=0;
    assert.throws(()=>openStoreFiles(root,{nativeWindowsProof:()=>true}),/STORE_IDENTITY_CHANGED/);
    mode='wrong-current-handle';reads=0;
    assert.throws(()=>openStoreFiles(root,{nativeWindowsProof:()=>true}),/STORE_IDENTITY_CHANGED/);
  }finally{
    Object.defineProperty(process,'platform',platform);
    named.mock.restore();held.mock.restore();syncBuiltinESMExports();
  }
});
