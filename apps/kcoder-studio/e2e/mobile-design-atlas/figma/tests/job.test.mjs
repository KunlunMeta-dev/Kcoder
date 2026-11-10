import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runE2E } from '../../../harness/run-context.mjs';
import { acquireSyncLock, atomicSyncJson, decodeSyncResult, synchronizeFigma } from '../sync/job.mjs';
import { FigmaSyncRpc } from '../transport/codex.mjs';
import { updateReferenceIndex } from '../canvas/audit.mjs';

const owned = (name, body) => runE2E(import.meta.url, {testId:`figma-sync-job-${name}`,tier:'unit',modelPolicy:'Offline synthetic orchestration and RPC failure injection; no Figma service or model'}, body);
async function fixture(run) {
  const checkpointPath=run.pathInState('checkpoint.json'),journalPath=run.pathInArtifacts('journal.json');
  const checkpoint={schema:1,fileKey:'file',rootNodeId:'1:1',states:['A','B'].map(stateId=>({stateId,nodeId:`frame-${stateId}`,hash:`old-${stateId}`,sourceHash:null})),routes:[]};
  await atomicSyncJson(checkpointPath,checkpoint);
  const bundle={schema:1,checkpoint,states:['A','B'].map(id=>({id,scene:{text:id}}))};
  const remote={A:'old-A',B:'old-B'},calls=[];
  const makeScript=async(b,{stateIds,mode})=>JSON.stringify({stateIds,mode,checkpoint:b.checkpoint});
  const planBatches=async b=>b.states.map(s=>[s.id]);
  const call=async(_,args)=>{
    const p=JSON.parse(args.code);calls.push(p);
    if(p.mode==='preview')return{structuredContent:{entries:p.stateIds.map(id=>({stateId:id,action:p.checkpoint.states.find(s=>s.stateId===id).sourceHash===`new-${id}`?'unchanged':'update'})),
      conflicts:p.stateIds.filter(id=>p.checkpoint.states.find(s=>s.stateId===id).hash!==remote[id]).map(stateId=>({stateId,reason:'designer-edit'}))}};
    const states=p.stateIds.map(id=>({...p.checkpoint.states.find(s=>s.stateId===id),hash:remote[id]=`new-${id}`,sourceHash:`new-${id}`}));
    return{structuredContent:{status:'updated',createdNodeIds:['new'],checkpointDelta:{states,routes:[]}}};
  };
  const options={bundle,call,sessionId:'session',checkpointPath,journalPath,makeScript,planBatches};
  return{...options,remote,calls,options};
}

test('all previews precede writes, checkpoints persist, unchanged rerun has no apply calls',()=>owned('ordered',async run=>{
  const f=await fixture(run);const first=await synchronizeFigma(f.options);
  assert.deepEqual(f.calls.map(p=>p.mode),['preview','preview','apply','apply']);assert.equal(first.job.status,'complete');assert.equal(first.job.completed.length,2);
  f.calls.length=0;const second=await synchronizeFigma(f.options);assert.equal(second.job.preflight.changes,0);assert.ok(f.calls.every(p=>p.mode==='preview'));
}));

test('conflict stops before all writes and keeps authoritative checkpoint',()=>owned('conflict',async run=>{
  const f=await fixture(run),before=await readFile(f.checkpointPath,'utf8');f.remote.B='designer-change';
  await assert.rejects(()=>synchronizeFigma(f.options),/Figma conflict/);assert.ok(f.calls.every(p=>p.mode==='preview'));assert.equal(await readFile(f.checkpointPath,'utf8'),before);
}));

test('unknown receipt is reconciled by preview; an applied unknown write is never replayed',()=>owned('unknown',async run=>{
  const f=await fixture(run);const base=f.call;
  f.options.call=async(t,args)=>{const p=JSON.parse(args.code);if(p.mode==='apply'&&p.stateIds[0]==='B'){f.remote.B='new-B';throw new Error('lost receipt');}return base(t,args);};
  await assert.rejects(()=>synchronizeFigma(f.options),/lost receipt/);const journal=JSON.parse(await readFile(f.journalPath));assert.equal(journal.status,'unknown');assert.ok(journal.inFlight);
  f.calls.length=0;await assert.rejects(()=>synchronizeFigma({...f.options,call:base,journal}),/Figma conflict/);assert.ok(f.calls.every(p=>p.mode==='preview'));
}));

test('failed write with unchanged remote can resume; successful states are not replayed',()=>owned('resume',async run=>{
  const f=await fixture(run),base=f.call;let fail=true;
  f.options.call=async(t,args)=>{const p=JSON.parse(args.code);if(fail&&p.mode==='apply'&&p.stateIds[0]==='B'){fail=false;throw new Error('transport dropped before execution');}return base(t,args);};
  await assert.rejects(()=>synchronizeFigma(f.options),/transport/);const journal=JSON.parse(await readFile(f.journalPath));f.calls.length=0;
  const result=await synchronizeFigma({...f.options,journal});assert.equal(result.job.status,'complete');assert.deepEqual(f.calls.filter(p=>p.mode==='apply').flatMap(p=>p.stateIds),['B']);
}));

