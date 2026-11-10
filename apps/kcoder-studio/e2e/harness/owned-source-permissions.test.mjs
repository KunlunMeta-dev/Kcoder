import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, cp, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secureOwnedSourceTree } from './owned-source-permissions.mjs';

test('a private copy becomes immutable to peer groups while the source permissions remain intact',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kcoder-source-mode-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source'),copy=join(root,'copy');await mkdir(source);await writeFile(join(source,'sdk.mjs'),'// inert fixture\n');await chmod(join(source,'sdk.mjs'),0o664);
 await cp(source,copy,{recursive:true,errorOnExist:true,force:false});await secureOwnedSourceTree(copy);
 assert.equal((await lstat(join(source,'sdk.mjs'))).mode&0o777,0o664);
 assert.equal((await lstat(join(copy,'sdk.mjs'))).mode&0o777,0o600);
 assert.equal((await lstat(copy)).mode&0o777,0o700);
});
test('copied-source permissions never follow a link into an unrelated tree',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kcoder-source-link-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const owned=join(root,'owned'),outside=join(root,'outside');await mkdir(owned);await writeFile(outside,'unrelated');await chmod(outside,0o664);await symlink(outside,join(owned,'link'));
 await assert.rejects(secureOwnedSourceTree(owned),/copied regular files/);
 assert.equal((await lstat(outside)).mode&0o777,0o664);
});
