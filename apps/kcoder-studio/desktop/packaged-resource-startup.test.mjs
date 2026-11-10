import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePackagedStartupResources } from './packaged-resource-startup.mjs';

function deferred() { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes;reject=no; });return {promise,resolve,reject}; }
function fixture(extra = {}) {
  const calls=[], warnings=[], pending=[deferred(),deferred()];
  const metadata={nativeConnectivityResources:{pin:'channel'}};
  let reads=0;
  const options={resourcesPath:'/owned/resources',metadataPath:'/owned/app/package.json',
    readMetadata:async()=>{reads++;return metadata;},warn:code=>warnings.push(code),
    ...Object.fromEntries(['channel','component'].map((name,index)=>[name,options=>{calls.push({name,options});return pending[index].promise;}])) , ...extra};
  return {options,calls,warnings,pending,metadata,get reads(){return reads;}};
}
test('both remaining domains start together, share one metadata read and preserve original opaque results',async()=>{
  const f=fixture(), running=preparePackagedStartupResources(f.options);
  await Promise.resolve();
  assert.equal(f.reads,1);assert.deepEqual(f.calls.map(call=>call.name),['channel','component']);
  for(const call of f.calls) assert.equal(call.options.appMetadata,f.metadata);
  const values=[Object.freeze({channel:true}),Object.freeze({component:true})];
  for(let index=0;index<2;index++) f.pending[index].resolve(values[index]);
  const result=await running;
  assert.equal(result.channel,values[0]);assert.equal(result.component,values[1]);
  assert.deepEqual(f.warnings,[]);
});
test('one failed domain leaves its siblings intact and does not abandon their pending verification',async()=>{
  const f=fixture(), running=preparePackagedStartupResources(f.options);let settled=false;void running.then(()=>{settled=true;});
  await Promise.resolve();f.pending[0].reject(Error('private-path-do-not-print'));
  await Promise.resolve();await Promise.resolve();assert.equal(settled,false);
  f.pending[1].resolve({component:true});const result=await running;
  assert.equal(result.channel,undefined);assert.deepEqual(result.component,{component:true});
  assert.deepEqual(f.warnings,['CHANNEL_NATIVE_UNAVAILABLE']);
});
test('metadata failure is read once and all optional domains fail without disclosing it',async()=>{
  const f=fixture({readMetadata:async()=>{throw Error('private-metadata-body');}});
  assert.deepEqual(await preparePackagedStartupResources(f.options),{});assert.deepEqual(f.calls,[]);
  assert.deepEqual(f.warnings,['CHANNEL_NATIVE_UNAVAILABLE','NATIVE_COMPONENT_IMAGE_UNAVAILABLE']);
});
test('legacy Office metadata does not start the removed component',async()=>{
  let officeCalls=0;
  const result=await preparePackagedStartupResources({
    resourcesPath:'/owned/resources',metadataPath:'/owned/package.json',
    readMetadata:async()=>({nativeOfficeResources:{pin:'legacy'}}),
    office:()=>{officeCalls++;throw Error('must not run');},
    channel:async()=>({channel:true}),component:async()=>({component:true}),
  });
  assert.equal(officeCalls,0);
  assert.deepEqual(result,{channel:{channel:true},component:{component:true}});
});
test('cancelled startup starts no verification and cancellation during metadata publishes no launch',async()=>{
  const abort=new AbortController();abort.abort();const early=fixture({signal:abort.signal});
  assert.equal(await preparePackagedStartupResources(early.options),null);assert.equal(early.reads,0);
  const metadata=deferred(), laterAbort=new AbortController(), f=fixture({signal:laterAbort.signal,readMetadata:()=>metadata.promise});
  const running=preparePackagedStartupResources(f.options);laterAbort.abort();metadata.resolve({});
  assert.equal(await running,null);assert.deepEqual(f.calls,[]);
});
test('close during verification joins every in-flight domain and prevents Gateway launch',async()=>{
  const abort=new AbortController(), f=fixture({signal:abort.signal});let gatewayStarts=0,settled=false;
  const running=preparePackagedStartupResources(f.options).then(result=>{settled=true;if(result)gatewayStarts++;return result;});
  await Promise.resolve();assert.equal(f.calls.length,2);abort.abort();
  f.pending[0].resolve({});await Promise.resolve();await Promise.resolve();assert.equal(settled,false);
  f.pending[1].reject(Error('cancelled-read'));assert.equal(await running,null);assert.equal(gatewayStarts,0);assert.deepEqual(f.warnings,[]);
});
test('a broken diagnostic sink cannot cancel another optional domain',async()=>{
  const f=fixture({warn:()=>{throw Error('closed-sink');}}),running=preparePackagedStartupResources(f.options);
  await Promise.resolve();f.pending[0].reject(Error('domain-failed'));f.pending[1].resolve({});
  assert.deepEqual((await running).component,{});
});

test('full desktop packaging includes the startup helper and its local image-verifier dependency',async()=>{
  const {readFile}=await import('node:fs/promises');
  const metadata=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  for(const file of ['desktop/packaged-resource-startup.mjs','desktop/native-component-image.mjs','desktop/resource-preparation-owner.mjs']) {
    assert.ok(metadata.build.files.includes(file),`Packaged main import must exist in ASAR: ${file}`);
  }
});