test('persisted receipt recovers local checkpoint failure after a successful remote write',()=>owned('receipt',async run=>{
  const f=await fixture(run),base=f.call;let changed=false;
  f.options.call=async(t,args)=>{const r=await base(t,args);if(!changed&&JSON.parse(args.code).mode==='apply'){changed=true;const c=JSON.parse(await readFile(f.checkpointPath));c.otherWriter='preserved';await atomicSyncJson(f.checkpointPath,c);}return r;};
  await assert.rejects(()=>synchronizeFigma(f.options),/saved receipt/);const journal=JSON.parse(await readFile(f.journalPath));assert.ok(journal.pendingReceipt);f.calls.length=0;
  const result=await synchronizeFigma({...f.options,call:base,journal});assert.equal(result.job.status,'complete');assert.equal(result.checkpoint.otherWriter,'preserved');assert.deepEqual(f.calls.filter(p=>p.mode==='apply').flatMap(p=>p.stateIds),['B']);
}));

test('dry run writes no remote changes; changed resume bundle and competing lock fail closed',()=>owned('dry',async run=>{
  const f=await fixture(run),before=await readFile(f.checkpointPath,'utf8');const r=await synchronizeFigma({...f.options,checkOnly:true});
  assert.equal(r.job.status,'checked');assert.equal(await readFile(f.checkpointPath,'utf8'),before);assert.ok(f.calls.every(p=>p.mode==='preview'));
  await assert.rejects(()=>synchronizeFigma({...f.options,journal:r.job,bundle:{...f.bundle,states:[{id:'A',scene:{text:'different'}}]}}),/original frozen/);
  const path=run.pathInState('lock');const release=await acquireSyncLock(path,{jobId:'owner'});await assert.rejects(()=>acquireSyncLock(path,{jobId:'peer'}),/Another sync/);await release();
}));

test('RPC transport pairs responses and refuses interactive requests; timeout marks unknown outcome',async()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();
  const rpc=new FigmaSyncRpc(child,{timeoutMs:25});let sent='';child.stdin.on('data',b=>{sent+=b.toString();});
  const reply=rpc.request('read',{});child.stdout.write(JSON.stringify({id:1,result:{ok:true}})+'\n');assert.deepEqual(await reply,{ok:true});
  child.stdout.write(JSON.stringify({id:77,method:'approve',params:{}})+'\n');await new Promise(r=>setTimeout(r,1));assert.match(sent,/Interactive requests are not supported/);
  await assert.rejects(()=>rpc.request('write',{}),/do not blindly replay/);rpc.close();child.stdout.end();
  assert.throws(()=>decodeSyncResult({isError:true,structuredContent:{error:{message:'rollback'},safeToRetryWithoutCanvasRead:true}}),/rollback/);
});

test('RPC rejects cleanup requests after owned process exit and settles pending calls on close', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough();
  const rpc = new FigmaSyncRpc(child);
  const pending = rpc.request('read', {});
  const rejected = assert.rejects(() => pending, /connection closed/);
  child.emit('exit', 0); await rejected;
  await assert.rejects(() => rpc.request('thread/unsubscribe', {}), /connection closed before/);
  assert.equal(rpc.pending.size, 0); rpc.close(); rpc.close();
  const other = new EventEmitter(); other.stdout = new PassThrough(); other.stdin = new PassThrough();
  const open = new FigmaSyncRpc(other); const waiting = open.request('read', {});
  const closed = assert.rejects(() => waiting, /connection closed/); open.close(); await closed;
  assert.equal(open.pending.size, 0);
});

test('reference index preserves metadata and counts owned starts; invalid audit cannot overwrite it',()=>owned('audit',async run=>{
  const path=run.pathInState('index.json');
  const checkpoint={fileKey:'file',rootNodeId:'ref'};
  const original={...checkpoint,designerMetadata:'preserve',counts:{other:7}};
  await atomicSyncJson(path,original);
  const audit={missing:[],temporary:[],emptyFrames:[],frames:['a','b'],bounds:{x:0,y:2500,width:900,height:1800},
    edges:[['button-a','b','NODE'],['button-b',null,'BACK']],flowStartingPoints:[{nodeId:'original'},{nodeId:'a'}],ownedFlowStartingPoints:[{nodeId:'a'}]};
  await updateReferenceIndex(path,checkpoint,audit,{componentSourceHash:'latest'});
  const result=JSON.parse(await readFile(path));
  assert.equal(result.designerMetadata,'preserve');assert.equal(result.counts.other,7);assert.equal(result.counts.prototypeStarts,1);
  assert.equal(result.counts.referenceScreens,2);assert.equal(result.counts.interactiveNodes,2);assert.equal(result.componentSourceSnapshot,'latest');
  const before=await readFile(path,'utf8');
  await assert.rejects(()=>updateReferenceIndex(path,checkpoint,{...audit,missing:[['bad','outside','NODE']]},{}),/destinations missing/);
  assert.equal(await readFile(path,'utf8'),before);
}));
