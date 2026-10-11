import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { startWorkflowModelFixture } from '../../harness/workflow-model.mjs';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url,{testId:'native-workflow-expanded-execution',tier:'manual-live',modelPolicy:'Deterministic provider routes a real Workflow tool; all node execution and human/event replies are real'},async context=>{
 const binary=process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot,'target/debug/kcoder');
 const client=await startOwnedAiVerify(context,{tauriBin:process.env.KCODER_E2E_TAURI_BIN || resolve(appRoot,'renderer/src-tauri/target/debug/app'),kcoderBin:binary,rendererRoot:resolve(appRoot,'renderer/dist')});
 const command=(action,id,args={})=>client.command(action,{selector:`[data-testid="${id}"]`,...args});
 let lines;
 try {
  await command('waitFor','desktop-sidebar');
  const fixture=await startWorkflowModelFixture(context);
  const profile=dirname(client.settingsPath), workspace=resolve(profile,'../workspaces/tauri-verification');
  context.registerSecret('workflow-nodes-fixture');
  await writeFile(client.settingsPath,JSON.stringify({active_provider:'fixture',permission_mode:'bypass',tools:{profile:'full'},providers:{fixture:{api_format:'openai_chat_completions',endpoint:fixture.baseUrl,default_model:'fixture',context_window_tokens:128000,max_output_tokens:4096,output_headroom_tokens:8192,no_proxy:true}}}));
  await writeFile(resolve(profile,'credentials.json'),JSON.stringify({fixture:{type:'api',key:'workflow-nodes-fixture'}}),{mode:0o600});
  const inputFile=resolve(workspace,'workflow-node-input.txt');
  await writeFile(inputFile,'Native direct-tool verification');
  const seed=context.spawnOwned('node-seed',binary,['--settings-file',client.settingsPath,'--cwd',workspace,'app-server'],{stdin:'pipe',env:context.isolatedEnvironment({KCODER_CONFIG_DIR:profile})});
  const responses=new Map(); lines=createInterface({input:seed.stdout});
  lines.on('line',line=>{try{const value=JSON.parse(line);if(value.id!==undefined)responses.set(value.id,value);}catch{}});
  let sequence=0;
  const rpc=async(method,params)=>{const id=++sequence;seed.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');const value=await waitFor(()=>responses.get(id),10000,method);assert.ok(!value.error,JSON.stringify(value));return value.result;};
  await rpc('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'node-native',version:'1'}});
  const save=async(title,nodes)=>{let def=await rpc('workflow/create',{title});for(const node of nodes)def=await rpc('workflow/upsertNode',{id:def.id,expectedRevision:def.revision,node});return rpc('workflow/save',{id:def.id,expectedRevision:def.revision});};
  const node=(id,kind,config={},dependsOn=[])=>({id,title:id,kind,config,dependsOn,position:{x:0,y:0}});
  const child=await save('Pure child',[node('compute','code',{code:{source:'return input.value * 2;'}})]);
  const graph=await save('Native expanded nodes',[
   node('transform','transform',{transform:{sourcePointer:'/input/values',steps:[{op:'limit',count:2}]}}),
   node('read','tool',{tool:{name:'read',arguments:{file_path:inputFile}},failurePolicy:{maxAttempts:2}}),
   node('child','subworkflow',{subworkflow:{definitionId:child.id,version:1,arguments:{value:3}}}),
   node('timer','wait',{wait:{delayMs:5}}),
   node('approval','human',{human:{prompt:'Approve the native test',responseSchema:{type:'object',required:['approved'],properties:{approved:{type:'boolean',default:false}}},timeoutMs:60000}},['timer']),
   node('event','event',{event:{name:'fixture-ready',payloadSchema:{type:'object',required:['ready'],properties:{ready:{type:'boolean'}}},timeoutMs:60000}}),
   node('result','code',{inputBindings:{items:'/nodes/transform'},resultCheck:{source:'return result.approved === true && result.items === bindings.items.length && result.readOk === true;'},code:{source:'return {approved:nodes.approval.approved,items:nodes.transform.length,child:nodes.child.outputs[0].output,event:nodes.event.ready,readOk:nodes.read.isError===false};'}},['transform','read','child','approval','event'])
  ]);
  await client.command('navigate',{value:'/'});
  await command('fill','chat-message-input',{value:'Run saved workflow '+JSON.stringify({definition_id:graph.id,version:1,args:{values:[1,2,3]}})});
  await command('waitFor','send-message-button',{enabled:true}); await command('click','send-message-button');
  await command('waitFor','workflow-execution-canvas');
  await command('waitFor','workflow-pending-approval');
  const runId=await waitFor(()=>fixture.observations.find(item=>item.kind==='run-reference')?.runId,10000,'workflow run ID');
  await rpc('workflow/runs/respond',{runId,requestId:`${runId}-node-5-await`,value:{ready:true}});
  await command('fill','workflow-arg-approved',{value:'0'});
  await client.command('click',{selector:'[data-testid="workflow-pending-approval"] [data-testid="workflow-submit-response"]'});
  const run=await waitFor(async()=>{const value=await rpc('workflow/runs/read',{runId});assert.notEqual(value.status,'failed',JSON.stringify(value));return value.status==='completed'?value:null;},20000,'all native nodes finish');
  const result=run.nodeStates.find(node=>node.nodeId==='result');
  assert.equal(result.status,'completed');
  assert.deepEqual(JSON.parse(result.outputPreview),{approved:true,items:2,child:6,event:true,readOk:true});
  const verified=await rpc('workflow/verification/read',{id:graph.id,version:1});
  const checked=verified.runs.find(item=>item.runId===runId);
  assert.equal(checked.executionStatus,'completed');
  assert.equal(checked.checkStatus,'passed');
  assert.deepEqual(checked.checkedNodes,['result']);
  assert.equal(checked.definitionSha256,verified.staticCheck.definitionSha256);
  assert.ok(checked.inputSha256 && checked.outputSha256);
  await client.capture('native-expanded-workflow-complete.png');
  await context.writeArtifactJson('expanded-node-results.json',{runId,nodeStates:run.nodeStates,result:JSON.parse(result.outputPreview)});
  // A failing check must reach the actual canvas and block later file writes.
  const blockedPath=resolve(workspace,'must-not-be-written.txt');
  const rejected=await save('Reject invalid result',[
   node('check','code',{code:{source:'return 1;'},resultCheck:{source:'return result === 2;'}}),
   node('blocked','tool',{tool:{name:'write',arguments:{file_path:blockedPath,content:'unexpected'}}},['check'])
  ]);
  await command('fill','chat-message-input',{value:'Run saved workflow '+JSON.stringify({definition_id:rejected.id,version:1,args:{}})});
  await command('waitFor','send-message-button',{enabled:true});await command('click','send-message-button');
  const failed=await waitFor(async()=>{const runs=await rpc('workflow/runs/list',{definitionId:rejected.id,limit:8});const item=runs.items[0];if(!item)return null;const current=await rpc('workflow/runs/read',{runId:item.runId});return current.status==='failed'?current:null;},20000,'result check rejects execution');
  assert.match(failed.error,/workflow_verification/);
  assert.equal(failed.nodeStates.find(item=>item.nodeId==='check')?.status,'failed');
  const failedEvidence=await rpc('workflow/verification/read',{id:rejected.id,version:1});
  const failedCheck=failedEvidence.runs.find(item=>item.runId===failed.runId);
  assert.equal(failedCheck.executionStatus,'failed');
  assert.equal(failedCheck.checkStatus,'failed');
  assert.equal(failedCheck.definitionSha256,failedEvidence.staticCheck.definitionSha256);
  await assert.rejects(readFile(blockedPath),{code:'ENOENT'});
  await client.command('waitFor',{selector:'[data-testid="workflow-node-check"][data-run-status="failed"]'});
  await client.capture('native-result-check-failed.png');
  await context.writeArtifactJson('result-check-rejection.json',{runId:failed.runId,error:failed.error,nodeStates:failed.nodeStates,downstreamWriteBlocked:true});

  await client.command('navigate',{value:'/workflows'});
  await command('waitFor',`workflow-library-${graph.id}`);
  await command('click',`workflow-library-${graph.id}`);
  await command('click','workflow-advanced-toggle');
  await command('waitFor','workflow-verification');
  await command('waitFor',`workflow-checked-${runId}`,{text:'result'});
  await command('waitFor','workflow-library-capacity');
  await command('click','workflow-management-toggle');
  await command('click','workflow-inspect-version-references');
  await command('waitFor','workflow-version-references',{text:runId});
  await command('click','workflow-storage-action');
  await command('waitFor','workflow-storage-dialog');
  await command('click','workflow-storage-confirm');
  await waitFor(async()=>await command('getElementCount','workflow-storage-dialog')==='0',10000,'native storage migration completed');
  assert.equal((await rpc('workflow/storage/read',{})).backend,'immutable_objects');
  await command('waitFor',`workflow-checked-${runId}`,{text:'result'});
  await client.capture('native-verification-migrated-storage.png');
  await context.writeArtifactJson('native-verification-evidence.json',{runId,definitionSha256:checked.definitionSha256,
    checkStatus:checked.checkStatus,failedRunId:failed.runId,failedCheckStatus:failedCheck.checkStatus,
    nativeEvidenceShown:true,nativeMigrationConfirmed:true});

  return {native:true,nodeKinds:['code','transform','tool','subworkflow','wait','human','event'],result:JSON.parse(result.outputPreview)};
 }catch(error){client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}
 finally{lines?.close();await context.stopOwned('node-seed');await client.stop();}
});
