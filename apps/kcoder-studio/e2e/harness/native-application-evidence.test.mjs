import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {readFile,open} from 'node:fs/promises';
import {RunContext,waitFor} from './run-context.mjs';
import {originalApplicationFixtureExited} from './native-application-evidence.mjs';

test('owned MCP observation distinguishes original process, PID reuse and inaccessible state',async()=>{
 const record={pid:123,startTicks:'456'};
 const stat=ticks=>`123 (owned source (fixture)) ${Array.from({length:20},(_,index)=>index===19?ticks:'S').join(' ')}`;
 assert.equal(await originalApplicationFixtureExited(record,async()=>stat('456')),false);
 assert.equal(await originalApplicationFixtureExited(record,async()=>stat('789')),true);
 assert.equal(await originalApplicationFixtureExited(record,async()=>{throw Object.assign(new Error('absent'),{code:'ENOENT'});}),true);
 await assert.rejects(originalApplicationFixtureExited(record,async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});}),/denied/);
 await assert.rejects(originalApplicationFixtureExited({pid:123,startTicks:null}),/Exact owned/);
});

test('registered controlled MCP source returns one typed resource and exact full bytes',async()=>{
 const context=await RunContext.create(import.meta.url,{testId:'application-controlled-mcp-contract',tier:'contract'});
 let failure;
 try{
  const log=context.pathInState('source.jsonl');
  const child=context.spawnOwned('owned-application-protocol',process.execPath,[fileURLToPath(new URL('./application-resource-mcp.cjs',import.meta.url)),'agent_mail',log],{env:context.isolatedEnvironment(),stdin:'pipe'});
  const responses=[];let pending='';
  child.stdout.on('data',chunk=>{pending+=chunk.toString('utf8');let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(line)responses.push(JSON.parse(line));}});
  let sequence=0;
  const call=async(method,params)=>{const id=++sequence;child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return waitFor(()=>responses.find(reply=>reply.id===id),5000,'owned MCP protocol reply',20);};
  assert.equal((await call('initialize',{protocolVersion:'2025-03-26'})).result.capabilities.resources!==undefined,true);
  const list=await call('resources/list',{});assert.equal(list.result.resources.length,1);
  const resource=list.result.resources[0];assert.equal(resource._meta['io.kcoder.applicationResource'].kind,'mailbox');
  const read=await call('resources/read',{uri:resource.uri});
  assert.equal(read.result.contents[0].uri,resource.uri);
  assert.equal(read.result.contents[0].text,'OWNED_MAIL_START\nFrom: owned-sender@example.invalid\nSubject: Fixture review\nReviewed total: 37 units.\nOWNED_MAIL_END');
  const exited=once(child,'exit');child.stdin.end();await exited;
  const rows=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row=>row.event==='resourceRead').length,1);
  assert.equal(await originalApplicationFixtureExited(rows.find(row=>row.event==='started')),true);
 }catch(error){failure=error;throw error;}
 finally{await context.finish(failure?'failed':'passed',null,failure);}
});

test('held owned artifact writes during cleanup preserve the active-context file guard and redaction',async()=>{
 const context=await RunContext.create(import.meta.url,{testId:'application-held-artifact-cleanup',tier:'contract'});
 const path=context.pathInArtifacts('held-fixed-observation.json');
 const file=await open(path,'wx',0o600);
 context.addCleanup('close exact held fixture artifact',()=>file.close());
 const secret='owned-artifact-redaction-marker';context.registerSecret(secret);
 context.addCleanup('write only the already held observation',async()=>{
  await assert.rejects(context.writeArtifactJson('forbidden-new-cleanup-file.json',{}),/finishing/);
  await file.writeFile(JSON.stringify(context.redactValue({marker:secret,count:1})));await file.sync();
 });
 await context.finish('passed');
 const captured=JSON.parse(await readFile(path,'utf8'));
 assert.equal(captured.marker,'[REDACTED]');assert.equal(captured.count,1);
});
