import assert from 'node:assert/strict';
import {runE2E} from '../../harness/run-context.mjs';
import {closeRpcAndWait} from '../../harness/rpc.mjs';
import {startWebSearchNetworkFixture} from '../../harness/web-search-network-fixture.mjs';
import {prepareWebNativeBinary,startWebNativeSession,startWebNativeTurn,approveWebNativeTool,completeWebNativeTurn} from '../../harness/web-search-native-session.mjs';

function distribution(values) {
  assert.equal(values.length,5);
  assert.ok(values.every(value=>Number.isFinite(value)&&value>=0));
  const sorted=[...values].sort((a,b)=>a-b);
  return {samples:values,p50Ms:sorted[2],p95Ms:sorted[4],quantiles:'nearest rank; five samples, P95 is the maximum'};
}

await runE2E(import.meta.url,{
  testId:'native-search-cold-and-warm-controlled-network-first-source-and-complete-turn-timing',
  tier:'manual-live',
  modelPolicy:'Model-independent timing only: actual Gateway/Native WebSearch and WebFetch through owned CONNECT/TLS origins; fixed three-response local protocol. Zero public queries, paid models or task grading.',
  prerequisites:'An explicit current web-network-test-fixture binary; OpenSSL. Cold means a first query in a fresh private profile/app-server, warm means five subsequent queries in the fifth retained process/thread; no physical cold-boot or public-network claim.',
  budgets:{sourceQueries:10,pageReads:10,ordinaryModelRequests:30,wallClockMs:240000},
  retainSuccessEvidence:true,
},async context=>{
  context.abortSignal=AbortSignal.any([context.abortSignal,AbortSignal.timeout(240000)]);
  const checkpoint=process.env.KCODER_E2E_SEARCH_NATIVE_CHECKPOINT;
  const expectedSha256=process.env.KCODER_E2E_SEARCH_NATIVE_SHA256;
  assert.match(checkpoint??'',/^[a-f0-9]{40}$/,'An explicit frozen source checkpoint is required');
  assert.match(expectedSha256??'',/^[a-f0-9]{64}$/,'An explicit frozen fixture binary SHA256 is required');
  const {binary,identity}=await prepareWebNativeBinary(context,{inputCheckpoint:checkpoint});
  assert.equal(identity.sha256,expectedSha256);
  const network=await startWebSearchNetworkFixture(context,{scenario:'timing',resultCount:3});
  const samples=[];
  const query=async(session,rpc,mode,index,threadId)=>{
    const marker=`WEBCASE${mode.toUpperCase()}${index}`;
    const offset=rpc.messages().length;
    const started=performance.now();
    try {
    const turn=await startWebNativeTurn(rpc,`Run the owned timing search and read ${marker}.`,threadId);
    const searchApproval=await approveWebNativeTool(rpc,turn,'WebSearch');
    const searched=await rpc.waitFor(frame=>frame.method==='item/completed'&&frame.params?.threadId===turn.threadId&&frame.params?.turnId===turn.turnId&&frame.params?.item?.webSources?.operation==='search',45000,'timed native search receipt');
    const firstSourceMs=performance.now()-started;
    const fetchApproval=await approveWebNativeTool(rpc,turn,'WebFetch');
    const result=await completeWebNativeTurn(rpc,turn);
    const completeTurnMs=performance.now()-started;
    assert.equal(result.completed.params.turn.status,'completed');
    assert.equal(result.receipts.length,2);
    const search=searched.params.item.webSources,fetch=result.receipts.find(receipt=>receipt.operation==='fetch');
    assert.equal(search.status,'success');assert.equal(search.provider,'exa-public');assert.equal(search.sources.length,3);
    assert.ok(search.sources.every(source=>source.readStatus==='summary_only'&&source.cacheHit!==true));
    assert.equal(fetch.status,'success');assert.equal(fetch.sources[0].readStatus,'read');assert.equal(fetch.sources[0].cacheHit,false);
    const frames=rpc.messages().slice(offset);
    for(const [approval,receipt,name]of [[searchApproval,search,'WebSearch'],[fetchApproval,fetch,'WebFetch']]){
      const started=frames.find(frame=>frame.method==='item/started'&&frame.params?.threadId===turn.threadId&&frame.params?.turnId===turn.turnId&&frame.params?.item?.id===receipt.toolCallId);
      assert.ok(started);assert.equal(started.params.item.name,name);assert.equal(started.params.item.inputTruncated,false);
      const input=approval.params.action.input??approval.params.action.arguments;
      assert.notEqual(input,undefined);
      assert.deepEqual(typeof input==='string'?JSON.parse(input):input,started.params.item.input);
    }
    assert.equal(frames.filter(frame=>frame.method==='approval/resolved'&&frame.params?.threadId===turn.threadId&&frame.params?.turnId===turn.turnId).length,2);
    const snapshot=await rpc.request('thread/read',{threadId:turn.threadId,limit:100});
    const durable=snapshot.messages.flatMap(message=>(message.blocks||[]).flatMap(block=>block.webSources?[block.webSources]:[]));
    for(const receipt of result.receipts)assert.ok(durable.some(value=>JSON.stringify(value)===JSON.stringify(receipt)));
    await session.assertModelOnlySettings();
    const record={mode,index,...turn,firstSourceMs,completeTurnMs,search,fetch,approvals:[searchApproval,fetchApproval],normalAsk:true,frames};
    samples.push(record);await context.writeArtifactJson(`samples/${mode}-${index}.json`,record);
    return turn.threadId;
    } catch(error) {
      await context.writeArtifactJson(`samples/${mode}-${index}-failure.json`,{mode,index,error:String(error),elapsedMs:performance.now()-started,frames:rpc.messages().slice(offset),observations:network.observations});
      throw error;
    }
  };
  let warmSession,warmRpc,threadId;
  for(let index=1;index<=5;index++){
    const session=await startWebNativeSession(context,{binary,network,label:`timing-cold-${index}`});
    const rpc=await session.connect('owner');
    try{
      const currentThread=await query(session,rpc,'cold',index);
      if(index===5){warmSession=session;warmRpc=rpc;threadId=currentThread;}
    }finally{
      if(index!==5){await closeRpcAndWait(rpc);await context.stopOwned(`timing-cold-${index}-gateway`);}
    }
  }
  try{for(let index=1;index<=5;index++)threadId=await query(warmSession,warmRpc,'warm',index,threadId);}
  finally{await closeRpcAndWait(warmRpc);await context.stopOwned('timing-cold-5-gateway');}
  assert.equal(network.sourceCalls,10);assert.equal(network.mainModelCalls,30);assert.equal(network.observations.pages.length,10);
  assert.deepEqual(network.observations.failures,[]);assert.ok(network.observations.connects.every(value=>value.accepted));
  const stats={};
  for(const mode of ['cold','warm']){
    const group=samples.filter(value=>value.mode===mode);
    stats[mode]={firstSource:distribution(group.map(value=>value.firstSourceMs)),completeTurn:distribution(group.map(value=>value.completeTurnMs))};
  }
  const result={identity,checkpoint,stats,definitions:{cold:'first query in each fresh private profile/app-server',warm:'five subsequent queries in the fifth retained process/thread; its first request is cold sample five',firstSource:'turn/start until the actual native search completion with source IDs',completeTurn:'turn/start until actual native turn/completed, including two normal ASK round trips and fixed local protocol'},publicQueries:0,paidModels:0,cacheBypassed:true,controlledSourceQueries:network.sourceCalls,controlledPageReads:network.observations.pages.length,localProtocolResponses:network.mainModelCalls,observations:network.observations,limits:['Five samples per group; nearest-rank P95 equals maximum','Owned origin latency and model protocol only; no public-network or model-quality latency claim','Warm denotes a retained native process; its first request is reported separately as cold sample five']};
  await context.writeArtifactJson('native-search-timing.json',result);
  assert.ok(stats.warm.firstSource.p95Ms<=15000,'Controlled warm first-source P95 must meet the plan target');
  return result;
});
