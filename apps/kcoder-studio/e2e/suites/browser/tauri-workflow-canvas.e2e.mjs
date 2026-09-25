import { startWorkflowModelFixture } from '../../harness/workflow-model.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, {testId:'native-workflow-canvas-edit-publish',tier:'manual-live',modelPolicy:'Deterministic loopback model protocol: real Tauri workflow selection and draft insertion'}, async context => {
 const client = await startOwnedAiVerify(context, {
  tauriBin:process.env.KCODER_E2E_TAURI_BIN || resolve(appRoot,'renderer/src-tauri/target/debug/app'),
  kcoderBin:process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot,'target/debug/kcoder'),
  rendererRoot:resolve(appRoot,'renderer/dist'),
 });
 const command = (action,id,args={}) => client.command(action,{selector:`[data-testid="${id}"]`,...args});
 try {
  await command('waitFor','desktop-sidebar');
  const fixture=await startWorkflowModelFixture(context);
  context.registerSecret('native-workflow-fixture');
  await writeFile(client.settingsPath,JSON.stringify({active_provider:'fixture',permission_mode:'bypass',tools:{profile:'full'},providers:{fixture:{api_format:'openai_chat_completions',endpoint:fixture.baseUrl,default_model:'fixture',context_window_tokens:128000,max_output_tokens:4096,output_headroom_tokens:8192,no_proxy:true}}}));
  await writeFile(resolve(dirname(client.settingsPath),'credentials.json'),JSON.stringify({fixture:{type:'api',key:'native-workflow-fixture'}}),{mode:0o600});
  // Create through the real protocol; library creation now opens normal chat.
  const seed = context.spawnOwned('workflow-seed', process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot,'target/debug/kcoder'),
   ['--settings-file',client.settingsPath,'--cwd',resolve(dirname(client.settingsPath),'../workspaces/tauri-verification'),'app-server'],
   {stdin:'pipe',env:context.isolatedEnvironment({KCODER_CONFIG_DIR:dirname(client.settingsPath)})});
  const responses = new Map();
  const lines = createInterface({input:seed.stdout});
  lines.on('line', line => { try { const message=JSON.parse(line); if(message.id) responses.set(message.id,message); else if(message.method==='turn/completed') responses.set('completed',message); } catch {} });
  const rpc=async(id,method,params)=>{
   seed.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
   const response=await waitFor(()=>responses.get(id),10000,method);
   assert.ok(!response.error,JSON.stringify(response.error)); return response.result;
  };
  await rpc(1,'initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'native-workflow-test',version:'1'}});
  const created=await rpc(2,'workflow/create',{title:'Native isolated canvas'});
  await rpc(3,'workflow/update',{id:created.id,expectedRevision:created.revision,title:created.title,description:'Reusable slide generation',inputSchema:{type:'object',required:['topic'],properties:{topic:{type:'string',title:'Topic',description:'What the slides should cover'},pages:{type:'integer',minimum:1,default:8}}}});
  lines.close(); await context.stopOwned('workflow-seed');
  await client.command('navigate',{value:'/workflows'});
  await command('waitFor',`workflow-library-${created.id}`);
  await command('click',`workflow-library-${created.id}`);
  await command('waitFor','workflow-add-node',{enabled:true});
  await command('click','workflow-add-node');
  await command('waitFor','workflow-node-title');
  await command('fill','workflow-node-title',{value:'Native review node'});
  await command('fill','workflow-node-prompt',{value:'Review the example. Do not execute during editing.'});
  await command('click','workflow-node-save');
  const libraryPath=resolve(dirname(client.settingsPath),'workflow-library/library.json');
  const readDefinition=async()=>{const library=JSON.parse(await readFile(libraryPath,'utf8'));return Object.values(library.records).find(value=>value.draft.title==='Native isolated canvas')?.draft;};
  const draft=await waitFor(async()=>{const value=await readDefinition();return value?.nodes[0]?.title==='Native review node'?value:null;},10000,'native persisted node');
  assert.equal(draft.nodes[0].prompt,'Review the example. Do not execute during editing.');
  await command('waitFor','workflow-publish',{enabled:true});
  await command('click','workflow-publish');
  const saved=await waitFor(async()=>{const value=await readDefinition();return value?.status==='saved'?value:null;},10000,'native publish');
  assert.equal(saved.savedVersion,1);
  assert.ok(saved.revision>draft.revision);
  await client.command('navigate',{value:'/'});
  await client.command('navigate',{value:'/workflows'});
  await command('waitFor',`workflow-library-${saved.id}`);
  await command('click',`workflow-library-${saved.id}`);
  await command('waitFor','workflow-canvas');
  await client.capture('native-workflow-saved.png');
  await client.command('navigate',{value:'/'});
  await command('fill','chat-message-input',{value:'Native reuse initial conversation'});
  await command('waitFor','send-message-button',{enabled:true});
  await command('click','send-message-button');
  await command('waitFor','workflow-reuse-open',{enabled:true});
  await command('click','workflow-reuse-open');
  await command('waitFor',`workflow-reuse-${saved.id}`);
  await command('click',`workflow-reuse-${saved.id}`);
  await command('waitFor','workflow-reuse-insert',{enabled:true});
  await client.capture('native-workflow-reuse-picker.png');
  await command('click','workflow-reuse-parameters-toggle');
  await command('waitFor','workflow-arg-topic');
  await command('fill','workflow-arg-topic',{value:'AI workflows'});
  assert.equal(await command('getValue','workflow-arg-pages'),'8');
  await client.capture('native-workflow-optional-parameters.png');
  await command('click','workflow-reuse-insert');
  await command('waitFor','chat-message-input',{text:'definition_id'});
  await client.capture('native-workflow-reuse-inserted.png');
  await context.writeArtifactJson('native-workflow-evidence.json',{id:saved.id,revision:saved.revision,version:saved.savedVersion,nodeCount:saved.nodes.length,native:true,modelIndependent:true});
  return {native:true,edited:true,published:true,reopened:true};
 } catch(error) { client.markFailed(); await client.capture('failure.png').catch(()=>{}); throw error; }
 finally { await client.stop(); }
});
