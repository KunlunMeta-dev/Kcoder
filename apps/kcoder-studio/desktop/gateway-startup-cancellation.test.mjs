import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startGateway } from './gateway-process.mjs';

test('a previously cancelled Gateway startup never spawns its command', async () => {
  const controller=new AbortController();controller.abort();
  await assert.rejects(startGateway({signal:controller.signal,nodeBinary:'/missing-never-start',timeoutMs:100}),/startup cancelled/);
});

for(const phase of ['readiness','login'])test(`cancelling actual owned child during ${phase} waits for its termination`,{timeout:10000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'kcoder-owned-start-cancel-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=join(root,'gateway.mjs');
  await writeFile(fixture,phase==='readiness'?`console.log('OWNED_PID='+process.pid);setInterval(()=>{},1000);`:`import {createServer} from 'node:http';const server=createServer(()=>{console.log('OWNED_PID='+process.pid);});server.listen(0,'127.0.0.1',()=>console.log('KCoder Studio: http://127.0.0.1:'+server.address().port));`);
  let observed;const started=new Promise(resolve=>{observed=resolve;});const controller=new AbortController();
  const pending=startGateway({gatewayScript:fixture,cwd:root,signal:controller.signal,timeoutMs:5000,loginTimeoutMs:5000,onStdout:chunk=>{const pid=String(chunk).match(/OWNED_PID=(\d+)/)?.[1];if(pid)observed(Number(pid));}});
  t.after(async()=>{controller.abort();await pending.catch(()=>{});});
  const rejected=assert.rejects(pending,/startup cancelled/);
  const pid=await started;controller.abort();await rejected;
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
});
