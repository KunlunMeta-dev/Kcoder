import test from 'node:test';
import assert from 'node:assert/strict';
import { runInteractiveWindowsProbe } from './windows-interactive-probe.mjs';
test('interactive probe rejects shell paths and non-owned modes before any Windows mutation', async()=>{
  const options={directory:'C:\\owned',node:'C:\\node.exe',installation:'C:\\studio',flags:['--model-scope','--native-input'],
    ps:()=>{throw new Error('must not access host');},upload:()=>{throw new Error('must not upload');}};
  for(const invalid of [{directory:"C:\\bad'path"},{flags:['--accounts']},{node:''}])
    await assert.rejects(runInteractiveWindowsProbe({}, {...options,...invalid}),/Invalid owned|Unsupported interactive/);
});
test('scheduled task cleanup uses its independent transport after RunContext closes', async()=>{
  let closed=false;const cleanups=[];const calls=[];
  const context={addCleanup:(_name,fn)=>cleanups.push(fn),writeStateJson:async()=>'/owned/config.json'};
  const ps=async script=>{
    assert.equal(closed,false,'active spawn transport cannot be reused during cleanup');
    if(script.includes('$done=Test-Path'))return JSON.stringify({done:true,state:'Ready',result:0});
    if(script.startsWith('if(Test-Path'))return JSON.stringify({result:{passed:true},cleaned:true});
    return '';
  };
  const result=await runInteractiveWindowsProbe(context,{ps,cleanupPs:async script=>calls.push(script),upload:async()=>{},
    directory:'C:\\owned',node:'C:\\node.exe',installation:'C:\\studio',flags:['--model-scope','--native-input']});
  assert.equal(result.result.passed,true);closed=true;
  for(const cleanup of cleanups)await cleanup();
  assert.equal(calls.length,1);assert.match(calls[0],/Unregister-ScheduledTask/);
  assert.match(calls[0],/CommandLine.Contains/);
});
