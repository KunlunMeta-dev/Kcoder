import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createResourcePreparationOwner } from './resource-preparation-owner.mjs';
import { preparePackagedStartupResources } from './packaged-resource-startup.mjs';
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

test('quit drains actual pending resource preparation even before any Gateway has been started',async()=>{
  const work=[deferred(),deferred()],abort=new AbortController(),owner=createResourcePreparationOwner();
  let starts=0,exited=false;
  const running=owner.run(()=>preparePackagedStartupResources({resourcesPath:'/owned',metadataPath:'/owned/package.json',signal:abort.signal,
    readMetadata:async()=>({}),channel:()=>work[0].promise,component:()=>work[1].promise})).then(value=>{if(value)starts++;return value;});
  await Promise.resolve();abort.abort();const quitting=owner.stop().then(()=>{exited=true;});
  await Promise.resolve();assert.equal(exited,false);
  work[0].resolve({});await Promise.resolve();assert.equal(exited,false);
  work[1].resolve({});assert.equal(await running,null);await quitting;
  assert.equal(exited,true);assert.equal(starts,0);
  assert.equal(await owner.run(()=>assert.fail('No late preparations after quit')),null);
});
test('stop is bounded and reports unknown completion without waiting forever or replaying work',async()=>{
  const work=deferred(),warnings=[],owner=createResourcePreparationOwner({timeoutMs:10,warn:code=>warnings.push(code)});
  const running=owner.run(()=>work.promise);const drain=owner.stop();assert.equal(owner.stop(),drain);
  assert.equal(await drain,false);assert.deepEqual(warnings,['NATIVE_RESOURCE_PREPARATION_STOP_UNCONFIRMED']);
  work.resolve({late:true});assert.equal(await running,null);
  assert.equal(await owner.run(()=>assert.fail('Closed owner')),null);
});
test('a verifier rejection is joined without blocking quit or touching another owner',async()=>{
  const a=createResourcePreparationOwner(),b=createResourcePreparationOwner(),one=deferred(),two=deferred();
  const failed=a.run(()=>one.promise),peer=b.run(()=>two.promise);
  const drain=a.stop();one.reject(Error('read-failed'));assert.equal(await failed,null);assert.equal(await drain,true);
  let settled=false;void peer.then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);
  two.resolve({peer:true});assert.deepEqual(await peer,{peer:true});assert.equal(await b.stop(),true);
});
test('main registers preparation with the same independent owner that the quit path drains',async()=>{
  const main=await readFile(new URL('./main.mjs',import.meta.url),'utf8');
  assert.match(main,/resourcePreparation\.run\(\(\) => preparePackagedStartupResources/);
  assert.match(main,/stopping = Promise\.all\(\[\s*resourcePreparation\.stop\(\)/);
  assert.ok(main.indexOf('startupAbort.abort()')<main.indexOf('resourcePreparation.stop()'));
  assert.match(main,/if \(!resources \|\| quitting\) return/);
});

test('a preparation failure before quit remains the original failure',async()=>{
  const owner=createResourcePreparationOwner(),failure=Error('owned-prepare-failed');
  await assert.rejects(owner.run(()=>{throw failure;}),error=>error===failure);
  assert.equal(await owner.stop(),true);
});
