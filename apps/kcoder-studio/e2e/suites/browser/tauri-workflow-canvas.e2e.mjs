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
  let releaseAgent;
  const agentGate=new Promise(resolve=>{releaseAgent=resolve;});
  const fixture=await startWorkflowModelFixture(context,{beforeAgentReply:()=>agentGate});
  context.addCleanup('release native workflow agent',()=>releaseAgent());
  context.registerSecret('native-workflow-fixture');
  await writeFile(client.settingsPath,JSON.stringify({active_provider:'fixture',permission_mode:'bypass',tools:{profile:'full'},providers:{fixture:{api_format:'openai_chat_completions',endpoint:fixture.baseUrl,default_model:'fixture-long-model-name-for-canvas-layout',context_window_tokens:128000,max_output_tokens:4096,output_headroom_tokens:8192,no_proxy:true}}}));
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
  // QA: drag each divider, verify actual pane geometry, then reset before existing canvas cases.
  let dividerDrag = 0;
  const resizePane = async (handle, panel, delta) => {
    const [before] = JSON.parse(await command('getElementMetrics', panel));
    const [divider] = JSON.parse(await command('getElementMetrics', handle));
    const x = Math.round(divider.left + divider.width / 2), y = Math.round(divider.top + 50 + 12 * dividerDrag++);
    await client.command('dragPointer', { value: `${x},${y}:${x + delta},${y}` });
    await waitFor(async () => {
      const [after] = JSON.parse(await command('getElementMetrics', panel));
      return Math.abs(after.width - before.width) > 30;
    }, 5000, `${panel} changes width`);
  };
  await resizePane('workflow-library-resize', 'workflow-library-panel', 100);
  await resizePane('workflow-library-resize', 'workflow-library-panel', -100);

  await command('click','workflow-add-node');
  await command('waitFor','workflow-node-title');
  await command('fill','workflow-node-title',{value:'Native review node'});
  await command('fill','workflow-node-prompt',{value:'WF_NODE_A_WORK: Review the example. Do not execute during editing.'});
  await command('click','workflow-node-save');
  const libraryPath=resolve(dirname(client.settingsPath),'workflow-library/library.json');
  const readDefinition=async()=>{const library=JSON.parse(await readFile(libraryPath,'utf8'));return Object.values(library.records).find(value=>value.draft.title==='Native isolated canvas')?.draft;};
  const draft=await waitFor(async()=>{const value=await readDefinition();return value?.nodes[0]?.title==='Native review node'?value:null;},10000,'native persisted node');
  assert.equal(draft.nodes[0].prompt,'WF_NODE_A_WORK: Review the example. Do not execute during editing.');
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
  let previousBounds = '', stableBounds = 0;
  const nodeBounds = await waitFor(async () => {
    const [bounds] = JSON.parse(await command('getElementMetrics',`workflow-node-${saved.nodes[0].id}`));
    const identity = JSON.stringify([bounds.left,bounds.top,bounds.width,bounds.height].map(Math.round));
    stableBounds = identity === previousBounds ? stableBounds + 1 : 0;
    previousBounds = identity;
    return bounds.width > 0 && stableBounds >= 3 ? bounds : null;
  },5000,'canvas viewport fit settled before pointer drag');
  const beforeMove = await readDefinition();
  const nx = Math.round(nodeBounds.left + 40), ny = Math.round(nodeBounds.top + 20);
  await client.command('dragPointer',{value:`${nx},${ny}:${nx+60},${ny+40}`});
  const moved = await waitFor(async()=>{const value=await readDefinition();return value?.nodes[0].position.x !== beforeMove.nodes[0].position.x ? value : null;},5000,'node position saved independently');
  assert.equal(moved.revision,beforeMove.revision);
  assert.equal(moved.status,beforeMove.status);
  assert.ok(moved.updatedAtMs > beforeMove.updatedAtMs);
  const [bounds] = JSON.parse(await command('getElementMetrics','workflow-canvas'));
  const x = Math.round(bounds.left + 10), y = Math.round(bounds.bottom - 20);
  for (let i = 0; i < 4; i++) {
    await client.command('dragPointer',{value:`${x},${y}:${x+100},${y-30}`});
    await command('waitFor','workflow-canvas');
  }
  assert.equal(Number(await client.command('getElementCount',{selector:'[data-testid="workflow-verification"]'})),0,'technical details are absent from the default canvas workspace');
  if (Number(await command('getElementCount','workflow-node-close'))) await command('click','workflow-node-close');
  await command('click','workflow-advanced-toggle');
  await command('waitFor','workflow-settings-dialog',{visible:true});
  await command('waitFor','workflow-verification');
  await command('click','workflow-settings-dialog-close');
  await command('waitFor','workflow-canvas',{visible:true});
  const [canvasBounds] = JSON.parse(await command('getElementMetrics','workflow-canvas'));
  assert.ok(canvasBounds.height > 300, 'canvas retains useful height after closing settings');
  await client.capture('native-workflow-saved.png');
  await client.command('navigate',{value:'/'});
  await command('fill','chat-message-input',{value:'Run saved workflow '+JSON.stringify({definition_id:saved.id,version:1,args:{topic:'Native',pages:8}})});
  await command('waitFor','send-message-button',{enabled:true});
  await command('click','send-message-button');
  await command('waitFor','workflow-execution-canvas');
  await resizePane('workflow-canvas-resize', 'workflow-pane', -80);
  await resizePane('workflow-canvas-resize', 'workflow-pane', 80);

  await command('waitFor',`workflow-node-${saved.nodes[0].id}`);
  await command('waitFor','workflow-running-spinner');
  await command('waitFor',`workflow-current-${saved.nodes[0].id}`);
  assert.equal(await command('getText','model-selector-button'), '模型');
  await command('click','model-selector-button');
  await command('waitFor','model-selector-current',{text:'fixture-long-model-name-for-canvas-layout'});
  await command('click','model-selector-button');
  await waitFor(async()=>{
    const [reuse]=JSON.parse(await command('getElementMetrics','workflow-reuse-open'));
    const [model]=JSON.parse(await command('getElementMetrics','model-selector-button'));
    return Math.abs((reuse.top+reuse.bottom)/2-(model.top+model.bottom)/2)<3;
  },5000,'workflow reuse and short model trigger share one row in the wide composer');
  // QA: opening the canvas reduces composer width independently of viewport
  // breakpoints. At three desktop widths, actions must not overlap model/send.
  for (const width of [1280, 1200, 1152]) {
    await client.command('resizeWindow',{value:`${width}x800`});
    await command('click','workflow-card-open');
    await command('waitFor','workflow-execution-canvas');
    const [canvas] = JSON.parse(await command('getElementMetrics','workflow-execution-canvas'));
    assert.ok(canvas.width > 100 && canvas.height > 100, 'canvas must actually be visible');
    await waitFor(async()=>{
      const [bar]=JSON.parse(await command('getElementMetrics','composer-toolbar'));
      const [controls]=JSON.parse(await command('getElementMetrics','composer-toolbar-model-controls'));
      const actions=JSON.parse(await client.command('getElementMetrics',{selector:'[data-testid="composer-toolbar-actions"] button'}));
      if(!bar || !controls || !actions.length || bar.right > canvas.left + 1) return false;
      return actions.filter(rect=>rect.width>0 && rect.height>0).every(rect=>
        rect.left>=bar.left-1 && rect.right<=bar.right+1 &&
        !(Math.min(rect.right,controls.right)-Math.max(rect.left,controls.left)>1 && Math.min(rect.bottom,controls.bottom)-Math.max(rect.top,controls.top)>1));
    },5000,`canvas composer does not overlap at ${width}`);
  }
  await client.capture('native-workflow-narrow-composer.png');
  await client.command('resizeWindow',{value:'1280x800'});
  await client.capture('native-workflow-running.png');
  // Hiding a shortcut must not stop execution, delete the definition or close its canvas.
  await command('click','workflow-card-dismiss');
  assert.equal(await command('getElementCount','workflow-conversation-card'),'0');
  await command('waitFor','workflow-execution-canvas');
  assert.ok(await readDefinition(), 'dismiss leaves the saved definition intact');
  await client.capture('native-workflow-card-dismissed.png');
  releaseAgent();
  await command('click',`workflow-node-${saved.nodes[0].id}`);
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
  await client.command('navigate',{value:'/workflows'});
  await command('waitFor',`workflow-library-${saved.id}`);
  await command('click',`workflow-library-${saved.id}`);
  await command('waitFor','workflow-add-node',{enabled:true});
  await command('click','workflow-add-node');
  await command('waitFor','workflow-node-title');
  await command('fill','workflow-node-title',{value:'Named router'});
  await command('fill','workflow-node-kind',{value:'switch'});
  await command('waitFor','workflow-switch-fields');
  await command('fill','workflow-predicate-operator',{value:'all'});
  await command('click','workflow-switch-add-route');
  await command('fill','workflow-switch-default',{value:'unmatched'});
  await command('click','workflow-node-save');
  const routed = await waitFor(async()=>{const value=await readDefinition();return value?.nodes.find(node=>node.kind==='switch')?value:null;},10000,'native named router persisted');
  const router = routed.nodes.find(node=>node.kind==='switch');
  assert.equal(router.config.switch.cases.length,2);
  assert.equal(router.config.switch.cases[0].condition.op,'all');
  assert.equal(router.config.switch.default,'unmatched');
  await client.command('navigate',{value:'/'});
  await client.command('navigate',{value:'/workflows'});
  await command('waitFor',`workflow-library-${saved.id}`);
  await command('click',`workflow-library-${saved.id}`);
  await command('waitFor',`workflow-node-${router.id}`);
  await command('click',`workflow-node-${router.id}`);
  await command('waitFor','workflow-switch-default');
  assert.equal(await command('getValue','workflow-switch-default'),'unmatched');
  await client.capture('native-workflow-named-router.png');
  await command('waitFor','workflow-add-node',{enabled:true});
  await command('click','workflow-add-node');
  await command('waitFor','workflow-add-node',{enabled:true});
  await command('fill','workflow-node-title',{value:'Structured calculation'});
  await command('fill','workflow-node-kind',{value:'code'});
  await command('waitFor','workflow-node-code-source');
  await command('fill','workflow-node-code-source',{value:'return {total: 6 * 7};'});
  await command('click','workflow-failure-toggle');
  await command('fill','workflow-failure-action',{value:'continue'});
  await command('click','workflow-node-save');
  const withCode = await waitFor(async()=>{const value=await readDefinition();return value?.nodes.find(node=>node.kind==='code')?value:null;},10000,'native code node saved');
  const codeNode = withCode.nodes.find(node=>node.kind==='code');
  assert.equal(codeNode.title,'Structured calculation');
  assert.equal(codeNode.config.failurePolicy.continueOnError,true);
  assert.equal(codeNode.config.code.source,'return {total: 6 * 7};');
  await command('click',`workflow-node-${codeNode.id}`);
  await command('waitFor','workflow-node-code-source');
  assert.equal(await command('getValue','workflow-node-code-source'),'return {total: 6 * 7};');
  await client.capture('native-workflow-code-node.png');
  await command('click','workflow-advanced-toggle');
  await command('click','workflow-management-toggle');
  await command('waitFor','workflow-delete',{enabled:true});
  await command('click','workflow-delete');
  await command('click','workflow-delete-cancel');
  assert.ok(await readDefinition(), 'cancel retains saved workflow');
  await command('click','workflow-delete');
  await command('click','workflow-delete-confirm');
  await waitFor(async()=>!(await readDefinition()),10000,'native workflow deleted from persisted library');
  await client.command('navigate',{value:'/'});
  await client.command('navigate',{value:'/workflows'});
  await command('waitFor','workflow-import-file');
  assert.equal(await command('getElementCount',`workflow-library-${saved.id}`),'0');
  await client.capture('native-workflow-deleted.png');
  await context.writeArtifactJson('native-workflow-evidence.json',{id:saved.id,revision:saved.revision,version:saved.savedVersion,nodeCount:saved.nodes.length,native:true,modelIndependent:true});
  return {native:true,edited:true,published:true,reopened:true};
 } catch(error) { client.markFailed(); await client.capture('failure.png').catch(()=>{}); throw error; }
 finally { await client.stop(); }
});
