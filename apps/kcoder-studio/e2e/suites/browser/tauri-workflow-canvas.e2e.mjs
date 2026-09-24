import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, {testId:'native-workflow-canvas-edit-publish',tier:'manual-live',modelPolicy:'No model requests: actual Tauri WebView and real Gateway workflow persistence'}, async context => {
 const client = await startOwnedAiVerify(context, {
  tauriBin:process.env.KCODER_E2E_TAURI_BIN || resolve(appRoot,'renderer/src-tauri/target/debug/app'),
  kcoderBin:process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot,'target/debug/kcoder'),
  rendererRoot:resolve(appRoot,'renderer/dist'),
 });
 const command = (action,id,args={}) => client.command(action,{selector:`[data-testid="${id}"]`,...args});
 try {
  await command('waitFor','desktop-sidebar');
  await client.command('navigate',{value:'/workflows'});
  await command('waitFor','workflow-new-title');
  await command('fill','workflow-new-title',{value:'Native isolated canvas'});
  await command('click','workflow-create');
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
  await context.writeArtifactJson('native-workflow-evidence.json',{id:saved.id,revision:saved.revision,version:saved.savedVersion,nodeCount:saved.nodes.length,native:true,noModelRequested:true});
  return {native:true,edited:true,published:true,reopened:true};
 } catch(error) { client.markFailed(); await client.capture('failure.png').catch(()=>{}); throw error; }
 finally { await client.stop(); }
});
