import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, link, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { RunContext } from './run-context.mjs';
import { holdOwnedExistingFileLease } from './owned-file-lease.mjs';

test('holds only the existing owned private lease and releases it without changing its bytes', { skip: process.platform !== 'linux' }, async()=>{
  const context=await RunContext.create(import.meta.url,{testId:'owned-existing-lease-exclusion'});let status='failed';
  try{
    const file=context.pathInState('private/.lock');await mkdir(resolve(file,'..'),{recursive:true,mode:0o700});await writeFile(file,'original',{mode:0o600});
    const release=await holdOwnedExistingFileLease(context,file,'first-owner');
    await assert.rejects(holdOwnedExistingFileLease(context,file,'second-owner'));
    await release();const again=await holdOwnedExistingFileLease(context,file,'reopened-owner');await again();
    assert.equal(await readFile(file,'utf8'),'original');status='passed';
  }finally{await context.finish(status);}
});
test('refuses parent/leaf symlinks and hard-linked files rather than locking an unintended resource', { skip: process.platform !== 'linux' }, async()=>{
  const context=await RunContext.create(import.meta.url,{testId:'owned-existing-lease-links'});let status='failed';
  try{
    const privateRoot=context.pathInState('private');await mkdir(privateRoot,{mode:0o700});const file=resolve(privateRoot,'.lock');await writeFile(file,'kept',{mode:0o600});
    const alias=context.pathInState('alias');await symlink(privateRoot,alias);
    await assert.rejects(holdOwnedExistingFileLease(context,resolve(alias,'.lock'),'parent-link'));
    await symlink(file,resolve(privateRoot,'leaf-link'));
    await assert.rejects(holdOwnedExistingFileLease(context,resolve(privateRoot,'leaf-link'),'leaf-link'));
    await link(file,resolve(privateRoot,'hard-link'));
    await assert.rejects(holdOwnedExistingFileLease(context,file,'hard-link'));
    assert.equal(await readFile(file,'utf8'),'kept');status='passed';
  }finally{await context.finish(status);}
});
