import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,chmod,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recordApplicationStartupFailure} from '../src/applications/startup-diagnostics.mjs';

test('startup diagnostics retain only hashes and fixed source locations in private owned runtime storage',{skip:process.platform!=='linux'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'kcoder-startup-diagnostic-'));t.after(()=>rm(root,{recursive:true,force:true}));await chmod(root,0o700);
 const error=Object.assign(new Error('SYNTHETIC_PRIVATE_VALUE'),{code:'SYNTHETIC_PRIVATE_CODE',stack:'Error: SYNTHETIC_PRIVATE_VALUE\n at boot (/private/path/stdio.mjs:12:3)'});
 assert.equal(await recordApplicationStartupFailure(error,{stage:'STORE_OPEN',runtimeDirectory:root}),true);
 const files=await readdir(root),path=join(root,files[0]),raw=await readFile(path,'utf8'),value=JSON.parse(raw);
 assert.equal(files.length,1);assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(value.stage,'STORE_OPEN');assert.deepEqual(value.frames,['stdio.mjs:12:3']);assert.ok(!raw.includes('SYNTHETIC_PRIVATE')&&!raw.includes('/private/path'));
 assert.equal(await recordApplicationStartupFailure(new Error('replacement'),{runtimeDirectory:root}),false);assert.equal(await readFile(path,'utf8'),raw);
});
test('startup diagnostics never write to a group-accessible directory',{skip:process.platform!=='linux'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'kcoder-startup-diagnostic-'));t.after(()=>rm(root,{recursive:true,force:true}));await chmod(root,0o750);
 assert.equal(await recordApplicationStartupFailure(new Error('private'),{runtimeDirectory:root}),false);assert.deepEqual(await readdir(root),[]);
});
